#!/usr/bin/env bash
# Install, uninstall or print the launchd job that runs `tallo sync --local-egress` daily at 03:30.
#
#   local-egress.sh print       render the plist to stdout (changes nothing)
#   local-egress.sh install     write ~/Library/LaunchAgents/<label>.plist and load it
#   local-egress.sh uninstall   unload the job and remove its plist
#
# Needs pnpm and node on this Mac. The plist pins their absolute paths at install time, so re-run
# `install` after moving or upgrading node or pnpm. Logs go to ~/Library/Logs/tallo/local-egress.log.
set -euo pipefail

LABEL="fyi.nandan.tallo.local-egress"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/$LABEL.plist"
REPO="$(cd "$HERE/../../.." && pwd)"
LOG_DIR="$HOME/Library/Logs/tallo"
LOG_FILE="$LOG_DIR/local-egress.log"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

render() {
  local pnpm node_dir pnpm_dir path
  pnpm="$(command -v pnpm || true)"
  [ -n "$pnpm" ] || { echo "pnpm not found on PATH; install it first" >&2; exit 1; }
  node_dir="$(dirname "$(command -v node || echo /usr/local/bin/node)")"
  pnpm_dir="$(dirname "$pnpm")"
  path="$node_dir:$pnpm_dir:/usr/local/bin:/usr/bin:/bin"
  sed \
    -e "s|__PNPM__|$pnpm|g" \
    -e "s|__REPO__|$REPO|g" \
    -e "s|__PATH__|$path|g" \
    -e "s|__LOG__|$LOG_FILE|g" \
    "$TEMPLATE"
}

case "${1:-}" in
  print)
    render
    ;;
  install)
    mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
    render >"$PLIST.tmp"
    plutil -lint "$PLIST.tmp" >/dev/null
    mv "$PLIST.tmp" "$PLIST"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Installed $LABEL (daily 03:30). Logs: $LOG_FILE"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL"
    ;;
  *)
    echo "usage: $0 print|install|uninstall" >&2
    exit 2
    ;;
esac
