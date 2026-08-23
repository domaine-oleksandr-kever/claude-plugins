#!/usr/bin/env bash
# shopify-admin-gql.sh — run an Admin GraphQL query/mutation without exposing secrets.
#
# TWO ENGINES, auto-selected (override with --engine):
#
#   store — Shopify CLI ≥ 4.x `shopify store execute`, using stored `shopify store auth`
#     credentials (a Shopify-managed OAuth app on the store; NO token in the repo at all).
#     Preferred when available. The one-time setup is a MANUAL developer step — it opens a
#     browser and requires the "install apps" permission on the store, which client stores
#     often deny:
#         shopify store auth --store <domain>.myshopify.com --scopes <comma-separated>
#     The stored token is ONLINE and expires — re-run `store auth` when execute reports the
#     auth missing/expired. This script NEVER runs `store auth` itself (it is interactive and
#     would hang a non-TTY run). Mutations: `store execute` refuses them unless
#     --allow-mutations is passed; the script detects a mutation operation and opts in
#     automatically. --operation is supported by extracting that named operation (plus all
#     fragments) into a temp file, because `store execute` has no operationName flag.
#
#   token — classic Admin API access token via curl. Mirrors the create-preview-theme.sh
#     token discipline: the token (shpat_…, scopes like write_metaobjects / write_products) is
#     read straight from the repo's gitignored .env into this subprocess and used ONLY in the
#     request header — it is NEVER printed, NEVER returned to the caller, and never on the
#     curl argv (it goes through a private 0600 curl config file that is removed on exit).
#     Skills must therefore call THIS script and must NOT `Read` the .env file themselves.
#
# Selection (--engine auto, the default): shopify CLI present AND major version ≥ 4 → try
# `store execute`; on PRE-execution failures (CLI missing/old, no stored auth, oversized
# variables) fall back to the token engine with a note on stderr. After an actually
# attempted execute, queries still fall back — MUTATIONS never do: the mutation may have
# been applied server-side before the CLI failed, and re-sending it through the token
# engine would execute it twice. `--engine store` / `--engine token` forces one.
# A store whose `store execute` has already failed on this machine is remembered, so later calls
# jump straight to the token engine instead of re-paying `shopify version` + a doomed execute; a
# SKIPPED execute leaves mutations safe to hand on, since nothing was sent. Only a MACHINE-level
# verdict is remembered (CLI missing `store execute`, no stored store auth) — a per-call skip such
# as an oversized variables payload, and an execute failing for an unrecognized (likely transient)
# reason, never pin the engine. `--engine store` never consults that memory — it always attempts
# and reports.
#
# The store domain comes from shopify.theme.toml's ($TOML_PATH's) FIRST uncommented `store=` line —
# the same pick as create-preview-theme.sh, which matters when a multi-environment toml lists
# several — unless overridden. An `https://` URL is accepted and normalized; anything else that
# cannot be a myshopify handle is refused (exit 2) rather than spliced into the request URL. The
# Theme Access token (shptka_) in shopify.theme.toml is NOT an admin token and is not used here.
#
# Usage:
#   shopify-admin-gql.sh --query <file.graphql> [--operation <name>] [--variables <json>] \
#                        [--variables-file <file.json>] [--out <file>] \
#                        [--env <path>] [--store <name|domain>] [--api-version <ver>] \
#                        [--engine auto|store|token]
#
#   --query          path to a .graphql file (may hold multiple named operations)
#   --operation      operationName to run when the file has more than one operation
#   --variables      JSON string of GraphQL variables (optional)
#   --variables-file file holding the variables JSON — use for large payloads (whole
#                    theme-file bodies): argv has a per-argument kernel limit
#   --out            write the envelope to this file instead of stdout and print a one-line
#                    summary: `ok=1 bytes=N out=<path> errors=<none|first-error head>` —
#                    use for big inspection reads (target the task workspace tmp/), then
#                    pull fields with jq. NEVER the default: theme-json.sh parses this
#                    script's stdout and must keep receiving the full envelope.
#   --env            path to the dotenv file holding the token (default: ./.env; token engine only)
#   --store          store subdomain or full *.myshopify.com (default: from $TOML_PATH / shopify.theme.toml)
#   --api-version    Admin API version (default: 2026-04, or $SHOPIFY_ADMIN_API_VERSION)
#   --engine         auto (default) | store | token
#
# The store→token fallback note prints in full once per store; later runs print
# `note=engine=token`. SHOPIFY_ADMIN_GQL_QUIET set to anything but 0 forces the short form always.
# That marker, the remembered store-engine verdict and the cached CLI version live in one private
# 0700 per-user dir under $TMPDIR (never a guessable flat file in a shared /tmp).
# FND_GQL_PROBE_CACHE = seconds the version + store-engine verdicts stay valid (default 21600);
# 0 re-probes on every call.
#
# For the token engine the token is read from $SHOPIFY_ADMIN_TOKEN (already exported), else from the
# --env file's `SHOPIFY_ADMIN_TOKEN=` line (`export ` prefix, "…"/'…'/bare, a trailing ` #comment`
# and CRLF all handled; last assignment wins). A file value must look like an shp*_ credential and
# neither source may hold whitespace, a quote or a control character — otherwise exit 3
# `error=invalid_admin_token`, never a quote/newline smuggled into the curl config.
#
# Output contract (BOTH engines): stdout is the classic GraphQL envelope — {"data":…} on
# success, {"errors":…} on a GraphQL-level failure — with exit 0 in both cases (mirrors the
# Admin API's HTTP 200 + errors object). `store execute` natively prints BARE data and boxes
# errors on stderr; the runner wraps/unboxes to keep one contract. Setup/transport errors
# exit non-zero with error=… on stderr. GraphQL errors never trigger the token fallback —
# re-running a mutation elsewhere could execute it twice.
set -euo pipefail

QUERY_FILE=""; OPERATION=""; VARIABLES=""; VARIABLES_FILE=""; ENV_FILE=".env"; STORE=""; ENGINE="auto"
OUT_FILE=""
API_VERSION="${SHOPIFY_ADMIN_API_VERSION:-2026-04}"

# a value flag must not be the last arg — a bare `shift 2` would exit silently under set -e
need_val() { [ "$1" -ge 2 ] || { echo "error=missing_value flag=$2" >&2; exit 2; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --query)        need_val $# "$1"; QUERY_FILE="$2"; shift 2 ;;
    --operation)    need_val $# "$1"; OPERATION="$2"; shift 2 ;;
    --variables)    need_val $# "$1"; VARIABLES="$2"; shift 2 ;;
    --variables-file) need_val $# "$1"; VARIABLES_FILE="$2"; shift 2 ;;
    --out)          need_val $# "$1"; OUT_FILE="$2"; shift 2 ;;
    --env)          need_val $# "$1"; ENV_FILE="$2"; shift 2 ;;
    --store)        need_val $# "$1"; STORE="$2"; shift 2 ;;
    --api-version)  need_val $# "$1"; API_VERSION="$2"; shift 2 ;;
    --engine)       need_val $# "$1"; ENGINE="$2"; shift 2 ;;
    *) echo "error=unknown_arg arg=$1" >&2; exit 2 ;;
  esac
done

case "$ENGINE" in auto|store|token) ;; *) echo "error=invalid_engine engine=$ENGINE (use auto|store|token)" >&2; exit 2 ;; esac
[ -n "$QUERY_FILE" ] || { echo "error=missing_query (pass --query <file.graphql>)" >&2; exit 2; }
[ -f "$QUERY_FILE" ] || { echo "error=query_file_not_found file=$QUERY_FILE" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "error=jq_not_found" >&2; exit 2; }

if [ -n "$VARIABLES" ] && ! printf '%s' "$VARIABLES" | jq empty >/dev/null 2>&1; then
  echo "error=invalid_variables_json (--variables must be valid JSON)" >&2
  exit 2
fi
if [ -n "$VARIABLES_FILE" ]; then
  [ -z "$VARIABLES" ] || { echo "error=conflicting_flags (--variables and --variables-file are mutually exclusive)" >&2; exit 2; }
  [ -f "$VARIABLES_FILE" ] || { echo "error=variables_file_not_found file=$VARIABLES_FILE" >&2; exit 2; }
  jq empty "$VARIABLES_FILE" >/dev/null 2>&1 || { echo "error=invalid_variables_json (--variables-file must hold valid JSON)" >&2; exit 2; }
  # the CLI engine can only take variables on argv — read them in; the oversize guard
  # in try_store_execute routes huge payloads to the curl engine (body via file)
  VARIABLES="$(cat "$VARIABLES_FILE")"
fi

# --- store domain: --store, else $SHOPIFY_STORE, else uncommented store= in shopify.theme.toml ---
TOML="${TOML_PATH:-shopify.theme.toml}"

# TOML scalar reader: handles "…" / '…' / bare values, drops a trailing comment only OUTSIDE quotes,
# tolerates CRLF. All three shapes occur in real shopify.theme.toml files, and a `"`-only sed
# (`s/^[^=]*=…; s/^"//; s/"$//`) silently keeps the single quotes — `store = 'x'` then becomes the
# request host `'x'.myshopify.com` and the API answers with something unrelated. Byte-identical
# copies live in theme-json.sh and create-preview-theme.sh — the plugin installs by git clone, so
# every script stands alone; keep the three in sync.
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

if [ -z "$STORE" ]; then STORE="${SHOPIFY_STORE:-}"; fi
[ -n "$STORE" ] || STORE="$(toml_value store)" || true
[ -n "$STORE" ] || { echo "error=no_store (pass --store or set store= in $TOML)" >&2; exit 2; }
# `shopify --store` documents the full URL form (https://acme.myshopify.com) as valid and real tomls
# carry it, so the scheme is stripped rather than refused. What is left must be a bare handle/domain:
# anything else would be spliced into the request URL and come back as an opaque 401/404, and this is
# also what keeps $DOMAIN safe to use as a state-file name below. Applies to --store / $SHOPIFY_STORE /
# the toml alike.
STORE="${STORE#http://}"; STORE="${STORE#https://}"; STORE="${STORE%/}"
case "$STORE" in
  ''|*[!A-Za-z0-9.-]*)
    echo "error=invalid_store store='$STORE' (expected a myshopify handle, <handle>.myshopify.com or its https:// URL)" >&2
    exit 2 ;;
esac
case "$STORE" in *.myshopify.com) DOMAIN="$STORE" ;; *) DOMAIN="${STORE}.myshopify.com" ;; esac

# single exit point for the envelope, both engines: inline by default; --out swaps the
# payload for a summary line so a 20–100 KB inspection read never lands in the caller's
# context. theme-json.sh never passes --out — its stdout contract is untouched.
emit_envelope() { # $1 = file holding the {"data"|"errors":…} envelope
  if [ -z "$OUT_FILE" ]; then cat "$1"; return 0; fi
  # a directory would make cp drop the envelope INSIDE it and the summary lie about the path
  if [ -d "$OUT_FILE" ]; then
    echo "error=out_write_failed out=$OUT_FILE (is a directory)" >&2; exit 5
  fi
  cp "$1" "$OUT_FILE" 2>/dev/null \
    || { echo "error=out_write_failed out=$OUT_FILE" >&2; exit 5; }
  local bytes errs
  bytes="$(wc -c < "$OUT_FILE" | tr -d ' ')"
  # the errors head must survive into the summary — callers gate on it before trusting
  # the data (and before any follow-up mutation)
  errs="$(jq -r 'if has("errors") then ((.errors[0].message // (.errors[0]|tostring))[0:160]) else "none" end' "$OUT_FILE" 2>/dev/null)" || errs=""
  [ -n "$errs" ] || errs="unparseable"
  echo "ok=1 bytes=$bytes out=$OUT_FILE errors=$errs"
}

# Domaine env files (process env wins): nearest .claude/domaine.env above cwd, then the global
# ~/.config/domaine/env — same dialect as scripts/env-file.cjs, read per key, never sourced.
# A file value fills an UNSET variable only; an empty value in the file cannot be expressed here.
domaine_env() {
  local d="$PWD" f v
  while :; do
    f="$d/.claude/domaine.env"
    if [ -f "$f" ]; then
      v="$(grep -m1 "^$1=" "$f" 2>/dev/null | cut -d= -f2-)"
      [ -n "$v" ] && { printf '%s' "$v"; return; }
      break
    fi
    [ "$d" = "/" ] && break
    d="$(dirname "$d")"
  done
  grep -m1 "^$1=" "${XDG_CONFIG_HOME:-$HOME/.config}/domaine/env" 2>/dev/null | cut -d= -f2- || true
}
if [ -z "${FND_GQL_PROBE_CACHE+x}" ]; then
  _v="$(domaine_env FND_GQL_PROBE_CACHE)"; [ -n "$_v" ] && FND_GQL_PROBE_CACHE="$_v"
fi
if [ -z "${SHOPIFY_ADMIN_GQL_QUIET+x}" ]; then
  _v="$(domaine_env SHOPIFY_ADMIN_GQL_QUIET)"; [ -n "$_v" ] && SHOPIFY_ADMIN_GQL_QUIET="$_v"
fi

# --- engine 1: shopify store execute (CLI ≥ 4.x + stored store auth) --------------------------
SKIP_REASON=""

# Two facts about this machine are sticky and expensive to rediscover per call: the CLI version
# (`shopify version` measures ~1.5 s, and theme-json.sh `set` runs this script twice per write) and
# "the store engine is unavailable for this store" (a doomed `store execute` on top). Both are
# cached in a PRIVATE 0700 per-user dir under $TMPDIR — rooted there so a caller (and the test
# suite) can isolate a run completely, and a dir rather than a flat `$TMPDIR/fnd-gql-…-$DOMAIN` marker
# because on a shared /tmp such a path is guessable: `: >` through a planted dangling symlink creates a
# file anywhere this uid can write, and a planted fifo blocks the run forever with the reason swallowed
# by 2>/dev/null. STATE_DIR="" (unusable path, e.g. a symlink sits there) = no state at all: every read
# and write below is skipped and the probes are simply paid.
PROBE_TTL="${FND_GQL_PROBE_CACHE:-21600}"
case "$PROBE_TTL" in ''|*[!0-9]*) PROBE_TTL=21600 ;; esac
NOW="$(date +%s 2>/dev/null || echo 0)"
case "$NOW" in ''|*[!0-9]*) NOW=0 ;; esac
STATE_DIR=""
init_state_dir() {
  local d="${TMPDIR:-/tmp}"; d="${d%/}/fnd-gql-${UID:-$(id -u)}"
  [ -L "$d" ] && return 0
  mkdir -p "$d" 2>/dev/null || return 0
  chmod 700 "$d" 2>/dev/null || true
  # The path is predictable, so on a shared /tmp the dir may already belong to another uid: the chmod
  # then fails SILENTLY and their world-writable dir would become this run's state store (a planted
  # store-skip mark pins every call on this machine to the token engine). Owner and resulting mode are
  # verified, never assumed — a dir that fails either is left alone and the run pays the probes.
  [ -d "$d" ] && [ -O "$d" ] || return 0
  case "$(ls -ld "$d" 2>/dev/null)" in drwx------*) STATE_DIR="$d" ;; esac
  return 0
}
# only the store engine has state; --engine token must not even create the dir
[ "$ENGINE" != "token" ] && init_state_dir
NOTE_MARK=""; SKIP_MARK=""
if [ -n "$STATE_DIR" ]; then NOTE_MARK="$STATE_DIR/note-$DOMAIN"; SKIP_MARK="$STATE_DIR/store-skip-$DOMAIN"; fi

write_state() { # $1 = target, $2… = lines; atomic, and never fatal when the write fails
  local target="$1"; shift
  local t="$target.$$"
  if printf '%s\n' "$@" > "$t" 2>/dev/null; then
    mv -f "$t" "$target" 2>/dev/null || rm -f "$t" 2>/dev/null || true
  else
    rm -f "$t" 2>/dev/null || true
  fi
  return 0
}

# leading/trailing whitespace off, INNER whitespace untouched — exactly `read`'s trimming, which the
# state files round-trip values through; the version probe and the token both must trim identically
trim_ws() { # $1 = value, result on stdout
  local v="$1"
  while :; do
    case "$v" in
      [[:space:]]*) v="${v#?}" ;;
      *[[:space:]]) v="${v%?}" ;;
      *) break ;;
    esac
  done
  printf '%s' "$v"
}

# Cached per RESOLVED binary path (the version differs between two installs), invalidated when that
# binary is newer than the cache file — `find -L` because the CLI is a symlink into node_modules, so
# the mtime that moves on an upgrade is behind it — and again after PROBE_TTL seconds, so a
# reinstall that somehow keeps the mtime cannot pin a stale major forever.
cli_version_line() { # $1 = resolved shopify binary
  local bin="$1" cache="" ts="" ver="" cbin="" age
  [ -n "$STATE_DIR" ] && [ "$NOW" -gt 0 ] && [ "$PROBE_TTL" -gt 0 ] && cache="$STATE_DIR/cli-version"
  if [ -n "$cache" ] && [ -f "$cache" ] && [ ! -L "$cache" ]; then
    { read -r ts ver; IFS= read -r cbin; } < "$cache" 2>/dev/null || true
    case "$ts" in ''|*[!0-9]*) ts=0 ;; esac
    age=$((NOW - ts))
    if [ -n "$ver" ] && [ "$cbin" = "$bin" ] && [ "$age" -ge 0 ] && [ "$age" -lt "$PROBE_TTL" ] \
       && [ -z "$(find -L "$bin" -newer "$cache" -print 2>/dev/null | head -1)" ]; then
      printf '%s\n' "$ver"; return 0
    fi
  fi
  ver="$(shopify version 2>/dev/null | head -1 || true)"
  # the cache round-trips the value through `read`, which drops leading/trailing whitespace — trim the
  # live probe the same way, or a padded `shopify version` makes the cold and warm calls of the same
  # command take different branches below and report different reasons
  ver="$(trim_ws "$ver")"
  # an empty probe result is never cached — a CLI that prints nothing today may print a version
  # tomorrow, and the unparseable-version note must stay reachable
  [ -n "$cache" ] && [ -n "$ver" ] && write_state "$cache" "$NOW $ver" "$bin"
  printf '%s\n' "$ver"
}

# The store engine's availability is a per-store, per-machine property (CLI version + a stored
# `store auth` token a client store often refuses to grant), so once it has failed here it fails on
# every later call. ONLY such a property is recorded (SKIP_STICKY): a per-call reason — an oversized
# variables payload, an operation that is missing from one query file, a CLI absent from this run's
# PATH — says nothing about the store and must never pin the engine for later calls. NOT the note
# marker either: that one records "the long note was already printed", is not written under
# SHOPIFY_ADMIN_GQL_QUIET, and must not expire.
SKIP_STICKY=0; SKIP_FROM_CACHE=0
store_skip_cached() { # 0 = known-unavailable here; sets SKIP_REASON from the recorded verdict
  [ -n "$SKIP_MARK" ] && [ "$NOW" -gt 0 ] && [ "$PROBE_TTL" -gt 0 ] || return 1
  [ -f "$SKIP_MARK" ] && [ ! -L "$SKIP_MARK" ] || return 1
  local ts="" reason="" age
  { read -r ts; IFS= read -r reason; } < "$SKIP_MARK" 2>/dev/null || true
  case "$ts" in ''|*[!0-9]*) return 1 ;; esac
  age=$((NOW - ts))
  [ "$age" -ge 0 ] && [ "$age" -lt "$PROBE_TTL" ] || return 1
  [ -n "$reason" ] || reason="store execute failed here before"
  # the reason is echoed into the caller's stderr below, so a file that grew (or was planted) is
  # capped rather than dumped whole
  SKIP_REASON="${reason:0:300} (cached — FND_GQL_PROBE_CACHE=0 re-probes now)"
  SKIP_FROM_CACHE=1
  return 0
}

# print only the named operation's block plus every fragment — `store execute` has no
# operationName flag, so a multi-operation file must be narrowed before sending
extract_operation() {
  awk -v op="$1" '
    /^[[:space:]]*(query|mutation|subscription)([[:space:]]|[({]|$)/ {
      line = $0
      sub(/^[[:space:]]*(query|mutation|subscription)[[:space:]]*/, "", line)
      name = line; sub(/[^A-Za-z0-9_].*$/, "", name)
      keep = (name == op)
    }
    /^[[:space:]]*fragment([[:space:]]|$)/ { keep = 1 }
    {
      if (keep) print
      d += gsub(/{/, "{") - gsub(/}/, "}")
      if (keep && d <= 0 && /}/) keep = 0
    }
  '
}

try_store_execute() {
  local bin; bin="$(command -v shopify 2>/dev/null || true)"
  [ -n "$bin" ] || { SKIP_REASON="shopify CLI not found"; return 1; }
  # skip the whole doomed probe when this store is already known-unavailable. NEVER under
  # --engine store, which must attempt and report. Nothing is sent here, so a MUTATION is safe to
  # hand to the token engine — unlike a failure AFTER an execute actually ran (bottom of this
  # function), where the mutation may already have been applied.
  if [ "$ENGINE" = "auto" ] && store_skip_cached; then return 1; fi
  local ver major
  ver="$(cli_version_line "$bin")"
  major="${ver%%.*}"
  case "$major" in ''|*[!0-9]*)
    SKIP_REASON="unparseable shopify CLI version '$ver'"
    # sticky only for a NON-empty garbled version: an empty probe is the one shape cli_version_line
    # refuses to cache ("may print a version tomorrow"), and a sticky verdict derived from it would
    # nullify that — the next call must re-run `shopify version`, not trust a 6 h skip mark
    [ -n "$ver" ] && SKIP_STICKY=1
    return 1 ;;
  esac
  [ "$major" -ge 4 ] || { SKIP_REASON="shopify CLI $ver has no \`store execute\` (needs >= 4.x)"; SKIP_STICKY=1; return 1; }
  # pre-execution guard: the CLI takes variables on argv, which has a per-argument kernel
  # limit — route oversized payloads to the curl engine (body goes via file there)
  if [ "${#VARIABLES}" -gt 100000 ]; then
    SKIP_REASON="variables too large for the CLI argv (${#VARIABLES} bytes)"
    return 1
  fi

  local qfile="$QUERY_FILE" tmpq=""
  if [ -n "$OPERATION" ]; then
    tmpq="$(mktemp)"
    extract_operation "$OPERATION" < "$QUERY_FILE" > "$tmpq"
    if ! [ -s "$tmpq" ] || ! grep -q "$OPERATION" "$tmpq"; then
      rm -f "$tmpq"
      SKIP_REASON="could not extract operation '$OPERATION' from $QUERY_FILE"
      return 1
    fi
    qfile="$tmpq"
  fi

  local args=(store execute --store "$DOMAIN" --query-file "$qfile" --json --no-color --version "$API_VERSION")
  [ -n "$VARIABLES" ] && args+=(--variables "$VARIABLES")
  # the CLI refuses mutations unless explicitly opted in
  local is_mutation=0
  if grep -qE '^[[:space:]]*mutation([[:space:]]|[({]|$)' "$qfile"; then is_mutation=1; args+=(--allow-mutations); fi

  local out err rc=0
  out="$(mktemp)"; err="$(mktemp)"
  shopify "${args[@]}" >"$out" 2>"$err" || rc=$?
  [ -n "$tmpq" ] && rm -f "$tmpq"
  if [ "$rc" -eq 0 ]; then
    # `store execute --json` prints BARE data (no {"data":…} envelope, unlike the Admin API
    # itself) — wrap it so both engines return the classic envelope
    local envf; envf="$(mktemp)"
    jq -c '{data: .}' "$out" > "$envf" 2>/dev/null || cp "$out" "$envf"
    emit_envelope "$envf"
    rm -f "$out" "$err" "$envf"
    return 0
  fi
  local safe_fallback=0
  if grep -q 'No stored app authentication found' "$err"; then
    # the CLI failed before sending anything — nothing executed server-side
    safe_fallback=1
    SKIP_STICKY=1
    SKIP_REASON="no stored store auth for $DOMAIN — one-time manual fix: shopify store auth --store $DOMAIN --scopes <comma-separated-scopes>, then FND_GQL_PROBE_CACHE=0 on the next call to re-probe immediately"
  elif grep -q 'GraphQL operation failed' "$err"; then
    # a definitive GraphQL error, not an availability problem — do NOT fall back to the token
    # engine (pointless for queries, double-execution risk for mutations). The CLI boxes the
    # {"errors":…} JSON on stderr; unbox it and return the classic envelope on stdout with
    # exit 0 — the same contract as the curl engine (HTTP 200 + errors object).
    local unboxed
    unboxed="$(jq -Rs -c 'gsub("[│\\n\\r]"; "") | match("\\{.*\\}").string | fromjson' "$err" 2>/dev/null || true)"
    if [ -n "$unboxed" ]; then
      local envf; envf="$(mktemp)"
      printf '%s\n' "$unboxed" > "$envf"
      emit_envelope "$envf"
      rm -f "$out" "$err" "$envf"
      return 0
    fi
    SKIP_REASON="store execute: GraphQL operation failed, and the boxed error JSON could not be parsed: $(tr '\n' ' ' < "$err" | cut -c1-300)"
  else
    # an execute that ran and failed for an UNRECOGNIZED reason is NOT recorded: the bucket is
    # dominated by transients (DNS drop, VPN flap, 5xx) and a sticky verdict here would pin the
    # engine off for PROBE_TTL over one bad network moment — with the wrong remediation in the
    # note. The recognized machine facts (version, stored auth) stay sticky above.
    SKIP_REASON="store execute failed: $(tr '\n' ' ' < "$err" | sed -E 's/[[:space:]]+/ /g' | cut -c1-300)"
  fi
  rm -f "$out" "$err"
  # an execute was actually attempted and failed for an unknown reason — for a mutation
  # that could mean "applied server-side, then the CLI died": re-sending it through the
  # token engine risks double execution, so never fall back here
  if [ "$is_mutation" -eq 1 ] && [ "$safe_fallback" -ne 1 ]; then
    echo "error=store_execute_failed_mutation ($SKIP_REASON)" >&2
    echo "hint=NOT falling back to the token engine — the mutation may already have been applied. Verify the store state first; re-run only if the change is absent." >&2
    exit 3
  fi
  return 1
}

if [ "$ENGINE" != "token" ]; then
  if try_store_execute; then exit 0; fi
  if [ "$ENGINE" = "store" ]; then
    echo "error=store_execute_failed ($SKIP_REASON)" >&2
    exit 3
  fi
  # the full note is a one-time pointer to the preferred engine — after the first run per
  # store (or under SHOPIFY_ADMIN_GQL_QUIET) a state-walking session pays 3 words, not 60
  if { [ -n "${SHOPIFY_ADMIN_GQL_QUIET:-}" ] && [ "${SHOPIFY_ADMIN_GQL_QUIET}" != "0" ]; } \
     || { [ -n "$NOTE_MARK" ] && [ -f "$NOTE_MARK" ]; }; then
    # a cached skip still names its escape hatch — the full note printed once, long ago, and
    # without this suffix the FND_GQL_PROBE_CACHE=0 remedy is unreachable from the short form
    if [ "$SKIP_FROM_CACHE" -eq 1 ]; then
      echo "note=engine=token (store-skip cached — FND_GQL_PROBE_CACHE=0 re-probes)" >&2
    else
      echo "note=engine=token" >&2
    fi
  else
    echo "note=store_execute unavailable — falling back to the admin-token engine ($SKIP_REASON)" >&2
    [ -n "$NOTE_MARK" ] && write_state "$NOTE_MARK" ""
  fi
  # Record ONLY a machine-level verdict (SKIP_STICKY), and only when this run actually probed:
  # re-stamping a mark that was itself read from the cache would slide the TTL forward on every call,
  # so the verdict would never expire on an active machine and its reason would grow one
  # "(cached — …)" suffix per call. The reason rides along so a later run can explain itself without
  # re-probing.
  [ -n "$SKIP_MARK" ] && [ "$NOW" -gt 0 ] && [ "$PROBE_TTL" -gt 0 ] \
    && [ "$SKIP_STICKY" -eq 1 ] && [ "$SKIP_FROM_CACHE" -eq 0 ] \
    && write_state "$SKIP_MARK" "$NOW" "${SKIP_REASON//$'\n'/ }"
fi

# --- engine 2: admin token + curl -------------------------------------------------------------
command -v curl >/dev/null 2>&1 || { echo "error=curl_not_found" >&2; exit 2; }

# dotenv scalar reader: LAST assignment wins (a later line overrides an earlier one), `export KEY=`
# is a legal line, values may be "…" / '…' / bare, and a bare value's trailing ` #comment` and any CR
# are dropped. The CR matters because a CRLF .env defeats a plain `s/"$//`, leaving BOTH the closing
# quote and the CR inside the token; either that or an inline comment reaching the auth header is an
# opaque 401 from the API.
dotenv_value() { # $1 = key, $2 = file
  awk -v k="$1" '
    BEGIN { SQ = "\047" }
    /^[ \t]*#/ { next }
    $0 ~ "^[ \t]*(export[ \t]+)?" k "[ \t]*=" {
      v = $0
      sub("^[ \t]*(export[ \t]+)?" k "[ \t]*=[ \t]*", "", v)
      sub(/\r$/, "", v)
      q = substr(v, 1, 1)
      if (q == "\"" || q == SQ) {
        v = substr(v, 2)
        p = index(v, q)
        if (p > 0) v = substr(v, 1, p - 1)
      } else {
        h = index(v, " #"); if (h > 0) v = substr(v, 1, h - 1)
        h = index(v, "\t#"); if (h > 0) v = substr(v, 1, h - 1)
        sub(/[ \t\r]+$/, "", v)
      }
      out = v; found = 1
    }
    END { if (found) print out }
  ' "$2"
}

# token: env var wins, else read just the one line from the dotenv file (never echo it).
# TOKEN_FROM_FILE drives the shape-gate decision below; TOKEN_SRC is display-only for `source=`
# (deciding on the display string would let a wording tweak silently disable the gate)
TOKEN="${SHOPIFY_ADMIN_TOKEN:-}"
TOKEN_SRC="\$SHOPIFY_ADMIN_TOKEN"; TOKEN_FROM_FILE=0
if [ -z "$TOKEN" ] && [ -f "$ENV_FILE" ]; then
  TOKEN="$(dotenv_value SHOPIFY_ADMIN_TOKEN "$ENV_FILE")"
  TOKEN_SRC="$ENV_FILE"; TOKEN_FROM_FILE=1
fi
# a copy-pasted export often carries surrounding whitespace; an INNER newline is deliberately left
# alone (trim_ws keeps it) so it reaches the charset gate below instead of being silently repaired
TOKEN="$(trim_ws "$TOKEN")"
# whitespace-only counts as absent (this is the code theme-json.sh greps for to decide its
# themecli fallback, so the wording is load-bearing)
if [ -z "$TOKEN" ]; then
  echo "error=no_admin_token" >&2
  echo "hint=Set SHOPIFY_ADMIN_TOKEN in $ENV_FILE (Admin API access token, shpat_…) — see metafield-metaobject-setup.md — OR use the store engine: Shopify CLI >= 4.x + one-time \`shopify store auth --store $DOMAIN --scopes <scopes>\`" >&2
  exit 3
fi
# The token rides a curl config file, where a stray quote breaks the header value and an embedded
# newline injects a SECOND curl directive — i.e. arbitrary curl options out of a malformed .env. The
# gate is against exactly those: whitespace, quotes, backslashes and control characters. Base64-ish
# characters (=, +, /) stay allowed — this is also the escape hatch for a non-standard credential, and
# a header value cannot be broken by them. The value itself is NEVER echoed, not even in the refusal.
case "$TOKEN" in
  *[!A-Za-z0-9_.+/=~-]*)
    echo "error=invalid_admin_token source=$TOKEN_SRC (contains whitespace, a quote or another character no Admin API token has)" >&2
    exit 3 ;;
esac
# shape gate on a FILE value only — $SHOPIFY_ADMIN_TOKEN stays the escape hatch for a
# non-standard credential, the same precedence the sibling scripts give their token env vars.
# Any shp*_ credential passes: shpat_/shpca_ are today's, and the legacy private-app shppa_ is still
# a valid X-Shopify-Access-Token, so the gate catches a typo/placeholder, not a token vintage.
if [ "$TOKEN_FROM_FILE" -eq 1 ]; then
  case "$TOKEN" in
    shp[a-z]*_*) ;;
    *)
      echo "error=invalid_admin_token source=$TOKEN_SRC (not an Admin API access token — expected shpat_…/shpca_… or another shp*_ credential; export SHOPIFY_ADMIN_TOKEN to force a non-standard one)" >&2
      exit 3 ;;
  esac
fi

URL="https://${DOMAIN}/admin/api/${API_VERSION}/graphql.json"

# Build the JSON body with jq, straight into a file — the query and variables never ride
# any argv (per-argument kernel limit) and the body goes to curl via @file for the same
# reason: --rawfile/--slurpfile keep both off the jq command line.
BODYF="$(mktemp)"; RESPF="$(mktemp)"; HDR_CFG="$(mktemp)"; VARSF_TMP="$(mktemp)"
trap 'rm -f "$HDR_CFG" "$BODYF" "$RESPF" "$VARSF_TMP"' EXIT
VARSF=""
if [ -n "$VARIABLES_FILE" ]; then
  VARSF="$VARIABLES_FILE"
elif [ -n "$VARIABLES" ]; then
  printf '%s' "$VARIABLES" > "$VARSF_TMP"   # printf is a builtin — no argv limit
  VARSF="$VARSF_TMP"
fi
if [ -n "$VARSF" ]; then
  jq -c -n \
    --rawfile q "$QUERY_FILE" \
    --arg op "$OPERATION" \
    --slurpfile vars "$VARSF" \
    '{query: $q}
     + (if $op != "" then {operationName: $op} else {} end)
     + {variables: $vars[0]}' > "$BODYF"
else
  jq -c -n \
    --rawfile q "$QUERY_FILE" \
    --arg op "$OPERATION" \
    '{query: $q}
     + (if $op != "" then {operationName: $op} else {} end)' > "$BODYF"
fi

# The token goes into a private curl config file (mktemp = 0600, removed on exit) instead of
# the argv, so it never shows in `ps` and never reaches stdout/stderr.
printf 'header = "X-Shopify-Access-Token: %s"\n' "$TOKEN" > "$HDR_CFG"

# Capture the HTTP status: a 401/404/429/5xx body is HTML/JSON garbage, not a GraphQL
# envelope — it must exit non-zero with error=http_<code>, never reach stdout as data.
HTTP_CODE="$(curl -sS -X POST "$URL" \
  -K "$HDR_CFG" \
  -H "Content-Type: application/json" \
  --data @"$BODYF" \
  -o "$RESPF" -w '%{http_code}')" \
  || { echo "error=curl_transport_failed" >&2; exit 5; }
case "$HTTP_CODE" in
  2*) emit_envelope "$RESPF" ;;
  *)
    echo "error=http_${HTTP_CODE} url=$URL" >&2
    head -c 600 "$RESPF" | tr '\n' ' ' >&2; echo >&2
    exit 5 ;;
esac
