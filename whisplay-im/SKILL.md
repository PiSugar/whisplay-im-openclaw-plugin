---
name: whisplay-im
description: HTTP bridge in Whisplay device for IM-style chat.
metadata:
  openclaw:
    emoji: "🤖"
    os:
      - linux
      - darwin
    requires:
      bins:
        - curl
---

# whisplay-im Bridge

## Overview

Use `whisplay-im` to connect OpenClaw to a Whisplay device as a pure IM bridge.
The device pushes ASR text into the bridge. OpenClaw polls for new messages and sends replies back for TTS playback.

## Inputs to collect

- Bridge base URL (host/port)
- Auth token for `Authorization: Bearer <token>` (optional)
- `waitSec` for long-polling (optional)

## Actions

### Poll for a new message

```bash
curl -X GET \
  -H "Authorization: Bearer <token>" \
  "http://<device-host>:18888/whisplay-im/poll?waitSec=30"
```

### Send reply to device

```bash
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reply":"Hello from OpenClaw","emoji":"🦞"}' \
  http://<device-host>:18888/whisplay-im/send
```

### Send reply with image to device

```bash
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reply":"Here is what I made","emoji":"🎨","imageBase64":"data:image/png;base64,iVBOR..."}' \
  http://<device-host>:18888/whisplay-im/send
```

### Send agent status to device

```bash
# Show thinking status
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"status":"thinking","emoji":"🤔","text":"Processing..."}' \
  http://<device-host>:18888/whisplay-im/status

# Show tool calling status
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"status":"tool_calling","emoji":"🔧","tool":"generateImage","text":"Generating image..."}' \
  http://<device-host>:18888/whisplay-im/status
```

## Notes

- `poll` returns an empty payload when no message is available.
- `send` supports optional `emoji` and `imageBase64`.
- `status` pushes live agent state (thinking, tool_calling, answering, idle) to the device display.
- Image messages from the device include `imageBase64` in the poll response.
- All images are transmitted as base64 data URLs.
