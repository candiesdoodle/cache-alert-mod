import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { CacheTrack, AlertSettings, SetupNote } from '../types'

const EMPTY: CacheTrack = { mode: 'none', lastRequestAt: 0, isAlerted: false }
const DEFAULTS: AlertSettings = { botToken: '', botName: '', chatId: '', ttl: '1h', thresholdPercent: 20, sound: true, nativeNotify: true }
const THRESHOLDS = [10, 15, 20, 25, 30, 50]

const track = atom({ plugin: 'cache-alert', key: 'track' } as const, EMPTY)
const info = atom({ plugin: 'cache-alert', key: 'info' } as const, { transcriptPath: '', title: '' })
const settings = atom({ plugin: 'cache-alert', key: 'settings' } as const, DEFAULTS)
const note = atom({ plugin: 'cache-alert', key: 'note' } as const, null as SetupNote)

const STORE_KEY = 'settings'
const SETUP = 'cache-alert-setup'
// Treat the cache as gone a little before the TTL says
const SAFETY_MARGIN_MS = 5_000
const RETRY_MS = 20_000
// The status shows a mm:ss clock; it is only redrawn when its text changes
const TICK_MS = 1_000

// Module variables start over on each reload, as these should
let alertTimer: Timer | undefined
let shownStatus: string | undefined
// False under `claude -p` and the SDK: no one is at the prompt to act on an alert
let isInteractive = true

type TelegramReply = { ok: boolean; description?: string; result?: unknown }

function fmtClock(ms: number): string {
  const total = Math.ceil(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// Green with more than half the TTL left, yellow down to the alert threshold, red inside it
function warmthIcon(left: number, s: AlertSettings): string {
  if (left <= leadMs(s)) return '🔴'
  return left <= ttlMs(s) / 2 ? '🟡' : '🟢'
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
    sound: r.sound !== false,
    nativeNotify: r.nativeNotify !== false,
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

// The /rename title, else the start-time title, else the slug, else the id
async function sessionLabel($: EngineInterface): Promise<string> {
  const i = await read($, info)
  let slug = ''
  if (i.transcriptPath) {
    try {
      const { stdout } = await $.process.run(['tail', '-c', '131072', i.transcriptPath], { timeoutMs: 5_000 })
      for (const line of stdout.split('\n').reverse()) {
        if (!line.includes('"custom-title"') && (slug || !line.includes('"slug"'))) continue
        try {
          const entry = JSON.parse(line) as { type?: string; customTitle?: string; slug?: string }
          if (entry.type === 'custom-title' && entry.customTitle) return entry.customTitle
          if (!slug && entry.slug) slug = entry.slug
        } catch {
          // the tail's cut first line
        }
      }
    } catch {
      // no tail on this host
    }
  }
  return i.title || slug || (await $.session.id()).slice(0, 8)
}

async function statusText($: EngineInterface): Promise<string | undefined> {
  const t = await read($, track)
  const s = await read($, settings)
  if (t.mode === 'none') return undefined
  const head = `Cache (${s.ttl}): Status`
  if (t.mode === 'working') return `${head} 🟢 active`
  if (t.mode === 'compacted') return `${head} ♻️ reset by /compact`
  const left = expiresAt(t, s) - (await $.clock.now())
  if (left <= 0) return `${head} ❄️ COLD`
  const alertIn = left - leadMs(s)
  const alert = t.isAlerted ? 'sent' : alertIn > 0 ? `in ${fmt(alertIn).replace(/(\d)([ms])$/, '$1 $2')}` : 'due'
  return `${head} ${warmthIcon(left, s)} ${fmtClock(left)} ; Alert 🔔 ${alert}`
}

async function refreshStatus($: EngineInterface) {
  const text = await statusText($)
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

async function fire($: EngineInterface, forRequestAt: number, isRetry: boolean) {
  alertTimer = undefined
  const t = await read($, track)
  const s = await read($, settings)
  if (t.mode !== 'idle' || t.isAlerted || t.lastRequestAt !== forRequestAt) return
  const left = expiresAt(t, s) - (await $.clock.now())
  if (left <= 0) return

  if (!isRetry) {
    $.ui.toast(`Prompt cache expires in ~${fmt(left)}. Send a message to keep it warm.`)
    if (s.nativeNotify) $.ui.notify(`Prompt cache expires in ~${fmt(left)}`, { title: 'cache-alert' }).catch(() => undefined)
  }

  if (isTelegramReady(s)) {
    const text =
      `⚠️ *Claude Code Prompt Cache Expiring Soon!*\n\n` +
      `📁 *Project:* \`${basename(await $.session.cwd())}\`\n` +
      `💬 *Session:* \`${await sessionLabel($)}\`\n` +
      `⏳ *Time Remaining:* *~${fmt(left)}* (of ${s.ttl} cache TTL)\n\n` +
      `💬 _Send a quick reply to your session to refresh the prompt cache._`
    const reply = await sendMessage($, s, text)
    if (!reply.ok) {
      // Retry until the cache goes cold; each attempt recomputes the time left
      if (left > RETRY_MS) alertTimer = $.clock.after(RETRY_MS, () => void fire($, forRequestAt, true))
      if (!isRetry) $.ui.log(`cache-alert: Telegram delivery failed (${reply.description ?? 'unknown'}), retrying every ${RETRY_MS / 1000}s`)
      return
    }
  }

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
    $.clock.every(TICK_MS, () => void refreshStatus($))
    // A hot reload keeps $.state but drops timers: re-arm from what was tracked
    await arm($)
    await refreshStatus($)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    await update($, info, () => ({ transcriptPath: e.transcript_path, title: e.session_title ?? '' }))
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await update($, info, cur => (cur.transcriptPath === e.transcript_path ? cur : { ...cur, transcriptPath: e.transcript_path }))
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
    $.ui.status(undefined)
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

  on('ui.render', { component: 'Pane', requestId: SETUP }, async ($, e) => {
    const s = await read($, settings)
    const n = await read($, note)
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>Run /cache-alert setup from a terminal or desktop session.</Text>
    }
    const { Box, Text, Input, Select, Button } = $.ui.resolve(e)
    const tokenHint = s.botToken ? `saved ••••${s.botToken.slice(-4)}${s.botName ? ` (@${s.botName})` : ''}; paste to replace` : 'paste the token from @BotFather'
    const leadMin = (p: number) => fmt((ttlMs(s) * p) / 100)

    return (
      <Box flexDirection="column">
        <Text bold>Telegram</Text>
        <Text dimColor>1. In Telegram, message @BotFather, send /newbot, and paste the token it gives you below.</Text>
        <Input key="token" label="Bot token " placeholder={tokenHint} value="" submitLabel="save" onSubmit={v => void saveToken($, v)} />
        <Text dimColor>2. Send your bot any message, then press Detect chat (or type a chat ID).</Text>
        <Box>
          <Input key="chat" label="Chat ID " placeholder={s.chatId ? `saved ${s.chatId}; type to replace` : 'not set'} value="" submitLabel="save" onSubmit={v => void saveChatId($, v)} />
          <Text> </Text>
          <Button key="detect" label="Detect chat" onPress={() => void detectChat($)} />
        </Box>
        <Text bold>Alerts</Text>
        <Select
          key="ttl"
          label="Cache TTL "
          value={s.ttl}
          options={[
            { value: '1h', label: '1 hour (extended cache)' },
            { value: '5m', label: '5 minutes (default cache)' },
          ]}
          onSelect={v => void saveSettings($, cur => ({ ...cur, ttl: v === '5m' ? '5m' : '1h' }))}
        />
        <Select
          key="threshold"
          label="Alert when left "
          value={String(s.thresholdPercent)}
          options={THRESHOLDS.map(p => ({ value: String(p), label: `${p}% (${leadMin(p)})` }))}
          onSelect={v => void saveSettings($, cur => ({ ...cur, thresholdPercent: Number(v) }))}
        />
        <Box>
          <Button key="sound" label={`Telegram sound: ${s.sound ? 'on' : 'off'}`} onPress={() => void saveSettings($, cur => ({ ...cur, sound: !cur.sound }))} />
          <Text> </Text>
          <Button key="notify" label={`Desktop notification: ${s.nativeNotify ? 'on' : 'off'}`} onPress={() => void saveSettings($, cur => ({ ...cur, nativeNotify: !cur.nativeNotify }))} />
        </Box>
        <Box>
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
