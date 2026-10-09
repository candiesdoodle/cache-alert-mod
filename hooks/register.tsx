import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AlertAction, AlertSettings, CacheLine, CacheTrack, SetupNote } from '../types'

const EMPTY: CacheTrack = { mode: 'none', lastRequestAt: 0, isAlerted: false }
const DEFAULTS: AlertSettings = { botToken: '', botName: '', chatId: '', ttl: '1h', thresholdPercent: 20, notify: true, sound: true, nativeNotify: true, onAlert: 'brb' }
const THRESHOLDS = [10, 15, 20, 25, 30, 50]
const TTLS: readonly { value: AlertSettings['ttl']; label: string }[] = [
  { value: '1h', label: '1 hour (extended cache)' },
  { value: '5m', label: '5 minutes (default cache)' },
]
const ACTIONS: readonly { value: AlertAction; label: string }[] = [
  { value: 'none', label: 'Nothing' },
  { value: 'brb', label: 'Send "be right back" (keeps the cache warm; default)' },
  { value: 'compact', label: 'Run /compact (summarises while the cache is warm)' },
  { value: 'clear', label: 'Run /clear (drops the conversation)' },
]
const BRB_TEXT = 'be right back'

const track = atom({ plugin: 'cache-alert', key: 'track' } as const, EMPTY)
const info = atom({ plugin: 'cache-alert', key: 'info' } as const, { title: '' })
const settings = atom({ plugin: 'cache-alert', key: 'settings' } as const, DEFAULTS)
const note = atom({ plugin: 'cache-alert', key: 'note' } as const, null as SetupNote)
const line = atom({ plugin: 'cache-alert', key: 'line' } as const, null as CacheLine)
// The /theme setting as /config holds it ('dark', 'light-daltonized', 'auto', ...); '' until read
const theme = atom({ plugin: 'cache-alert', key: 'theme' } as const, '')

const STORE_KEY = 'settings'
const SETUP = 'cache-alert-setup'
// Treat the cache as gone a little before the TTL says
const SAFETY_MARGIN_MS = 5_000
const RETRY_MS = 20_000
// The band shows a mm:ss clock; it is only redrawn when its text changes
const TICK_MS = 1_000
// /theme raises no event a mod can see: look again this often
const THEME_POLL_MS = 5_000

// Module variables start over on each reload, as these should
let alertTimer: Timer | undefined
// False under `claude -p` and the SDK: no one is at the prompt to act on an alert
let isInteractive = true

type TelegramReply = { ok: boolean; description?: string; result?: unknown }

// The band's fill, end to end whatever it shows; none where the theme follows the terminal
function bandFill(themeName: string): string | undefined {
  if (themeName.startsWith('dark')) return '#303030'
  if (themeName.startsWith('light')) return '#e4e4e4'
  return undefined
}

async function readTheme($: EngineInterface) {
  const rows = await $.config.list().catch(() => [])
  const value = rows.find(row => row.key === 'theme')?.value
  const next = typeof value === 'string' ? value : ''
  if ((await read($, theme)) !== next) await update($, theme, () => next)
}

function fmtClock(ms: number): string {
  const total = Math.ceil(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// Green with more than half the TTL left, yellow down to the alert threshold, red inside it
function warmth(left: number, s: AlertSettings): { icon: string; tone: 'success' | 'warning' | 'error' } {
  if (left <= leadMs(s)) return { icon: '🔴', tone: 'error' }
  return left <= ttlMs(s) / 2 ? { icon: '🟡', tone: 'warning' } : { icon: '🟢', tone: 'success' }
}

function lineText(l: NonNullable<CacheLine>): string {
  return `Cache (${l.ttl}): Status ${l.icon} ${l.state}${l.alert === null ? '' : ` ; Alert 🔔 ${l.alert}`}`
}

function actionText(channels: readonly string[], followUp: string | null, notify: boolean): string {
  const where = !notify ? null : channels.length ? `Notifications armed for ${channels.join(', ')}` : 'In-app toast only'
  const what = where && followUp ? `${where}, then ${followUp}` : (where ?? followUp ?? 'none, the alert is off')
  return `Action: ${what} (/cache-alert setup to configure)`
}

// The setup pane's checkbox and radio marks, drawn on its buttons
function checkbox(isOn: boolean): string {
  return isOn ? '[x]' : '[ ]'
}

function radio(isOn: boolean): string {
  return isOn ? '(•)' : '( )'
}

// Terminal cells a text takes: an emoji or other astral character takes two
function cells(text: string): number {
  return [...text].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1), 0)
}

function fmt(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.ceil(ms / 1000))}s`
}

function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p
}

function ttlMs(s: AlertSettings): number {
  return (s.ttl === '5m' ? 300 : 3600) * 1000
}

function leadMs(s: AlertSettings): number {
  return (ttlMs(s) * s.thresholdPercent) / 100
}

function expiresAt(t: CacheTrack, s: AlertSettings): number {
  return t.lastRequestAt + ttlMs(s) - SAFETY_MARGIN_MS
}

function isTelegramReady(s: AlertSettings): boolean {
  return s.botToken !== '' && s.chatId !== ''
}

// Whatever the store holds, from any earlier version, read as complete AlertSettings
function normalize(raw: unknown): AlertSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AlertSettings>
  return {
    botToken: typeof r.botToken === 'string' ? r.botToken : '',
    botName: typeof r.botName === 'string' ? r.botName : '',
    chatId: typeof r.chatId === 'string' ? r.chatId : '',
    ttl: r.ttl === '5m' ? '5m' : '1h',
    thresholdPercent: THRESHOLDS.includes(Number(r.thresholdPercent)) ? Number(r.thresholdPercent) : DEFAULTS.thresholdPercent,
    notify: r.notify !== false,
    sound: r.sound !== false,
    nativeNotify: r.nativeNotify !== false,
    onAlert: ACTIONS.some(a => a.value === r.onAlert) ? (r.onAlert as AlertAction) : DEFAULTS.onAlert,
  }
}

function cancelAlert() {
  alertTimer?.cancel()
  alertTimer = undefined
}

async function telegram($: EngineInterface, token: string, method: string, body?: object): Promise<TelegramReply> {
  try {
    const res = await $.http.fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return JSON.parse(res.text) as TelegramReply
  } catch (err) {
    return { ok: false, description: err instanceof Error ? err.message : String(err) }
  }
}

async function sendMessage($: EngineInterface, s: AlertSettings, text: string): Promise<TelegramReply> {
  const base = { chat_id: s.chatId, disable_notification: !s.sound }
  const reply = await telegram($, s.botToken, 'sendMessage', { ...base, text, parse_mode: 'Markdown' })
  // Unescaped Markdown in a project or session name: resend as plain text
  if (!reply.ok && /parse/i.test(reply.description ?? '')) {
    return telegram($, s.botToken, 'sendMessage', { ...base, text: text.replace(/[*_`]/g, '') })
  }
  return reply
}

async function saveSettings($: EngineInterface, change: (s: AlertSettings) => AlertSettings): Promise<AlertSettings> {
  const next = await update($, settings, change)
  await $.store.set(STORE_KEY, next)
  // A new TTL or threshold moves the pending alert
  await arm($)
  await refreshStatus($)
  return next
}

async function setNote($: EngineInterface, text: string, isError = false) {
  await update($, note, () => ({ text, isError }))
}

async function saveToken($: EngineInterface, value: string) {
  const token = value.trim()
  if (!token) return setNote($, 'Paste the token @BotFather gave you, then press Enter.', true)
  await setNote($, 'Checking the token…')
  const me = await telegram($, token, 'getMe')
  if (!me.ok) return setNote($, `Telegram rejected the token: ${me.description ?? 'unknown error'}`, true)
  const botName = (me.result as { username?: string } | undefined)?.username ?? ''
  await saveSettings($, s => ({ ...s, botToken: token, botName }))
  await setNote($, `Connected to @${botName}. Send it any message in Telegram, then press Detect chat.`)
}

async function saveChatId($: EngineInterface, value: string) {
  const chatId = value.trim()
  // A numeric user, group or channel id, or a public channel's @name
  if (!/^(-?\d+|@\w{4,})$/.test(chatId)) return setNote($, 'A chat ID is a number (e.g. 123456789, or -100… for a group) or a channel @name.', true)
  await saveSettings($, cur => ({ ...cur, chatId }))
  await setNote($, `Chat ID ${chatId} saved. Press Send test to check.`)
}

async function detectChat($: EngineInterface) {
  const s = await read($, settings)
  if (!s.botToken) return setNote($, 'Save a bot token first.', true)
  const updates = await telegram($, s.botToken, 'getUpdates')
  if (!updates.ok) return setNote($, `Could not read the bot's messages: ${updates.description ?? 'unknown error'}`, true)
  type Chat = { id: number | string; title?: string; username?: string; first_name?: string }
  const list = (updates.result ?? []) as { message?: { chat?: Chat }; channel_post?: { chat?: Chat } }[]
  const chat = list
    .map(u => u.message?.chat ?? u.channel_post?.chat)
    .filter((c): c is Chat => c !== undefined)
    .at(-1)
  if (!chat) return setNote($, `No messages yet. Send @${s.botName || 'your bot'} any message in Telegram, then press Detect chat again.`, true)
  await saveSettings($, cur => ({ ...cur, chatId: String(chat.id) }))
  await setNote($, `Chat found: ${chat.title ?? chat.username ?? chat.first_name ?? chat.id}. Press Send test to check.`)
}

async function sendTest($: EngineInterface) {
  const s = await read($, settings)
  if (!isTelegramReady(s)) return setNote($, 'Save a bot token and a chat first.', true)
  const reply = await sendMessage($, s, '🔔 *cache-alert* is connected.\nYou will get prompt cache expiry warnings here.')
  await setNote($, reply.ok ? 'Test message sent.' : `Telegram send failed: ${reply.description ?? 'unknown error'}`, !reply.ok)
}

// The session's title at start, else its id
async function sessionLabel($: EngineInterface): Promise<string> {
  return (await read($, info)).title || (await $.session.id()).slice(0, 8)
}

async function cacheLine($: EngineInterface): Promise<CacheLine> {
  const t = await read($, track)
  const s = await read($, settings)
  if (t.mode === 'none') return null
  const at = { ttl: s.ttl, alert: null, channels: null, followUp: null, notify: s.notify }
  const followUp = await nextAction($, s)
  const channels = [...(isTelegramReady(s) ? ['Telegram'] : []), ...(s.nativeNotify ? ['Desktop'] : [])]
  if (t.mode === 'working') return { ...at, icon: '🟢', state: 'active', tone: 'success', channels, followUp }
  if (t.mode === 'compacted') return { ...at, icon: '♻️', state: 'reset by /compact', tone: 'subtle' }
  const left = expiresAt(t, s) - (await $.clock.now())
  if (left <= 0) return { ...at, icon: '❄️', state: 'COLD', tone: 'subtle' }
  const alertIn = left - leadMs(s)
  const alert = t.isAlerted ? 'sent' : alertIn > 0 ? `in ${fmt(alertIn).replace(/(\d)([ms])$/, '$1 $2')}` : 'due'
  return { ...at, ...warmth(left, s), state: fmtClock(left), alert, ...(t.isAlerted ? {} : { channels, followUp }) }
}

async function statusText($: EngineInterface): Promise<string | undefined> {
  const l = await cacheLine($)
  return l ? lineText(l) + (l.channels ? `\n${actionText(l.channels, l.followUp, l.notify)}` : '') : undefined
}

async function refreshStatus($: EngineInterface) {
  const next = await cacheLine($)
  // Written only on a change, so the band redraws once a second at most
  await update($, line, cur => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next))
}

// What the alert will do in the chat, as the band and the messages name it; null for nothing
async function nextAction($: EngineInterface, s: AlertSettings): Promise<string | null> {
  if (s.onAlert === 'compact') return '/compact'
  if (s.onAlert === 'clear') return '/clear'
  if (s.onAlert === 'brb') return `"${BRB_TEXT}"`
  return null
}

// Queued, never awaited: each runs once the session is idle, after this alert's own work
async function runAction($: EngineInterface, s: AlertSettings) {
  const failed = (err: unknown) => $.ui.log(`cache-alert: the on-alert action failed: ${err instanceof Error ? err.message : String(err)}`)
  if (s.onAlert === 'compact') void $.command.run({ command: 'compact', args: '' }).catch(failed)
  if (s.onAlert === 'clear') void $.command.run({ command: 'clear', args: '' }).catch(failed)
  // Its reply refreshes the cache and re-arms the alert, so this repeats on every alert
  if (s.onAlert === 'brb') void $.prompt.submit({ text: BRB_TEXT }).catch(failed)
}

async function fire($: EngineInterface, forRequestAt: number, isRetry: boolean) {
  alertTimer = undefined
  const t = await read($, track)
  const s = await read($, settings)
  if (t.mode !== 'idle' || t.isAlerted || t.lastRequestAt !== forRequestAt) return
  const left = expiresAt(t, s) - (await $.clock.now())
  if (left <= 0) return

  const followUp = isRetry ? null : await nextAction($, s)
  if (!isRetry && s.notify) {
    $.ui.toast(`Prompt cache expires in ~${fmt(left)}. ${followUp ? `Sending ${followUp}.` : 'Send a message to keep it warm.'}`)
    if (s.nativeNotify) $.ui.notify(`Prompt cache expires in ~${fmt(left)}`, { title: 'cache-alert' }).catch(() => undefined)
  }

  let isDelivered = true
  if (s.notify && isTelegramReady(s)) {
    const text =
      `⚠️ *Claude Code Prompt Cache Expiring Soon!*\n\n` +
      `📁 *Project:* \`${basename(await $.session.cwd())}\`\n` +
      `💬 *Session:* \`${await sessionLabel($)}\`\n` +
      `⏳ *Time Remaining:* *~${fmt(left)}* (of ${s.ttl} cache TTL)\n\n` +
      (followUp ? `▶️ *Then:* sending ${followUp} to the session` : `💬 _Send a quick reply to your session to refresh the prompt cache._`)
    const reply = await sendMessage($, s, text)
    if (!reply.ok) {
      isDelivered = false
      // Retry until the cache goes cold; each attempt recomputes the time left
      if (left > RETRY_MS) alertTimer = $.clock.after(RETRY_MS, () => void fire($, forRequestAt, true))
      if (!isRetry) $.ui.log(`cache-alert: Telegram delivery failed (${reply.description ?? 'unknown'}), retrying every ${RETRY_MS / 1000}s`)
    }
  }

  // The action goes ahead with or without Telegram, and whether or not the message got through
  if (followUp) await runAction($, s)
  if (!isDelivered) return
  await update($, track, cur => (cur.lastRequestAt === forRequestAt ? { ...cur, isAlerted: true } : cur))
  await refreshStatus($)
}

async function arm($: EngineInterface) {
  cancelAlert()
  const t = await read($, track)
  const s = await read($, settings)
  if (t.mode !== 'idle' || t.isAlerted || !t.lastRequestAt) return
  const now = await $.clock.now()
  if (expiresAt(t, s) <= now) return
  // Past the threshold already (a reload or a new threshold late in the window): fire at once
  const delay = Math.max(1_000, expiresAt(t, s) - leadMs(s) - now)
  const forRequestAt = t.lastRequestAt
  alertTimer = $.clock.after(delay, () => void fire($, forRequestAt, false))
}

async function openSetup($: EngineInterface) {
  await update($, note, () => null)
  return $.ui.open({ id: SETUP, title: 'cache-alert setup', focus: true, closeOnEscape: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The command is a convenience: never let it keep the timers from starting
    await $.command
      .register({
        name: 'cache-alert',
        description: 'Prompt cache status; `setup` to configure Telegram alerts, `test` to send a test message.',
        argumentHint: '[setup|test]',
      })
      .catch(() => undefined)
    const stored = await $.store.get(STORE_KEY).catch(() => undefined)
    await update($, settings, () => normalize(stored))
    isInteractive = e.isInteractive
    if (!isInteractive) return next(e)
    if (stored === undefined) $.ui.toast('cache-alert: run /cache-alert setup to get Telegram alerts before the prompt cache expires.')
    // Earlier versions pinned a status line; the band replaces it
    $.ui.status(undefined)
    $.clock.every(TICK_MS, () => void refreshStatus($))
    await readTheme($)
    $.clock.every(THEME_POLL_MS, () => void readTheme($))
    // A hot reload keeps $.state but drops timers: re-arm from what was tracked
    await arm($)
    await refreshStatus($)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    await update($, info, () => ({ title: e.session_title ?? '' }))
    return next(e)
  })

  // Subagents raise no turn.start: this is the main loop starting a request
  on('turn.start', async ($, e, next) => {
    if (!isInteractive) return next(e)
    cancelAlert()
    await update($, track, (cur): CacheTrack => ({ ...cur, mode: 'working' }))
    await refreshStatus($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!isInteractive || e.agentId !== undefined) return next(e)
    const u = e.usage
    const now = await $.clock.now()
    await update($, track, (cur): CacheTrack => {
      // A request that read or wrote the cache refreshed it now
      if (u && u.cache_read_input_tokens + u.cache_creation_input_tokens > 0) return { mode: 'idle', lastRequestAt: now, isAlerted: false }
      // A request ran but caching is off
      if (u) return EMPTY
      // Interrupted or failed before any request counted: the previous refresh still stands
      return cur.lastRequestAt ? { ...cur, mode: 'idle' } : EMPTY
    })
    await arm($)
    await refreshStatus($)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (isInteractive && e.agentId === undefined && 'messages' in result) {
      cancelAlert()
      await update($, track, () => ({ mode: 'compacted', lastRequestAt: 0, isAlerted: false }))
      await refreshStatus($)
    }
    return result
  })

  // /clear lands here too, and the process carries on under a new session
  on('session.end', async ($, e, next) => {
    cancelAlert()
    await update($, track, () => EMPTY)
    await update($, line, () => null)
    return next(e)
  })

  on('command.run', { command: 'cache-alert' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'setup') {
      const opened = await openSetup($)
      return { text: opened.isPlaced ? 'Opened cache-alert setup.' : 'cache-alert setup is waiting for room: widen the terminal.' }
    }
    if (arg === 'test') {
      const s = await read($, settings)
      if (!isTelegramReady(s)) return { text: 'Telegram is not set up yet: run /cache-alert setup.' }
      const reply = await sendMessage($, s, '🔔 *cache-alert test notification*\n\nEverything is working.')
      return { text: reply.ok ? 'Test alert sent to Telegram.' : `Telegram send failed: ${reply.description ?? 'unknown error'}` }
    }
    const s = await read($, settings)
    const status = (await statusText($)) ?? 'No cached turn yet in this session.'
    const telegramLine = isTelegramReady(s) ? `Telegram: @${s.botName || 'bot'} → chat ${s.chatId}` : 'Telegram: not set up (/cache-alert setup)'
    return { text: `${status}\n${telegramLine} · TTL ${s.ttl} · alert at ${s.thresholdPercent}% left` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const l = await read($, line)
    if (l === null || e.props.hasSurvey) return next(e)
    const fill = bandFill(await read($, theme))
    // On a fill, every text takes the theme's colours: the terminal's own foreground may not suit it
    const plain = fill === undefined ? {} : { color: 'text' }
    const muted = fill === undefined ? { dimColor: true } : { color: 'inactive' }
    const { Box, Text } = $.ui.resolve(e)
    const action = l.channels ? actionText(l.channels, l.followUp, l.notify) : null
    // The action shares the row while it fits, else takes a row of its own
    const isOneRow = action === null || cells(`${lineText(l)} ; ${action}`) + 2 <= e.props.bodyColumns
    return (
      <Box marginTop={1}>
        <Box width={e.props.bodyColumns} backgroundColor={fill} paddingX={1} flexDirection={isOneRow ? 'row' : 'column'}>
          <Box>
            <Text {...muted}>Cache ({l.ttl}): </Text>
            <Text {...plain}>Status {l.icon} </Text>
            {/* COLD and reset by /compact read like the Action text, not fainter */}
            {l.tone === 'subtle' ? (
              <Text {...muted}>{l.state}</Text>
            ) : (
              <Text color={l.tone} bold>
                {l.state}
              </Text>
            )}
            {l.alert === null ? null : <Text {...muted}> ; </Text>}
            {l.alert === null ? null : <Text {...plain}>Alert 🔔 {l.alert}</Text>}
          </Box>
          {action === null ? null : <Text {...muted}>{isOneRow ? ` ; ${action}` : action}</Text>}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: SETUP }, async ($, e) => {
    const s = await read($, settings)
    const n = await read($, note)
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>Run /cache-alert setup from a terminal or desktop session.</Text>
    }
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    const tokenHint = s.botToken ? `saved ••••${s.botToken.slice(-4)}${s.botName ? ` (@${s.botName})` : ''}; paste to replace` : 'paste the token from @BotFather'
    const leadMin = (p: number) => fmt((ttlMs(s) * p) / 100)

    return (
      <Box flexDirection="column">
        <Text bold>Telegram</Text>
        <Text dimColor>1. In Telegram, message @BotFather, send /newbot, and paste the token it gives you below.</Text>
        <Input key="token" label="Bot token " placeholder={tokenHint} value="" submitLabel="save" onSubmit={v => void saveToken($, v)} />
        <Box marginTop={1}>
          <Text dimColor>2. Send your bot any message, then press Detect chat (or type a chat ID).</Text>
        </Box>
        <Box>
          <Input key="chat" label="Chat ID " placeholder={s.chatId ? `saved ${s.chatId}; type to replace` : 'not set'} value="" submitLabel="save" onSubmit={v => void saveChatId($, v)} />
          <Text> </Text>
          <Button key="detect" label="Detect chat" onPress={() => void detectChat($)} />
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Cache</Text>
          <Text>Cache TTL</Text>
          <Box marginLeft={4} flexWrap="wrap" columnGap={2}>
            {TTLS.map(t => (
              <Button key={`ttl-${t.value}`} label={`${radio(s.ttl === t.value)} ${t.label}`} onPress={() => void saveSettings($, cur => ({ ...cur, ttl: t.value }))} />
            ))}
          </Box>
          <Text>Alert when left</Text>
          <Box marginLeft={4} flexWrap="wrap" columnGap={2}>
            {THRESHOLDS.map(p => (
              <Button key={`threshold-${p}`} label={`${radio(s.thresholdPercent === p)} ${p}% (${leadMin(p)})`} onPress={() => void saveSettings($, cur => ({ ...cur, thresholdPercent: p }))} />
            ))}
          </Box>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>When the alert fires</Text>
          <Text dimColor>Notify, do one thing in the chat, or both.</Text>
          <Button key="notify" label={`${checkbox(s.notify)} Notify`} onPress={() => void saveSettings($, cur => ({ ...cur, notify: !cur.notify }))} />
          {s.notify ? (
            <Box marginLeft={4}>
              <Button key="desktop" label={`${checkbox(s.nativeNotify)} Desktop notification`} onPress={() => void saveSettings($, cur => ({ ...cur, nativeNotify: !cur.nativeNotify }))} />
              <Text> </Text>
              <Button key="sound" label={`${checkbox(s.sound)} Telegram sound`} onPress={() => void saveSettings($, cur => ({ ...cur, sound: !cur.sound }))} />
            </Box>
          ) : null}
          <Box marginTop={1}>
            <Text dimColor>In the chat (pick one):</Text>
          </Box>
          {ACTIONS.map(a => (
            <Button key={`onAlert-${a.value}`} label={`${radio(s.onAlert === a.value)} ${a.label}`} onPress={() => void saveSettings($, cur => ({ ...cur, onAlert: a.value }))} />
          ))}
        </Box>
        <Box marginTop={1}>
          <Button key="test" variant="primary" label="Send test" onPress={() => void sendTest($)} />
          <Text> </Text>
          {s.botToken ? (
            <Button
              key="disconnect"
              label="Disconnect Telegram"
              onPress={() =>
                void saveSettings($, cur => ({ ...cur, botToken: '', botName: '', chatId: '' })).then(() => setNote($, 'Telegram disconnected.'))
              }
            />
          ) : null}
          <Text> </Text>
          <Button key="done" role="dismiss" label="Done" onPress={() => void $.ui.close({ id: SETUP })} />
        </Box>
        {n ? (
          <Text color={n.isError ? 'error' : 'success'}>
            {n.text}
          </Text>
        ) : null}
      </Box>
    )
  })
}
