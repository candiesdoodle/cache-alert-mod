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

/** What the mod does in the chat when the alert fires, with or without the notifications. */
export type AlertAction = 'none' | 'brb' | 'compact' | 'clear'

/** What /cache-alert setup writes; kept in $.store across sessions. */
export type AlertSettings = {
  botToken: string
  /** The bot's username, as getMe answered when the token was saved. */
  botName: string
  chatId: string
  ttl: '1h' | '5m'
  /** Alert when this share of the TTL remains. */
  thresholdPercent: number
  /** Notify at all: the toast, plus Desktop and Telegram where set up. */
  notify: boolean
  sound: boolean
  nativeNotify: boolean
  onAlert: AlertAction
}

/** What the band above the prompt shows; null when there is no cached turn. */
export type CacheLine = {
  ttl: '1h' | '5m'
  icon: string
  /** The time left (mm:ss), or active, COLD, reset by /compact. */
  state: string
  tone: 'success' | 'warning' | 'error' | 'subtle'
  /** in 47 m, in 30 s, due, sent; null when there is nothing to alert about. */
  alert: string | null
  /** Where the coming alert goes (Telegram, Desktop); null once there is no alert to come. */
  channels: string[] | null
  /** The notifications are on; when off, only the chat action runs. */
  notify: boolean
  /** What follows the notifications in the chat (/compact, "be right back"); null for nothing. */
  followUp: string | null
} | null

/** The setup pane's last result line. */
export type SetupNote = { text: string; isError: boolean } | null

declare module 'claude-code' {
  interface PluginState {
    'cache-alert': { track: CacheTrack; info: SessionInfo; settings: AlertSettings; note: SetupNote; line: CacheLine; theme: string }
  }
}
