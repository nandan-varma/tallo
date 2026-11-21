#!/usr/bin/env bash
# Export the production D1 catalog to a local directory, with retention.
#
#   backup-d1.sh            print what a backup would do (default; touches nothing, calls nothing)
#   backup-d1.sh run        take a backup now
#
# Why not a plain `wrangler d1 export`: it refuses databases that hold virtual tables, and `jobs_fts` is an FTS5
# table (issue #17). So this lists the real tables, leaves out `jobs_fts*` (the FTS index and its shadow tables)
# and exports only those. The index is derived data: after a restore, apply the migrations and rebuild it with
# `INSERT INTO jobs_fts(jobs_fts) VALUES ('rebuild')`. See docs/runbook.md, "Backup and restore".
#
# Output: $TALLO_BACKUP_DIR/tallo-d1-<UTC stamp>/{tallo.sql.gz,time-travel.json,meta.txt}. A failed run leaves
# no directory behind. The newest $TALLO_BACKUP_KEEP backups are kept; only `tallo-d1-*` directories directly
# under the backup directory are ever pruned.
#
# Env: TALLO_BACKUP_DIR   default ~/Backups/tallo (outside the repo, so it cannot be committed)
#      TALLO_BACKUP_KEEP  default 8
#      TALLO_D1_NAME      default tallo
#      TALLO_WRANGLER     wrangler command, default `pnpm --filter @tallo/api exec wrangler`
# Needs Cloudflare auth for wrangler (CLOUDFLARE_API_TOKEN or a wrangler login). No secret is read or written here.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
DB_NAME="${TALLO_D1_NAME:-tallo}"
BACKUP_ROOT="${TALLO_BACKUP_DIR:-$HOME/Backups/tallo}"
KEEP="${TALLO_BACKUP_KEEP:-8}"

case "$KEEP" in
  '' | *[!0-9]* | 0)
    echo "TALLO_BACKUP_KEEP must be a whole number of at least 1" >&2
    exit 2
    ;;
esac

if [ -n "${TALLO_WRANGLER:-}" ]; then
  WRANGLER=("$TALLO_WRANGLER")
else
  WRANGLER=(pnpm --filter @tallo/api exec wrangler)
fi

# Real tables only: no FTS index or shadow tables, no SQLite or Cloudflare internals.
TABLES_SQL="SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'jobs\\_fts%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name"

plan() {
  cat <<PLAN
Dry run. Nothing was called or written. Run '$0 run' to back up.
  database       $DB_NAME (remote)
  destination    $BACKUP_ROOT/tallo-d1-<UTC stamp>/
  retention      newest $KEEP backups
  steps
    1. ${WRANGLER[*]} d1 execute $DB_NAME --remote --json --command "<list tables, excluding jobs_fts*>"
    2. ${WRANGLER[*]} d1 export $DB_NAME --remote --output <tmp>/tallo.sql --table <each table>
    3. ${WRANGLER[*]} d1 time-travel info $DB_NAME --json    (restore bookmark, recorded alongside)
    4. gzip, move into place, prune older backups
PLAN
}

run() {
  local stamp work dest tables name
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dest="$BACKUP_ROOT/tallo-d1-$stamp"
  if [ -e "$dest" ]; then
    echo "$dest already exists; try again in a second" >&2
    exit 1
  fi
  mkdir -p "$BACKUP_ROOT"
  work="$(mktemp -d "$BACKUP_ROOT/.tallo-d1-$stamp.XXXXXX")"
  # A failed run must leave nothing behind; a finished run has already moved $work to $dest.
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT

  cd "$REPO"
  # Read-only listing. Node parses the JSON so the script needs no jq.
  tables="$("${WRANGLER[@]}" d1 execute "$DB_NAME" --remote --json --command "$TABLES_SQL" \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{for(const r of JSON.parse(s)[0].results)console.log(r.name)})')"
  [ -n "$tables" ] || { echo "no tables listed; refusing to write an empty backup" >&2; exit 1; }

  local args=()
  while IFS= read -r name; do
    case "$name" in
      *[!A-Za-z0-9_]* | '')
        echo "unexpected table name: $name" >&2
        exit 1
        ;;
    esac
    args+=(--table "$name")
  done <<<"$tables"

  "${WRANGLER[@]}" d1 export "$DB_NAME" --remote --output "$work/tallo.sql" "${args[@]}"
  grep -q '^CREATE TABLE' "$work/tallo.sql" || { echo "export has no CREATE TABLE; refusing to keep it" >&2; exit 1; }
  gzip -9 "$work/tallo.sql"
  "${WRANGLER[@]}" d1 time-travel info "$DB_NAME" --json >"$work/time-travel.json"
  {
    echo "created_utc=$stamp"
    echo "database=$DB_NAME"
    echo "tables=$(echo "$tables" | tr '\n' ' ')"
    echo "excluded=jobs_fts* (FTS5; rebuild after restore)"
  } >"$work/meta.txt"

  mv "$work" "$dest"
  trap - EXIT
  echo "backup written: $dest"

  # Names sort by UTC stamp, so reverse order is newest first. -type d never matches a symlink.
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'tallo-d1-*' | sort -r | tail -n +"$((KEEP + 1))" \
    | while IFS= read -r old; do
      rm -rf "$old"
      echo "pruned: $old"
    done
}

case "${1:-}" in
  '' | print) plan ;;
  run) run ;;
  *)
    echo "usage: $0 [print|run]" >&2
    exit 2
    ;;
esac
