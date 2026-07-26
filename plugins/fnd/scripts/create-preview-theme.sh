#!/usr/bin/env bash
#
# create-preview-theme.sh — build an unpublished Shopify PREVIEW theme for the fnd
# `create-pull-request` / `create-preview-theme` skills.
#
# MODEL: a preview = YOUR branch's CODE (built locally) + the dev theme's CUSTOMIZER
# SETTINGS. Code always comes from the local repo (so fixes in the branch show up);
# only the customizer content is copied from the configured dev theme. This avoids
# cloning stale/broken code that happens to live on the dev theme.
#
# "Settings" preserved from the dev theme (everything else is code, from the repo):
#   - config/settings_data.json      (theme settings)
#   - templates/**/*.json            (per-template section config)
#   - sections/*.json                (section groups: header/footer/etc.)
#
# WHY a script (not a subagent): deterministic, and the Theme Access token lives in
# shopify.theme.toml. This reads the token straight into the `shopify` subprocess so it
# NEVER enters Claude's context and is never printed. The calling skill must NOT read
# shopify.theme.toml itself.
#
# Config source (project root, or $TOML_PATH): shopify.theme.toml
#   - dev theme id : the UNCOMMENTED `theme = "..."` line, digits (commented variants ignored)
#   - store        : the UNCOMMENTED `store = "..."` line, a myshopify handle, full domain or https:// URL
#   - token        : `password = "..."`, else first shp*_… in the file, else $SHOPIFY_CLI_THEME_TOKEN
#                    (the repo's own credential wins — an env token exported for another project
#                    would authenticate this repo's pushes against that store)
#   Values may be double-quoted, single-quoted or bare; a malformed store/theme id is a hard stop
#   (it would otherwise reach the CLI and target the wrong store, or orphan a created theme).
#   NB: the FIRST uncommented match wins — in a multi-environment toml ([environments.*])
#   that is the first environment listed; point TOML_PATH at a single-env file to override.
#
# Subcommands:
#   info
#       → store=… dev_theme_id=… dev_theme_name=…                       (no mutation)
#   create --name "<NAME>" [--reuse] [--no-build] [--build-cmd "<cmd>"] [--ignore-extra "<glob>"]
#       → build repo → push code (settings ignored) to a new unpublished theme
#         (or an existing same-named one with --reuse) → overlay dev-theme settings
#       → theme_id=… name=… store=… preview_url=… editor_url=… reused=… built=…
#   refresh --theme <ID> [--no-build] [--build-cmd "<cmd>"] [--ignore-extra "<glob>"]
#       → build repo → push CODE ONLY to <ID>, leaving its customizer settings intact
#         (reuse this when a preview theme's code broke and needs a redeploy)
#       → theme_id=… store=… preview_url=… editor_url=… built=…
#
#   --ignore-extra "<glob>"  (create & refresh, repeatable) — extra `--ignore` pattern passed
#       through to `shopify theme push`, for a file inside a theme dir that must not ship.
#
# Output is `key=value` lines on stdout. Errors print `error=<reason>` and exit non-zero.
# Requires: shopify CLI, jq; npm for the default build.

set -euo pipefail

TOML="${TOML_PATH:-shopify.theme.toml}"

# Customizer content copied from the dev theme; everything else is code from the repo.
SETTINGS_PATTERNS=(
  "config/settings_data.json"
  "templates/*.json"
  "templates/**/*.json"
  "sections/*.json"
)

# Canonical Shopify theme directories. We assemble ONLY these into a clean temp dir and
# push that (never `--path .`), so non-theme paths in the repo (multi-brand build sources,
# tmp/ artifacts, metaobjects-def.json, src/, schemas/, node_modules/, …) are physically
# absent from the push root. This is stricter than `--only` globs: Shopify's matcher is
# loose (e.g. `--only "snippets/**"` also re-captures nested multi-brand/**/snippets/*),
# so a whitelist glob leaks; a clean directory cannot. Repo-agnostic, no .shopifyignore
# dependency. Without this the CLI crashes parsing the API's rejection of an invalid asset.
THEME_DIRS=( assets blocks config layout locales sections snippets templates )

fail() { printf 'error=%s\n' "$1"; exit 1; }
# a flag that takes a value must not be the last arg — a bare `shift 2` past the end of $@
# kills the whole script silently under `set -e`, with no error= line for the caller
need_val() { [ "$1" -ge 2 ] || fail "missing value for $2"; }

command -v shopify >/dev/null 2>&1 || fail "shopify CLI not found on PATH"
command -v jq >/dev/null 2>&1 || fail "jq not found on PATH (install: brew install jq)"
[ -f "$TOML" ] || fail "config not found: $TOML (run from the project root, or set TOML_PATH)"

# --- parse shopify.theme.toml (token is read but NEVER printed) ---------------
# TOML scalar reader: handles "…" / '…' / bare values, drops a trailing comment only OUTSIDE quotes,
# tolerates CRLF. All three shapes occur in real shopify.theme.toml files, and a `"`-only sed
# (`s/^[^"]*"([^"]*)".*/\1/`) silently returns the WHOLE LINE for the other two — the store then
# reaches the CLI as `store = 'x'` and a single-quoted password= is exported as the access token.
# Byte-identical copies live in theme-json.sh and shopify-admin-gql.sh — the plugin installs by git
# clone, so every script stands alone; keep the three in sync.
toml_value() { # $1 = key, first uncommented value to stdout (empty when absent)
  [ -f "$TOML" ] || return 0
  awk -v k="$1" '
    BEGIN { SQ = "\047" }
    /^[ \t]*#/ { next }
    $0 ~ "^[ \t]*" k "[ \t]*=" {
      v = $0
      sub("^[ \t]*" k "[ \t]*=[ \t]*", "", v)
      q = substr(v, 1, 1)
      if (q == "\"" || q == SQ) {
        v = substr(v, 2)
        p = index(v, q)
        if (p > 0) v = substr(v, 1, p - 1)
      } else {
        h = index(v, "#"); if (h > 0) v = substr(v, 1, h - 1)
        sub(/[ \t\r]+$/, "", v)
      }
      print v; exit
    }
  ' "$TOML" 2>/dev/null
}

DEV_THEME_ID="$(toml_value theme || true)"
STORE="$(toml_value store || true)"
# The project's own credential wins: a $SHOPIFY_CLI_THEME_TOKEN exported for ANOTHER project (a common
# `theme dev` habit) would otherwise authenticate this repo's pushes against that store and die as an
# opaque CLI 401 naming neither source. The env var is the last resort — which is also the escape
# hatch for a token this file cannot supply, since a password= that is not token-shaped is not a
# token and falls through to the file-wide scan.
TOKEN="$(toml_value password || true)"
case "$TOKEN" in shp[a-z]*_[A-Za-z0-9]*) ;; *) TOKEN="" ;; esac
[ -n "$TOKEN" ] || TOKEN="$(grep -oE 'shp[a-z]+_[A-Za-z0-9]+' "$TOML" | head -1 || true)"
[ -n "$TOKEN" ] || TOKEN="${SHOPIFY_CLI_THEME_TOKEN:-}"

[ -n "${DEV_THEME_ID:-}" ] || fail "no uncommented \`theme = \"...\"\` line in $TOML"
[ -n "${STORE:-}" ]        || fail "no uncommented \`store = \"...\"\` line in $TOML"
[ -n "${TOKEN:-}" ]        || fail "no access token (password / shp*_… in $TOML, or \$SHOPIFY_CLI_THEME_TOKEN)"

# `shopify --store` documents the full URL form as valid and real tomls carry it — strip the scheme
# instead of refusing a supported config.
STORE="${STORE#http://}"; STORE="${STORE#https://}"; STORE="${STORE%/}"

# A value that cannot be what it claims to be is a typo or a mis-parse, and handing it to the CLI is
# an opaque failure at best and the WRONG STORE at worst. A malformed dev theme id is the nastier
# one: the code push does not use it, so a theme IS created, and only the settings pull fails —
# which is how a run ends up reporting a pull error while an orphan theme burns a slot on the store.
case "$DEV_THEME_ID" in *[!0-9]*)
  fail "invalid_dev_theme_id id='$DEV_THEME_ID' (expected digits — check the \`theme =\` line in $TOML)" ;;
esac
case "$STORE" in ''|*[!A-Za-z0-9.-]*)
  fail "invalid_store store='$STORE' (expected a myshopify handle, <handle>.myshopify.com or its https:// URL — check the \`store =\` line in $TOML)" ;;
esac

export SHOPIFY_CLI_THEME_TOKEN="$TOKEN"   # consumed by `shopify`; never echoed

# --- helpers ------------------------------------------------------------------
# Build flag arrays portably (bash 3.2 on macOS has no mapfile).
IGN=(); for p in "${SETTINGS_PATTERNS[@]}"; do IGN+=(--ignore "$p"); done   # settings to skip on code push
ONLY=(); for p in "${SETTINGS_PATTERNS[@]}"; do ONLY+=(--only "$p"); done   # settings-only, for the overlay
EXTRA_IGN=()   # extra --ignore patterns passed through from the CLI (--ignore-extra)

# Every temp path is built from an explicit $TMPDIR template: BSD `mktemp` (macOS) IGNORES $TMPDIR
# without one, so a caller — and the test that asserts nothing is left behind — cannot otherwise
# isolate a run. The bare form stays as a fallback for an unusable $TMPDIR.
TMPROOT="${TMPDIR:-/tmp}"; TMPROOT="${TMPROOT%/}"
mk_tmpd() { mktemp -d "$TMPROOT/fnd-cpt.XXXXXX" 2>/dev/null || mktemp -d; }
mk_tmpf() { mktemp "$TMPROOT/fnd-cpt.XXXXXX" 2>/dev/null || mktemp; }

# Temp dirs to clean up on exit (registered as they're created).
CLEAN_DIRS=()
PULL_PID=""; PULL_DIR=""; PULL_ERR=""
cleanup() {
  # An early exit (build/code-push failure) must not leave the backgrounded settings pull writing
  # into a directory we are about to delete. A still-uncollected pull also means its stderr log was
  # never reported to anyone, so that temp file goes too — reported logs must survive the exit.
  # The `wait` both reaps the job before the rm -rf below can race its last writes and swallows the
  # shell's own "Terminated: 15" job report, which bash writes to stderr for any signalled job and
  # which the caller would read as script output. Both redirections are load-bearing. SIGKILL follows
  # SIGTERM immediately and unconditionally: a CLI that traps TERM (oclif does) would otherwise hold
  # this `wait` — and with it the caller, which blocks on process exit — for the whole remaining pull,
  # long after `error=build_failed` was printed. The pull writes only into a dir we are deleting, so
  # there is nothing for a graceful unwind to save.
  if [ -n "${PULL_PID:-}" ]; then
    { kill "$PULL_PID" 2>/dev/null; kill -9 "$PULL_PID" 2>/dev/null; wait "$PULL_PID" 2>/dev/null; } 2>/dev/null || true
    rm -f "${PULL_ERR:-}"
  fi
  for d in ${CLEAN_DIRS[@]+"${CLEAN_DIRS[@]}"}; do rm -rf "$d"; done
  return 0
}
trap cleanup EXIT

# Assemble a clean push root containing only the canonical theme dirs (post-build).
# Uses APFS clonefile (cp -Rc, instant/zero-copy) with a plain-copy fallback. Echoes the
# temp path; the caller registers it for cleanup. The repo's .shopifyignore is carried
# along so any intentional excludes still apply.
assemble_theme() {
  local dest d; dest="$(mk_tmpd)"
  for d in "${THEME_DIRS[@]}"; do
    if [ -e "$d" ]; then cp -Rc "$d" "$dest/" 2>/dev/null || cp -R "$d" "$dest/"; fi
  done
  # Carry .shopifyignore so intentional excludes still apply — BUT strip its locale-ignore
  # lines. Repos commonly `locales/*.json` (+ `!` negations) so routine deploys don't clobber
  # a one-time seed; on a freshly created/seeded preview theme that leaves NO locale files, so
  # the storefront/admin shows "Translation missing" everywhere (the CLI may not honour the `!`
  # negations). Dropping the locale lines makes the branch's locales always ship. Other excludes
  # (settings_data, templates, section groups) stay — we also guard those via --ignore + overlay.
  if [ -f .shopifyignore ]; then grep -vE 'locales/' .shopifyignore > "$dest/.shopifyignore" 2>/dev/null || true; fi
  printf '%s' "$dest"
}

# One `theme list` call per run, shared by the name / id / role lookups below (each of those runs in a
# command substitution, i.e. a subshell, so the cache only survives if load_theme_list is called from
# the PARENT shell first — every call site does).
THEME_LIST=""; THEME_LIST_LOADED=0; THEME_LIST_OK=0; THEME_LIST_SILENT=1
load_theme_list() {
  [ "$THEME_LIST_LOADED" -eq 1 ] && return 0
  THEME_LIST_LOADED=1
  local raw
  raw="$(shopify theme list --store "$STORE" --json --no-color 2>/dev/null || true)"
  [ -z "$raw" ] || THEME_LIST_SILENT=0
  # The CLI can print a deprecation/upgrade banner before the JSON, and a banner is enough to make jq
  # fail on the whole document — which would leave every lookup below (the live-theme guard included)
  # blind. Drop every byte before the first `[`/`{` — BYTE-anchored, not line-anchored, because a
  # spinner artifact or stray ANSI can share the JSON's own line (--no-color trims most of it, the cut
  # handles the rest). Then record whether what remains actually parses: a listing the callers cannot
  # read is UNKNOWN, never "not the live theme".
  THEME_LIST="$(printf '%s' "$raw" | awk 'f{print;next} match($0,/[[{]/){print substr($0,RSTART);f=1}')"
  [ -n "$THEME_LIST" ] && printf '%s' "$THEME_LIST" | jq empty >/dev/null 2>&1 && THEME_LIST_OK=1
  return 0
}
# 1 = the CLI answered but nothing parseable came out. A SILENT call (the listing failed) is not this
# case and must stay non-fatal — a listing outage cannot be allowed to brick every preview refresh.
theme_list_unreadable() { [ "$THEME_LIST_SILENT" -eq 0 ] && [ "$THEME_LIST_OK" -ne 1 ]; }
theme_name_by_id() {
  load_theme_list
  printf '%s' "$THEME_LIST" | jq -r --arg id "$1" '.. | objects | select((.id|tostring)==$id) | .name' 2>/dev/null \
    | head -1 || true
}
theme_role_by_id() {
  # `// empty` so an object that matches the id but has no role yields NOTHING — a printed literal
  # `null` would satisfy neither guard branch in assert_not_live and silently clear the target
  load_theme_list
  printf '%s' "$THEME_LIST" | jq -r --arg id "$1" '.. | objects | select((.id|tostring)==$id) | .role // empty' 2>/dev/null \
    | head -1 || true
}
theme_found_by_id() { # 0 = the parsed listing contains an object with this id
  load_theme_list
  printf '%s' "$THEME_LIST" | jq -e --arg id "$1" 'any(.. | objects; (.id|tostring)==$id)' >/dev/null 2>&1
}
# Every id matching the name — Shopify allows duplicate theme names, so a single `head -1` here silently
# picked whichever theme the API happened to list first and the push target flipped between runs.
theme_ids_by_name() {
  load_theme_list
  printf '%s' "$THEME_LIST" | jq -r --arg n "$1" '.. | objects | select(.name==$n) | .id' 2>/dev/null || true
}

# Never write to the PUBLISHED theme: a mistyped `refresh --theme <id>` or a `--reuse` name colliding
# with the live theme would push branch code (and then the dev theme's settings) onto the storefront.
# An EMPTY listing (the call failed) leaves the role unknown and the write proceeds, so a listing
# outage cannot brick the script — but a listing that came back and cannot be read is refused rather
# than waved through: that is the one input shape where "no role matched" means nothing. The CLI spells
# the role lowercase (`live`); `main` is accepted too so a spelling change cannot silently disarm this.
assert_not_live() { # $1 = target theme id
  local role
  role="$(theme_role_by_id "$1" | tr 'A-Z' 'a-z')"
  case "$role" in
    live|main)
      fail "live_theme_write_refused theme=$1 role=$role name=$(theme_name_by_id "$1") — that is the PUBLISHED theme; pass an unpublished/preview theme id" ;;
  esac
  if [ -z "$role" ] && theme_list_unreadable; then
    fail "cli_list_unreadable theme=$1 — \`shopify theme list --json\` returned output that is not JSON, so the live-theme guard cannot clear this target; check \`shopify theme list\` by hand and re-run"
  fi
  # id present in a listing we CAN read, but no role on it — a list-shape drift (role renamed/moved)
  # would otherwise clear every target, the published theme included. An id ABSENT from the listing
  # stays non-fatal like the silent-listing case: absence is what a fresh/paginated-away theme looks
  # like, and pre-existing behavior let it through.
  if [ -z "$role" ] && theme_found_by_id "$1"; then
    fail "live_role_unreadable theme=$1 — the theme is in \`shopify theme list --json\` but carries no readable role, so the live-theme guard cannot clear it; check the listing by hand and re-run"
  fi
  return 0
}
# Tolerant: `2>/dev/null` swallows jq parse errors (load_theme_list decides what an unparseable
# listing means), and `|| true` neutralizes a no-match / SIGPIPE pipeline status so a
# bare `VAR=$(json_field …)` can't abort the script under `set -e` (the `[ -n "$THEME_ID" ]`
# guard after the code push handles an empty result instead). NB: a `first(.. | objects | .[$f]?)` rewrite is WRONG — it returns
# empty for the wrapping object — so keep the `| head -1` form.
json_field() { printf '%s' "$1" | jq -r --arg f "$2" '.. | objects | .[$f]? // empty' 2>/dev/null | head -1 || true; }

# Report a push failure with the REAL cause, not a truncated trace. Keeps the full
# stderr log (in $ERR) and points to it, plus shows the last 25 lines inline. Shopify
# crashes ("undefined method 'dig' for nil") when an invalid asset is rejected — the
# offending file is named a few lines above the ruby trace, so show enough context.
push_fail() {
  printf 'error=%s\n' "$1"
  printf 'log=%s\n' "$ERR"
  printf -- '--- last 25 lines of shopify stderr ---\n'
  tail -n 25 "$ERR"
  exit 1
}

# The settings pull needs only the dev theme id, which is known before the build — so run it in the
# BACKGROUND and collect it in overlay_settings, where it overlaps the (usually far longer) npm build
# and the code push. Nothing before overlay_settings may `wait` for it: the error PRECEDENCE
# build_failed → push_code_failed/theme_limit → overlay pull/push is a caller-visible contract, and
# waiting earlier would let a pull failure jump the queue.
start_settings_pull() {
  PULL_DIR="$(mk_tmpd)"; CLEAN_DIRS+=("$PULL_DIR")
  PULL_ERR="$(mk_tmpf)"
  # </dev/null: a background job inherits the script's stdin, so a CLI that decided to prompt would
  # both steal it and hang the `wait` invisibly — fail fast instead.
  shopify theme pull --store "$STORE" --theme "$DEV_THEME_ID" --path "$PULL_DIR" "${ONLY[@]}" --nodelete \
    </dev/null >/dev/null 2>"$PULL_ERR" &
  PULL_PID=$!
  return 0
}

# first non-blank line, for a stderr whose wording no pattern recognized
first_line() { grep -v '^[[:space:]]*$' "$1" | head -1 | sed -E 's/^[[:space:]]*//' || true; }

# Report a failed overlay so the caller can act on it, and never leave a theme behind that only this
# run knows about. Deleting FIRST keeps the cleanup independent of the best-effort cause extraction
# at the call sites: a no-match grep in a bare `reason=$(…)` assignment aborts the script under
# `set -euo pipefail` before both the delete and the report, silently orphaning the new theme.
# A --reuse target pre-existed, so it is never deleted — but it now carries this branch's code with
# unmatched settings, and that mixed state has to be said out loud.
overlay_fail() { # $1 = error code, $2 = target theme, $3 = reused, $4 = stderr log, $5 = cause (may be empty)
  local deleted="no"
  if [ "$3" != "true" ]; then
    if shopify theme delete --store "$STORE" --theme "$2" --force >/dev/null 2>&1; then deleted="yes"; else deleted="failed"; fi
  fi
  printf 'error=%s\n' "$1"
  printf 'cause=%s\n' "${5:-see the shopify stderr below}"
  printf 'dev_theme_id=%s\n' "$DEV_THEME_ID"
  # `created_theme=` is a claim about a theme THIS RUN created, and a reader acts on
  # `created_theme_deleted=no` by cleaning an orphan up — so a pre-existing --reuse target is reported
  # under its own key instead
  if [ "$3" = "true" ]; then
    printf 'theme=%s\n' "$2"
    printf 'reused=true\n'
    printf 'mixed_state=theme %s has THIS branch code but its settings are the pre-existing/partial ones — not a faithful preview until the overlay succeeds\n' "$2"
  else
    printf 'created_theme=%s\n' "$2"
    printf 'created_theme_deleted=%s\n' "$deleted"
  fi
  printf 'log=%s\n' "$4"
  printf -- '--- last 25 lines of shopify stderr ---\n'
  tail -n 25 "$4"
  exit 1
}

# Apply the dev theme's customizer settings onto $1 (target theme id), collecting the backgrounded
# pull on the way in.
#   $2 = "true" if the theme pre-existed (--reuse), else we created it this run.
# Three outcomes, and the caller acts differently on each: applied (return 0); DRIFT — the dev theme
# is "ahead" of this branch (e.g. its templates/product.json references a block type whose schema
# lives only in another feature branch) so Shopify rejects that template, and since a partial overlay
# would give a misleading preview the only fix is duplicating the dev theme MANUALLY in the admin (a
# server-side copy keeps even drifted settings); anything else — a transient/auth failure that is
# simply worth retrying. stderr is captured, never swallowed.
overlay_settings() {
  local target="$1" reused="$2" tmp perr reason prc
  [ -n "$PULL_PID" ] || start_settings_pull
  prc=0; wait "$PULL_PID" || prc=$?
  # collected: cleanup() must not kill a recycled pid, and the log below outlives this process
  PULL_PID=""
  tmp="$PULL_DIR"; perr="$PULL_ERR"
  # ANY non-zero status is a failed pull (127 = already reaped included) — a backgrounded failure
  # must never read as a silent success. The overlay never ran, so the theme we created this run is
  # code-only: delete it and name it, or the caller cannot even tell which theme burns a slot.
  if [ "$prc" -ne 0 ]; then
    reason="$(grep -iE 'error|does not exist|forbidden|denied' "$perr" | head -1 | sed -E 's/^[[:space:]]*//' || true)"
    [ -n "$reason" ] || reason="$(first_line "$perr")"
    overlay_fail overlay_pull_failed "$target" "$reused" "$perr" "$reason"
  fi
  if shopify theme push --store "$STORE" --theme "$target" --path "$tmp" --nodelete "${ONLY[@]}" >/dev/null 2>"$perr"; then
    rm -f "$perr"; return 0   # no drift — settings applied
  fi
  # Only real DRIFT (Shopify rejecting a setting whose code is missing from this branch) justifies the
  # manual-duplication verdict, so it is gated on the drift wording; a 503, a socket hang-up or an
  # auth rejection is a transient failure to RETRY and gets its own code. A bare `invalid` alternative
  # would match "Invalid API key or access token" — the highest-confidence possible misdiagnosis,
  # sending the developer to duplicate a theme by hand over an expired token.
  reason="$(grep -iE 'must be defined|invalid value|invalid setting|could not be synced|invalid (section|block|schema|type)|(section|block|schema|type) [^ ]+ does not exist' "$perr" | head -1 | sed -E 's/^[[:space:]]*//' || true)"
  if [ -n "$reason" ]; then
    overlay_fail settings_drift "$target" "$reused" "$perr" "$reason"
  fi
  # cause= is the machine-readable field the caller acts on — it must never stay a placeholder while
  # the real diagnostic sits in the log, so an unrecognized wording falls back to the first line
  reason="$(grep -iE 'error|fail|invalid|denied' "$perr" | head -1 | sed -E 's/^[[:space:]]*//' || true)"
  [ -n "$reason" ] || reason="$(first_line "$perr")"
  overlay_fail overlay_push_failed "$target" "$reused" "$perr" "$reason"
}

NO_BUILD=0
BUILD_CMD="npm run build"
BUILT="no"
run_build() {
  [ "$NO_BUILD" -eq 1 ] && { BUILT="skipped"; return 0; }
  local log; log="$(mk_tmpf)"
  if ( eval "$BUILD_CMD" ) >"$log" 2>&1; then
    BUILT="yes"; rm -f "$log"
  else
    printf 'error=build_failed (%s):\n' "$BUILD_CMD"; tail -n 5 "$log"; rm -f "$log"; exit 1
  fi
}

MODE="${1:-}"; shift || true

case "$MODE" in
  info)
    load_theme_list
    printf 'store=%s\n' "$STORE"
    printf 'dev_theme_id=%s\n' "$DEV_THEME_ID"
    printf 'dev_theme_name=%s\n' "$(theme_name_by_id "$DEV_THEME_ID")"
    ;;

  create)
    NAME=""; REUSE=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) need_val $# "$1"; NAME="$2"; shift 2 ;;
        --reuse) REUSE=1; shift ;;
        --no-build) NO_BUILD=1; shift ;;
        --build-cmd) need_val $# "$1"; BUILD_CMD="$2"; shift 2 ;;
        --ignore-extra) need_val $# "$1"; EXTRA_IGN+=(--ignore "$2"); shift 2 ;;
        *) fail "unknown arg: $1" ;;
      esac
    done
    [ -n "$NAME" ] || fail "create requires --name \"<new theme name>\""

    # Resolve (and vet) the --reuse target BEFORE the build: a refusal after a several-minute npm
    # build is a refusal the developer waited for, and the live-theme guard must land before the push.
    EXISTING=""; REUSED=false
    if [ "$REUSE" -eq 1 ]; then
      load_theme_list
      # "no match" out of a listing we cannot read is not "the theme does not exist" — creating here
      # would add a SECOND theme with this name, which the ambiguity check then blocks on every later
      # run until a human deletes one in the admin
      ! theme_list_unreadable || fail "cli_list_unreadable — \`shopify theme list --json\` returned output that is not JSON, so \"$NAME\" cannot be resolved; re-running would create a duplicate theme of that name"
      MATCHES_RAW="$(theme_ids_by_name "$NAME" || true)"
      # keep only digit ids, so a `null` from an odd list shape can never become a push target
      MATCHES="$(printf '%s' "$MATCHES_RAW" | grep '^[0-9][0-9]*$' || true)"
      NRAW="$(printf '%s' "$MATCHES_RAW" | grep -c '.' || true)"
      NMATCH="$(printf '%s' "$MATCHES" | grep -c '^[0-9]' || true)"
      [ "$NRAW" -eq "$NMATCH" ] || fail "unusable_theme_id — a theme named \"$NAME\" is listed with a non-numeric id ($(printf '%s' "$MATCHES_RAW" | tr '\n' ' ')); pass --theme <id> to \`refresh\` it instead of creating a duplicate"
      [ "$NMATCH" -le 1 ] || fail "ambiguous_name — $NMATCH themes on $STORE are named \"$NAME\" (ids: $(printf '%s' "$MATCHES" | tr '\n' ' ')); pass --theme <id> to \`refresh\` the one you mean"
      EXISTING="$(printf '%s' "$MATCHES" | head -1)"
      if [ -n "$EXISTING" ]; then assert_not_live "$EXISTING"; fi
    fi

    start_settings_pull
    run_build
    TMP_CODE="$(assemble_theme)"; CLEAN_DIRS+=("$TMP_CODE")

    # 1) push the built local code (settings ignored) to a new/existing theme.
    ERR="$(mk_tmpf)"
    # ${EXTRA_IGN[@]+"${EXTRA_IGN[@]}"} expands to nothing when empty (bash-3.2 set -u safe).
    if [ -n "$EXISTING" ]; then
      OUT="$(shopify theme push --store "$STORE" --theme "$EXISTING" --path "$TMP_CODE" "${IGN[@]}" ${EXTRA_IGN[@]+"${EXTRA_IGN[@]}"} --json 2>"$ERR")" \
        || push_fail push_code_failed_reuse
      REUSED=true
    else
      if ! OUT="$(shopify theme push --store "$STORE" --unpublished --theme "$NAME" --path "$TMP_CODE" "${IGN[@]}" ${EXTRA_IGN[@]+"${EXTRA_IGN[@]}"} --json 2>"$ERR")"; then
        grep -qiE 'theme limit|maximum number of themes|too many themes' "$ERR" \
          && { rm -f "$ERR"; fail "theme_limit — store is at its theme cap (20 non-Plus / 100 Plus). Delete an old theme or re-run with --reuse."; }
        push_fail push_code_failed
      fi
    fi
    rm -f "$ERR"

    THEME_ID="$(json_field "$OUT" id)"
    PREVIEW="$(json_field "$OUT" preview_url)"
    EDITOR="$(json_field "$OUT" editor_url)"
    [ -n "$THEME_ID" ] || fail "code push succeeded but could not parse theme id from --json"

    # 2) overlay the dev theme's customizer settings onto the new theme.
    #    On drift this exits error=settings_drift (and removes the just-created theme).
    overlay_settings "$THEME_ID" "$REUSED"

    printf 'theme_id=%s\n' "$THEME_ID"
    printf 'name=%s\n' "$NAME"
    printf 'store=%s\n' "$STORE"
    printf 'preview_url=%s\n' "$PREVIEW"
    printf 'editor_url=%s\n' "$EDITOR"
    printf 'reused=%s\n' "$REUSED"
    printf 'built=%s\n' "$BUILT"
    ;;

  refresh)
    TARGET=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --theme) need_val $# "$1"; TARGET="$2"; shift 2 ;;
        --no-build) NO_BUILD=1; shift ;;
        --build-cmd) need_val $# "$1"; BUILD_CMD="$2"; shift 2 ;;
        --ignore-extra) need_val $# "$1"; EXTRA_IGN+=(--ignore "$2"); shift 2 ;;
        *) fail "unknown arg: $1" ;;
      esac
    done
    [ -n "$TARGET" ] || fail "refresh requires --theme <existing theme id>"
    # Numeric ids only: the CLI resolves a NAME here too, but assert_not_live vets by id — a name
    # target would sail past the guard with role="" and let the CLI resolve it to any theme,
    # the published one included. Names go through create --reuse, which resolves and vets them.
    case "$TARGET" in *[!0-9]*)
      fail "invalid_theme_id theme='$TARGET' (refresh takes a numeric theme id — for a theme NAME use \`create --name \"<name>\" --reuse\`, which resolves and vets it)" ;;
    esac
    load_theme_list
    assert_not_live "$TARGET"

    run_build
    TMP_CODE="$(assemble_theme)"; CLEAN_DIRS+=("$TMP_CODE")

    ERR="$(mk_tmpf)"
    if ! OUT="$(shopify theme push --store "$STORE" --theme "$TARGET" --path "$TMP_CODE" "${IGN[@]}" ${EXTRA_IGN[@]+"${EXTRA_IGN[@]}"} --json 2>"$ERR")"; then
      push_fail refresh_push_failed
    fi
    rm -f "$ERR"

    printf 'theme_id=%s\n' "$(json_field "$OUT" id)"
    printf 'store=%s\n' "$STORE"
    printf 'preview_url=%s\n' "$(json_field "$OUT" preview_url)"
    printf 'editor_url=%s\n' "$(json_field "$OUT" editor_url)"
    printf 'built=%s\n' "$BUILT"
    ;;

  *)
    fail "usage: create-preview-theme.sh info | create --name \"<name>\" [--reuse] [--no-build] [--build-cmd \"<cmd>\"] [--ignore-extra \"<glob>\"] | refresh --theme <id> [--no-build] [--build-cmd \"<cmd>\"] [--ignore-extra \"<glob>\"]"
    ;;
esac
