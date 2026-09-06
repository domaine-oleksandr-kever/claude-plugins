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
# SESSION THEME (`pin` / `--pin-toml`): one preview theme per work stream. Pinning rewrites the
# `theme =` line of ONE environment block — the block `shopify theme dev -e <name>` actually reads
# (see `pin` below) — so the session theme is what the dev server syncs into. In the usual
# single-environment toml that is also the line THIS script reads, so a later `create` copies the
# customizer settings from the SESSION theme rather than the shared dev theme: that is the point
# (the session theme was seeded from the dev theme when it was created), and it is why the pin
# belongs to a work stream, not to the repo. In a MULTI-environment toml the two can differ — the
# CLI resolves per environment, this script still resolves the first uncommented line — so pin the
# environment the dev server uses and pass a single-env $TOML_PATH if the settings source matters.
#
# Subcommands:
#   info
#       → store=… dev_theme_id=… dev_theme_name=…                       (no mutation)
#   create --name "<NAME>" [--reuse] [--no-build] [--build-script <name>] [--ignore-extra "<glob>"] [--pin-toml [--env <name>]]
#       → build repo → push code (settings ignored) to a new unpublished theme
#         (or an existing same-named one with --reuse) → overlay dev-theme settings
#         → read the overlay back (see verify_overlay)
#       → theme_id=… name=… store=… preview_url=… editor_url=… reused=… built=… overlay=…
#         [warn=overlay_file_dropped file=… [unknown_types=…]] [hint=…] | [warn=overlay_unverified …]
#   refresh --theme <ID> [--no-build] [--build-script <name>] [--ignore-extra "<glob>"] [--pin-toml [--env <name>]]
#       → build repo → push CODE ONLY to <ID>, leaving its customizer settings intact
#         (reuse this when a preview theme's code broke and needs a redeploy)
#       → theme_id=… store=… preview_url=… editor_url=… built=…
#   pin --theme <ID> [--env <name>]
#       → vet <ID> against the store (must exist, must not be the live theme) and pin it into
#         the toml. No build, no push, no theme is created or changed on the store. A `theme list`
#         that gave no readable answer leaves the id unverifiable and the pin is REFUSED
#         (`error=theme_unverifiable`): a pin persists in the config, so fail-open is not an
#         option here — retry when the store answers.
#       → theme_id=… store=… pinned_toml=… pin=… pin_env=… commented_dupes=… [superseded_theme_id=…]
#
#   --build-script <name>  (create & refresh, default `build`) — the ./package.json script the
#       build runs, as `npm run <name>`. A script NAME, never a command line: the skills that
#       call this script pre-approve its whole argv, so anything that reached a shell here would
#       run without a permission prompt. A value that is not a bare `[A-Za-z0-9_.:-]+` name, or is
#       absent from package.json, is refused (`bad_build_script` / `build_script_missing`) before
#       the store is touched. `--no-build` skips the build, and with it the package.json lookup —
#       the shape of the name is still checked.
#   --ignore-extra "<glob>"  (create & refresh, repeatable) — extra `--ignore` pattern passed
#       through to `shopify theme push`, for a file inside a theme dir that must not ship.
#   --pin-toml  (create & refresh) — after the push succeeds, pin the resulting theme id into
#       the toml (see `pin`) and add `pinned_toml=… pin=… pin_env=… commented_dupes=…
#       [superseded_theme_id=…]` to the output; on failure only `pinned_toml=`, `pin=failed`,
#       `pin_error=…` are printed. A pin failure here is reported but never fails the run: the
#       theme exists by then and a caller that lost its id cannot clean it up. When `theme list`
#       gave no readable answer the pin still proceeds (unlike standalone `pin` — the theme is
#       real by now and its id must reach the config) but `warn=pin_unvetted` precedes the pin keys.
#   --env <name>  (pin, and create/refresh WITH --pin-toml — without it the flag would be a silent
#       no-op, so it is refused: `--env requires --pin-toml`) — the `[environments.<name>]` block
#       to pin. Default: `dev`, else `development` — by NAME, never by count (a single block under
#       any other name is not auto-picked) — else the top-level keys when an uncommented top-level
#       `theme =`/`store =` precedes the first block (reported as `pin_env=-`), else refuse
#       (`error=ambiguous_env`, pass --env <name>) rather than guess which one the dev server reads.
#
# Output is `key=value` lines on stdout. Errors print `error=<reason>` and exit non-zero.
# Pushes retry on a Shopify `Throttled` answer (pauses: $FND_CPT_THROTTLE_WAITS, default "20 60");
# a throttle that holds is reported as `cause=throttled`.
# After the overlay push, `create` pulls the settings patterns back off the target and reports
# `overlay=verified|partial|unverified|skipped` — Shopify silently drops a *.json file whose
# section/block types this branch's code lacks while the push exits 0 (see verify_overlay). Each
# dropped file prints `warn=overlay_file_dropped file=… [unknown_types=…]`; the run still exits 0.
# FND_CPT_OVERLAY_VERIFY=0 skips the read-back; FND_CPT_OVERLAY_VERIFY_WAIT sets its re-check pause.
# The read-back pulls go through push_retry too, so on a throttled store they can add the
# $FND_CPT_THROTTLE_WAITS pauses AFTER every piece of real work has already succeeded.
# Requires: shopify CLI, jq; npm (and node, to read package.json) unless --no-build.

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

# The subcommand is resolved BEFORE the config is parsed. `pin` is the one mode that WRITES the
# toml, and a missing or malformed `theme =` line is exactly the state it exists to repair — so
# the two hard stops on that value below must not kill it before it runs.
MODE="${1:-}"; shift || true

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

[ "$MODE" = pin ] || [ -n "${DEV_THEME_ID:-}" ] || fail "no uncommented \`theme = \"...\"\` line in $TOML"
[ -n "${STORE:-}" ]        || fail "no uncommented \`store = \"...\"\` line in $TOML"
[ -n "${TOKEN:-}" ]        || fail "no access token (password / shp*_… in $TOML, or \$SHOPIFY_CLI_THEME_TOKEN)"

# `shopify --store` documents the full URL form as valid and real tomls carry it — strip the scheme
# instead of refusing a supported config.
STORE="${STORE#http://}"; STORE="${STORE#https://}"; STORE="${STORE%/}"

# A value that cannot be what it claims to be is a typo or a mis-parse, and handing it to the CLI is
# an opaque failure at best and the WRONG STORE at worst. A malformed dev theme id is the nastier
# one: the code push does not use it, so a theme IS created, and only the settings pull fails —
# which is how a run ends up reporting a pull error while an orphan theme burns a slot on the store.
if [ "$MODE" != pin ]; then
  case "$DEV_THEME_ID" in *[!0-9]*)
    fail "invalid_dev_theme_id id='$DEV_THEME_ID' (expected digits — check the \`theme =\` line in $TOML)" ;;
  esac
fi
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
  # A half-written pin temp lives NEXT TO the developer's toml (same dir = atomic rename), so an
  # interrupted run must not leave a dot-file behind in the repo root.
  [ -z "${PIN_TMP:-}" ] || rm -f "$PIN_TMP"
  [ -z "${PIN_META:-}" ] || rm -f "$PIN_META"
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
push_fail() { # $1 = error code; $2 (create only) = theme name to scan for a this-run-created orphan
  printf 'error=%s\n' "$1"
  # A throttle that held through the retries is an actionable state of its own: the fix is outside
  # this run (stop the competing consumer or wait), not "check the asset the trace names".
  if grep -qi 'throttled' "$ERR"; then
    printf 'cause=throttled — the store+token rate limit held through the retries; a `shopify theme dev` running against this store draws on the same budget — stop it (or wait a minute) and re-run\n'
  fi
  [ -z "${2:-}" ] || reap_created_orphan "$2"
  printf 'log=%s\n' "$ERR"
  printf -- '--- last 25 lines of shopify stderr ---\n'
  tail -n 25 "$ERR"
  exit 1
}

# Domaine env files (process env wins): nearest .claude/domaine.env above cwd — tuning keys only,
# see below — then the global ~/.config/domaine/env; same dialect as scripts/env-file.cjs, read per
# key, never sourced. Fills an UNSET variable only — a set-but-empty FND_CPT_THROTTLE_WAITS
# (retrying disabled) stays exactly that, and an empty value in the file cannot be expressed here.
domaine_env() {
  local d="$PWD" f v
  # PROJECT_OK, mirrored by hand from scripts/env-file.cjs: the project file is committable by a
  # client repo, so only these tuning keys are read from it. Every other switch — the guards, the
  # spill dir, the verify gates — comes from the environment or the global file, default-deny.
  case "$1" in
    FND_LEAN|FND_CTX_MONITOR|FND_CTX_WARN|FND_CTX_WINDOW|FND_MCP_SLIM_DEBUG|FND_WHALE_GUIDE|FND_NOGAIN_MEMO|FND_GQL_PROBE_CACHE|FND_CPT_THROTTLE_WAITS|FND_CPT_OVERLAY_VERIFY_WAIT|FND_THEME_JSON_VERIFY_WAIT|SHOPIFY_ADMIN_GQL_QUIET)
      while :; do
        f="$d/.claude/domaine.env"
        if [ -f "$f" ]; then
          v="$(grep -m1 "^$1=" "$f" 2>/dev/null | cut -d= -f2-)"
          [ -n "$v" ] && { printf '%s' "$v"; return; }
          break
        fi
        [ "$d" = "/" ] && break
        d="$(dirname "$d")"
      done ;;
  esac
  grep -m1 "^$1=" "${XDG_CONFIG_HOME:-$HOME/.config}/domaine/env" 2>/dev/null | cut -d= -f2- || true
}
if [ -z "${FND_CPT_THROTTLE_WAITS+x}" ]; then
  _v="$(domaine_env FND_CPT_THROTTLE_WAITS)"; [ -n "$_v" ] && FND_CPT_THROTTLE_WAITS="$_v"
fi
if [ -z "${FND_CPT_OVERLAY_VERIFY+x}" ]; then
  _v="$(domaine_env FND_CPT_OVERLAY_VERIFY)"; [ -n "$_v" ] && FND_CPT_OVERLAY_VERIFY="$_v"
fi
if [ -z "${FND_CPT_OVERLAY_VERIFY_WAIT+x}" ]; then
  _v="$(domaine_env FND_CPT_OVERLAY_VERIFY_WAIT)"; [ -n "$_v" ] && FND_CPT_OVERLAY_VERIFY_WAIT="$_v"
fi
# a non-numeric pause would hand `sleep` an argument it refuses under `set -e`; `1.2.3` passes a
# bytes-only filter, so multi-dot values are rejected too
OVERLAY_VERIFY_WAIT="${FND_CPT_OVERLAY_VERIFY_WAIT:-2}"
case "$OVERLAY_VERIFY_WAIT" in ''|.|*.*.*|*[!0-9.]*) OVERLAY_VERIFY_WAIT=2 ;; esac

# Shopify rate-limits per store+token, and a running `shopify theme dev` against the same store
# draws on the SAME budget — so a bulk push can land a 429 `Throttled` (observed live at 0% upload)
# while every other call is healthy. Two spaced retries absorb the transient case;
# FND_CPT_THROTTLE_WAITS overrides the pauses (tests pass "0 0"; an empty value disables retrying).
push_retry() { # $1 = stderr log; rest = the push argv. 0 → $PUSH_OUT holds stdout; 1 → $1 holds the last stderr
  local err="$1" w; shift
  PUSH_OUT="$("$@" 2>"$err")" && return 0
  for w in ${FND_CPT_THROTTLE_WAITS-20 60}; do
    grep -qi 'throttled' "$err" || return 1
    sleep "$w"
    PUSH_OUT="$("$@" 2>"$err")" && return 0
  done
  return 1
}

# After a failed `--unpublished` push: the CLI creates the theme server-side FIRST and uploads
# second, so a mid-upload failure (a held throttle above all) leaves a code-less theme this run
# created and nobody can name — burning a slot toward the 20/100 cap with no `created_theme=` line.
# Attribution is the pre-push snapshot: an id wearing the name NOW that was not there BEFORE the
# push is ours. Exactly one — zero means the server-side create never happened, and two or more
# means a concurrent run, where deleting on a guess could take someone else's theme.
PRE_NAME_IDS=""
reap_created_orphan() { # $1 = the create's theme name; prints created_theme= lines when attributable
  # the snapshot must not be answered from the cache — reset and re-list
  THEME_LIST_LOADED=0; THEME_LIST_OK=0; THEME_LIST_SILENT=1; THEME_LIST=""
  load_theme_list
  [ "$THEME_LIST_OK" -eq 1 ] || return 0   # silent/unreadable fresh listing — cannot attribute, leave it
  local post id new n deleted
  post="$(theme_ids_by_name "$1" | grep '^[0-9][0-9]*$' || true)"
  new=""; n=0
  for id in $post; do
    case " $PRE_NAME_IDS " in *" $id "*) ;; *) new="$id"; n=$((n + 1)) ;; esac
  done
  [ "$n" -eq 1 ] || return 0
  deleted="no"
  if shopify theme delete --store "$STORE" --theme "$new" --force >/dev/null 2>&1; then deleted="yes"; else deleted="failed"; fi
  printf 'created_theme=%s\n' "$new"
  printf 'created_theme_deleted=%s\n' "$deleted"
  return 0
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
# Three outcomes, and the caller acts differently on each: applied (return 0, carrying the read-back
# verdict in $OVERLAY_VERIFY — verified/partial/unverified/skipped, see verify_overlay, so an applied
# overlay is not automatically a complete one); DRIFT — the dev theme
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
  if push_retry "$perr" shopify theme push --store "$STORE" --theme "$target" --path "$tmp" --nodelete "${ONLY[@]}"; then
    rm -f "$perr"
    verify_overlay "$target" "$tmp"   # exit 0 is the transport's opinion — read the overlay back
    return 0
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
  # A held throttle gets its own cause: the generic grep below would fish the CLI's box-drawing
  # frame line out of the 429 output, burying the one hint that is actually actionable.
  if grep -qi 'throttled' "$perr"; then
    overlay_fail overlay_push_failed "$target" "$reused" "$perr" "throttled — a \`shopify theme dev\` running against this store draws on the token's rate limit; stop it (or wait a minute) and retry"
  fi
  # cause= is the machine-readable field the caller acts on — it must never stay a placeholder while
  # the real diagnostic sits in the log, so an unrecognized wording falls back to the first line
  reason="$(grep -iE 'error|fail|invalid|denied' "$perr" | head -1 | sed -E 's/^[[:space:]]*//' || true)"
  [ -n "$reason" ] || reason="$(first_line "$perr")"
  overlay_fail overlay_push_failed "$target" "$reused" "$perr" "$reason"
}

# --- overlay read-back --------------------------------------------------------
# `shopify theme push` exiting 0 with a clean stderr does not prove the files landed: Shopify
# validates theme JSON server-side and silently DROPS a file it rejects while the push reports
# success (the same class theme-json.sh's `set` read-back exists for). Observed live 2026-08-31:
# a dev theme's templates/product.json referenced a block type absent from this branch's schemas —
# the overlay "succeeded", the file never landed, every PDP on the preview 404'd. So after a clean
# overlay push the settings patterns are pulled back off the TARGET and every source *.json must be
# present. Presence only, by design: content can differ legitimately (Shopify re-stamps its /*…*/
# banner), and the verified failure class drops the whole file — which also means a --reuse
# target's pre-existing stale copy can still pass (known ceiling). A missing file is re-checked
# once after $OVERLAY_VERIFY_WAIT seconds (a read straight after a write can trail it), then
# reported as warn=overlay_file_dropped — a WARNING, not settings_drift: unlike the stderr-worded
# drift (where the push failed wholesale) everything else landed, the cheap recovery is fixing the
# one file via theme-json.sh set, and deleting the theme would only replay the same silent drop on
# the next create. A verify PULL that fails must never fail a run whose pushes all succeeded —
# that is overlay=unverified. FND_CPT_OVERLAY_VERIFY=0 skips the read-back (overlay=skipped).
OVERLAY_VERIFY="skipped"; OVERLAY_DROPPED=""
overlay_missing() { # $1 = overlay source dir, $2 = pulled-back dir → source *.json absent from $2
  ( cd "$1" && find . -type f -name '*.json' ) | sed 's|^\./||' | while IFS= read -r f; do
    [ -f "$2/$f" ] || printf '%s\n' "$f"
  done
}
overlay_unknown_types() { # $1 = dropped source file → types with no schema in the pushed code, comma-joined
  local t types body out=""
  # Every theme *.json Shopify serves carries an auto-generated /*…*/ banner, which jq refuses —
  # stripping it is what keeps the structural read below the live path instead of the fallback.
  # Only a LEADING banner is stripped: a /*…*/ further down is a settings value, not a comment.
  body="$(awk 'NR==1 && $0 ~ /^[ \t]*\/\*/ { skip=1 } skip { if (sub(/.*\*\//, "")) { skip=0; if (length) print }; next } { print }' "$1" 2>/dev/null || true)"
  if [ -n "$body" ] && printf '%s\n' "$body" | jq empty >/dev/null 2>&1; then
    # only the section/block `type` chains — a settings VALUE that happens to sit under a "type"
    # key is content, not a schema reference. `objects |` keeps a non-object inside a blocks
    # container from erroring out the collector, which would cost the whole file's type list.
    types="$(printf '%s\n' "$body" | jq -r 'def t: objects | ((.type? | strings), (.blocks[]? | t)); [.sections[]? | t] | unique | .[]' 2>/dev/null || true)"
  else
    # unparseable even without a banner — raw scan instead. On this path the list is a HINT, not a
    # definitive one: the schema check below only removes types it RECOGNIZES, so a content value
    # that happens to sit under a "type" key survives into unknown_types=.
    types="$(grep -oE '"type"[[:space:]]*:[[:space:]]*"[^"]+"' "$1" 2>/dev/null | sed -E 's/.*"([^"]*)"$/\1/' | sort -u || true)"
  fi
  # read, not `for t in $types` — an unquoted expansion would glob a type like "Bundle * Save"
  # against the checkout; a heredoc keeps $out in THIS shell where a pipe would not
  while IFS= read -r t; do
    # @app/@theme are placeholders; a type with odd characters would also poison the grep below
    case "$t" in ''|@*|*[!A-Za-z0-9_-]*) continue ;; esac
    [ -f "$TMP_CODE/sections/$t.liquid" ] && continue
    [ -f "$TMP_CODE/blocks/$t.liquid" ] && continue
    grep -qE "\"type\"[[:space:]]*:[[:space:]]*\"$t\"" "$TMP_CODE"/sections/*.liquid "$TMP_CODE"/blocks/*.liquid 2>/dev/null && continue
    out="$out,$t"
  done <<EOF
$types
EOF
  printf '%s' "${out#,}"
}
verify_overlay() { # $1 = target theme id, $2 = overlay source dir; fills OVERLAY_VERIFY/_DROPPED
  local target="$1" src="$2" verr vdir missing f t rows=""
  [ "${FND_CPT_OVERLAY_VERIFY:-1}" = "0" ] && return 0
  OVERLAY_VERIFY="unverified"
  vdir="$(mk_tmpd)"; CLEAN_DIRS+=("$vdir")
  # the stderr sink lives INSIDE the verify dir, so cleanup() reaps it even when the run aborts
  # mid-verify — a loose $TMPDIR file would just accumulate
  verr="$vdir/verify.err"
  # --nodelete is NOT decorative here: verify.err shares the pull target dir, and without the
  # flag the CLI is licensed to delete local files absent from the theme
  push_retry "$verr" shopify theme pull --store "$STORE" --theme "$target" --path "$vdir" "${ONLY[@]}" --nodelete </dev/null \
    || return 0
  missing="$(overlay_missing "$src" "$vdir")"
  if [ -n "$missing" ]; then
    # non-fatal like the pin step below: past this point the theme is real, and dying on sleep's
    # complaint would take the run non-zero without ever printing the id the caller needs
    sleep "$OVERLAY_VERIFY_WAIT" || true
    vdir="$(mk_tmpd)"; CLEAN_DIRS+=("$vdir")
    # a failed RE-pull keeps the first observation — loud beats silent here
    if push_retry "$verr" shopify theme pull --store "$STORE" --theme "$target" --path "$vdir" "${ONLY[@]}" --nodelete </dev/null; then
      missing="$(overlay_missing "$src" "$vdir")"
    fi
  fi
  [ -n "$missing" ] || { OVERLAY_VERIFY="verified"; return 0; }
  OVERLAY_VERIFY="partial"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    t="$(overlay_unknown_types "$src/$f")"
    rows="$rows$f"$'\t'"$t"$'\n'
  done <<EOF
$missing
EOF
  OVERLAY_DROPPED="$rows"
  return 0
}
# The overlay keys, printed with the theme keys on create: overlay= is the machine-readable
# verdict, and each dropped file gets its own warn= line so a caller that only skims for error=
# still sees the failure spelled out in the stream.
print_overlay_keys() {
  printf 'overlay=%s\n' "$OVERLAY_VERIFY"
  if [ "$OVERLAY_VERIFY" = "unverified" ]; then
    printf 'warn=overlay_unverified — the read-back pull failed, so whether every settings file landed is unknown; spot-check a key template (theme-json.sh get) before trusting the preview\n'
    return 0
  fi
  [ "$OVERLAY_VERIFY" = "partial" ] || return 0
  printf '%s' "$OVERLAY_DROPPED" | while IFS=$'\t' read -r f t; do
    [ -n "$f" ] || continue
    if [ -n "$t" ]; then printf 'warn=overlay_file_dropped file=%s unknown_types=%s\n' "$f" "$t"
    else printf 'warn=overlay_file_dropped file=%s\n' "$f"; fi
  done
  printf 'hint=Shopify rejected the file(s) server-side while the push reported success — the dev-theme customizer state references a section/block type this branch does not define, so the affected pages render 404 (missing template) or stale content. Fix the one file: pull it (theme-json.sh get), strip the unknown section/block entry plus its order/block_order reference, push it back with theme-json.sh set (read-back verified) — or duplicate the dev theme manually in the admin for a full-fidelity preview.\n'
}

# --- session-theme pin --------------------------------------------------------
# Pin $1 as the session theme — scoped to ONE environment block, because that is how the Shopify
# CLI reads this file: `shopify theme dev -e dev` takes `theme =` from `[environments.dev]`, NOT
# from the first one in the file. A file-order pin would drop the session id into whichever block
# happens to be listed first (`[environments.production]` in a real multi-env config, whose id is
# usually the LIVE theme) and leave the block the dev server reads with no theme at all.
# Which block:
#   --env <name>          → [environments.<name>]         (absent → env_not_found)
#   no [environments.*]   → the top-level keys before the first section header (reported as pin_env=-)
#   any blocks            → `dev`, else `development` — by NAME, never by count (a single block
#                           under any other name, e.g. production, is NOT auto-picked); else the
#                           top-level keys, when an uncommented top-level `theme =`/`store =`
#                           precedes the first header (pin_env=-); else ambiguous_env — refuse,
#                           never guess
# Inside that block the FIRST uncommented `theme =` line takes the new id and every LATER
# uncommented `theme =` line in the SAME block is prefixed with `# ` (value intact, uncomment to
# restore; their count is reported as `commented_dupes=`). Blocks the pin does not target are
# never touched.
# The value being replaced is not lost either: the original line is kept, commented, directly
# above the pinned one and marked `# fnd:superseded` — this file is gitignored, so once the shared
# dev theme id is overwritten it exists nowhere else. A block that ALREADY carries a real marker
# line (`# theme = … # fnd:superseded` — a stray comment merely containing the string is not one)
# keeps it untouched: the first pin's value is the one worth restoring, and re-pins must neither
# stack markers nor lose the original.
# With no uncommented `theme =` in the block, one is inserted after its `store =` line, else right
# under the block header — carrying a trailing `# fnd:session-theme` tag: the block had no
# `theme =` of its own, so there is nothing to supersede, and the tag is what lets
# worktree-setup.sh's unpin DELETE the line and restore the original no-theme state. A re-pin of a
# different id on a tagged line swaps the value, keeps the tag and writes no marker (the line is
# session-owned).
# Indentation, quoting style, trailing comments, CRLF endings and a missing final newline are
# all preserved, so re-pinning the same id is a byte-for-byte no-op — which is what lets a skill
# re-enter a session and pin again without asking.
# The file holds the Theme Access token: nothing here prints a line, a diff or a byte of it.
PIN_ACTION=""; PIN_DUPES=0; PIN_OLD=""; PIN_ENV_USED=""; PIN_PATH=""; PIN_TMP=""; PIN_META=""
PIN_ERR_KEY=""; PIN_ERR_MSG=""
resolve_pin_path() {
  local d b
  d="$(dirname "$TOML")"; b="$(basename "$TOML")"
  PIN_PATH="$(cd "$d" 2>/dev/null && pwd)/$b" || PIN_PATH="$TOML"
}
pin_toml() { # $1 = theme id → 0 + PIN_ACTION=rewritten|appended|unchanged; 1 + PIN_ERR_KEY/_MSG
  local id="$1" target link hops dir tmp meta endnl mode had status envs
  resolve_pin_path
  PIN_ERR_KEY="pin_toml_failed"
  PIN_ERR_MSG="toml=$PIN_PATH — could not rewrite the \`theme =\` line (check the file's permissions and its directory's, and free disk space)"

  # Follow a symlinked config to its target: the rename below would otherwise REPLACE the link
  # with a regular file and silently unpin whatever the developer pointed it at. Bounded, so a
  # symlink cycle is a failure and not a hang.
  target="$TOML"; hops=0
  while [ -L "$target" ] && [ "$hops" -lt 16 ]; do
    link="$(readlink "$target")" || return 1
    case "$link" in /*) target="$link" ;; *) target="$(dirname "$target")/$link" ;; esac
    hops=$((hops + 1))
  done
  [ -f "$target" ] || return 1
  dir="$(dirname "$target")"

  # A file whose last byte is not a newline must not gain one — that alone would make a re-pin a
  # "change" and cost idempotence. Command substitution strips trailing newlines, so an empty
  # result means the last byte IS one.
  endnl=1
  if [ -s "$target" ] && [ -n "$(tail -c 1 "$target" 2>/dev/null)" ]; then endnl=0; fi

  # awk writes the new file to stdout and its findings (which block it chose, what it replaced) to
  # a side file: one pass owns the block resolution, so the report can never describe a different
  # rewrite than the one on disk. Nothing in it is secret — an env name, a theme id, two counts.
  meta="$(mk_tmpf)" || return 1
  PIN_META="$meta"
  # Same-directory temp + rename: rename(2) is atomic and never crosses a filesystem, so a kill
  # mid-write cannot leave the developer with a truncated (token-less) config.
  tmp="$(mktemp "$dir/.fnd-pin.XXXXXX" 2>/dev/null)" || { rm -f "$meta"; PIN_META=""; return 1; }
  PIN_TMP="$tmp"
  if ! awk -v id="$id" -v want="$PIN_ENV" -v endnl="$endnl" -v meta="$meta" '
    function emit(t) { if (started) printf "\n"; printf "%s", t; started = 1 }
    function nocr(s) { sub(/\r$/, "", s); return s }
    function valof(orig,   v, q, p, h) {
      v = nocr(orig)
      sub(/^[ \t]*theme[ \t]*=[ \t]*/, "", v)
      q = substr(v, 1, 1)
      if (q == "\"" || q == SQ) {
        v = substr(v, 2); p = index(v, q)
        if (p > 0) v = substr(v, 1, p - 1)
      } else {
        h = index(v, "#"); if (h > 0) v = substr(v, 1, h - 1)
        sub(/[ \t]+$/, "", v)
      }
      return v
    }
    function repin(orig, newid,   s, cr, pre, rest, q, p, tail) {
      s = orig; cr = ""
      if (s ~ /\r$/) { cr = "\r"; sub(/\r$/, "", s) }
      if (!match(s, /^[ \t]*theme[ \t]*=[ \t]*/)) return orig
      pre = substr(s, 1, RLENGTH); rest = substr(s, RLENGTH + 1)
      q = substr(rest, 1, 1)
      if (q == "\"" || q == SQ) {
        p = index(substr(rest, 2), q)
        tail = (p > 0) ? substr(rest, p + 2) : ""
      } else {
        match(rest, /^[^ \t#]*/)
        if (RLENGTH > 0) { q = ""; tail = substr(rest, RLENGTH + 1) }
        else { q = "\""; tail = rest }
      }
      return pre q newid q tail cr
    }
    BEGIN { SQ = "\047"; n = 0 }
    { line[++n] = $0 }
    END {
      # 1. map the uncommented section headers and the environment blocks among them
      nenv = 0; nh = 0; firsthdr = 0; envs = ""
      for (i = 1; i <= n; i++) {
        s = nocr(line[i])
        if (s ~ /^[ \t]*#/) continue
        if (s ~ /^[ \t]*\[/) {
          if (firsthdr == 0) firsthdr = i
          hline[++nh] = i
          nm = s; sub(/^[ \t]*\[[ \t]*/, "", nm); sub(/[ \t]*\].*$/, "", nm)
          if (index(nm, "environments.") == 1) {
            nenv++; ename[nenv] = substr(nm, 14); eline[nenv] = i
            envs = (envs == "") ? ename[nenv] : envs " " ename[nenv]
          }
        }
      }
      # 2. choose the block (hdr = its header line; 0 = the top-level keys). By NAME only —
      # `shopify theme dev -e <name>` resolves by name, so "there happens to be exactly one
      # block" proves nothing about which environment the dev server reads and a lone
      # [environments.production] must not be auto-picked. The top-level keys are the fallback
      # when the file actually HAS them (an uncommented theme=/store= before the first header).
      toplevel = 0
      toplim = (firsthdr > 0) ? firsthdr - 1 : n
      for (i = 1; i <= toplim; i++) {
        s = nocr(line[i])
        if (s ~ /^[ \t]*#/) continue
        if (s ~ /^[ \t]*(theme|store)[ \t]*=/) { toplevel = 1; break }
      }
      hdr = -1; used = "-"
      if (want != "") {
        for (j = 1; j <= nenv; j++) if (ename[j] == want) { hdr = eline[j]; used = want }
        if (hdr < 0) { print "status=env_not_found" > meta; print "envs=" envs > meta; exit 1 }
      } else if (nenv == 0) {
        hdr = 0
      } else {
        for (j = 1; j <= nenv; j++) if (ename[j] == "dev") { hdr = eline[j]; used = "dev" }
        if (hdr < 0) for (j = 1; j <= nenv; j++) if (ename[j] == "development") { hdr = eline[j]; used = "development" }
        if (hdr < 0 && toplevel) hdr = 0
        if (hdr < 0) { print "status=ambiguous_env" > meta; print "envs=" envs > meta; exit 1 }
      }
      if (hdr > 0) {
        rstart = hdr + 1; rend = n
        for (j = 1; j <= nh; j++) if (hline[j] > hdr) { rend = hline[j] - 1; break }
      } else {
        rstart = 1; rend = (firsthdr > 0) ? firsthdr - 1 : n
      }
      # 3. what is in that block. `marked` matches only a REAL marker line — a commented
      # `theme =` carrying the string — because a stray comment that merely mentions
      # fnd:superseded must not suppress the marker a real pin still owes the file. `tagged`
      # means the first uncommented `theme =` line is a session-owned append (trailing
      # `# fnd:session-theme`): re-pinning it swaps the value and keeps the tag, and no marker
      # is ever written for it — the original state had no `theme =` line to restore.
      first = 0; extra = 0; anchor = 0; marked = 0; tagged = 0
      for (i = rstart; i <= rend; i++) {
        s = nocr(line[i])
        if (s ~ /^[ \t]*#/) { if (s ~ /^[ \t]*#[ \t]*theme[ \t]*=.*fnd:superseded/) marked = 1; continue }
        if (s ~ /^[ \t]*theme[ \t]*=/) {
          if (first == 0) { first = i; if (s ~ /#[ \t]*fnd:session-theme[ \t]*$/) tagged = 1 }
          else extra++
          continue
        }
        if (anchor == 0 && s ~ /^[ \t]*store[ \t]*=/) anchor = i
      }
      old = ""; mark = ""; ins = ""; at = -1
      if (first > 0) {
        old = valof(line[first])
        if (old != id && marked == 0 && tagged == 0) {
          mo = line[first]; mcr = ""
          if (mo ~ /\r$/) { mcr = "\r"; sub(/\r$/, "", mo) }
          mark = "# " mo "  # fnd:superseded" mcr
        }
        line[first] = repin(line[first], id)
        for (i = first + 1; i <= rend; i++) {
          s = nocr(line[i])
          if (s ~ /^[ \t]*#/) continue
          if (s ~ /^[ \t]*theme[ \t]*=/) line[i] = "# " line[i]
        }
      } else {
        ref = (anchor > 0) ? anchor : hdr
        at = (ref > 0) ? ref : rend
        ind = ""; cr = ""
        if (ref > 0) {
          if (line[ref] ~ /\r$/) cr = "\r"
          match(line[ref], /^[ \t]*/); ind = substr(line[ref], 1, RLENGTH)
        }
        ins = ind "theme = \"" id "\" # fnd:session-theme" cr
      }
      print "status=ok" > meta
      print "env=" used > meta
      print "had=" (first > 0 ? 1 : 0) > meta
      print "commented_dupes=" extra > meta
      print "old=" old > meta
      started = 0
      if (ins != "" && at == 0) emit(ins)
      for (i = 1; i <= n; i++) {
        if (mark != "" && i == first) emit(mark)
        emit(line[i])
        if (ins != "" && i == at) emit(ins)
      }
      if (started && endnl == 1) printf "\n"
    }
  ' "$target" > "$tmp" 2>/dev/null; then
    status="$(grep '^status=' "$meta" 2>/dev/null | head -1 | cut -d= -f2- || true)"
    envs="$(grep '^envs=' "$meta" 2>/dev/null | head -1 | cut -d= -f2- || true)"
    case "$status" in
      env_not_found)
        PIN_ERR_KEY="env_not_found"
        PIN_ERR_MSG="env='$PIN_ENV' toml=$PIN_PATH — no \`[environments.$PIN_ENV]\` block in it (present: ${envs:-none})" ;;
      ambiguous_env)
        PIN_ERR_KEY="ambiguous_env"
        PIN_ERR_MSG="envs='$envs' toml=$PIN_PATH — no environment block named \`dev\`/\`development\` and no top-level \`theme =\`/\`store =\` keys, so which block \`shopify theme dev\` reads cannot be guessed; re-run with --env <name>" ;;
    esac
    rm -f "$tmp" "$meta"; PIN_TMP=""; PIN_META=""; return 1
  fi
  [ -s "$tmp" ] || { rm -f "$tmp" "$meta"; PIN_TMP=""; PIN_META=""; return 1; }

  PIN_ENV_USED="$(grep '^env=' "$meta" | head -1 | cut -d= -f2- || true)"
  had="$(grep '^had=' "$meta" | head -1 | cut -d= -f2- || true)"
  PIN_DUPES="$(grep '^commented_dupes=' "$meta" | head -1 | cut -d= -f2- || true)"
  PIN_OLD="$(grep '^old=' "$meta" | head -1 | cut -d= -f2- || true)"
  rm -f "$meta"; PIN_META=""
  case "$PIN_DUPES" in ''|*[!0-9]*) PIN_DUPES=0 ;; esac
  # only a value that actually went away is worth reporting — the caller records it so the
  # environment can be restored without hunting the id down in the Shopify admin
  [ "$PIN_OLD" != "$id" ] || PIN_OLD=""

  if cmp -s "$tmp" "$target"; then
    rm -f "$tmp"; PIN_TMP=""; PIN_ACTION="unchanged"; return 0
  fi
  # mktemp creates 0600; a config the developer keeps at 0644 must not silently change mode.
  # GNU first: on Linux `stat -f` is a different valid command (filesystem status) that exits 0
  # with non-octal output, so BSD-first would skip the fallback and silently drop the mode.
  mode="$(stat -c '%a' "$target" 2>/dev/null || stat -f '%Lp' "$target" 2>/dev/null || true)"
  case "$mode" in ''|*[!0-7]*) ;; *) chmod "$mode" "$tmp" 2>/dev/null || true ;; esac
  mv -f "$tmp" "$target" 2>/dev/null || { rm -f "$tmp"; PIN_TMP=""; return 1; }
  PIN_TMP=""
  if [ "$had" = "1" ]; then PIN_ACTION="rewritten"; else PIN_ACTION="appended"; fi
  return 0
}

# The pin keys, printed AFTER the theme keys on create/refresh: a caller reading the stream must
# have the theme id in hand before it learns anything about the toml.
PIN=0; PIN_ENV=""; PIN_FAIL=""
print_pin_keys() {
  [ -n "$PIN_PATH" ] || resolve_pin_path
  # `theme list` never gave a readable answer, so the pinned id could not be vetted against the
  # store — said BEFORE the pin keys, so a caller acting on pin= has already seen it. Standalone
  # `pin` refuses that state outright (error=theme_unverifiable) and never reaches this line.
  [ "$THEME_LIST_OK" -eq 1 ] || printf 'warn=pin_unvetted\n'
  printf 'pinned_toml=%s\n' "$PIN_PATH"
  if [ -n "$PIN_FAIL" ]; then
    printf 'pin=failed\n'
    printf 'pin_error=%s\n' "$PIN_FAIL"
    return 0
  fi
  printf 'pin=%s\n' "$PIN_ACTION"
  printf 'pin_env=%s\n' "$PIN_ENV_USED"
  printf 'commented_dupes=%s\n' "$PIN_DUPES"
  [ -z "$PIN_OLD" ] || printf 'superseded_theme_id=%s\n' "$PIN_OLD"
}

NO_BUILD=0
BUILD_SCRIPT="build"
BUILT="no"
# Name-only, run as argv — the callers pre-approve this script's whole argv, so a value that
# reached a shell would run with no permission prompt (rationale: header). Refuse before the store.
vet_build_script() {
  case "$BUILD_SCRIPT" in
    ''|-*|*[!A-Za-z0-9_.:-]*)
      fail "bad_build_script ($BUILD_SCRIPT) — --build-script takes the NAME of a script in ./package.json ([A-Za-z0-9_.:-], no leading dash), not a command; nothing was built or pushed" ;;
  esac
  # --no-build never reads package.json — the repo it runs in may legitimately not have one —
  # but the name is still vetted above, so a bogus value is never silently pocketed.
  [ "$NO_BUILD" -eq 1 ] && return 0
  command -v node >/dev/null 2>&1 \
    || fail "build_script_missing ($BUILD_SCRIPT) — node not found on PATH, so ./package.json cannot be read; install node or pass --no-build if the repo is already built"
  node -e 'const fs=require("fs");let p;try{p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(e){process.exit(1)}const s=p&&p.scripts;process.exit(s&&typeof s[process.argv[2]]==="string"?0:1)' \
    package.json "$BUILD_SCRIPT" 2>/dev/null \
    || fail "build_script_missing ($BUILD_SCRIPT) — no such script under \`scripts\` in ./package.json (run from the project root); pick one it defines or pass --no-build; nothing was built or pushed"
}
run_build() {
  [ "$NO_BUILD" -eq 1 ] && { BUILT="skipped"; return 0; }
  local log; log="$(mk_tmpf)"
  if npm run "$BUILD_SCRIPT" >"$log" 2>&1; then
    BUILT="yes"; rm -f "$log"
  else
    printf 'error=build_failed (npm run %s):\n' "$BUILD_SCRIPT"; tail -n 5 "$log"; rm -f "$log"; exit 1
  fi
}

case "$MODE" in
  info)
    load_theme_list
    printf 'store=%s\n' "$STORE"
    printf 'dev_theme_id=%s\n' "$DEV_THEME_ID"
    printf 'dev_theme_name=%s\n' "$(theme_name_by_id "$DEV_THEME_ID")"
    ;;

  pin)
    TARGET=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --theme) need_val $# "$1"; TARGET="$2"; shift 2 ;;
        --env) need_val $# "$1"; PIN_ENV="$2"; shift 2 ;;
        *) fail "unknown arg: $1" ;;
      esac
    done
    [ -n "$TARGET" ] || fail "pin requires --theme <existing theme id>"
    # Numeric ids only, for the same reason refresh insists: assert_not_live vets by id, so a NAME
    # would sail past the guard with role="" — and here it would then be written into the config
    # every later run and `shopify theme dev` resolve against.
    case "$TARGET" in *[!0-9]*)
      fail "invalid_theme_id theme='$TARGET' (pin takes a numeric theme id — the id of an existing unpublished/preview theme; to create one use \`create --name \"<name>\" --reuse --pin-toml\`)" ;;
    esac
    load_theme_list
    # A pin PERSISTS in the config and a wrong one poisons every later run — so unlike
    # create/refresh, where a listing outage only risks one push, standalone `pin` must not
    # fail open: no readable listing, no vetting, no pin. (create/refresh --pin-toml still
    # proceed under an outage — their theme is real by pin time and the caller must not lose
    # its id — but say so with warn=pin_unvetted.)
    [ "$THEME_LIST_OK" -eq 1 ] || \
      fail "theme_unverifiable theme=$TARGET store=$STORE — \`shopify theme list --json\` gave no readable answer, so the id cannot be vetted, and a pin persists in the config; re-run when the store answers — nothing was changed"
    assert_not_live "$TARGET"
    # Pinning an id that is not on the store poisons every later run (the settings pull, `info`
    # and `shopify theme dev` all resolve it) with an error naming the config, not the typo. Only
    # a listing we could actually READ can make that claim — and by here it always was.
    if [ "$THEME_LIST_OK" -eq 1 ] && ! theme_found_by_id "$TARGET"; then
      fail "theme_not_found theme=$TARGET store=$STORE — no theme with that id is listed on the store; check the id (a preview URL's \`?preview_theme_id=…\`) or create one with \`create --name \"<name>\"\`"
    fi
    pin_toml "$TARGET" || fail "$PIN_ERR_KEY $PIN_ERR_MSG; nothing was changed"
    printf 'theme_id=%s\n' "$TARGET"
    printf 'store=%s\n' "$STORE"
    print_pin_keys
    ;;

  create)
    NAME=""; REUSE=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) need_val $# "$1"; NAME="$2"; shift 2 ;;
        --reuse) REUSE=1; shift ;;
        --no-build) NO_BUILD=1; shift ;;
        --build-script) need_val $# "$1"; BUILD_SCRIPT="$2"; shift 2 ;;
        --ignore-extra) need_val $# "$1"; EXTRA_IGN+=(--ignore "$2"); shift 2 ;;
        --pin-toml) PIN=1; shift ;;
        --env) need_val $# "$1"; PIN_ENV="$2"; shift 2 ;;
        *) fail "unknown arg: $1" ;;
      esac
    done
    [ -n "$NAME" ] || fail "create requires --name \"<new theme name>\""
    # --env only ever feeds pin_toml — accepted without --pin-toml it would be a silent no-op
    # the caller reads as "the block I named was pinned"
    [ "$PIN" -eq 1 ] || [ -z "$PIN_ENV" ] || fail "--env requires --pin-toml"
    vet_build_script

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
      push_retry "$ERR" shopify theme push --store "$STORE" --theme "$EXISTING" --path "$TMP_CODE" "${IGN[@]}" ${EXTRA_IGN[@]+"${EXTRA_IGN[@]}"} --json \
        || push_fail push_code_failed_reuse
      OUT="$PUSH_OUT"
      REUSED=true
    else
      # Snapshot the ids already wearing this name BEFORE the push: `--unpublished` creates the
      # theme server-side before uploading, so a failed upload needs to know which id APPEARED to
      # reap it — and must never touch a same-named theme that pre-existed.
      load_theme_list
      PRE_NAME_IDS="$(theme_ids_by_name "$NAME" | grep '^[0-9][0-9]*$' | tr '\n' ' ' || true)"
      if ! push_retry "$ERR" shopify theme push --store "$STORE" --unpublished --theme "$NAME" --path "$TMP_CODE" "${IGN[@]}" ${EXTRA_IGN[@]+"${EXTRA_IGN[@]}"} --json; then
        # The CLI boxes its cap message ("│  A shop may only have 100 themes  │") — match the sentence, not the box.
        grep -qiE 'theme limit|maximum number of themes|too many themes|may only have [0-9]+ themes' "$ERR" \
          && { rm -f "$ERR"; fail "theme_limit — store is at its theme cap (20 non-Plus / 100 Plus). Delete an old theme or re-run with --reuse."; }
        push_fail push_code_failed "$NAME"
      fi
      OUT="$PUSH_OUT"
    fi
    rm -f "$ERR"

    THEME_ID="$(json_field "$OUT" id)"
    PREVIEW="$(json_field "$OUT" preview_url)"
    EDITOR="$(json_field "$OUT" editor_url)"
    [ -n "$THEME_ID" ] || fail "code push succeeded but could not parse theme id from --json"

    # 2) overlay the dev theme's customizer settings onto the new theme.
    #    On drift this exits error=settings_drift (and removes the just-created theme).
    overlay_settings "$THEME_ID" "$REUSED"

    # 3) pin, non-fatally: the theme is real by now, and a config hiccup that took the run
    #    non-zero would cost the caller the id it needs to reuse (or delete) it.
    #    The id is re-vetted first — it came out of `--json`, and a gid
    #    (`gid://shopify/OnlineStoreTheme/…`, a shape this CLI really does emit) written into the
    #    config would make every later run of this script die on `invalid_dev_theme_id` inside a
    #    gitignored file only a hand edit can repair. `refresh --pin-toml` pins its own vetted
    #    $TARGET for the same reason.
    if [ "$PIN" -eq 1 ]; then
      case "$THEME_ID" in
        *[!0-9]*) PIN_FAIL="the push reported a non-numeric theme id ('$THEME_ID'), which \`shopify theme dev\` cannot resolve; the theme was created, the config was NOT changed" ;;
        *) pin_toml "$THEME_ID" || PIN_FAIL="$PIN_ERR_KEY $PIN_ERR_MSG; the theme was created, the config was NOT changed" ;;
      esac
    fi

    printf 'theme_id=%s\n' "$THEME_ID"
    printf 'name=%s\n' "$NAME"
    printf 'store=%s\n' "$STORE"
    printf 'preview_url=%s\n' "$PREVIEW"
    printf 'editor_url=%s\n' "$EDITOR"
    printf 'reused=%s\n' "$REUSED"
    printf 'built=%s\n' "$BUILT"
    print_overlay_keys
    [ "$PIN" -eq 0 ] || print_pin_keys
    ;;

  refresh)
    TARGET=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --theme) need_val $# "$1"; TARGET="$2"; shift 2 ;;
        --no-build) NO_BUILD=1; shift ;;
        --build-script) need_val $# "$1"; BUILD_SCRIPT="$2"; shift 2 ;;
        --ignore-extra) need_val $# "$1"; EXTRA_IGN+=(--ignore "$2"); shift 2 ;;
        --pin-toml) PIN=1; shift ;;
        --env) need_val $# "$1"; PIN_ENV="$2"; shift 2 ;;
        *) fail "unknown arg: $1" ;;
      esac
    done
    [ -n "$TARGET" ] || fail "refresh requires --theme <existing theme id>"
    # same guard as create: --env without --pin-toml would be a silent no-op
    [ "$PIN" -eq 1 ] || [ -z "$PIN_ENV" ] || fail "--env requires --pin-toml"
    vet_build_script
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
    if ! push_retry "$ERR" shopify theme push --store "$STORE" --theme "$TARGET" --path "$TMP_CODE" "${IGN[@]}" ${EXTRA_IGN[@]+"${EXTRA_IGN[@]}"} --json; then
      push_fail refresh_push_failed
    fi
    OUT="$PUSH_OUT"
    rm -f "$ERR"

    # $TARGET, not the pushed-back id: it is the vetted numeric id this run targeted, and a
    # --json shape the parser missed must never silently pin an empty value.
    if [ "$PIN" -eq 1 ]; then
      pin_toml "$TARGET" || PIN_FAIL="$PIN_ERR_KEY $PIN_ERR_MSG; the refresh landed, the config was NOT changed"
    fi

    printf 'theme_id=%s\n' "$(json_field "$OUT" id)"
    printf 'store=%s\n' "$STORE"
    printf 'preview_url=%s\n' "$(json_field "$OUT" preview_url)"
    printf 'editor_url=%s\n' "$(json_field "$OUT" editor_url)"
    printf 'built=%s\n' "$BUILT"
    [ "$PIN" -eq 0 ] || print_pin_keys
    ;;

  *)
    fail "usage: create-preview-theme.sh info | create --name \"<name>\" [--reuse] [--no-build] [--build-script <name>] [--ignore-extra \"<glob>\"] [--pin-toml [--env <name>]] | refresh --theme <id> [--no-build] [--build-script <name>] [--ignore-extra \"<glob>\"] [--pin-toml [--env <name>]] | pin --theme <id> [--env <name>]"
    ;;
esac
