#!/usr/bin/env bash
# figma-rest.sh — fetch ONE Figma node through the REST API when no Figma MCP can be reached.
#
# WHY A SCRIPT AT ALL: figma-reader reads designs through a Figma MCP — the remote connector, or
# the local `figma-dev-mode` bridge, which needs the Figma DESKTOP app running with the page
# loaded in it. When neither answers, the design is simply invisible to the model and the
# developer has to drive the REST API by hand. This is that rung of the ladder, automated: the
# node's subtree, the file's local variables and a PNG render, on disk, for scripts/figma-node-
# slim.cjs to turn into a compact build tree. The RAW payloads are never meant for the model —
# one frame is 230-280 KB of JSON — so they land in the workspace and the compactor is what the
# reader actually reads.
#
# CREDENTIALS — a per-developer Figma PERSONAL ACCESS TOKEN, read-only scopes:
#   FIGMA_TOKEN, process env first, else the --env dotenv (default ./.env, gitignored). Same
#   discipline as jira-attachments.sh: the value is NEVER printed and NEVER on the argv — it
#   rides a private 0600 curl config (`header = "X-Figma-Token: <token>"`) removed on exit — and
#   a value carrying whitespace, a quote or a control character is refused before curl runs
#   rather than smuggled into that file as a second directive. Skills and agents must call THIS
#   script and must NOT `Read` the .env themselves. Walk-through: references/figma-rest.md.
#
# ONE HOST, AND ONE TOKEN-LESS HOP: every AUTHENTICATED request goes to https://api.figma.com and
# nowhere else — `-L` is never passed with the config, so a redirect can never carry the token
# off it. The PNG render is the exception that proves the rule: /v1/images answers with a
# PRE-SIGNED S3 URL, which needs no credential at all, so the download is a SEPARATE curl call
# WITHOUT `-K` — the token never leaves api.figma.com. Those URLs expire; the bytes are the copy.
#
# WHERE THE BYTES LAND: --out must be a path git ignores, judged at its PHYSICAL location, by the
# gate jira-attachments.sh uses (out_dir_gate in _shopify-common.sh) — a worktree's `.claude/tasks`
# is a symlink into the main checkout, and "never reaches a commit" is a requirement, not a
# preference. Default `.claude/tasks/_figma/tmp`; the reader passes `<workspace>/tmp/figma`.
#
# CACHE: a `.nodes.json` already on disk that is non-empty, valid JSON and actually carries the
# node is `cached` — no request. Same for the variables file (non-empty JSON) and the PNG at THAT
# scale (non-empty; the scale is in the name, so `--scale 4` never answers from a 2× render).
# `--force` re-fetches all three. On a cached run `last_modified` is the value the cached payload
# carries — it is the cache's own stamp, NOT a version check: `--probe` is what asks Figma.
# Downloads stage through a PER-PROCESS sibling of the final name and are renamed into place, so
# parallel readers on two frames of one file cannot hand each other half a body.
#
# TIMEOUTS: every call gets --connect-timeout 10 and --max-time 120 — except `variables/local`,
# which gets 300. That one request serialises the file's WHOLE variable library and measured 66 s
# for 656 KB on a real ELC file, so 120 s is only 2x headroom on a good network. It is also the
# one request that is cached per FILE key rather than per node, so the long wait is paid once and
# every later node in the same file reads `<key>.variables.json` off disk.
#
# Usage:
#   figma-rest.sh <figma-url | --file <key> --node <id>> [--out <dir>] [--env <dotenv>]
#                 [--scale <N>] [--no-variables] [--no-image] [--force] [--json]
#   figma-rest.sh --check  [--env <dotenv>]
#   figma-rest.sh --policy [--env <dotenv>]
#   figma-rest.sh --probe  <figma-url | --file <key>> [--env <dotenv>]
#
#   <figma-url>     a figma.com /design/, /file/, /proto/ or /board/ URL WITH a node-id
#   --file/--node   the explicit form (`--node 123:456`); a URL and these together is a usage error
#   --out           where the payloads land (default .claude/tasks/_figma/tmp)
#   --env           dotenv holding FIGMA_TOKEN (default ./.env)
#   --scale         PNG render scale, 0 < N <= 4 (default 2)
#   --no-variables  skip /variables/local
#   --no-image      skip the PNG render
#   --force         re-fetch even when the files are already on disk
#   --json          one object on stdout instead of the key=value lines
#   --check         probe the token only: `ok=1 figma_user=… token_source=…` (no out-dir gate)
#   --policy        print the source policy and whether a token exists — NO network, no out-dir
#                   gate. FND_FIGMA_SOURCE (process env, else the GLOBAL domaine env file) is
#                   auto|mcp|rest; anything else reads as auto plus a note.
#   --probe         ask Figma when the FILE last changed (`GET /v1/files/<key>?depth=1`) and print
#                   `ok=1 file_key=… [node_id=…] last_modified=…`; nothing is written, no out-dir
#                   gate, and the node-id in the link is optional. This is the freshness probe.
#
# MODE PRECEDENCE — checked right after parsing, before the credential is even looked up, because a
# swallowed flag is worse than a refusal: an agent that asked one question and silently got another
# answer has no way to notice.
#   1. --check / --policy / --probe are THREE different questions: any two together is
#      `error=conflicting_mode`, exit 2. This is checked FIRST, so `--check --policy <url>` names
#      the mode clash rather than the target one.
#   2. --check and --policy take NO target: a URL or --file/--node alongside either is
#      `error=conflicting_target`, exit 2 — the same error a URL and --file/--node already share.
#      --probe DOES take one (the file key IS its question), and its node-id is optional.
#
# stdout — one key=value line per artifact, then one meta line:
#   kind=nodes     status=saved|cached                                path=<abs>          bytes=<n>
#   kind=variables status=saved|cached|unavailable|failed|skipped     path=<abs or empty> bytes=<n>
#   kind=image     status=saved|cached|unavailable|failed|skipped     path=<abs or empty> bytes=<n>
#   kind=meta      file_key=<key> node_id=<id> last_modified=<ts> name=<node name>
# `name=` is LAST on the meta line, and it is the only field that may carry spaces: a frame called
# "Hero last_modified=2020" placed before the other fields would shadow them for any reader that
# splits on whitespace. Everything up to `name=` is a fixed key=value grammar; the name is the rest
# of the line.
# stderr — notes, then always a last summary line:
#   ok=1 saved=N cached=N unavailable=N failed=N out=<abs dir>
#
# Exit: 0 ok · 1 an OPTIONAL artifact failed (variables other than 403, the image download) ·
#       2 usage/precondition (the out-dir gate, a bad URL, no curl/jq) ·
#       3 the token is missing or malformed ·
#       4 the API rejected the request (token, unknown node, rate limit) ·
#       5 transport failure on the one request that is not optional.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
[ -f "$SCRIPT_DIR/_shopify-common.sh" ] || { echo "error=common_lib_not_found path=$SCRIPT_DIR/_shopify-common.sh" >&2; exit 2; }
. "$SCRIPT_DIR/_shopify-common.sh"
REFERENCE="$(dirname "$SCRIPT_DIR")/references/figma-rest.md"

URL=""; FILE_KEY=""; NODE_ID=""; OUT_DIR=""; ENV_FILE=".env"; SCALE=2
DO_VARS=1; DO_IMAGE=1; FORCE=0; JSON=0; CHECK=0; POLICY=0; PROBE=0
EXPLICIT=0   # --file/--node were used: a URL as well is two answers to one question

# a value flag must not be the last arg — a bare `shift 2` would exit silently under set -e
need_val() { [ "$1" -ge 2 ] || { echo "error=missing_value flag=$2" >&2; exit 2; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --file)         need_val $# "$1"; FILE_KEY="$2"; EXPLICIT=1; shift 2 ;;
    --node)         need_val $# "$1"; NODE_ID="$2"; EXPLICIT=1; shift 2 ;;
    --out)          need_val $# "$1"; OUT_DIR="$2"; shift 2 ;;
    --env)          need_val $# "$1"; ENV_FILE="$2"; shift 2 ;;
    --scale)        need_val $# "$1"; SCALE="$2"; shift 2 ;;
    --no-variables) DO_VARS=0; shift ;;
    --no-image)     DO_IMAGE=0; shift ;;
    --force)        FORCE=1; shift ;;
    --json)         JSON=1; shift ;;
    --check)        CHECK=1; shift ;;
    --policy)       POLICY=1; shift ;;
    --probe)        PROBE=1; shift ;;
    -*) echo "error=unknown_arg arg=$1" >&2; exit 2 ;;
    *) [ -z "$URL" ] || { echo "error=unexpected_arg arg=$1" >&2; exit 2; }; URL="$1"; shift ;;
  esac
done

# --- the mode gate: one question per run, and two of them take no target -------------------------
# Before the credential, before the target is parsed and long before anything is fetched. A mode
# flag that silently wins over another — or a target quietly dropped on the floor because the mode
# never looks at one — answers a question nobody asked, and the caller cannot tell from the output
# that it happened. Mode clash first: `--check --policy <url>` is one mistake, not two.
MODES=$((CHECK + POLICY + PROBE))
if [ "$MODES" -gt 1 ]; then
  echo "error=conflicting_mode (--check, --policy and --probe are three different questions — pass one)" >&2
  exit 2
fi
if [ "$CHECK" -eq 1 ] || [ "$POLICY" -eq 1 ]; then
  if [ -n "$URL" ] || [ "$EXPLICIT" -eq 1 ]; then
    echo "error=conflicting_target (--check and --policy ask about the credential, not about a node — drop the URL / --file / --node, or drop the mode flag)" >&2
    exit 2
  fi
fi

# --- credentials --------------------------------------------------------------------------------
HINT="hint=Figma REST reads need a per-developer personal access token — FIGMA_TOKEN in <repo>/.env (gitignored). Create it at https://www.figma.com/settings → Security → Personal access tokens, with scopes File content: read-only + Variables: read-only (honoured on Enterprise plans only, harmless elsewhere) + Current user: read-only (for --check). Walk-through: $REFERENCE"
AUTH_HINT="hint=The token was rejected — it has expired, was revoked, or lacks the File content: read-only scope. Regenerate it at https://www.figma.com/settings → Security → Personal access tokens: $REFERENCE"

TOKEN="${FIGMA_TOKEN:-}"; TOKEN_SRC=env
if [ -f "$ENV_FILE" ] && [ -z "$TOKEN" ]; then
  TOKEN="$(dotenv_value FIGMA_TOKEN "$ENV_FILE")"; TOKEN_SRC=file
fi
# a copy-pasted export often carries surrounding whitespace; an INNER newline is deliberately left
# alone so it reaches the gate below instead of being silently repaired
TOKEN="$(trim_ws "$TOKEN")"

# The value lands inside a quoted curl-config directive, where a stray quote breaks the value and
# an embedded newline injects a SECOND directive — arbitrary curl options out of a malformed .env.
# The gate is against exactly that. The value is never echoed, not even in the refusal.
token_charset_ok() {
  case "$TOKEN" in
    ''|*[!A-Za-z0-9_.+/=~:-]*) return 1 ;;
  esac
  return 0
}

# --- --policy: no network, no out-dir gate, no refusal ------------------------------------------
# The reader's rung 0. It must ALWAYS answer — a developer with a typo in .env still needs to be
# told which rung the ladder starts on, so a malformed token reads as `token=invalid` plus a note
# rather than an exit code that would look like "Figma is down". `invalid` and `missing` are two
# different repairs — one .env line to fix versus one to write — so they are two different words,
# and `token_source=` names the file to open.
if [ "$POLICY" -eq 1 ]; then
  # FND_FIGMA_SOURCE is GLOBAL-ONLY: it decides whether a token may be used at all, so a client
  # repository's committable .claude/domaine.env has no say in it (env-file.cjs's PROJECT_OK).
  POL="${FND_FIGMA_SOURCE:-}"
  [ -n "$POL" ] || POL="$(domaine_env FND_FIGMA_SOURCE || true)"
  POL="$(trim_ws "$POL")"
  case "$POL" in
    ''|auto) POL=auto ;;
    mcp|rest) ;;
    *) echo "note=invalid_figma_source value=$POL" >&2; POL=auto ;;
  esac
  tok=missing; tok_src=none
  if [ -n "$TOKEN" ]; then
    if token_charset_ok; then tok=present; tok_src="$TOKEN_SRC"
    else tok=invalid; tok_src="$TOKEN_SRC"; echo "note=invalid_figma_token source=$TOKEN_SRC" >&2; fi
  fi
  printf 'policy=%s token=%s token_source=%s\n' "$POL" "$tok" "$tok_src"
  exit 0
fi

# --- the target: a URL, or the explicit --file/--node pair ---------------------------------------
# Both halves are outside content and both become a URL path/query segment, so they are gated
# before ANYTHING is built out of them. LC_ALL=C so a locale cannot widen A-Z into something a
# path separator fits in.

# percent-decoding, table-driven: a node-id arrives as `I123-456%3B789-1` from a copied Dev Mode
# link and as `I123-456;789-1` from a hand-typed one. %00 is left literal and the gate refuses it.
url_decode() { # $1 = raw value
  printf '%s' "$1" | LC_ALL=C awk '
    BEGIN { for (i = 1; i < 256; i++) hex[sprintf("%02X", i)] = sprintf("%c", i) }
    {
      s = $0; out = ""
      while ((p = index(s, "%")) > 0) {
        out = out substr(s, 1, p - 1)
        h = toupper(substr(s, p + 1, 2))
        if (h ~ /^[0-9A-F][0-9A-F]$/ && (h in hex)) { out = out hex[h]; s = substr(s, p + 3) }
        else { out = out "%"; s = substr(s, p + 1) }
      }
      printf "%s", out s
    }'
}

# the segment right after /design/, /file/, /proto/ or /board/ — the four shapes figma.com hands
# out for the same file
url_file_key() { # $1 = url path → the key on stdout, non-zero when the path has none
  local seg take=0 reglob=0
  case "$-" in *f*) ;; *) reglob=1; set -f ;; esac
  local IFS=/
  for seg in $1; do
    if [ "$take" -eq 1 ]; then
      [ "$reglob" -eq 0 ] || set +f
      printf '%s' "$seg"; return 0
    fi
    case "$seg" in design|file|proto|board) take=1 ;; esac
  done
  [ "$reglob" -eq 0 ] || set +f
  return 1
}

url_query_param() { # $1 = query string, $2 = key → the raw value on stdout, non-zero when absent
  local pair reglob=0
  case "$-" in *f*) ;; *) reglob=1; set -f ;; esac
  local IFS='&'
  for pair in $1; do
    case "$pair" in
      "$2="*)
        [ "$reglob" -eq 0 ] || set +f
        printf '%s' "${pair#*=}"; return 0 ;;
    esac
  done
  [ "$reglob" -eq 0 ] || set +f
  return 1
}

if [ "$CHECK" -eq 0 ]; then
  if [ -n "$URL" ] && [ "$EXPLICIT" -eq 1 ]; then
    echo "error=conflicting_target (a URL and --file/--node are two ways to name one node — pass one or the other)" >&2
    exit 2
  fi
  if [ -n "$URL" ]; then
    u="$URL"; u="${u#https://}"; u="${u#http://}"
    host="${u%%/*}"; host="${host%%:*}"
    case "$host" in
      figma.com|www.figma.com) ;;
      *) echo "error=invalid_file_key url=$URL (expected a https://www.figma.com/design/<key>/… link)" >&2; exit 2 ;;
    esac
    rest=""; case "$u" in */*) rest="${u#*/}" ;; esac
    path="${rest%%\?*}"; path="${path%%#*}"
    query=""; case "$rest" in *\?*) query="${rest#*\?}" ;; esac
    query="${query%%#*}"
    FILE_KEY="$(url_file_key "$path" || true)"
    [ -n "$FILE_KEY" ] || { echo "error=invalid_file_key url=$URL (no /design/, /file/, /proto/ or /board/ segment)" >&2; exit 2; }
    FILE_KEY="$(url_decode "$FILE_KEY")"
    raw_node="$(url_query_param "$query" node-id || true)"
    # `--probe` asks the FILE when it last changed, so it is the one mode a node-less link answers
    [ -n "$raw_node" ] || [ "$PROBE" -eq 1 ] || {
      echo "error=missing_node_id url=$URL (the link must carry a node-id — select the frame in Figma and copy its link; whole-file reads are out of scope)" >&2
      exit 2
    }
    # Figma writes `123:456` as `123-456` in a link, instance ids `I123:456;789:1` as
    # `I123-456%3B789-1`: decode first, then every `-` is a `:` again
    [ -z "$raw_node" ] || NODE_ID="$(url_decode "$raw_node" | LC_ALL=C tr '-' ':')"
  else
    [ -n "$FILE_KEY" ] || { echo "error=missing_file_key (usage: figma-rest.sh <figma-url> | --file <key> --node <id>)" >&2; exit 2; }
    [ -n "$NODE_ID" ] || [ "$PROBE" -eq 1 ] \
      || { echo "error=missing_node_id (usage: figma-rest.sh <figma-url> | --file <key> --node <id>)" >&2; exit 2; }
  fi

  printf '%s' "$FILE_KEY" | LC_ALL=C grep -qE '^[A-Za-z0-9]+$' \
    || { echo "error=invalid_file_key key=$FILE_KEY" >&2; exit 2; }
  # a plain node id, or an INSTANCE id: `I<id>;<id>[;<id>…]`, the chain Figma builds for a nested
  # instance. Nothing else — both halves ride a URL query and a filename. (Empty only under
  # `--probe`, which never builds either from it.)
  [ -z "$NODE_ID" ] \
    || printf '%s' "$NODE_ID" | LC_ALL=C grep -qE '^([0-9]+:[0-9]+|I[0-9]+:[0-9]+(;[0-9]+:[0-9]+)+)$' \
    || { echo "error=invalid_node_id node=$NODE_ID (expected 123:456, or I123:456;789:1 for an instance)" >&2; exit 2; }

  case "$SCALE" in
    ''|*[!0-9.]*|.|*.*.*) echo "error=invalid_scale value=$SCALE (0 < N <= 4)" >&2; exit 2 ;;
  esac
  LC_ALL=C awk -v s="$SCALE" 'BEGIN { exit !(s + 0 > 0 && s + 0 <= 4) }' \
    || { echo "error=invalid_scale value=$SCALE (0 < N <= 4)" >&2; exit 2; }
fi

command -v curl >/dev/null 2>&1 || { echo "error=curl_not_found" >&2; exit 2; }
command -v jq   >/dev/null 2>&1 || { echo "error=jq_not_found" >&2; exit 2; }

if [ -z "$TOKEN" ]; then
  echo "error=no_figma_token (FIGMA_TOKEN, from the environment or $ENV_FILE)" >&2
  echo "$HINT" >&2
  exit 3
fi
token_charset_ok || {
  echo "error=invalid_figma_token source=$TOKEN_SRC (contains whitespace, a quote or another character no Figma personal access token has)" >&2
  # the same ONE hint line the missing case gets: BOTH exit-3 outcomes are "the credential needs
  # fixing", and figma-reader quotes that line verbatim into needs_clarification either way
  echo "$HINT" >&2
  exit 3
}

CFG="$(mktemp)"; HDRF="$(mktemp)"; SCRATCH="$(mktemp)"
# Staging paths, filled in as each artifact is fetched (below). They are PER PROCESS: figma-reader
# runs one per Figma URL in parallel, and two frames of the SAME file share both `--out` and the
# file key, so a fixed `<key>.variables.json.part` would have two curls writing one file.
NODES_PART=""; VARS_PART=""; IMG_PART=""
trap 'rm -f "$CFG" "$HDRF" "$SCRATCH" ${NODES_PART:+"$NODES_PART"} ${VARS_PART:+"$VARS_PART"} ${IMG_PART:+"$IMG_PART"}' EXIT
curl_config_write "$CFG" "$(printf 'header = "X-Figma-Token: %s"' "$TOKEN")" \
  || { echo "error=curl_config_unwritable" >&2; exit 2; }

# --- requests -----------------------------------------------------------------------------------
# The timeouts are bounds, not tuning: without them a stalled Figma call hangs every skill waiting
# on it. NO `-L` here — a redirect must never carry the token config anywhere.
# 120 s covers the node tree (~2 s on a real 275 KB frame) and the PNG hop (~4 s). `variables/local`
# is the outlier: it serialises the file's WHOLE variable library, and a real ELC read took 66 s for
# 656 KB — 120 s leaves barely 2× headroom, so a slow network turns an optional artifact into
# `note=variables_failed` + exit 1. It gets 300 s of its own.
CURL_MAX_TIME=120
CURL_MAX_TIME_VARIABLES=300
CURL_OPTS=(-sS --connect-timeout 10 --proto =https --proto-redir =https)
API=https://api.figma.com

api_get() { # $1 = full URL, $2 = out file, $3 = --max-time override ("" = $CURL_MAX_TIME)
  : > "$HDRF"
  curl "${CURL_OPTS[@]}" --max-time "${3:-$CURL_MAX_TIME}" -K "$CFG" -H 'Accept: application/json' \
    -D "$HDRF" -o "$2" -w '%{http_code}' "$1"
}

retry_after() { # the header dump → the Retry-After seconds, "" when the response carried none
  LC_ALL=C sed -n 's/^[Rr]etry-[Aa]fter:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$HDRF" 2>/dev/null \
    | head -1 | tr -d '\r' || true
}

# ONE retry, and the wait is Figma's own number — capped at 60 s because a server that asks for an
# hour is asking for a later run, not a sleeping script. No Retry-After at all → 5 s. Out-of-range
# values are clamped INTO the range, never to its far end: `Retry-After: 0` is a server saying
# "retry now", and turning that into a full minute is the opposite of honouring it. The note is
# printed HERE, from the clamped number, so the wait announced is always the wait taken.
sleep_retry() { # $1 = the Retry-After value ("" = none)
  local s="$1"
  case "$s" in ''|*[!0-9]*) s=5 ;; esac
  [ "$s" -ge 1 ] 2>/dev/null || s=1
  [ "$s" -le 60 ] 2>/dev/null || s=60
  echo "note=rate_limited_retry after=${s}s" >&2
  sleep "$s"
}

api_get_retry() { # $1 = url, $2 = out file, $3 = --max-time override → http code; one 429 retry
  local code ra
  code="$(api_get "$1" "$2" "${3:-}")" || return 1
  if [ "$code" = 429 ]; then
    ra="$(retry_after)"
    sleep_retry "$ra"
    code="$(api_get "$1" "$2" "${3:-}")" || return 1
  fi
  printf '%s' "$code"
}

# The PNG hop. A pre-signed S3 URL needs no credential and must not be handed one, so this call
# takes NO `-K` — that is the whole reason it is a second function and not a flag on the first.
img_get() { # $1 = pre-signed url, $2 = out file → http code on stdout
  curl -sS -L --connect-timeout 10 --max-time "$CURL_MAX_TIME" --proto =https --proto-redir =https \
    -o "$2" -w '%{http_code}' "$1"
}

reject_auth() { # $1 = http code
  echo "error=token_rejected http=$1" >&2
  echo "$AUTH_HINT" >&2
  exit 4
}

if [ "$CHECK" -eq 1 ]; then
  code="$(api_get_retry "$API/v1/me" "$SCRATCH")" || { echo "error=curl_transport_failed" >&2; exit 5; }
  case "$code" in
    2*) ;;
    401|403) reject_auth "$code" ;;
    *) echo "error=figma_request_failed http=$code path=me" >&2; exit 4 ;;
  esac
  # the handle, never the email: /v1/me carries one and a --check line is pasted into tickets
  printf 'ok=1 figma_user=%s token_source=%s\n' \
    "$(jq -r '((.handle // .name // "unknown") | tostring) | gsub("[[:cntrl:]]"; " ")' "$SCRATCH" 2>/dev/null || echo unknown)" \
    "$TOKEN_SRC"
  exit 0
fi

# --- --probe: the file's version, and nothing else -----------------------------------------------
# The freshness probe. `lastModified` on a CACHED run is the cached file's own value — comparing it
# with itself can only ever say "fresh" — so a real version check has to ask Figma. `depth=1` is the
# cheapest question that carries it: the file's meta plus its top-level children, not the tree. No
# out-dir gate and nothing written: this mode reads, it does not fetch.
if [ "$PROBE" -eq 1 ]; then
  code="$(api_get_retry "$API/v1/files/$FILE_KEY?depth=1" "$SCRATCH")" \
    || { echo "error=curl_transport_failed" >&2; exit 5; }
  case "$code" in
    2*) ;;
    401|403) reject_auth "$code" ;;
    404) echo "error=file_not_found file_key=$FILE_KEY http=404" >&2; exit 4 ;;
    429) echo "error=rate_limited http=429 (Figma is throttling this token — try again in a minute)" >&2; exit 4 ;;
    *) echo "error=figma_request_failed http=$code path=files/$FILE_KEY" >&2; exit 4 ;;
  esac
  PROBE_LM="$(jq -r '((.lastModified // "") | tostring) | gsub("[[:cntrl:]]"; " ")' "$SCRATCH" 2>/dev/null || true)"
  [ -n "$PROBE_LM" ] || {
    echo "error=figma_request_failed http=$code path=files/$FILE_KEY (the response carries no lastModified)" >&2
    exit 4
  }
  printf 'ok=1 file_key=%s%s last_modified=%s\n' \
    "$FILE_KEY" "${NODE_ID:+ node_id=$NODE_ID}" "$PROBE_LM"
  exit 0
fi

# --- the payload dir must be a path git ignores --------------------------------------------------
[ -n "$OUT_DIR" ] || OUT_DIR=".claude/tasks/_figma/tmp"
out_dir_gate "$OUT_DIR" || exit 2
OUT_ABS="$OUT_DIR_ABS"

# `:` is legal in a filename on every platform this runs on and illegal on one it may be copied to,
# and `;` is a shell metacharacter in every path a developer pastes: the node id is flattened for
# disk and percent-encoded for the query, so neither spelling has to be guessed downstream.
NODE_FS="$(printf '%s' "$NODE_ID" | LC_ALL=C tr ':;' '-_')"
NODE_Q="$(printf '%s' "$NODE_ID" | LC_ALL=C sed -e 's/:/%3A/g' -e 's/;/%3B/g')"

NODES_FILE="$OUT_ABS/$FILE_KEY-$NODE_FS.nodes.json"
VARS_FILE="$OUT_ABS/$FILE_KEY.variables.json"
# The render scale is part of the PNG's IDENTITY, not a detail of how it was fetched: a developer
# who asks for `--scale 4` to read fine text off a frame must not be handed the 2× render a previous
# run left behind. In the name, so a different scale is a cache miss.
IMG_FILE="$OUT_ABS/$FILE_KEY-$NODE_FS@${SCALE}x.png"

# A unique sibling of the final path: the rename stays atomic (same directory) while two concurrent
# runs can never hand each other half a body.
mkpart() { # $1 = the final path → the staging path on stdout, non-zero when the dir refuses it
  mktemp "$1.XXXXXX" 2>/dev/null
}

file_size() { wc -c < "$1" 2>/dev/null | tr -d ' '; }
json_cached() { [ -s "$1" ] && jq -e . "$1" >/dev/null 2>&1; }
nodes_cached() { json_cached "$1" && jq -e --arg id "$NODE_ID" '(.nodes[$id] // null) != null' "$1" >/dev/null 2>&1; }

saved=0; cached=0; unavailable=0; failed=0
count() { case "$1" in saved) saved=$((saved + 1)) ;; cached) cached=$((cached + 1)) ;;
                       unavailable) unavailable=$((unavailable + 1)) ;; failed) failed=$((failed + 1)) ;; esac; }

# --- 1. the node subtree — the one request that is not optional ---------------------------------
if [ "$FORCE" -eq 0 ] && nodes_cached "$NODES_FILE"; then
  NODES_STATUS=cached
else
  NODES_PART="$(mkpart "$NODES_FILE")" \
    || { echo "error=out_dir_not_writable out=$OUT_ABS" >&2; exit 2; }
  code="$(api_get_retry "$API/v1/files/$FILE_KEY/nodes?ids=$NODE_Q" "$NODES_PART")" \
    || { rm -f "$NODES_PART"; echo "error=curl_transport_failed" >&2; exit 5; }
  case "$code" in
    2*) ;;
    401|403) rm -f "$NODES_PART"; reject_auth "$code" ;;
    404) rm -f "$NODES_PART"
         echo "error=node_not_found file_key=$FILE_KEY node_id=$NODE_ID http=404" >&2; exit 4 ;;
    429) rm -f "$NODES_PART"
         echo "error=rate_limited http=429 (Figma is throttling this token — try again in a minute)" >&2; exit 4 ;;
    *)   rm -f "$NODES_PART"
         echo "error=figma_request_failed http=$code path=files/$FILE_KEY/nodes" >&2; exit 4 ;;
  esac
  # Figma answers 200 with `{"nodes":{"<id>":null}}` for an id that is not in the file — a body
  # that parses perfectly and carries no design at all. Unknown node, not a successful read.
  if ! nodes_cached "$NODES_PART"; then
    rm -f "$NODES_PART"
    echo "error=node_not_found file_key=$FILE_KEY node_id=$NODE_ID (the response carries no such node)" >&2
    exit 4
  fi
  mv -f "$NODES_PART" "$NODES_FILE" \
    || { rm -f "$NODES_PART"; echo "error=out_dir_not_writable out=$OUT_ABS" >&2; exit 2; }
  NODES_PART=""
  NODES_STATUS=saved
fi
count "$NODES_STATUS"
NODE_NAME="$(jq -r --arg id "$NODE_ID" '((.nodes[$id].document.name // "") | tostring) | gsub("[[:cntrl:]]"; " ")' "$NODES_FILE" 2>/dev/null || true)"
LAST_MOD="$(jq -r '((.lastModified // "") | tostring) | gsub("[[:cntrl:]]"; " ")' "$NODES_FILE" 2>/dev/null || true)"

# --- 2. the file's local variables — absent on every plan below Enterprise ----------------------
VARS_STATUS=skipped; VARS_PATH=""
if [ "$DO_VARS" -eq 1 ]; then
  if [ "$FORCE" -eq 0 ] && json_cached "$VARS_FILE"; then
    VARS_STATUS=cached; VARS_PATH="$VARS_FILE"
  else
    if VARS_PART="$(mkpart "$VARS_FILE")"; then
      code="$(api_get_retry "$API/v1/files/$FILE_KEY/variables/local" "$VARS_PART" "$CURL_MAX_TIME_VARIABLES")" || code=000
      case "$code" in
        # An OPTIONAL artifact never takes the run down with it: a rename that loses a race
        # degrades to `failed` + a note, exactly like a bad response would.
        2*) if mv -f "$VARS_PART" "$VARS_FILE" 2>/dev/null; then
              VARS_PART=""; VARS_STATUS=saved; VARS_PATH="$VARS_FILE"
            else
              rm -f "$VARS_PART"; VARS_PART=""; VARS_STATUS=failed
              echo "note=variables_failed http=$code reason=stage_failed" >&2
            fi ;;
        # 403 here is a PLAN, not a permission problem: the Variables REST API is Enterprise-only,
        # and the compactor already knows how to fall back to raw values. Not an error.
        403) rm -f "$VARS_PART"; VARS_PART=""; VARS_STATUS=unavailable
             echo "note=variables_unavailable http=403" >&2 ;;
        *) rm -f "$VARS_PART"; VARS_PART=""; VARS_STATUS=failed
           echo "note=variables_failed http=$code" >&2 ;;
      esac
    else
      VARS_PART=""; VARS_STATUS=failed
      echo "note=variables_failed http=000 reason=stage_failed" >&2
    fi
  fi
  count "$VARS_STATUS"
fi

# --- 3. the PNG render — the reader's visual ground truth ----------------------------------------
IMG_STATUS=skipped; IMG_PATH=""
if [ "$DO_IMAGE" -eq 1 ]; then
  if [ "$FORCE" -eq 0 ] && [ -s "$IMG_FILE" ]; then
    IMG_STATUS=cached; IMG_PATH="$IMG_FILE"
  else
    code="$(api_get_retry "$API/v1/images/$FILE_KEY?ids=$NODE_Q&format=png&scale=$SCALE" "$SCRATCH")" || code=000
    case "$code" in
      2*)
        img_url="$(jq -r --arg id "$NODE_ID" '(.images[$id] // "") | tostring' "$SCRATCH" 2>/dev/null || true)"
        img_err="$(jq -r '(.err // "") | tostring' "$SCRATCH" 2>/dev/null || true)"
        case "$img_url" in
          https://*)
            if IMG_PART="$(mkpart "$IMG_FILE")"; then
              dcode="$(img_get "$img_url" "$IMG_PART")" || dcode=000
              case "$dcode" in
                2*) if [ -s "$IMG_PART" ] && mv -f "$IMG_PART" "$IMG_FILE" 2>/dev/null; then
                      IMG_PART=""; IMG_STATUS=saved; IMG_PATH="$IMG_FILE"
                    else
                      rm -f "$IMG_PART"; IMG_PART=""; IMG_STATUS=failed
                      echo "note=image_failed http=$dcode reason=empty_body" >&2
                    fi ;;
                *) rm -f "$IMG_PART"; IMG_PART=""; IMG_STATUS=failed
                   echo "note=image_failed http=$dcode" >&2 ;;
              esac
            else
              IMG_PART=""; IMG_STATUS=failed
              echo "note=image_failed http=000 reason=stage_failed" >&2
            fi ;;
          # a null url is Figma saying it could not render this node (too large, or nothing
          # visible in it) — the node tree is still the deliverable, so this is not a failure.
          # A render from an EARLIER run is removed with it: a node Figma can no longer draw must
          # not keep answering `cached` with bytes that no longer match the tree.
          *) rm -f "$IMG_FILE"; IMG_STATUS=unavailable
             echo "note=image_unavailable${img_err:+ err=$img_err}" >&2 ;;
        esac ;;
      *) IMG_STATUS=failed; echo "note=image_failed http=$code" >&2 ;;
    esac
  fi
  count "$IMG_STATUS"
fi

# --- the rows -------------------------------------------------------------------------------------
nb="$(file_size "$NODES_FILE")"; [ -n "$nb" ] || nb=0
vb=0; [ -z "$VARS_PATH" ] || { vb="$(file_size "$VARS_PATH")"; [ -n "$vb" ] || vb=0; }
ib=0; [ -z "$IMG_PATH" ] || { ib="$(file_size "$IMG_PATH")"; [ -n "$ib" ] || ib=0; }

if [ "$JSON" -eq 1 ]; then
  jq -nc --arg fk "$FILE_KEY" --arg nid "$NODE_ID" --arg nm "$NODE_NAME" --arg lm "$LAST_MOD" \
    --arg ns "$NODES_STATUS" --arg np "$NODES_FILE" --argjson nb "$nb" \
    --arg vs "$VARS_STATUS" --arg vp "$VARS_PATH" --argjson vb "$vb" \
    --arg is "$IMG_STATUS" --arg ip "$IMG_PATH" --argjson ib "$ib" \
    '{file_key: $fk, node_id: $nid, name: $nm, last_modified: $lm,
      nodes: {status: $ns, path: $np, bytes: $nb},
      variables: {status: $vs, path: $vp, bytes: $vb},
      image: {status: $is, path: $ip, bytes: $ib}}'
else
  printf 'kind=nodes status=%s path=%s bytes=%s\n' "$NODES_STATUS" "$NODES_FILE" "$nb"
  printf 'kind=variables status=%s path=%s bytes=%s\n' "$VARS_STATUS" "$VARS_PATH" "$vb"
  printf 'kind=image status=%s path=%s bytes=%s\n' "$IMG_STATUS" "$IMG_PATH" "$ib"
  # `name=` LAST: it is the one field a Figma layer can put spaces (and a `last_modified=` of its
  # own) into, so it goes where nothing follows it to shadow.
  printf 'kind=meta file_key=%s node_id=%s last_modified=%s name=%s\n' \
    "$FILE_KEY" "$NODE_ID" "$LAST_MOD" "$NODE_NAME"
fi

echo "ok=1 saved=$saved cached=$cached unavailable=$unavailable failed=$failed out=$OUT_ABS" >&2
[ "$failed" -eq 0 ] || exit 1
