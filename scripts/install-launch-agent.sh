#!/bin/zsh
set -euo pipefail

LABEL="com.jessmartin.slack-thread-monitor"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${ROOT_DIR}/logs"
OUT_LOG="${LOG_DIR}/launchd.out.log"
ERR_LOG="${LOG_DIR}/launchd.err.log"
UID_VALUE="$(id -u)"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf "%s" "$value"
}

shell_quote() {
  printf "%q" "$1"
}

mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"

ROOT_DIR_QUOTED="$(shell_quote "$ROOT_DIR")"
START_COMMAND="cd ${ROOT_DIR_QUOTED} && export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin && if [ ! -f .env ]; then echo \"Missing ${ROOT_DIR}/.env. Create it before starting Slack Thread Monitor.\" >&2; exit 78; fi && exec npm run dev"
START_COMMAND_XML="$(xml_escape "$START_COMMAND")"
OUT_LOG_XML="$(xml_escape "$OUT_LOG")"
ERR_LOG_XML="$(xml_escape "$ERR_LOG")"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${START_COMMAND_XML}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${OUT_LOG_XML}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG_XML}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST

/bin/launchctl bootout "gui/${UID_VALUE}/${LABEL}" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/${UID_VALUE}" "$PLIST_PATH"
/bin/launchctl enable "gui/${UID_VALUE}/${LABEL}"
/bin/launchctl kickstart -k "gui/${UID_VALUE}/${LABEL}"

echo "Installed and started ${LABEL}"
echo "Plist: ${PLIST_PATH}"
echo "Logs: ${OUT_LOG} ${ERR_LOG}"
