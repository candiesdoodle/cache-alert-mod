# cache-alert 🔔

A Claude Code mod that warns you before your session's prompt cache expires, and automatically can send a message to keep it warm, or compact or clear the session, instead of paying to rebuild the cache.

It shows a live countdown in a one-line band just above the prompt. When the alert fires you get an in-terminal toast, a desktop notification, and (optionally) a Telegram message on your phone.

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
3. Under **Cache**, pick the **Cache TTL** (1 hour or 5 minutes) and when to alert (10–50% of the TTL left; 20% of 1h is 12 minutes).
4. Under **When the alert fires**, tick **Notify** (the toast, plus Desktop and Telegram where set up), pick one thing to do in the chat:
   - **Nothing**: no change to the chat.
   - **Send "be right back"** (the default): sends that message as a prompt, so the reply refreshes the cache. The reply re-arms the alert, so while you are away it repeats on every alert and keeps the cache warm.
   - **Run /compact**: summarises the conversation while the cache is still warm, so the summary is cheaper to make.
   - **Run /clear**: drops the conversation, so there is no cache left to lose. This cannot be undone.
5. Press **Send test**.

Settings are saved across sessions. Without Telegram you still get the toast and the desktop notification.

## The band

The time left is coloured green, yellow or red to match the icon. Collapse the band with its `[-]` mark.

Until the alert goes out, the band also says where it will go, for example `Action: Notifications armed for Telegram, Desktop, then /compact (/cache-alert setup to configure)`. On a narrow terminal that moves to a second row.

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

## Privacy and permissions

What the mod reads, sends, runs and hooks, in full.

**Network.** The only host it contacts is `https://api.telegram.org`, and only once you have set up Telegram. It calls three Bot API methods:

- `getMe`, when you save a bot token, to check the token and read the bot's name.
- `getUpdates`, when you press Detect chat, to find the chat you messaged the bot from.
- `sendMessage`, for the test message and for each alert. An alert carries the project folder's name, the session's name, the time left on the cache, the TTL, and the chat action it is about to take. It never carries conversation text, prompts, code or file contents.

**The bot token.** It is your own Telegram bot's token, typed into the setup pane. It is stored in Claude Code's plugin store on your machine and sent only to `api.telegram.org`, as the Bot API requires (in the request path). The mod reads no token from your environment or files.

**What it reads.**

- Token usage counts from each finished turn (`turn.complete`), to know when the cache was last refreshed. It reads no message text.
- The session title from Claude Code's session start (`classic.SessionStart`), for the alert message. The hook changes nothing and passes the event on unchanged.
- Your `theme` setting (`config.list`), every 5 seconds, to colour the band to match. It is not sent anywhere.

**Programs it runs.** None.

**What it does in your session** (the chat action you pick in setup):

- "be right back": submits that fixed text as a prompt (`prompt.submit`). Nothing else is put in it.
- /compact or /clear: runs that built-in command (`command.run`).
- Nothing: no change to the chat.

**Other hooks.** It registers the `/cache-alert` command and handles it. It hooks `session.compact` and `session.end` only to cancel a pending alert and reset the band; both pass the event on unchanged. It draws the band above the prompt and the setup pane (`ui.render`). Desktop alerts use Claude Code's own notification call (`ui.notify`). It sets no permissions and changes no settings.

## Develop

```
claude --plugin-dir .            # run it from this folder; edits hot-reload
claude plugin validate .
claude plugin test .
```

## License

MIT © candiesdoodle
