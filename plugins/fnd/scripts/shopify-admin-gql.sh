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
#     --allow-mutations is passed; the script detects a mutation in the text it actually sends and
#     opts in automatically. `store execute` has no operationName flag and runs the WHOLE document
#     it is given, so a --operation run is narrowed first: that named operation plus the fragments
#     it reaches go into a temp file. Supported shape = top-level `query`/`mutation`/`subscription`/
#     `fragment` definitions (anywhere on a line, `#` comments and "…" string contents ignored) with
#     ordinary strings only. Anything that cannot be narrowed to exactly the one operation asked
#     for — a name matching none or several, several operations with no --operation at all, a `"""`
#     block string or another shape the reader refuses while narrowing — is REFUSED here rather
#     than sent unnarrowed: under --engine auto the token engine takes over (it does pass
#     operationName), under --engine store the run stops with error=store_execute_failed. Without
#     --operation there is nothing to narrow, so a document the reader cannot read still goes over
#     whole (as it always did) and the API judges it.
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
# The store domain comes from shopify.theme.toml's ($TOML_PATH's) `store=` line — unless
# overridden — read out of the ONE environment block the shared resolver picks, the same pick
# create-preview-theme.sh and theme-json.sh make: $SHOPIFY_FLAG_ENVIRONMENT (this script's --env
# names the dotenv file, not a block), else `dev`, else `development`, else the top-level keys;
# blocks naming different stores with none of those names is `error=ambiguous_env` (exit 2) before
# any request, rather than a query silently sent to another environment's store. An `https://` URL
# is accepted and normalized; anything else that cannot be a myshopify handle is refused (exit 2)
# rather than spliced into the request URL. The Theme Access token (shptka_) in shopify.theme.toml
# is NOT an admin token and is not used here.
#
# Usage:
#   shopify-admin-gql.sh --query <file.graphql> [--operation <name>] [--variables <json>] \
#                        [--variables-file <file.json>] [--out <file>] \
#                        [--env <path>] [--store <name|domain>] [--api-version <ver>] \
#                        [--engine auto|store|token]
#
#   --query          path to a .graphql file (may hold multiple named operations)
#   --operation      operationName to run — REQUIRED as soon as the file holds more than one
#                    operation, and it must name exactly one of them (see the store engine above)
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
[ -f "$SCRIPT_DIR/_shopify-common.sh" ] || { echo "error=common_lib_not_found path=$SCRIPT_DIR/_shopify-common.sh" >&2; exit 2; }
. "$SCRIPT_DIR/_shopify-common.sh"

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

if [ -z "$STORE" ]; then STORE="${SHOPIFY_STORE:-}"; fi
if [ -z "$STORE" ]; then
  # This script's own --env is a DOTENV PATH (the Admin token file), so the toml block selector is
  # $SHOPIFY_FLAG_ENVIRONMENT — the one `shopify theme dev -e` reads.
  toml_env_ready \
    || { echo "error=$(toml_env_error 'pass --store, export SHOPIFY_FLAG_ENVIRONMENT=<name> (this script'"'"'s --env names the dotenv file, not a toml block), or point TOML_PATH at a single-environment file')" >&2; exit 2; }
  STORE="$(toml_value store)" || true
fi
[ -n "$STORE" ] || { echo "error=no_store (pass --store or set store= in $TOML, env=$TOML_ENV)" >&2; exit 2; }
# the handle guard is also what keeps $DOMAIN safe to use as a state-file name below; it applies to
# --store / $SHOPIFY_STORE / the toml alike
STORE="$(store_handle "$STORE")" \
  || { echo "error=invalid_store store='$STORE' (expected a myshopify handle, <handle>.myshopify.com or its https:// URL)" >&2; exit 2; }
DOMAIN="$(store_domain "$STORE")"

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

# Domaine env files fill an UNSET variable only.
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

# ONE reader for every GraphQL question this script asks: which operations a document declares,
# which text to hand `store execute` (it has no operationName flag, so a file must already BE the
# one operation to run), whether that text is a mutation, and whether a timed-out request could
# have been one. It finds definitions the way the language does — a `query`/`mutation`/
# `subscription`/`fragment` keyword at brace and paren depth 0, ANYWHERE on a line, not only at the
# start of one — after blanking `#` comments and the contents of "…" strings, so a brace or a
# keyword inside either cannot move the depth counter or invent a declaration. Blanking is
# length-preserving, which is what lets an offset in the sanitized text address the same character
# in the original and a declaration be cut out mid-line. `"""` block strings are outside that
# blanking, so a document holding a real one (a `"""` surviving the blanking, not one merely quoted
# or commented) is reported unsupported instead of mis-parsed. This is not a GraphQL lexer and does
# not try to be: every shape it cannot read confidently comes back as `unsupported <why>`, and the
# callers decide — refusing where a wrong read would send the wrong text.
GQL_AWK='
function sanitize(s,   out, i, c, n, instr, esc) {
  n = length(s); out = ""; instr = 0; esc = 0
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (instr) {
      if (esc) { esc = 0; out = out " "; continue }
      if (c == "\\") { esc = 1; out = out " "; continue }
      if (c == "\"") { instr = 0; out = out "\""; continue }
      out = out " "; continue
    }
    if (c == "\"") { instr = 1; out = out "\""; continue }
    if (c == "#") { while (i <= n) { out = out " "; i++ }; return out }
    out = out c
  }
  return out
}
function refuse(why) {
  if (mode == "extract") exit 1
  print "unsupported " why
  exit 0
}
function spreads(k,   t, r) {   # fragment names the definition k spreads, into need[]
  t = substr(san, dstart[k], dend[k] - dstart[k] + 1)
  while (match(t, /\.\.\.[ \t\r\n]*[A-Za-z_][A-Za-z0-9_]*/)) {
    r = substr(t, RSTART, RLENGTH)
    sub(/^\.\.\.[ \t\r\n]*/, "", r)
    # `... on Type` is an inline fragment; `on` is a reserved word, never a fragment name
    if (r != "on") need[r] = 1
    t = substr(t, RSTART + RLENGTH)
  }
}
{
  line = sanitize($0)
  raw = raw $0 "\n"; san = san line "\n"
  # a `"""` inside a # comment or a "…" string is text, not a block string — look at the
  # sanitized line, where both are already blanked out
  if (index(line, "\"\"\"")) block = 1
}
END {
  if (block) refuse("block string (\"\"\") — this reader handles ordinary \"…\" strings only")
  n = length(san); i = 1; depth = 0; pdepth = 0; ndef = 0; cur = 0
  while (i <= n) {
    c = substr(san, i, 1)
    if (c == "(") { pdepth++; i++; continue }
    if (c == ")") { if (pdepth > 0) pdepth--; i++; continue }
    # inside variable definitions: a { } there is a default value, not a selection set
    if (pdepth > 0) { i++; continue }
    if (c == "{") {
      if (cur == 0 && depth == 0) { ndef++; dstart[ndef] = i; dkind[ndef] = "query"; dname[ndef] = ""; cur = ndef }
      depth++; i++; continue
    }
    if (c == "}") {
      if (depth > 0) depth--
      i++
      if (depth == 0 && cur > 0) { dend[cur] = i - 1; cur = 0 }
      continue
    }
    if (c ~ /[A-Za-z_]/) {
      j = i
      while (j <= n && substr(san, j, 1) ~ /[A-Za-z0-9_]/) j++
      w = substr(san, i, j - i)
      if (cur == 0 && depth == 0) {
        rest = substr(san, j)
        if (w == "query" || w == "mutation" || w == "subscription") {
          # variable definitions `(`, a selection set `{`, or a directive `@` may follow the name
          if (rest !~ /^[ \t\r\n]*([A-Za-z_][A-Za-z0-9_]*)?[ \t\r\n]*[({@]/) refuse("unreadable " w " declaration")
          name = ""
          if (match(rest, /^[ \t\r\n]*[A-Za-z_][A-Za-z0-9_]*/)) {
            name = substr(rest, 1, RLENGTH); sub(/^[ \t\r\n]+/, "", name)
          }
          ndef++; dstart[ndef] = i; dkind[ndef] = w; dname[ndef] = name; cur = ndef
        } else if (w == "fragment") {
          if (rest !~ /^[ \t\r\n]*[A-Za-z_][A-Za-z0-9_]*[ \t\r\n]/) refuse("unreadable fragment declaration")
          name = ""
          if (match(rest, /^[ \t\r\n]*[A-Za-z_][A-Za-z0-9_]*/)) {
            name = substr(rest, 1, RLENGTH); sub(/^[ \t\r\n]+/, "", name)
          }
          ndef++; dstart[ndef] = i; dkind[ndef] = "fragment"; dname[ndef] = name; cur = ndef
        } else {
          refuse("unrecognized top-level token \047" w "\047")
        }
      }
      i = j; continue
    }
    i++
  }
  if (cur > 0) refuse("unterminated " dkind[cur] " definition")
  if (mode == "extract") {
    # only the fragments the chosen operation can actually reach: GraphQL rejects a document
    # carrying a fragment nothing uses, and `store execute` reports that as a hard GraphQL
    # error with no engine left to fall back to
    for (k = 1; k <= ndef; k++) if (dkind[k] != "fragment" && want != "" && dname[k] == want) spreads(k)
    grew = 1
    while (grew) {
      grew = 0
      for (k = 1; k <= ndef; k++)
        if (dkind[k] == "fragment" && (dname[k] in need) && !(k in used)) { used[k] = 1; spreads(k); grew = 1 }
    }
  }
  for (k = 1; k <= ndef; k++) {
    if (mode == "extract") {
      if ((dkind[k] == "fragment" && (k in used)) || (dkind[k] != "fragment" && want != "" && dname[k] == want)) {
        printf "%s\n", substr(raw, dstart[k], dend[k] - dstart[k] + 1)
      }
    } else if (dkind[k] == "fragment") {
      print "frag"
    } else {
      print "op " dkind[k] " " dname[k]
    }
  }
}
'

# LC_ALL=C on both entry points: the reader walks the document one character at a time and hands
# byte offsets from the sanitized text back to the raw text, so it must count bytes, not runes —
# and a stray non-UTF-8 byte or a leading BOM aborts a multibyte-locale awk mid-parse.
gql_defs() { # $1 = file → one line per top-level definition: `op <kind> <name>` | `frag` | `unsupported <why>`
  LC_ALL=C awk -v mode=scan -v want="" "$GQL_AWK" "$1"
}

# print only the named operation's block plus the fragments it reaches — `store execute` has no
# operationName flag, so a multi-operation file must be narrowed before sending
gql_extract() { # $1 = file, $2 = operation name
  LC_ALL=C awk -v mode=extract -v want="$2" "$GQL_AWK" "$1"
}

# Was the request that just died on the wire a mutation (which may already have committed)? The
# name is compared literally, never as a regex. A document the reader refuses is the one place a
# MISSED warning would hurt most, so it degrades to "does this file mention a mutation at all" —
# over-warning is the safe direction.
sent_could_be_mutation() {
  local defs
  defs="$(gql_defs "$QUERY_FILE" 2>/dev/null || true)"
  case "$defs" in
    ''|unsupported*) grep -q 'mutation' "$QUERY_FILE" ;;
    *) printf '%s\n' "$defs" | awk -v op="$OPERATION" '
         $1 == "op" && $2 == "mutation" && (op == "" || $3 == op) { found = 1 }
         END { exit found ? 0 : 1 }' ;;
  esac
}

OPS_TOTAL=0; OPS_NAMED=0; OPS_KIND=""
count_ops() { # $1 = gql_defs output, $2 = wanted name ("" = any) → OPS_TOTAL / OPS_NAMED / OPS_KIND
  local tag kind name
  OPS_TOTAL=0; OPS_NAMED=0; OPS_KIND=""
  while IFS=' ' read -r tag kind name; do
    [ "$tag" = "op" ] || continue
    OPS_TOTAL=$((OPS_TOTAL + 1))
    if [ -z "$2" ]; then OPS_KIND="$kind"
    elif [ "$name" = "$2" ]; then OPS_NAMED=$((OPS_NAMED + 1)); OPS_KIND="$kind"; fi
  done <<< "$1"
  # a counter, never a verdict: the caller decides — and under `set -e` a bare call must not abort
  return 0
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

  # `store execute` runs the WHOLE document it is given, so the file handed over must already be
  # the one operation to run. Every shape that cannot be narrowed to exactly that — a --operation
  # name that does not resolve to exactly one declaration, a document the reader cannot read while
  # narrowing, several confidently-counted operations with no --operation at all — steps aside
  # HERE, before anything is sent: under --engine auto the token engine takes over (it passes
  # operationName), under --engine store the run reports and stops. A document with no --operation
  # needs no narrowing, so a shape the reader refuses is NOT a reason to withhold it — it goes over
  # untouched exactly as it did before this reader existed, and the API judges the GraphQL.
  local qfile="$QUERY_FILE" tmpq="" defs why
  defs="$(gql_defs "$QUERY_FILE" 2>/dev/null || true)"
  why=""
  case "$defs" in unsupported*) why="${defs#unsupported }" ;; esac
  count_ops "$defs" "$OPERATION"
  if [ -n "$OPERATION" ]; then
    if [ -n "$why" ]; then
      SKIP_REASON="store engine cannot isolate operation '$OPERATION' in $QUERY_FILE ($why)"
      return 1
    fi
    if [ "$OPS_NAMED" -ne 1 ]; then
      SKIP_REASON="store engine cannot isolate operation '$OPERATION' in $QUERY_FILE ($OPS_NAMED operations carry that name, $OPS_TOTAL in the document)"
      return 1
    fi
    tmpq="$(mktemp)"
    gql_extract "$QUERY_FILE" "$OPERATION" > "$tmpq" 2>/dev/null || true
    # the gate is on the text that will actually be SENT, not on the document it came out of
    defs="$(gql_defs "$tmpq" 2>/dev/null || true)"
    count_ops "$defs" "$OPERATION"
    if [ ! -s "$tmpq" ] || [ "$OPS_TOTAL" -ne 1 ] || [ "$OPS_NAMED" -ne 1 ]; then
      rm -f "$tmpq"
      SKIP_REASON="store engine cannot isolate operation '$OPERATION' in $QUERY_FILE (the narrowed text holds $OPS_TOTAL operations)"
      return 1
    fi
    qfile="$tmpq"
  elif [ -z "$why" ] && [ "$OPS_TOTAL" -ne 1 ]; then
    SKIP_REASON="store engine cannot pick an operation in $QUERY_FILE ($OPS_TOTAL operations found — pass --operation)"
    return 1
  fi

  local args=(store execute --store "$DOMAIN" --query-file "$qfile" --json --no-color --version "$API_VERSION")
  [ -n "$VARIABLES" ] && args+=(--variables "$VARIABLES")
  # the CLI refuses mutations unless explicitly opted in — decided by the operation actually sent,
  # so a query carved out of a document that also holds a mutation never opts in. On the one path
  # that sends a document the reader could not read, the opt-in degrades to "does this file mention
  # a mutation at all": --allow-mutations only PERMITS one, so granting it to a query changes
  # nothing while withholding it from a mutation is a hard refusal.
  local is_mutation=0
  if [ "$OPS_KIND" = "mutation" ]; then is_mutation=1
  elif [ -n "$why" ] && grep -qE '(^|[^A-Za-z0-9_])mutation([^A-Za-z0-9_]|$)' "$qfile"; then is_mutation=1
  fi
  if [ "$is_mutation" -eq 1 ]; then args+=(--allow-mutations); fi

  local out err rc=0
  out="$(mktemp)"; err="$(mktemp)"
  shopify "${args[@]}" >"$out" 2>"$err" || rc=$?
  [ -n "$tmpq" ] && rm -f "$tmpq"
  if [ "$rc" -eq 0 ]; then
    # `store execute --json` prints BARE data (no {"data":…} envelope, unlike the Admin API
    # itself) — wrap it so both engines return the classic envelope. Conditionally: a CLI that
    # ever starts printing the envelope itself must not come back as {"data":{"data":…}}.
    local envf; envf="$(mktemp)"
    jq -c 'if type == "object" and (has("data") or has("errors")) then . else {data: .} end' \
      "$out" > "$envf" 2>/dev/null || cp "$out" "$envf"
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
# The timeouts are bounds, not tuning: without them a stalled Admin API call hangs the caller
# (and every skill waiting on it) forever. 120 s clears the slowest real write — a whole
# settings_data.json upsert — with room to spare.
HTTP_CODE="$(curl -sS -X POST "$URL" \
  --connect-timeout 20 --max-time 120 \
  -K "$HDR_CFG" \
  -H "Content-Type: application/json" \
  --data @"$BODYF" \
  -o "$RESPF" -w '%{http_code}')" \
  || {
    crc=$?
    echo "error=curl_transport_failed" >&2
    # Only a request that was on the wire can have committed server-side — a timeout or a dropped
    # connection (28, 52, 55, 56), not a DNS/connect/TLS failure that never sent a byte. Under
    # --operation only the SELECTED operation decides: a query carved out of a mixed document
    # carries no such hazard.
    case "$crc" in 28|52|55|56) ;; *) exit 5 ;; esac
    if sent_could_be_mutation; then
      echo "hint=the mutation may already have been applied. Verify the store state first; re-run only if the change is absent." >&2
    fi
    exit 5
  }
case "$HTTP_CODE" in
  2*) emit_envelope "$RESPF" ;;
  *)
    echo "error=http_${HTTP_CODE} url=$URL" >&2
    head -c 600 "$RESPF" | tr '\n' ' ' >&2; echo >&2
    exit 5 ;;
esac
