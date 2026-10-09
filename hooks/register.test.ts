import { expect, mock, test } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'
import type { Engine, FoundElement } from 'claude-code/testing'

const MIN = 60_000
const CACHED: TurnUsage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100, model: 'm' }
const READY = { botToken: '123:abc', botName: 'mybot', chatId: '42', ttl: '1h', thresholdPercent: 20, sound: true, nativeNotify: true }

function world(on: On, settings?: object, chats: object[] = []) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const store = new Map<string, unknown>(settings ? [['settings', settings]] : [])
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const sent: string[] = []
  on('ui.status', ($, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: '/home/u/proj' }))
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', ($, e) => {
    const reply = (body: object) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (e.url.endsWith('/getMe')) {
      return e.url.includes('/botbad/') ? reply({ ok: false, description: 'Unauthorized' }) : reply({ ok: true, result: { username: 'mybot' } })
    }
    if (e.url.endsWith('/getUpdates')) return reply({ ok: true, result: chats })
    sent.push(String(e.init?.body))
    return reply({ ok: true })
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  return { clock, statuses, toasts, sent, store }
}

const start = { cwd: '/home/u/proj', surface: 'terminal', isInteractive: true } as const
const done = (usage?: TurnUsage, isAborted = false) =>
  ({ answer: 'ok', durationMs: 1, isAborted, turnId: 't1', reason: isAborted ? 'aborted' : 'answer', usage }) as const
const SETUP = {
  component: 'Pane',
  requestId: 'cache-alert-setup',
  props: { title: 'cache-alert setup', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// The band's line as text; undefined when it draws nothing of its own
async function shown($: Engine) {
  try {
    const ui = await $.ui.mount({ plugin: 'cache-alert', surface: 'terminal', ...BAND })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
    await ui.unmount()
    return texts || undefined
  } catch {
    return undefined
  }
}

// The pane's result line is its last Text
async function lastLine(ui: { findAll: (q: { type: string }) => Promise<FoundElement[]> }) {
  return (await ui.findAll({ type: 'Text' })).at(-1)?.text
}

test('alerts by Telegram at the threshold, once, and counts down', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on, READY)
  await $.session.start(start)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(await shown($)).toBe('Cache (1h): Status 🟢 active')
  await $.turn.complete(done(CACHED))
  expect(await shown($)).toBe('Cache (1h): Status 🟢 59:55 ; Alert 🔔 in 48 m')
  await w.clock.advance(30 * MIN)
  expect(await shown($)).toBe('Cache (1h): Status 🟡 29:55 ; Alert 🔔 in 18 m')

  await w.clock.advance(17 * MIN)
  expect(w.sent).toHaveLength(0)
  await w.clock.advance(1 * MIN)
  expect(w.sent).toHaveLength(1)
  expect(w.sent[0]).toContain('proj')
  expect(w.toasts).toHaveLength(1)
  await w.clock.advance(1_000)
  expect(await shown($)).toBe('Cache (1h): Status 🔴 11:54 ; Alert 🔔 sent')

  await w.clock.advance(20 * MIN)
  expect(w.sent).toHaveLength(1)
  expect(await shown($)).toBe('Cache (1h): Status ❄️ COLD')
})

test('a new turn cancels the pending alert', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on, READY)
  await $.session.start(start)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done(CACHED))
  await w.clock.advance(40 * MIN)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await w.clock.advance(10 * MIN)
  expect(w.sent).toHaveLength(0)
})

test('an interrupted turn keeps the earlier refresh armed', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on, READY)
  await $.session.start(start)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done(CACHED))
  await w.clock.advance(10 * MIN)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await $.turn.complete(done(undefined, true))
  await w.clock.advance(38 * MIN)
  expect(w.sent).toHaveLength(1)
})

test('first run hints at setup, and still toasts without Telegram', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  expect(w.toasts[0]).toContain('/cache-alert setup')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done(CACHED))
  await w.clock.advance(48 * MIN)
  expect(w.sent).toHaveLength(0)
  expect(w.toasts).toHaveLength(2)
})

test('5m TTL alerts with a minute left', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on, { ...READY, ttl: '5m' })
  await $.session.start(start)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done(CACHED))
  await w.clock.advance(3.8 * MIN)
  expect(w.sent).toHaveLength(0)
  await w.clock.advance(0.2 * MIN)
  expect(w.sent).toHaveLength(1)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`setup on ${surface} saves a verified token, detects the chat and sends a test`, async ($, on) => {
    const w = world(on, undefined, [{ message: { chat: { id: 777, first_name: 'Piyush' } } }])
    await $.session.start(start)
    const ui = await $.ui.mount({ plugin: 'cache-alert', surface, ...SETUP })

    await ui.input({ key: 'token', text: 'bad' })
    expect(await lastLine(ui)).toContain('rejected')
    expect(w.store.get('settings')).toBeUndefined()

    await ui.input({ key: 'token', text: '123:abc' })
    expect(await lastLine(ui)).toContain('@mybot')

    await ui.press({ key: 'detect' })
    expect(await lastLine(ui)).toContain('Piyush')
    expect(w.store.get('settings')).toMatchObject({ botToken: '123:abc', botName: 'mybot', chatId: '777' })

    await ui.press({ key: 'test' })
    expect(w.sent).toHaveLength(1)
    expect(await lastLine(ui)).toBe('Test message sent.')
    await ui.unmount()
  })
}

test('a new threshold in setup moves the pending alert', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on, READY)
  await $.session.start(start)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done(CACHED))
  const ui = await $.ui.mount({ plugin: 'cache-alert', surface: 'terminal', ...SETUP })
  await ui.select({ key: 'threshold', value: '50' })
  expect(w.store.get('settings')).toMatchObject({ thresholdPercent: 50 })
  await w.clock.advance(30 * MIN)
  expect(w.sent).toHaveLength(1)
  await ui.unmount()
})

test('a non-interactive run (-p, SDK) stays quiet: no hint, no status, no alert', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on, READY)
  await $.session.start({ cwd: '/home/u/proj', surface: null, isInteractive: false })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done(CACHED))
  await w.clock.advance(60 * MIN)
  expect(w.toasts).toHaveLength(0)
  expect(w.statuses).toHaveLength(0)
  expect(await shown($)).toBeUndefined()
  expect(w.sent).toHaveLength(0)
})

test('a typed chat ID is checked, saved and shown in the field', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on, { ...READY, chatId: '' })
  await $.session.start(start)
  const ui = await $.ui.mount({ plugin: 'cache-alert', surface: 'terminal', ...SETUP })
  expect((await ui.find({ key: 'chat' }))?.props.placeholder).toBe('not set')

  await ui.input({ key: 'chat', text: 'hello' })
  expect(await lastLine(ui)).toContain('A chat ID is a number')
  expect(w.store.get('settings')).toMatchObject({ chatId: '' })

  await ui.input({ key: 'chat', text: ' 123456789 ' })
  expect(w.store.get('settings')).toMatchObject({ chatId: '123456789' })
  expect((await ui.find({ key: 'chat' }))?.props.placeholder).toBe('saved 123456789; type to replace')
  expect(await lastLine(ui)).toContain('Chat ID 123456789 saved')
  await ui.unmount()
})

test('the band draws the line in colour above the prompt', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on, READY)
  await $.session.start(start)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done(CACHED))
  await w.clock.advance(1_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cache-alert', surface, ...BAND })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
    expect(texts).toBe('Cache (1h): Status 🟢 59:54 ; Alert 🔔 in 48 m')
    expect((await ui.find({ type: 'Text', text: '59:54' }))?.props.color).toBe('success')
    await ui.unmount()
  }
})
