/** Where this session's main-loop prompt cache stands. */
export type CacheMode = 'none' | 'working' | 'idle' | 'compacted'

export type CacheTrack = {
  mode: CacheMode
  /** ms epoch of the last main-loop model turn that touched the cache; 0 when none. */
  lastRequestAt: number
  /** The alert for lastRequestAt was delivered. */
  isAlerted: boolean
}

export type SessionInfo = {
  transcriptPath: string
  title: string
}

/** What /cache-alert setup writes; kept in $.store across sessions. */
export type AlertSettings = {
  botToken: string
  /** The bot's username, as getMe answered when the token was saved. */
  botName: string
  chatId: string
  ttl: '1h' | '5m'
  /** Alert when this share of the TTL remains. */
  thresholdPercent: number
  sound: boolean
  nativeNotify: boolean
}

/** The setup pane's last result line. */
export type SetupNote = { text: string; isError: boolean } | null

declare module 'claude-code' {
  interface PluginState {
    'cache-alert': { track: CacheTrack; info: SessionInfo; settings: AlertSettings; note: SetupNote }
  }
}
