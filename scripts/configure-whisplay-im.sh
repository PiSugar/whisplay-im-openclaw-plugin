#!/usr/bin/env bash

set -euo pipefail

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
ACCOUNT_ID="default"
HOST=""
CREDENTIAL_SET=0
CREDENTIAL_VALUE=""
WAIT_SEC_SET=0
WAIT_SEC_VALUE=""
RESTART_GATEWAY=0

usage() {
    cat <<'EOF'
Usage:
  configure-whisplay-im.sh --host <host[:port]> [options]

Options:
  --host <host[:port]>        Required. Example: 192.168.0.66:18888
  --account <account-id>      Account id under channels.whisplay-im.accounts
                              Default: default
  --credential <token>        Optional bearer token for the device
  --wait-sec <seconds>        Optional poll waitSec value
  --restart                   Restart the OpenClaw gateway after updating config
  --openclaw-bin <path>       Explicit path to the openclaw executable
  -h, --help                  Show this help message

Examples:
  ./scripts/configure-whisplay-im.sh --host 192.168.0.66:18888
  ./scripts/configure-whisplay-im.sh --host 192.168.0.66:18888 --account chatbot-zero --wait-sec 60 --restart
  OPENCLAW_BIN=/home/pi/.npm-global/bin/openclaw ./scripts/configure-whisplay-im.sh --host 192.168.0.66:18888
EOF
}

json_string() {
    node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

set_config() {
    local path="$1"
    local value="$2"
    "$OPENCLAW_BIN" config set "$path" "$value"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --host)
            HOST="${2:-}"
            shift 2
            ;;
        --account)
            ACCOUNT_ID="${2:-}"
            shift 2
            ;;
        --credential)
            CREDENTIAL_SET=1
            CREDENTIAL_VALUE="${2:-}"
            shift 2
            ;;
        --wait-sec)
            WAIT_SEC_SET=1
            WAIT_SEC_VALUE="${2:-}"
            shift 2
            ;;
        --restart)
            RESTART_GATEWAY=1
            shift
            ;;
        --openclaw-bin)
            OPENCLAW_BIN="${2:-}"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [[ -z "$HOST" ]]; then
    echo "--host is required" >&2
    usage >&2
    exit 1
fi

if ! command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
    echo "openclaw executable not found: $OPENCLAW_BIN" >&2
    exit 1
fi

if [[ -z "$ACCOUNT_ID" ]]; then
    echo "--account must not be empty" >&2
    exit 1
fi

if [[ "$WAIT_SEC_SET" -eq 1 ]] && ! [[ "$WAIT_SEC_VALUE" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    echo "--wait-sec must be a number" >&2
    exit 1
fi

ACCOUNT_PATH="channels.whisplay-im.accounts.${ACCOUNT_ID}"

set_config "plugins.entries.whisplay-im.enabled" "true"
set_config "channels.whisplay-im.enabled" "true"
set_config "${ACCOUNT_PATH}.host" "$(json_string "$HOST")"

if [[ "$CREDENTIAL_SET" -eq 1 ]]; then
    set_config "${ACCOUNT_PATH}.credential" "$(json_string "$CREDENTIAL_VALUE")"
fi

if [[ "$WAIT_SEC_SET" -eq 1 ]]; then
    set_config "${ACCOUNT_PATH}.waitSec" "$WAIT_SEC_VALUE"
fi

echo
echo "Configured whisplay-im:"
echo "  openclaw bin: $OPENCLAW_BIN"
echo "  account:      $ACCOUNT_ID"
echo "  host:         $HOST"
if [[ "$CREDENTIAL_SET" -eq 1 ]]; then
    echo "  credential:   [set]"
fi
if [[ "$WAIT_SEC_SET" -eq 1 ]]; then
    echo "  waitSec:      $WAIT_SEC_VALUE"
fi

if [[ "$RESTART_GATEWAY" -eq 1 ]]; then
    echo
    "$OPENCLAW_BIN" gateway restart
fi
