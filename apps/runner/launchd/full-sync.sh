#!/usr/bin/env bash
# Print, install or uninstall the launchd job that runs the weekly full `tallo sync` (Sundays 01:00).
#
#   full-sync.sh            print the rendered plist to stdout (default; changes nothing)
#   full-sync.sh print      same
#   full-sync.sh install    write ~/Library/LaunchAgents/<label>.plist and load it
#   full-sync.sh uninstall  unload the job and remove its plist
#
# Nothing is installed unless you run `install`. Needs pnpm and node on this Mac; the plist pins their absolute
# paths at install time, so re-run `install` after moving or upgrading them. Logs: ~/Library/Logs/tallo/full-sync.log.
set -euo pipefail

LABEL="fyi.nandan.tallo.full-sync"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/$LABEL.plist"
REPO="$(cd "$HERE/../../.." && pwd)"
LOG_DIR="$HOME/Library/Logs/tallo"
LOG_FILE="$LOG_DIR/full-sync.log"
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
  '' | print)
    render
    ;;
  install)
    mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
    render >"$PLIST.tmp"
    plutil -lint "$PLIST.tmp" >/dev/null
    mv "$PLIST.tmp" "$PLIST"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Installed $LABEL (Sundays 01:00). Logs: $LOG_FILE"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL"
    ;;
  *)
    echo "usage: $0 [print|install|uninstall]" >&2
    exit 2
    ;;
esac
