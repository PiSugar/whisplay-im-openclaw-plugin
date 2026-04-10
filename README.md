# whisplay-im OpenClaw Channel

`whisplay-im` is an IM channel adapter for OpenClaw, used to integrate with the Whisplay Chatbot device bridge interface.

- OpenClaw pulls user messages: `GET /whisplay-im/poll`
- OpenClaw sends reply messages: `POST /whisplay-im/send`
- Optional authentication supported: `Authorization: Bearer <token>`

## Compatibility

| Plugin Version | OpenClaw Version | Tag | Status |
|---|---|---|---|
| 2.0.x | >=2026.3.22 | latest | Active |
| 0.1.x | >=2026.1.0 <2026.3.22 | legacy | Maintenance |

The plugin checks the host version at startup and will refuse to load if the
running OpenClaw version is outside the supported range.

- **2.0.x** (>=2026.3.22): uses the runtime-injected `channelRuntime.reply` API for routing, dispatch, and session management
- **1.0.x** (>=2026.1.0 <2026.3.22): uses the legacy `plugin-sdk.dispatchReplyFromConfigWithSettledDispatcher` compatibility path

## Contents

- `whisplay-im/index.js`: OpenClaw channel plugin implementation
- `whisplay-im/openclaw.channel.json`: OpenClaw channel metadata
- `whisplay-im/openclaw.plugin.json`: plugin metadata
- `whisplay-im/SKILL.md`: protocol contract

## Installation

This channel is a JavaScript OpenClaw plugin. No Python runtime is required.

Before installing the plugin, confirm your OpenClaw version:

```bash
openclaw --version
```

If your version is lower than `2026.1.0`, upgrade OpenClaw first.

### 1) Install plugin with OpenClaw CLI

Use `openclaw plugins install` with your local plugin path:

```bash
openclaw plugins install /absolute/path/to/whisplay-im-openclaw-plugin/whisplay-im --link
```

Notes:

- Replace the path with your real absolute path.
- `--link` keeps plugin code linked to your local workspace (good for local development).
- If already installed, uninstall first: `openclaw plugins uninstall whisplay-im --force`.
- If needed, explicitly enable plugin: `openclaw plugins enable whisplay-im`.

### 1.2) Multi-device / multi-account `accounts` example

If you connect multiple Whisplay devices, configure multiple account ids under `channels.whisplay-im.accounts`:

```json
{
	"channels": {
		"whisplay-im": {
			"enabled": true,
			"accounts": {
				"default": {
					"ip": "192.168.1.50:18888",
					"token": "",
					"waitSec": 60
				},
				"home": {
					"ip": "192.168.1.51:18888",
					"token": "home-token",
					"waitSec": 25
				},
				"office": {
					"ip": "10.0.10.20:18888",
					"token": "office-token",
					"waitSec": 20
				}
			}
		}
	}
}
```

Notes:

- `default` is recommended as the primary account id.
- Account ids (`default`, `home`, `office`) become runtime account identifiers in channel status/logs.
- You can use any stable id names; avoid spaces and keep them short.
- No top-level device fallback: every active account must define its own `ip`.

### 2) Configure `openclaw.json`

Use this as a complete example for `~/.openclaw/openclaw.json` (focused on `whisplay-im` related settings):

```json
{
	"channels": {
		"whisplay-im": {
			"enabled": true,
			"accounts": {
				"default": {
					"ip": "192.168.1.50:18888",
					"token": "",
					"waitSec": 60
				}
			}
		}
	}
}
```

### 3) Restart gateway

```bash
openclaw gateway restart
```

### 4) Verify plugin is loaded

```bash
openclaw plugins info whisplay-im
openclaw channels status
```

You should see `Whisplay IM` in configured/running channels.

## Uninstall

### 1) Uninstall plugin

```bash
openclaw plugins uninstall whisplay-im --force
```

### 2) Restart gateway

```bash
openclaw gateway restart
```

### 3) (Optional) Remove channel config

Delete `channels.whisplay-im` from `~/.openclaw/openclaw.json` if you no longer use this channel.

## OpenClaw Page Configuration

Configure channel accounts in `~/.openclaw/openclaw.json` under `channels.whisplay-im.accounts`.

Minimum required structure:

```json
{
	"channels": {
		"whisplay-im": {
			"enabled": true,
			"accounts": {
				"default": {
					"ip": "192.168.1.50:18888"
				}
			}
		}
	}
}
```

Optional per-account fields: `token`, `waitSec` (default `60`), `enabled`.

## Local Debugging

### 1) Poll user messages

```bash
curl -X GET \
	-H "Authorization: Bearer <token>" \
	"http://<device-host>:18888/whisplay-im/poll?waitSec=60"
```

### 2) Send reply messages

```bash
curl -X POST \
	-H "Authorization: Bearer <token>" \
	-H "Content-Type: application/json" \
	-d '{"reply":"Hello, I am OpenClaw","emoji":"🤖"}' \
	"http://<device-host>:18888/whisplay-im/send"
```

## OpenClaw Integration Notes

OpenClaw periodically runs `poll` to fetch the latest user input; after generating a response, it calls `send` to send it back to the Whisplay device.

1. Call `poll`: returns `null` when there is no new message.
2. If a message exists, read the `text` field as user input.
3. After inference, call `send`, put the response in `reply`, and optionally include `emoji`.

## Alignment with SKILL.md

This implementation follows the protocol in `openclaw/skills/whisplay-im/SKILL.md`:

- `GET /whisplay-im/poll?waitSec=<n>`
- `POST /whisplay-im/send`, Body: `{"reply":"...","emoji":"..."}`
- token is optional
