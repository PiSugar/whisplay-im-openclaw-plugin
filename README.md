# whisplay-im OpenClaw Channel

`whisplay-im` is an IM channel adapter for OpenClaw, used to integrate with the Whisplay Chatbot device bridge interface.

- OpenClaw pulls user messages: `GET /whisplay-im/poll`
- OpenClaw sends reply messages: `POST /whisplay-im/send`
- Optional authentication supported: `Authorization: Bearer <credential>`

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
- Local/workspace plugins may stay disabled by default on newer OpenClaw builds until explicitly enabled.
- After install, run `openclaw plugins enable whisplay-im` or set `plugins.entries.whisplay-im.enabled: true` in `~/.openclaw/openclaw.json`.
- `openclaw plugins install` does not auto-create `channels.whisplay-im`; use the helper script below to write the channel config safely.

### 1.1) Apply channel config with helper script

After installation, run the helper script once per device/account you want to configure:

```bash
./scripts/configure-whisplay-im.sh --host 192.168.0.66:18888 --account chatbot-zero --wait-sec 60 --restart
```

Notes:

- The script writes `plugins.entries.whisplay-im.enabled = true`.
- The script writes `channels.whisplay-im.enabled = true`.
- The script writes `channels.whisplay-im.accounts.<account-id>.*`.
- Set `OPENCLAW_BIN` if your active OpenClaw executable is not on `PATH`, for example:

```bash
OPENCLAW_BIN=/home/pi/.npm-global/bin/openclaw \
./scripts/configure-whisplay-im.sh --host 192.168.0.66:18888 --account chatbot-zero --restart
```

### 1.2) Multi-device / multi-account `accounts` example

If you connect multiple Whisplay devices, configure multiple account ids under `channels.whisplay-im.accounts`:

```json
{
	"plugins": {
		"entries": {
			"whisplay-im": {
				"enabled": true
			}
		}
	},
	"channels": {
		"whisplay-im": {
			"enabled": true,
			"accounts": {
				"default": {
					"host": "192.168.1.50:18888",
					"credential": "",
					"waitSec": 60
				},
				"home": {
					"host": "192.168.1.51:18888",
					"credential": "home-token",
					"waitSec": 25
				},
				"office": {
					"host": "10.0.10.20:18888",
					"credential": "office-token",
					"waitSec": 20
				}
			}
		}
	}
}
```

If you use `plugins.allow`, add `whisplay-im` there too or OpenClaw will silently refuse to load this plugin:

```json
{
	"plugins": {
		"allow": ["whisplay-im"],
		"entries": {
			"whisplay-im": {
				"enabled": true
			}
		}
	}
}
```

Notes:

- `default` is recommended as the primary account id.
- Account ids (`default`, `home`, `office`) become runtime account identifiers in channel status/logs.
- You can use any stable id names; avoid spaces and keep them short.
- No top-level device fallback: every active account must define its own `host`.

### 2) Configure `openclaw.json`

Use this as a complete example for `~/.openclaw/openclaw.json` (focused on `whisplay-im` related settings):

```json
{
	"channels": {
		"whisplay-im": {
			"enabled": true,
			"accounts": {
				"default": {
					"host": "192.168.1.50:18888",
					"credential": "",
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

If you used `./scripts/configure-whisplay-im.sh --restart`, you can skip this manual restart.

### 4) Verify plugin is loaded

```bash
openclaw plugins info whisplay-im
openclaw channels status
```

You should see `Whisplay IM` in configured/running channels.

If `openclaw plugins info whisplay-im` works but `openclaw channels status` does not show the channel, check these first:

- `plugins.entries.whisplay-im.enabled` is `true`
- `plugins.allow` is absent, empty, or includes `whisplay-im`
- `channels.whisplay-im.accounts.<account-id>.host` exists
- the gateway was restarted after install or enablement

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
					"host": "192.168.1.50:18888"
				}
			}
		}
	}
}
```

Optional per-account fields: `credential`, `waitSec` (default `60`), `enabled`.

## Local Debugging

### 1) Poll user messages

```bash
curl -X GET \
	-H "Authorization: Bearer <credential>" \
	"http://<device-host>:18888/whisplay-im/poll?waitSec=60"
```

### 2) Send reply messages

```bash
curl -X POST \
	-H "Authorization: Bearer <credential>" \
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
- credential is optional
