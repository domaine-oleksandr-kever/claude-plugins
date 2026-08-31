#!/usr/bin/env bash
# theme-json.sh — read/write a theme's customizer state (the JSON content layer).
#
# What the customizer edits is not code — it's theme JSON: templates/*.json (which sections a
# page has, their order, blocks, per-section settings), sections/*.json (header/footer groups)
# and config/settings_data.json (global theme settings). Foundation repos exclude those paths
# from ALL Shopify CLI sync (.shopifyignore): they are store-owned runtime state, and
# `theme dev`'s watcher will neither upload nor hot-reload them. This script edits that state
# DIRECTLY ON A THEME, so nothing routes through the project working tree and no secret is
# ever exposed.
#
# THREE ENGINES (--engine auto|store|token|themecli):
#   gql      — Admin GraphQL via shopify-admin-gql.sh (which itself picks `shopify store
#              execute` or SHOPIFY_ADMIN_TOKEN). Needs read_themes (+ write_themes for `set`).
#              `--engine store` / `--engine token` force that sub-engine, no CLI fallback.
#   themecli — `shopify theme pull/push --only <file> --nodelete` from a private temp dir,
#              authenticated by the Theme Access token (SHOPIFY_CLI_THEME_TOKEN env, else
#              password= / first shp*_… in shopify.theme.toml — read internally, NEVER printed).
#              This is the token every Foundation project already has for `theme dev`, so the
#              flow works even with no Admin API access at all.
#   auto (default) — gql first; if its credentials are missing (runner exit 3) or lack the
#              theme scopes (ACCESS_DENIED), falls back to themecli when a Theme Access token
#              is available, with a note on stderr.
#
# SAFETY: `set` hard-refuses the live theme (role MAIN / live) on every engine — that is
# merchant-owned content; a human changes it in the customizer. The role check runs
# immediately before each write but check→write is not atomic: a human publishing the
# target theme in that seconds-wide window slips past — a documented residual risk.
# Write only to development/
# unpublished themes, and follow the snapshot protocol (files in a temp dir, never the repo):
#   1. get  --out snapshot.json          # pristine copy (raw — restores byte-exact)
#   2. edit a working copy               # get --strip-comments first; then jq
#   3. set  --from working.json          # read-back verified (below); then check the storefront
#   4. set  --from snapshot.json         # restore
#
# VERIFY (mechanical, both engines): Shopify validates theme JSON server-side and, for some
# payloads, KEEPS THE PREVIOUS CONTENT while the write reports success — `shopify theme push`
# exits 0, `themeFilesUpsert` returns no userErrors, and the theme still serves the old file.
# Every `set` therefore pulls the file back and compares it against the payload: for *.json
# normalized (banner comments stripped, `jq -S` key order) so Shopify's re-stamped /*…*/ header
# is not a diff, raw bytes (modulo trailing newlines) for anything else. A mismatch is retried
# ONCE after FND_THEME_JSON_VERIFY_WAIT seconds, default 2 (a read straight after a write can
# still serve the old copy). Landed →
# `verified=true` on the result line; the read-back does NOT carry the payload →
# `error=not_applied` + hint + exit 6; the read-back itself unable to produce the file (including
# a throttled/5xx/garbled gql read — the mutation already ran, so it is never retried on the
# other engine) → `error=verify_read_failed` + hint + the same exit 6 (state unconfirmed, not
# known-stale). NOTE the one degradation: normalizing a *.json body needs perl, and on a host
# without it (or with a perl that will not run) the compare is raw bytes, which cannot tell a
# re-stamped banner from a dropped write — so there a MISMATCH is `verified=unverified` + exit 0,
# not `not_applied`, noted on stderr as `note=verify_raw_compare` (fail-open, the same direction
# the `set` json guard degrades in; a raw MATCH is still proof, `verified=true`). A read-back
# that does NOT strip+parse as JSON on a host that can normalize is a different story and not a
# degradation: the payload is gated as valid JSON before the upload, so a theme serving a
# non-JSON body is not serving the payload — `note=verify_body_not_json` and the ordinary
# not_applied verdict. On themecli the
# push's own --json envelope is gated FIRST, so a failed upload is never reported as not_applied:
# a non-empty `.errors` is `error=cli_push_reported_errors` + exit 5 before any read-back, while
# `.warnings` only print `note=cli_push_warnings` and let the read-back decide.
# FND_THEME_JSON_VERIFY=0 skips the read-back and prints `verified=skipped`.
#
# What verify does NOT establish: no pre-image is read before the write, so a mismatch proves
# only "the theme does not serve the payload" — never "the theme still holds exactly what it
# held before". Treat exit 6 as "state diverged, go look", and restore from the snapshot if the
# `get` shows it changed.
#
# Usage:
#   theme-json.sh themes [--role main|development|unpublished|live|demo]
#   theme-json.sh get  --theme <id|gid> --file <path/in/theme.json> [--out <file>] [--strip-comments]
#   theme-json.sh set  --theme <id|gid> --file <path/in/theme.json> --from <file>
# Common: [--store <name|domain>] [--engine auto|store|token|themecli] [--env <path>]
#          [--api-version <v>]   (store domain defaults from shopify.theme.toml)
#
# --strip-comments removes /*…*/ blocks that sit OUTSIDE JSON strings (Shopify's auto-generated
# banner) so the result is plain JSON a jq edit can consume; a `/*` inside a value (custom_css) is
# content and survives. Lossless — Shopify re-stamps the banner on every write. Snapshot WITHOUT it
# (raw bytes restore byte-exact); strip only the working base you'll edit.
#
# Output: `themes` prints one {"id","name","role"} JSON per line (gid + UPPERCASE role on every
# engine); `get` prints the raw file body (--out preserves exact bytes) — an inline body over
# 8 KB to any non-TTY (pipes and `>` redirects alike) is suppressed as a self-describing
# `note=large_file … NOT the file content` line (a settings_data.json is 30–150 KB of context
# burn; a human terminal still prints in full; a redirect-snapshot of the note fails `set`'s
# json validation before any upload — real snapshots use --out); `set` prints a
# one-line result incl. the engine used and `verified` ("true" = read back and compared,
# "skipped" = FND_THEME_JSON_VERIFY=0, "unverified" = read back but this host could not normalize
# the JSON to compare it — see VERIFY above), or an `error=not_applied …` /
# `error=verify_read_failed …` line on stdout with the fix hint on stderr.
# GraphQL errors print the {"errors":…} head on stdout (partial data stripped) with exit 5 and
# the FULL envelope at a `log=<path>` mktemp (plus a scope hint when it looks like a missing
# read_themes/write_themes grant).
# Exit: 0 ok · 2 usage · 4 live-theme write refused · 5 GraphQL/user/CLI errors · 3 no engine
# credentials at all (hints name every remedy) · 6 the write reported success but the theme does
# not serve the payload (read-back mismatch, or the read-back itself failed — state unconfirmed).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$SCRIPT_DIR/shopify-admin-gql.sh"
[ -x "$RUNNER" ] || { echo "error=runner_not_found path=$RUNNER" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "error=jq_not_found" >&2; exit 2; }

CMD="${1:-}"; [ $# -gt 0 ] && shift
case "$CMD" in themes|get|set) ;; *) echo "error=unknown_command cmd='$CMD' (use themes|get|set)" >&2; exit 2 ;; esac

THEME=""; FILE=""; OUT=""; FROM=""; ROLE_FILTER=""; STRIP=0
ENGINE="auto"; STORE_ARG=""; ENV_ARG=""; APIV_ARG=""
TOML="${TOML_PATH:-shopify.theme.toml}"

need_val() { [ "$1" -ge 2 ] || { echo "error=missing_value flag=$2" >&2; exit 2; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --theme) need_val $# "$1"; THEME="$2"; shift 2 ;;
    --file)  need_val $# "$1"; FILE="$2"; shift 2 ;;
    --out)   need_val $# "$1"; OUT="$2"; shift 2 ;;
    --from)  need_val $# "$1"; FROM="$2"; shift 2 ;;
    --role)  need_val $# "$1"; ROLE_FILTER="$2"; shift 2 ;;
    --strip-comments) STRIP=1; shift ;;
    --engine) need_val $# "$1"; ENGINE="$2"; shift 2 ;;
    --store)  need_val $# "$1"; STORE_ARG="$2"; shift 2 ;;
    --env)    need_val $# "$1"; ENV_ARG="$2"; shift 2 ;;
    --api-version) need_val $# "$1"; APIV_ARG="$2"; shift 2 ;;
    *) echo "error=unknown_arg arg=$1" >&2; exit 2 ;;
  esac
done
case "$ENGINE" in auto|store|token|themecli) ;; *) echo "error=invalid_engine engine=$ENGINE (use auto|store|token|themecli)" >&2; exit 2 ;; esac
# validate --role at parse time — a typo (`--role dev`) must not read as "no themes", exit 0
case "$ROLE_FILTER" in ''|main|development|unpublished|live|demo|MAIN|DEVELOPMENT|UNPUBLISHED|LIVE|DEMO) ;;
  *) echo "error=invalid_role role=$ROLE_FILTER (use main|development|unpublished|live|demo)" >&2; exit 2 ;;
esac

RUNNER_ARGS=()
[ -n "$STORE_ARG" ] && RUNNER_ARGS+=(--store "$STORE_ARG")
[ -n "$ENV_ARG" ]   && RUNNER_ARGS+=(--env "$ENV_ARG")
[ -n "$APIV_ARG" ]  && RUNNER_ARGS+=(--api-version "$APIV_ARG")
case "$ENGINE" in store|token) RUNNER_ARGS+=(--engine "$ENGINE") ;; esac

CLEAN=()
cleanup() { for d in ${CLEAN[@]+"${CLEAN[@]}"}; do rm -rf "$d"; done; }
trap cleanup EXIT

gid_of() {
  case "$1" in
    gid://shopify/OnlineStoreTheme/*) printf '%s' "$1" ;;
    *[!0-9]*|'') echo "error=bad_theme_id value='$1' (numeric id or gid://shopify/OnlineStoreTheme/…)" >&2; exit 2 ;;
    *) printf 'gid://shopify/OnlineStoreTheme/%s' "$1" ;;
  esac
}
num_of() {
  case "$1" in
    gid://shopify/OnlineStoreTheme/*) printf '%s' "${1##*/}" ;;
    *[!0-9]*|'') echo "error=bad_theme_id value='$1' (numeric id or gid://shopify/OnlineStoreTheme/…)" >&2; exit 2 ;;
    *) printf '%s' "$1" ;;
  esac
}

# /*…*/ removal that tracks JSON string state. A plain `s{/\*.*?\*/}{}gs` CANNOT do this job: a `/*`
# inside a custom_css value plus a `*/` in any later value makes it delete every key in between and
# still emit VALID JSON, so the `set` guard passes and corrupted settings upload silently. Escapes
# (\" \\) are honored; an UNTERMINATED comment stays in place so the json guard fails loudly instead
# of eating the tail. Leading whitespace goes (the result starts at `{`); no byte is ever appended.
# The file rides a shell redirect, not @ARGV — perl's <> would treat a path with `>` or a trailing
# space as an open() expression.
strip_json_comments() { # $1 = file, body to stdout
  perl -0777 -e '
    my $s = <>; my $n = length $s; my @o;
    pos($s) = 0;
    while (pos($s) < $n) {
      if ($s =~ /\G([^"\/]+)/gsc)           { push @o, $1; next }   # neutral run
      if ($s =~ /\G("(?:[^"\\]|\\.)*")/gsc) { push @o, $1; next }   # whole string verbatim
      if ($s =~ m{\G/\*.*?\*/}gsc)          { next }                # comment
      if ($s =~ /\G(.)/gsc)                 { push @o, $1; next }   # lone " or /
      last;
    }
    my $out = join "", @o;
    $out =~ s/\A\s+//;
    print $out;
  ' < "$1"
}

# shared output path for `get` — $1 is a file holding the raw body
emit_file() {
  filter() {
    if [ "$STRIP" -eq 1 ]; then
      command -v perl >/dev/null 2>&1 || { echo "error=strip_needs_perl" >&2; exit 2; }
      strip_json_comments "$1"
    else
      cat "$1"
    fi
  }
  if [ -n "$OUT" ]; then
    # a failed snapshot write must be a hard stop — the snapshot→mutate→restore protocol
    # has nothing to restore from if this silently fails
    filter "$1" > "$OUT" \
      || { echo "error=out_write_failed out=$OUT (no snapshot written — do NOT proceed to mutate)" >&2; exit 5; }
    echo "ok=saved file=$FILE out=$OUT bytes=$(wc -c < "$OUT" | tr -d ' ')" >&2
  else
    local body bytes
    body="$(mktemp)"; CLEAN+=("$body")
    filter "$1" > "$body"
    bytes="$(wc -c < "$body" | tr -d ' ')"
    # every non-TTY caller is suppressed — pipes AND file redirects: the model's Bash
    # harness captures via a file redirect, indistinguishable from `> snap.json`, so the
    # note is self-describing and a later `set --from <note-file>` fails json validation
    # before any upload (fail-closed). Real snapshots go through --out (byte-exact).
    if [ "$bytes" -gt 8192 ] && [ ! -t 1 ]; then
      echo "note=large_file bytes=$bytes file=$FILE — body suppressed, this line is NOT the file content; re-run with --out <path> and pull what you need with jq"
      return 0
    fi
    cat "$body"; echo
  fi
}

live_refuse() { # $1 name
  echo "error=live_theme_write_refused theme='$1' role=MAIN — the live theme is merchant-owned content; write to a development/unpublished theme instead" >&2
  exit 4
}

# ------------------------------------------------- read-back verify (shared) --
# Both engines report success from the transport alone (push exit code / empty userErrors),
# and Shopify's server-side validation silently keeps the previous content for payloads it
# rejects — so `set` is only believable after reading the file back. One comparison helper,
# two engine-specific readers.
VERIFY=1
[ "${FND_THEME_JSON_VERIFY:-1}" = "0" ] && VERIFY=0
# Pause before the ONE read-back retry: a read issued straight after a write can still be served
# the old copy, so the default buys the write a moment to land. The suites pass 0 — every
# not_applied case would otherwise pay it. A non-numeric value falls back to the default rather
# than handing `sleep` an argument it refuses under `set -e` — including `1.2.3`, which a
# bytes-only filter would let through.
VERIFY_WAIT="${FND_THEME_JSON_VERIFY_WAIT:-2}"
case "$VERIFY_WAIT" in ''|.|*.*.*|*[!0-9.]*) VERIFY_WAIT=2 ;; esac

# normalize_body <file> → stdout: the comparable form of a theme file body. *.json rides
# strip_json_comments (Shopify re-stamps its /*…*/ banner on every write, so the banner is not
# a difference) and then `jq -S .` (neither is key order or whitespace). Anything else — a
# non-.json file — compares as RAW bytes minus trailing newlines: the CLI's pull can hand back a
# body with a newline the payload did not have, and that is not a dropped write.
# TWO different failures hide behind "we could not normalize", and they point opposite ways:
#   HOST — this machine cannot normalize *.json at all (no perl, or a perl that will not run).
#          Shopify re-stamps its banner and reserializes on EVERY successful write, so a raw
#          compare then differs for every real `set`: a mismatch is no evidence and the verdict
#          fails OPEN (unverified). A property of the machine, so the flag lives for the run.
#   BODY — perl ran and the READ-BACK did not parse as JSON after stripping. `set` gates the
#          payload as valid JSON before any upload, so a theme serving a non-JSON body is a
#          theme not serving the payload: that is a MISMATCH, and it belongs on the not_applied
#          path. A property of ONE read-back, so it resets per attempt — a garbled attempt 1
#          must not decide the outcome of a clean attempt 2.
VERIFY_HOST_NOTED=0
VERIFY_HOST_DEGRADED=0
VERIFY_BODY_NOTED=0
VERIFY_BODY_UNPARSED=0
# which side of the compare normalize_body is working on: only the READ-BACK's failure to parse
# says anything about the write, and the intended payload degrades fail-open like the host case
NORM_SIDE=intended
verify_raw_note() { # $1 = why
  VERIFY_HOST_DEGRADED=1
  [ "$VERIFY_HOST_NOTED" -eq 1 ] && return 0
  VERIFY_HOST_NOTED=1
  echo "note=verify_raw_compare ($1 — comparing raw bytes, which cannot tell Shopify's re-stamped /*…*/ banner from a lost write, so a difference is reported as unverified)" >&2
}
verify_body_note() { # $1 = why
  [ "$NORM_SIDE" = "read_back" ] || { verify_raw_note "$1"; return 0; }
  VERIFY_BODY_UNPARSED=1
  [ "$VERIFY_BODY_NOTED" -eq 1 ] && return 0
  VERIFY_BODY_NOTED=1
  echo "note=verify_body_not_json ($1 — the payload is validated as JSON before the upload, so a read-back that will not parse is not the payload)" >&2
}
raw_body() { # trailing newlines are not content for this comparison; $() eats them on both sides
  printf '%s' "$(cat "$1")"
}
normalize_body() {
  local s t
  case "$FILE" in *.json) ;; *) raw_body "$1"; return 0 ;; esac
  if ! command -v perl >/dev/null 2>&1; then
    verify_raw_note "no perl to strip /*…*/ comments"
    raw_body "$1"; return 0
  fi
  s="$(mktemp)"; t="$(mktemp)"; CLEAN+=("$s" "$t")
  # the strip and the parse are graded SEPARATELY: a perl that exits non-zero is the host's
  # limitation, a body jq then refuses is the body's, and one verdict for both fails the wrong way
  if ! strip_json_comments "$1" > "$s" 2>/dev/null; then
    verify_raw_note "perl is present but could not strip /*…*/ comments"
    raw_body "$1"; return 0
  fi
  if jq -S . < "$s" > "$t" 2>/dev/null; then cat "$t"; return 0; fi
  verify_body_note "the body did not parse as JSON after stripping /*…*/ comments"
  raw_body "$1"
}

# bodies_match <intended> <read-back> — 0 when the write landed. Called with redirects (never
# in a command substitution) so normalize_body's flags and one-shot notes survive the call.
bodies_match() {
  local a b
  a="$(mktemp)"; b="$(mktemp)"; CLEAN+=("$a" "$b")
  NORM_SIDE=intended;  normalize_body "$1" > "$a"
  NORM_SIDE=read_back; normalize_body "$2" > "$b"
  NORM_SIDE=intended
  cmp -s "$a" "$b"
}

# verify_applied <engine> <theme-id> <reader-fn>: reader-fn <dest> writes the theme's current
# copy of $FILE to <dest> (non-zero = could not read it). Compares against $FROM and, on a
# mismatch, retries ONCE after a short sleep — a read issued right after a write can still be
# served the old copy, and a false `not_applied` would send the caller chasing a phantom.
# Returns 0 = the payload is on the theme; 2 = compared raw and it differed, which on this host
# is not evidence either way (VERIFY_HOST_DEGRADED); both real failure modes exit 6 and never
# return.
verify_applied() {
  local engine="$1" theme="$2" reader="$3" back rc=0 attempt=1
  while : ; do
    VERIFY_BODY_UNPARSED=0   # a per-attempt fact; the last attempt's read-back is the one judged
    back="$(mktemp)"; CLEAN+=("$back")
    rc=0; "$reader" "$back" || rc=$?
    if [ "$rc" -eq 0 ] && bodies_match "$FROM" "$back"; then return 0; fi
    [ "$attempt" -eq 1 ] || break
    # non-fatal: the mutation already committed, so dying on sleep's complaint instead of
    # printing the verdict (or the exit-6 hint) would strand the caller with no read-back at all
    attempt=2; sleep "$VERIFY_WAIT" || true
  done
  if [ "$rc" -ne 0 ]; then
    echo "error=verify_read_failed engine=$engine theme=$theme file=$FILE"
    echo "hint=the write reported success but the file could not be read back, so the theme's state is unconfirmed — re-run \`theme-json.sh get --theme $theme --file $FILE\` before assuming either outcome" >&2
    exit 6
  fi
  if [ "$VERIFY_BODY_UNPARSED" -eq 0 ] && [ "$VERIFY_HOST_DEGRADED" -eq 1 ]; then
    # a raw compare said "different" — but see note=verify_raw_compare: on this host that also
    # describes a write that landed and came back with its banner re-stamped. Fail OPEN and say
    # the state is unknown, the same direction the `set` json guard degrades in.
    echo "note=verify_unverified engine=$engine theme=$theme file=$FILE — the read-back differs from the payload, but this host could not normalize the JSON to compare it (see note=verify_raw_compare), so this is NOT evidence the write was dropped. Confirm with \`theme-json.sh get --theme $theme --file $FILE\`; install perl to get the real verdict." >&2
    return 2
  fi
  echo "error=not_applied engine=$engine theme=$theme file=$FILE"
  # No pre-image is read before the write, so the ONE proven statement is "the theme does not
  # serve the payload" — claiming the previous content survived would waive the restore step on
  # a theme that may well have changed.
  echo "hint=the write reported success but the theme does NOT serve the payload — the usual cause is Shopify validating it server-side, dropping it and keeping the previous content. Two known triggers: an attribute the setting's schema does not support, and a non-canonical dynamic-source string — write '{{ ….value }}', a .value after EVERY reference hop, the form the customizer itself stores. Fix the payload and re-run — and \`theme-json.sh get --theme $theme --file $FILE\` to see what the theme holds now, restoring your snapshot if it is neither the payload nor the content you started from." >&2
  exit 6
}

# ---------------------------------------------------------------- gql engine --
# gql <query> <variables>: fills RESP. Returns 0 = ok; 1 = fall back to themecli (auto mode,
# credentials missing/insufficient AND a Theme Access token exists); exits on hard failures —
# EXCEPT while GQL_SOFT=1 (the post-mutation read-back), where every hard failure returns 2
# instead. Exiting from inside the read-back would print the pre-existing `error=gql_errors`
# exit 5 — byte-identical to "the upsert itself failed" — for a write that already committed,
# and Admin API throttling right after a mutation is an ordinary condition, not a new failure.
GQL_NOTE=""
GQL_SOFT=0
gql() {
  local qf vf rerr rc=0
  qf="$(mktemp)"; vf="$(mktemp)"; rerr="$(mktemp)"; CLEAN+=("$qf" "$vf" "$rerr")
  printf '%s\n' "$1" > "$qf"
  # variables ride a file, not argv — a whole settings_data.json body can exceed the
  # kernel's per-argument limit (MAX_ARG_STRLEN) and die as "Argument list too long"
  printf '%s' "$2" > "$vf"
  RESP="$("$RUNNER" --query "$qf" --variables-file "$vf" ${RUNNER_ARGS[@]+"${RUNNER_ARGS[@]}"} 2>"$rerr")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    # fall back only on "neither admin engine set up" (error=no_admin_token) — the runner also
    # exits 3 for store_execute_failed_mutation, where a themecli re-push could double-apply, and
    # for error=invalid_admin_token, which is DELIBERATELY fatal here: a malformed token is a broken
    # config someone tried to set up, and a silent themecli fallback would mask it indefinitely
    if [ "$ENGINE" = "auto" ] && [ "$rc" -eq 3 ] && grep -q 'error=no_admin_token' "$rerr" \
        && cli_token_ready; then
      GQL_NOTE="admin credentials not set up"
      return 1
    fi
    if [ "$GQL_SOFT" -eq 1 ]; then tail -3 "$rerr" >&2; return 2; fi
    cat "$rerr" >&2
    [ "$rc" -eq 3 ] && echo "hint=the theme-CLI engine is a third option — put the Theme Access password in $TOML or export SHOPIFY_CLI_THEME_TOKEN" >&2
    exit "$rc"
  fi
  # ONE pass over the envelope answers both "is it JSON" (jq's exit status) and "is it an error
  # envelope" (the printed token) — a settings_data.json response is 100s of KB and each extra jq
  # walk costs ~10 ms. Only a NON-ZERO jq exit means "not JSON": a valid non-object envelope and a
  # response yielding no value at all must both fall through to the shape checks.
  local status="" jrc=0
  status="$(printf '%s' "$RESP" | jq -r 'if type == "object" and has("errors") then "errors" else "ok" end' 2>/dev/null)" || jrc=$?
  # one line per input document, so a second line means this is not ONE envelope. Every check below
  # would then read the first document's answer glued to the rest — including `set`'s live-theme
  # refusal, whose `.data.theme.role` comparison would silently stop matching MAIN.
  case "$status" in *$'\n'*) jrc=1 ;; esac
  if [ "$jrc" -ne 0 ]; then
    # GQL_SOFT is gated FIRST, exactly as the errors branch below: inside the post-mutation
    # read-back a transient 5xx is an ordinary condition on a run that goes on to exit 0
    # verified, and an `error=` line on its stderr reads as a failed write. The log file is
    # still written (a garbled body is worth keeping) but joins CLEAN so the soft path leaks
    # nothing into $TMPDIR.
    local lf; lf="$(mktemp)"; printf '%s\n' "$RESP" > "$lf"
    if [ "$GQL_SOFT" -eq 1 ]; then CLEAN+=("$lf"); head -c 400 "$lf" >&2; echo >&2; return 2; fi
    echo "error=non_json_response log=$lf" >&2
    head -c 600 "$lf" >&2; echo >&2
    exit 5
  fi
  if [ "$status" = "errors" ]; then
    if [ "$GQL_SOFT" -eq 1 ]; then
      # never gql_err_report here: its errors head goes to STDOUT, which in a read-back is the
      # channel the error=verify_read_failed line owns
      printf '%s' "$RESP" | jq -c '{errors}' 2>/dev/null | head -c 400 >&2; echo >&2
      return 2
    fi
    if printf '%s' "$RESP" | grep -qi 'ACCESS_DENIED\|access denied'; then
      if [ "$ENGINE" = "auto" ] && cli_token_ready; then
        GQL_NOTE="admin credential lacks read_themes/write_themes"
        return 1
      fi
      gql_err_report
      echo "hint=the credential lacks read_themes/write_themes — re-run \`shopify store auth --store <domain> --scopes <existing>,read_themes,write_themes\`, extend the custom app's scopes, or use --engine themecli (Theme Access token)" >&2
      exit 5
    fi
    gql_err_report
    exit 5
  fi
}

# an error envelope's partial `data` can drag a whole theme file along — print only the
# errors object (head-capped); the full envelope stays readable at log= (mktemp, NOT in
# CLEAN — it must survive exit)
gql_err_report() {
  local lf; lf="$(mktemp)"; printf '%s\n' "$RESP" > "$lf"
  printf '%s' "$RESP" | jq -c '{errors}' 2>/dev/null | head -c 600; echo
  echo "error=gql_errors log=$lf (full envelope at log=)" >&2
}

# role filter applied inside each engine fn so `themes` streams straight to stdout (no capture);
# the user's `live` is already normalized to the GraphQL enum MAIN at dispatch
role_filter() {
  if [ -n "$ROLE_FILTER" ]; then jq -c --arg r "$ROLE_FILTER" 'select(.role == ($r | ascii_upcase))'
  else cat; fi
}

gql_themes_lines() {
  gql 'query FndThemesList { themes(first: 250) { nodes { id name role } } }' '{}' || return 1
  printf '%s' "$RESP" | jq -c '.data.themes.nodes[]' | role_filter
}

# one query text for the two readers (`get` and the `set` read-back) — a second copy would be
# free to drift into asking for a different shape than the status pass below parses
GQL_FILE_GET='query FndThemeFileGet($id: ID!, $filenames: [String!]!) {
    theme(id: $id) {
      id name role
      files(filenames: $filenames, first: 1) {
        nodes { filename updatedAt body { ... on OnlineStoreThemeFileBodyText { content } } }
        userErrors { filename code }
      }
    }
  }'

gql_get() {
  local gid; gid="$(gid_of "$THEME")"
  gql "$GQL_FILE_GET" "$(jq -n --arg id "$gid" --arg f "$FILE" '{id: $id, filenames: [$f]}')" || return 1
  # ONE status pass, deciding in the caller-visible order: theme missing → file userErrors → body
  # missing (callers branch on which error comes first, so the order is a contract). The body stays
  # its own `jq -rj` pass — that trailing-newline-free write IS the byte-exact restore promise.
  local st=""
  st="$(printf '%s' "$RESP" | jq -r '
    . as $r
    | (try $r.data.theme.files.userErrors catch null) // [] | tojson as $ue
    | if ((try $r.data.theme catch null) // null) == null then "no_theme"
      elif $ue != "[]" then "ue " + $ue
      elif ((try $r.data.theme.files.nodes[0].body.content catch null) // null) == null then "no_body"
      else "ok" end' 2>/dev/null)" || st=""
  case "$st" in
    ok) ;;
    "ue "*)  echo "error=file_user_errors file=$FILE ${st#ue }" >&2; exit 5 ;;
    no_body) echo "error=file_not_found_or_not_text file=$FILE theme=$gid" >&2; exit 5 ;;
    *)       echo "error=theme_not_found theme=$gid" >&2; exit 5 ;;
  esac
  local raw; raw="$(mktemp)"; CLEAN+=("$raw")
  printf '%s' "$RESP" | jq -rj '.data.theme.files.nodes[0].body.content' > "$raw"
  emit_file "$raw"
}

# read-back reader for verify_applied. NOTHING in here may leave the script: a `gql` hand-back
# (return 1 = "fall back to themecli") must not propagate, because the mutation already ran and
# re-running it on the other engine would double-apply — and neither may `gql`'s own hard
# failures (throttled/error envelope, non-JSON body, runner exit), which GQL_SOFT turns into a
# return 2. Every one of them reads as an unreadable file, which verify_applied retries and then
# reports as error=verify_read_failed + exit 6.
gql_read_back() { # $1 = dest file
  local rc=0
  GQL_SOFT=1
  gql_read_back_inner "$1" || rc=$?
  GQL_SOFT=0
  return "$rc"
}
gql_read_back_inner() { # $1 = dest file
  local gid st=""
  gid="$(gid_of "$THEME")"
  gql "$GQL_FILE_GET" "$(jq -n --arg id "$gid" --arg f "$FILE" '{id: $id, filenames: [$f]}')" || return 1
  st="$(printf '%s' "$RESP" | jq -r '
    if ((try .data.theme.files.nodes[0].body.content catch null) // null) == null then "no" else "ok" end' 2>/dev/null)" || st="no"
  [ "$st" = "ok" ] || return 1
  printf '%s' "$RESP" | jq -rj '.data.theme.files.nodes[0].body.content' > "$1"
}

gql_set() {
  local gid role name ue verified="skipped"
  gid="$(gid_of "$THEME")"
  gql 'query FndThemeMeta($id: ID!) { theme(id: $id) { id name role } }' \
      "$(jq -n --arg id "$gid" '{id: $id}')" || return 1
  role="$(printf '%s' "$RESP" | jq -r '.data.theme.role // empty')"
  name="$(printf '%s' "$RESP" | jq -r '.data.theme.name // empty')"
  [ -n "$role" ] || { echo "error=theme_not_found theme=$gid" >&2; exit 5; }
  [ "$role" = "MAIN" ] && live_refuse "$name"
  gql 'mutation FndThemeFileSet($id: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $id, files: $files) {
      upsertedThemeFiles { filename }
      userErrors { field message code }
    }
  }' "$(jq -n --arg id "$gid" --arg f "$FILE" --rawfile body "$FROM" \
        '{id: $id, files: [{filename: $f, body: {type: "TEXT", value: $body}}]}')" || return 1
  ue="$(printf '%s' "$RESP" | jq -c '.data.themeFilesUpsert.userErrors // []')"
  [ "$ue" = "[]" ] || { local lf; lf="$(mktemp)"; printf '%s\n' "$RESP" > "$lf"
    echo "error=upsert_user_errors $(printf '%s' "$ue" | head -c 600) log=$lf" >&2; exit 5; }
  # no userErrors is NOT proof the content landed — read it back (exits 6 when it did not).
  # NEVER inside a command substitution: verify_applied's exit 6 would only kill the subshell.
  if [ "$VERIFY" -eq 1 ]; then
    local vrc=0; verify_applied gql "$gid" gql_read_back || vrc=$?
    if [ "$vrc" -eq 0 ]; then verified="true"; else verified="unverified"; fi
  fi
  jq -nc --arg name "$name" --arg role "$role" --arg f "$FILE" --arg v "$verified" \
    '{ok: "upserted", engine: "gql", theme: $name, role: $role, files: [$f], verified: $v}'
}

# ----------------------------------------------------------- themecli engine --
# TOML scalar reader: handles "…" / '…' / bare values, drops a trailing comment only OUTSIDE quotes,
# tolerates CRLF. All three shapes occur in real shopify.theme.toml files, and a `"`-only sed
# (`s/^[^"]*"([^"]*)".*/\1/`) silently returns the WHOLE LINE for the other two — `store = 'x'`
# becomes the domain `store = 'x'.myshopify.com` and a single-quoted password= is exported as the
# Theme Access token. Byte-identical copies live in create-preview-theme.sh and
# shopify-admin-gql.sh — the plugin installs by git clone, so every script stands alone; keep the
# three in sync.
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

DOMAIN=""
resolve_domain() {
  local s="$STORE_ARG"
  [ -z "$s" ] && s="${SHOPIFY_STORE:-}"
  if [ -z "$s" ]; then s="$(toml_value store)" || true; fi
  [ -n "$s" ] || { echo "error=no_store (pass --store or set store= in $TOML)" >&2; exit 2; }
  # `shopify --store` documents the full URL form as valid, so the scheme is stripped, not refused;
  # what is left must be a shop handle, because a mis-parse handed to the CLI is an opaque error at
  # best and the wrong store at worst
  s="${s#http://}"; s="${s#https://}"; s="${s%/}"
  case "$s" in ''|*[!A-Za-z0-9.-]*)
    echo "error=invalid_store store='$s' (expected a myshopify handle, <handle>.myshopify.com or its https:// URL)" >&2; exit 2 ;;
  esac
  case "$s" in *.myshopify.com) DOMAIN="$s" ;; *) DOMAIN="${s}.myshopify.com" ;; esac
}

# Theme Access token: env wins, else shopify.theme.toml (password=, else first shp*_…).
# Read internally and exported ONLY for the `shopify` subprocess — never printed.
cli_token_ready() {
  [ -n "${SHOPIFY_CLI_THEME_TOKEN:-}" ] && return 0
  [ -f "$TOML" ] || return 1
  local t
  t="$(toml_value password)"
  # a password= that is not token-shaped is not a token — fall through to the file-wide scan
  # instead of exporting it (a garbage token surfaces as an opaque CLI 401)
  case "$t" in shp[a-z]*_[A-Za-z0-9]*) ;; *) t="" ;; esac
  [ -n "$t" ] || t="$(grep -oE 'shp[a-z]+_[A-Za-z0-9]+' "$TOML" | head -1)" || true
  [ -n "$t" ] || return 1
  export SHOPIFY_CLI_THEME_TOKEN="$t"
}

prep_cli() {
  command -v shopify >/dev/null 2>&1 || { echo "error=shopify_cli_not_found" >&2; exit 3; }
  resolve_domain
  cli_token_ready || {
    echo "error=no_theme_token (themecli engine needs SHOPIFY_CLI_THEME_TOKEN or a password=/shp*_ token in $TOML)" >&2
    exit 3; }
  if [ -n "$GQL_NOTE" ]; then
    echo "note=gql engine unavailable ($GQL_NOTE) — using the theme-CLI engine (Theme Access token)" >&2
  fi
}

CLI_LIST=""
cli_list() {
  local err rc=0; err="$(mktemp)"; CLEAN+=("$err")
  CLI_LIST="$(shopify theme list --store "$DOMAIN" --json --no-color 2>"$err")" || rc=$?
  if [ "$rc" -ne 0 ] || ! printf '%s' "$CLI_LIST" | jq empty >/dev/null 2>&1; then
    echo "error=cli_list_failed" >&2; tail -5 "$err" >&2; exit 5
  fi
}

cli_themes_lines() {
  cli_list
  printf '%s' "$CLI_LIST" | jq -c \
    '.[] | {id: ("gid://shopify/OnlineStoreTheme/" + (.id|tostring)), name,
            role: (if .role == "live" then "MAIN" else (.role|ascii_upcase) end)}' | role_filter
}

cli_get() {
  local nid tmp err
  nid="$(num_of "$THEME")"
  tmp="$(mktemp -d)"; err="$(mktemp)"; CLEAN+=("$tmp" "$err")
  shopify theme pull --store "$DOMAIN" --theme "$nid" --path "$tmp" \
      --only "$FILE" --nodelete --no-color >/dev/null 2>"$err" \
    || { echo "error=cli_pull_failed theme=$nid" >&2; tail -5 "$err" >&2; exit 5; }
  [ -f "$tmp/$FILE" ] || { echo "error=file_not_found file=$FILE theme=$nid (engine=themecli)" >&2; exit 5; }
  emit_file "$tmp/$FILE"
}

# read-back reader for verify_applied — the `cli_get` pull mechanics into a private temp dir,
# minus the emit path (the body goes to a file, never to stdout)
cli_read_back() { # $1 = dest file
  local nid d e
  nid="$(num_of "$THEME")"
  d="$(mktemp -d)"; e="$(mktemp)"; CLEAN+=("$d" "$e")
  shopify theme pull --store "$DOMAIN" --theme "$nid" --path "$d" \
      --only "$FILE" --nodelete --no-color >/dev/null 2>"$e" \
    || { tail -3 "$e" >&2; return 1; }
  [ -f "$d/$FILE" ] || return 1
  cat "$d/$FILE" > "$1"
}

# The push's --json envelope. Exit 0 does not mean the server took the file, but when the CLI
# DOES know about per-file trouble it says so here. The shape varies across CLI versions, so only
# a parseable envelope with a non-empty `errors` is fatal; `warnings` are surfaced as a note and
# the read-back below decides the outcome.
cli_push_report() { # $1 = raw --json output; $2 = theme id, for the recovery hint
  local errs warns
  printf '%s' "$1" | jq empty >/dev/null 2>&1 || return 0
  errs="$(printf '%s' "$1" | jq -c 'try (.errors // null) catch null | if . == null or . == [] or . == {} or . == "" then empty else . end' 2>/dev/null)" || errs=""
  warns="$(printf '%s' "$1" | jq -c 'try (.warnings // null) catch null | if . == null or . == [] or . == {} or . == "" then empty else . end' 2>/dev/null)" || warns=""
  if [ -n "$warns" ]; then echo "note=cli_push_warnings $(printf '%s' "$warns" | head -c 400)" >&2; fi
  if [ -n "$errs" ]; then
    echo "error=cli_push_reported_errors file=$FILE $(printf '%s' "$errs" | head -c 400)" >&2
    # this exits BEFORE the read-back, so the theme's state is as unconfirmed here as it is on
    # the exit-6 paths — hand over the same way to look
    echo "hint=the upload reported per-file errors and nothing was read back, so the theme's state is unconfirmed — re-run \`theme-json.sh get --theme $2 --file $FILE\` before assuming either outcome" >&2
    exit 5
  fi
}

cli_set() {
  local nid role name tmp err out verified="skipped"
  nid="$(num_of "$THEME")"
  cli_list
  role="$(printf '%s' "$CLI_LIST" | jq -r --arg id "$nid" '.[] | select((.id|tostring) == $id) | .role' | head -1)"
  name="$(printf '%s' "$CLI_LIST" | jq -r --arg id "$nid" '.[] | select((.id|tostring) == $id) | .name' | head -1)"
  [ -n "$role" ] || { echo "error=theme_not_found theme=$nid (engine=themecli)" >&2; exit 5; }
  [ "$role" = "live" ] && live_refuse "$name"
  tmp="$(mktemp -d)"; err="$(mktemp)"; CLEAN+=("$tmp" "$err")
  mkdir -p "$tmp/$(dirname "$FILE")"
  cp "$FROM" "$tmp/$FILE"
  out="$(shopify theme push --store "$DOMAIN" --theme "$nid" --path "$tmp" \
      --only "$FILE" --nodelete --json --no-color 2>"$err")" \
    || { echo "error=cli_push_failed theme=$nid" >&2; tail -8 "$err" >&2; exit 5; }
  cli_push_report "$out" "$nid"
  # rc 0 is the transport's opinion, not the server's — read it back (exits 6 when it did not land)
  if [ "$VERIFY" -eq 1 ]; then
    local vrc=0; verify_applied themecli "$nid" cli_read_back || vrc=$?
    if [ "$vrc" -eq 0 ]; then verified="true"; else verified="unverified"; fi
  fi
  jq -nc --arg name "$name" --arg role "$(printf '%s' "$role" | tr '[:lower:]' '[:upper:]' | sed 's/^LIVE$/MAIN/')" --arg f "$FILE" --arg v "$verified" \
    '{ok: "upserted", engine: "themecli", theme: $name, role: $role, files: [$f], verified: $v}'
}

# ------------------------------------------------------------------ dispatch --
# run_op <gql_fn> <cli_fn>: engine dispatch with auto-fallback (gql fn returns 1 = fall back).
run_op() {
  if [ "$ENGINE" = "themecli" ]; then prep_cli; "$2"; return; fi
  if "$1"; then return; fi
  prep_cli; "$2"
}

case "$CMD" in
  themes)
    case "$ROLE_FILTER" in live|LIVE) ROLE_FILTER="MAIN" ;; esac
    run_op gql_themes_lines cli_themes_lines
    ;;
  get)
    [ -n "$THEME" ] && [ -n "$FILE" ] || { echo "error=usage (get needs --theme and --file)" >&2; exit 2; }
    gid_of "$THEME" >/dev/null   # validate id format HERE — inside $(…) an exit can't stop the flow
    run_op gql_get cli_get
    ;;
  set)
    [ -n "$THEME" ] && [ -n "$FILE" ] && [ -n "$FROM" ] || { echo "error=usage (set needs --theme, --file and --from)" >&2; exit 2; }
    gid_of "$THEME" >/dev/null
    [ -f "$FROM" ] || { echo "error=from_file_not_found file=$FROM" >&2; exit 2; }
    case "$FILE" in
      *.json)
        # theme JSON may carry /* … */ comments (Horizon ships an auto-generated banner in its
        # templates) — Shopify strips them, so validate the stripped variant before refusing
        if ! jq empty "$FROM" >/dev/null 2>&1; then
          if command -v perl >/dev/null 2>&1; then
            strip_json_comments "$FROM" 2>/dev/null | jq empty >/dev/null 2>&1 \
              || { echo "error=from_file_invalid_json file=$FROM" >&2; exit 2; }
          else
            echo "note=json_validation_skipped (no perl to strip /*…*/ comments)" >&2
          fi
        fi ;;
    esac
    run_op gql_set cli_set
    ;;
esac
