# cache-alert 🔔

A Claude Code mod that warns you before your session's prompt cache expires, so you can send a message and keep it warm instead of paying to rebuild the cache.

It shows a countdown in Claude Code's status line. When the alert fires you get an in-terminal toast, a desktop notification, and (optionally) a Telegram message on your phone.

## Install

At a Claude Code prompt:

```
/plugin install cache-alert --marketplace candiesdoodle/cache-alert-mod
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

## Set up Telegram

```
/cache-alert setup
```

A setup pane opens:

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and paste the token it gives you into **Bot token**, then press Enter. The mod checks the token with Telegram before saving it.
2. Send your new bot any message in Telegram, then press **Detect chat**. You can also type a chat ID (a group or channel ID works too).
3. Choose the **Cache TTL** (1 hour or 5 minutes) and when to alert (10–50% of the TTL left; 20% of 1h is 12 minutes).
4. Press **Send test**.

Settings are saved across sessions. Without Telegram you still get the toast and the desktop notification.

## Status line

| Shown | Meaning |
| --- | --- |
| `Cache (1h): Status 🟢 active` | A turn is running, so the cache is being refreshed |
| `Cache (1h): Status 🟢 58:58 ; Alert 🔔 in 47 m` | Cache expires in 58:58; the alert fires in 47 minutes |
| `Cache (1h): Status 🟡 25:10 ; Alert 🔔 in 13 m` | Less than half the TTL is left |
| `Cache (1h): Status 🔴 11:54 ; Alert 🔔 sent` | Inside the alert window; the alert went out |
| `Cache (1h): Status ❄️ COLD` | The cache has expired |
| `Cache (1h): Status ♻️ reset by /compact` | `/compact` replaced the cached prefix; the next turn starts a new one |

## Commands

| Command | Does |
| --- | --- |
| `/cache-alert` | Shows the cache status and the Telegram setup |
| `/cache-alert setup` | Opens the setup pane |
| `/cache-alert test` | Sends a test Telegram message |

## How it works

- Each main-conversation turn that reads or writes the prompt cache restarts the countdown. Subagent turns are ignored, since they use their own cache.
- A new turn cancels the pending alert. An interrupted turn keeps the earlier countdown running.
- `/compact` and `/clear` cancel the alert.
- A failed Telegram send is retried every 20 seconds until the cache goes cold.

## Things to know

- Alerts come from the running Claude Code session. If you close the session, no alert is sent.
- Set the TTL to match your cache. The mod counts from the time of the last turn; it does not ask Anthropic when your cache expires.
- The bot token is kept in Claude Code's plugin store on your machine. The only network calls go to `api.telegram.org`.

## Develop

```
claude --plugin-dir .            # run it from this folder; edits hot-reload
claude plugin validate .
claude plugin test .
```

## License

MIT © candiesdoodle
