#!/usr/bin/env bash
# Simulation harness for scripts/figma-rest.sh. No network and no Figma: `curl` and `sleep` are
# PATH shims, and the PATH itself is a dir of symlinks to exactly the tools the script uses.
# The curl shim answers by URL, logs the argv as it was handed over (the transport flags and the
# -K pairing live nowhere else) and copies the private 0600 config out, so a case can assert both
# that the auth header is the only directive in it and that the pre-signed S3 hop carries neither.
# Exit 0 = all green.
set -u

# Hermetic env: a developer with a real FIGMA_TOKEN exported would otherwise have their own
# credential reach the fake curl (and this suite's argv log) instead of the fixture value, and an
# exported FND_FIGMA_SOURCE would answer every --policy case before the resolution ever ran.
unset FIGMA_TOKEN FND_FIGMA_SOURCE

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FR="$ROOT/plugins/fnd/scripts/figma-rest.sh"
BASH_BIN="$(command -v bash)"

# physical, not logical: on macOS `mktemp -d` hands back a /var/… path whose real home is
# /private/var, and the script compares its own $PWD-derived out dir against what git reports
TMP="$(mktemp -d)"; TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
STATE="$TMP/state"; mkdir -p "$STATE" "$TMP/frtmp" "$TMP/xdg"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }
# assert <label> <want-rc> <got-rc> <stderr-file> [required-stderr-substring]
assert() {
  local label="$1" want="$2" got="$3" errf="$4" substr="${5-}"
  if [ "$got" -ne "$want" ]; then
    bad "$label" "exit $got, want $want :: $(head -c 200 "$errf" | tr '\n' ' ')"; return
  fi
  if [ -n "$substr" ] && ! grep -qF "$substr" "$errf"; then
    bad "$label" "stderr missing '$substr' :: $(head -c 200 "$errf" | tr '\n' ' ')"; return
  fi
  ok
}

# --------------------------------------------------------------------------- the shims --
BIN="$TMP/bin"; mkdir -p "$BIN"
for b in bash sh jq git awk sed tr grep head tail wc sort cat cp mv rm mkdir rmdir touch chmod \
         mktemp dirname basename ls env printf date find od; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$BIN/$b"
done

SHIM="$TMP/shim"; mkdir -p "$SHIM"

cat > "$SHIM/curl" <<'FAKE'
#!/usr/bin/env bash
# Answers by URL. Every code knob is a comma list read one entry per call (`429,200` = throttled
# once, then fine) so a retry can be modelled without a second process.
[ -n "${CURL_ARGV:-}" ] && printf '%s\n' "$*" >> "$CURL_ARGV"
out=""; cfg=""; url=""; hdr=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -D) hdr="$2"; shift 2 ;;
    -K) cfg="$2"; shift 2 ;;
    -w|-H) shift 2 ;;
    --connect-timeout|--max-time|--proto|--proto-redir) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ -n "$cfg" ] && [ -n "${CURL_CFG_SAVE:-}" ] && cp "$cfg" "$CURL_CFG_SAVE"
# the -K pairing per URL: the S3 hop must appear here with an EMPTY config column
[ -n "${CFG_LOG:-}" ] && printf '%s\t%s\n' "$url" "$cfg" >> "$CFG_LOG"
[ -n "$hdr" ] && : > "$hdr"
out="${out:-/dev/null}"

pick() { # $1 = comma list, $2 = counter name → the nth entry (the last one repeats)
  local f n
  f="${CURL_STATE:-/tmp}/$2.count"
  n=0; [ -f "$f" ] && n="$(cat "$f")"
  n=$((n + 1)); printf '%s' "$n" > "$f"
  printf '%s' "$1" | awk -F, -v i="$n" '{ if (i > NF) i = NF; printf "%s", $i }'
}
ids_of() { printf '%s' "$1" | sed -n 's/.*[?&]ids=\([^&]*\).*/\1/p' | sed -e 's/%3A/:/g' -e 's/%3B/;/g'; }

code=200
case "$url" in
  */v1/me)
    code="$(pick "${FAKE_HTTP_ME:-200}" me)"
    printf '{"id":"1","handle":"ada","email":"ada@example.com"}' > "$out" ;;
  */v1/files/*depth=1*)
    # the freshness probe: the file's own meta, never the tree
    code="$(pick "${FAKE_HTTP_PROBE:-200}" probe)"
    if [ "${FAKE_PROBE_NO_LM:-}" = 1 ]; then printf '{"name":"File","role":"viewer"}' > "$out"
    else printf '{"name":"File","role":"viewer","lastModified":"%s"}' "${FAKE_LAST_MODIFIED:-2026-09-01T10:00:00Z}" > "$out"; fi ;;
  */v1/files/*/variables/local)
    code="$(pick "${FAKE_HTTP_VARS:-200}" vars)"
    printf '{"meta":{"variableCollections":{},"variables":{}}}' > "$out" ;;
  */v1/files/*/nodes*)
    code="$(pick "${FAKE_HTTP_NODES:-200}" nodes)"
    ids="$(ids_of "$url")"
    [ -n "${IDS_LOG:-}" ] && printf '%s\n' "$ids" >> "$IDS_LOG"
    if [ -n "${FAKE_NODES_RAW:-}" ]; then printf '%s' "$FAKE_NODES_RAW" > "$out"
    elif [ "${FAKE_NODE_NULL:-}" = 1 ]; then
      printf '{"name":"File","lastModified":"2026-09-01T10:00:00Z","nodes":{"%s":null}}' "$ids" > "$out"
    else
      printf '{"name":"File","lastModified":"%s","nodes":{"%s":{"document":{"id":"%s","name":"Hero Frame","type":"FRAME"}}}}' \
        "${FAKE_LAST_MODIFIED:-2026-09-01T10:00:00Z}" "$ids" "$ids" > "$out"
    fi ;;
  */v1/images/*)
    code="$(pick "${FAKE_HTTP_IMAGES:-200}" images)"
    ids="$(ids_of "$url")"
    [ -n "${IMG_URL_LOG:-}" ] && printf '%s\n' "$url" >> "$IMG_URL_LOG"
    if [ "${FAKE_IMAGE_NULL:-}" = 1 ]; then
      printf '{"err":null,"images":{"%s":null}}' "$ids" > "$out"
    else
      printf '{"err":null,"images":{"%s":"https://s3.example.com/render.png"}}' "$ids" > "$out"
    fi ;;
  https://s3.example.com/*)
    code="$(pick "${FAKE_HTTP_S3:-200}" s3)"
    head -c "${FAKE_PNG_BYTES:-512}" /dev/zero | tr '\0' 'P' > "$out" ;;
  *) code=599; : > "$out" ;;
esac
# a throttled answer carries the wait Figma wants; the script's cap is asserted against it
if [ "$code" = 429 ] && [ -n "$hdr" ]; then
  printf 'HTTP/2 429\r\nRetry-After: %s\r\n\r\n' "${FAKE_RETRY_AFTER:-7}" > "$hdr"
fi
printf '%s' "$code"
FAKE

cat > "$SHIM/sleep" <<'FAKE'
#!/usr/bin/env bash
# a suite may not actually wait out a Retry-After — the instants themselves are the assertion
[ -n "${SLEEP_LOG:-}" ] && printf '%s\n' "$*" >> "$SLEEP_LOG"
exit 0
FAKE
chmod +x "$SHIM/curl" "$SHIM/sleep"

# ------------------------------------------------------------------------ fixtures + runner --
KEY="AbC123xyz"
TOKEN="figd_SECRET-value_09=="
URL_D="https://www.figma.com/design/$KEY/Loyalty?node-id=1-2&t=abc"

FR_PATH="$SHIM:$BIN"
fr() { # fr <cwd> <args…> — every knob below is a one-shot prefix on the call
  local cwd="$1"; shift
  # the per-URL call counters are per RUN: a 429 retry happens inside one invocation, and a
  # sequence left over from an earlier case would answer the next one's first request. A case that
  # runs two invocations AT ONCE passes its own FR_STATE so neither resets the other's counters.
  local st="${FR_STATE:-$STATE}"
  if [ -z "${FR_STATE:-}" ]; then rm -rf "$STATE"; mkdir -p "$STATE"; fi
  ( cd "$cwd" && PATH="${FR_PATH_OVERRIDE:-$FR_PATH}" \
      CURL_ARGV="${CURL_ARGV:-/dev/null}" CURL_CFG_SAVE="${CURL_CFG_SAVE:-}" \
      CFG_LOG="${CFG_LOG:-/dev/null}" IDS_LOG="${IDS_LOG:-/dev/null}" \
      IMG_URL_LOG="${IMG_URL_LOG:-/dev/null}" SLEEP_LOG="${SLEEP_LOG:-/dev/null}" \
      CURL_STATE="$st" \
      FAKE_HTTP_PROBE="${FAKE_HTTP_PROBE:-200}" FAKE_PROBE_NO_LM="${FAKE_PROBE_NO_LM:-}" \
      FAKE_HTTP_NODES="${FAKE_HTTP_NODES:-200}" FAKE_HTTP_VARS="${FAKE_HTTP_VARS:-200}" \
      FAKE_HTTP_IMAGES="${FAKE_HTTP_IMAGES:-200}" FAKE_HTTP_S3="${FAKE_HTTP_S3:-200}" \
      FAKE_HTTP_ME="${FAKE_HTTP_ME:-200}" FAKE_NODE_NULL="${FAKE_NODE_NULL:-}" \
      FAKE_NODES_RAW="${FAKE_NODES_RAW:-}" FAKE_IMAGE_NULL="${FAKE_IMAGE_NULL:-}" \
      FAKE_RETRY_AFTER="${FAKE_RETRY_AFTER:-7}" FAKE_PNG_BYTES="${FAKE_PNG_BYTES:-512}" \
      FAKE_LAST_MODIFIED="${FAKE_LAST_MODIFIED:-2026-09-01T10:00:00Z}" \
      XDG_CONFIG_HOME="${FR_XDG:-$TMP/xdg}" \
      FIGMA_TOKEN="${FR_TOKEN-$TOKEN}" FND_FIGMA_SOURCE="${FR_SOURCE-}" \
      TMPDIR="$TMP/frtmp" \
      "$BASH_BIN" "$FR" "$@" )
}

new_repo() { # new_repo <name> [gitignore-line] → prints the path of a fresh git repo
  local d="$TMP/repos/$1"
  mkdir -p "$d"
  git -C "$d" init -q 2>/dev/null
  [ -n "${2-}" ] && printf '%s\n' "$2" > "$d/.gitignore"
  printf '%s' "$d"
}

# `kind=<k>` row, field <name> — the stdout contract is key=value, so the reader is one awk
row() { # row <kind> <key> <file>
  awk -v k="kind=$1" -v want="$2=" \
    '$1 == k { for (i = 2; i <= NF; i++) if (index($i, want) == 1) print substr($i, length(want) + 1) }' "$3"
}
# the meta line's `name=` is the one field that may carry spaces, and it is LAST for exactly that
# reason: everything before it is a fixed key=value grammar, the name is the rest of the line. A
# name in front of the other fields would shadow them for this very reader.
meta() { # meta <key> <file> — file_key / node_id / last_modified
  awk -v want="$1=" '$1 == "kind=meta" {
    for (i = 2; i <= NF; i++) if (index($i, want) == 1) { print substr($i, length(want) + 1); exit } }' "$2"
}
# the fixed prefix is stripped by NAME, not by a greedy `.*`: a name carrying ` name=` of its own
# would otherwise hand back its own tail
meta_name() { sed -n 's/^kind=meta file_key=[^ ]* node_id=[^ ]* last_modified=[^ ]* name=//p' "$1" | head -1; }

O="$TMP/out"; E="$TMP/err"
REPO="$(new_repo main '.claude/')"
OUT="$REPO/.claude/tasks/ELC-1/tmp/figma"

# ============================================================ 1. URL parsing =================
# Every shape figma.com hands out for the same file, and the node-id spelling rule: `123-456` in a
# link IS `123:456` in the API, and an instance id arrives percent-encoded or with a literal `;`.
i=0
for u in "https://www.figma.com/design/$KEY/Loyalty?node-id=1-2&t=abc" \
         "https://figma.com/file/$KEY/Loyalty?node-id=1-2" \
         "https://www.figma.com/proto/$KEY/Loyalty?node-id=1-2&scaling=min-zoom" \
         "https://www.figma.com/board/$KEY/Jam?node-id=1-2" \
         "https://www.figma.com/design/$KEY/Name%20With%20Spaces?node-id=1-2#hash"; do
  i=$((i + 1))
  D="$(new_repo "url$i" '.claude/')"
  rc=0; fr "$D" "$u" --out "$D/.claude/x" >"$O" 2>"$E" || rc=$?
  if [ "$rc" -eq 0 ] && [ "$(meta file_key "$O")" = "$KEY" ] && [ "$(meta node_id "$O")" = "1:2" ]; then ok
  else bad "F1-url-form-$i" "rc=$rc url=$u meta=$(grep '^kind=meta' "$O")"; fi
done

# instance ids: `I1-2%3B3-4` (copied from Dev Mode) and `I1-2;3-4` (hand-typed) are one node
IDSL="$TMP/ids-inst"; : > "$IDSL"
D="$(new_repo url-inst '.claude/')"
rc=0; IDS_LOG="$IDSL" fr "$D" "https://www.figma.com/design/$KEY/L?node-id=I1-2%3B3-4" \
  --out "$D/.claude/x" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(meta node_id "$O")" = "I1:2;3:4" ] && [ "$(cat "$IDSL")" = "I1:2;3:4" ]; then ok
else bad F1-instance-encoded "rc=$rc node=$(meta node_id "$O") ids=$(cat "$IDSL")"; fi
D="$(new_repo url-inst2 '.claude/')"
rc=0; fr "$D" "https://www.figma.com/design/$KEY/L?node-id=I1-2;3-4" --out "$D/.claude/x" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(meta node_id "$O")" = "I1:2;3:4" ]; then ok
else bad F1-instance-literal "rc=$rc node=$(meta node_id "$O")"; fi
# the id also becomes a FILENAME: neither spelling may leave a `:` or a `;` on disk
if [ -s "$D/.claude/x/$KEY-I1-2_3-4.nodes.json" ] \
   && [ -z "$(find "$D/.claude/x" -name '*[:;]*' 2>/dev/null)" ]; then ok
else bad F1-instance-filename "$(ls "$D/.claude/x" 2>&1 | tr '\n' ' ')"; fi

# a URL with no node-id is a whole-file read, which is out of scope — and nothing goes out
ARGV="$TMP/argv-nonode"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" fr "$REPO" "https://www.figma.com/design/$KEY/Loyalty" --out "$OUT" >"$O" 2>"$E" || rc=$?
assert F1-missing-node-id 2 "$rc" "$E" "error=missing_node_id"
if [ ! -s "$ARGV" ]; then ok; else bad F1-missing-node-no-request "a request went out for a node-less URL"; fi

# hostile values: both halves ride a URL and a filename, so they are gated before anything is built
ARGV="$TMP/argv-hostile"
for pair in "https://www.figma.com/design/..%2F..%2Fetc/x?node-id=1-2:error=invalid_file_key" \
            "https://www.figma.com/design/$KEY-x/L?node-id=1-2:error=invalid_file_key" \
            "https://www.figma.com/design/$KEY/L?node-id=1-2%26ids%3D9-9:error=invalid_node_id" \
            "https://www.figma.com/design/$KEY/L?node-id=..%2F..%2Fx:error=invalid_node_id" \
            "https://www.figma.com/design/$KEY/L?node-id=1-2%20-o%20x:error=invalid_node_id" \
            "https://evil.example.com/design/$KEY/L?node-id=1-2:error=invalid_file_key" \
            "https://www.figma.com/$KEY/L?node-id=1-2:error=invalid_file_key"; do
  u="${pair%:error=*}"; want="error=${pair##*:error=}"
  : > "$ARGV"
  rc=0; CURL_ARGV="$ARGV" fr "$REPO" "$u" --out "$OUT" >"$O" 2>"$E" || rc=$?
  assert F1-hostile 2 "$rc" "$E" "$want"
  if [ ! -s "$ARGV" ]; then ok; else bad F1-hostile-request "a hostile target reached the network: $u"; fi
done

# the explicit form, and the two ways of naming one node being mutually exclusive
D="$(new_repo explicit '.claude/')"
rc=0; fr "$D" --file "$KEY" --node "1:2" --out "$D/.claude/x" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(meta file_key "$O")" = "$KEY" ] && [ "$(meta node_id "$O")" = "1:2" ]; then ok
else bad F1-explicit "rc=$rc meta=$(grep '^kind=meta' "$O")"; fi
rc=0; fr "$REPO" "$URL_D" --file "$KEY" --node 1:2 --out "$OUT" >"$O" 2>"$E" || rc=$?
assert F1-conflict 2 "$rc" "$E" "error=conflicting_target"
rc=0; fr "$REPO" --file "$KEY" --out "$OUT" >"$O" 2>"$E" || rc=$?
assert F1-file-only 2 "$rc" "$E" "error=missing_node_id"
rc=0; fr "$REPO" --node 1:2 --out "$OUT" >"$O" 2>"$E" || rc=$?
assert F1-node-only 2 "$rc" "$E" "error=missing_file_key"
rc=0; fr "$REPO" --file "$KEY" --node '1:2 x' --out "$OUT" >"$O" 2>"$E" || rc=$?
assert F1-explicit-bad-node 2 "$rc" "$E" "error=invalid_node_id"
rc=0; fr "$REPO" --file "../../etc" --node 1:2 --out "$OUT" >"$O" 2>"$E" || rc=$?
assert F1-explicit-bad-key 2 "$rc" "$E" "error=invalid_file_key"
rc=0; fr "$REPO" "$URL_D" --out "$OUT" --bogus >"$O" 2>"$E" || rc=$?
assert F1-unknown-arg 2 "$rc" "$E" "error=unknown_arg arg=--bogus"
rc=0; fr "$REPO" "$URL_D" --out >"$O" 2>"$E" || rc=$?
assert F1-missing-value 2 "$rc" "$E" "error=missing_value flag=--out"
rc=0; fr "$REPO" "$URL_D" "$URL_D" --out "$OUT" >"$O" 2>"$E" || rc=$?
assert F1-two-urls 2 "$rc" "$E" "error=unexpected_arg"

# --- the mode gate: one question per run, and two of the three take no target ---------------
# `--check` and `--policy` used to parse the target only to drop it, and `--policy` exited before
# the target was looked at at all: `--policy <url>` answered a question nobody asked and nothing in
# the output said the URL had been swallowed. Both halves are refusals now, and the mode clash is
# judged FIRST so `--check --policy <url>` names one mistake rather than the wrong one.
MODEARGV="$TMP/argv-mode"
mode_case() { # mode_case <label> <want-error> <args…>
  local label="$1" want="$2"; shift 2
  : > "$MODEARGV"
  rc=0; CURL_ARGV="$MODEARGV" fr "$REPO" "$@" >"$O" 2>"$E" || rc=$?
  assert "$label" 2 "$rc" "$E" "$want"
  # a refused run asks nothing and answers nothing: no request, and no mode's stdout line
  if [ ! -s "$MODEARGV" ] && [ ! -s "$O" ]; then ok
  else bad "$label-quiet" "argv=$(tr '\n' ';' < "$MODEARGV" | head -c 120) out=$(head -c 120 "$O")"; fi
}
mode_case F1-check-url          error=conflicting_target --check "$URL_D"
mode_case F1-check-explicit     error=conflicting_target --check --file "$KEY" --node 1:2
mode_case F1-check-file-only    error=conflicting_target --check --file "$KEY"
mode_case F1-policy-url         error=conflicting_target --policy "$URL_D"
mode_case F1-policy-explicit    error=conflicting_target --policy --file "$KEY" --node 1:2
mode_case F1-check-policy       error=conflicting_mode   --check --policy
mode_case F1-check-probe        error=conflicting_mode   --check --probe
mode_case F1-policy-probe       error=conflicting_mode   --policy --probe "$URL_D"
mode_case F1-probe-check        error=conflicting_mode   --probe "$URL_D" --check
# precedence: the mode clash wins over the target one, so one run names one mistake
mode_case F1-mode-before-target error=conflicting_mode   --check --policy "$URL_D"
# …and `--probe` DOES take a target — the file key is its whole question
rc=0; fr "$REPO" "$URL_D" --probe >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qF "file_key=$KEY" "$O"; then ok
else bad F1-probe-keeps-target "rc=$rc out=$(cat "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# ============================================================ 2. the token ====================
NOTOK="$(new_repo notoken '.claude/')"
ARGV="$TMP/argv-notoken"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" FR_TOKEN="" fr "$NOTOK" "$URL_D" --out "$NOTOK/.claude/x" >"$O" 2>"$E" || rc=$?
assert F2-no-token 3 "$rc" "$E" "error=no_figma_token"
for want in "https://www.figma.com/settings" "Personal access tokens" "File content: read-only" \
            "Variables: read-only" "Current user: read-only" "FIGMA_TOKEN in <repo>/.env" \
            "references/figma-rest.md"; do
  if grep -qF "$want" "$E"; then ok; else bad F2-hint "hint does not name '$want'"; fi
done
# ONE hint line, so a reader can quote it verbatim into needs_clarification
if [ "$(grep -c '^hint=' "$E")" = 1 ]; then ok
else bad F2-hint-one-line "the hint is $(grep -c '^hint=' "$E") lines"; fi
if [ ! -s "$ARGV" ]; then ok; else bad F2-no-request "a request went out with no token: $(cat "$ARGV")"; fi

# the credential never leaves the config file: not the argv, not either stream
CFGSAVE="$TMP/cfg2"; ARGV="$TMP/argv2"; : > "$ARGV"; : > "$CFGSAVE"
D2="$(new_repo tok-env '.claude/')"; OUT2="$D2/.claude/tasks/ELC-1/tmp/figma"
rc=0; CURL_ARGV="$ARGV" CURL_CFG_SAVE="$CFGSAVE" fr "$D2" "$URL_D" --out "$OUT2" >"$O" 2>"$E" || rc=$?
assert F2-env-token 0 "$rc" "$E"
if grep -qx "header = \"X-Figma-Token: $TOKEN\"" "$CFGSAVE" \
   && [ "$(wc -l < "$CFGSAVE" | tr -d ' ')" = 1 ]; then ok
else bad F2-config-line "config is not the single header line: $(head -c 200 "$CFGSAVE" 2>/dev/null)"; fi
for f in "$ARGV" "$O" "$E"; do
  if grep -qF "$TOKEN" "$f"; then bad "F2-leak-${f##*/}" "the token reached ${f##*/}"; else ok; fi
done

# the dotenv dialect the shared reader owns — every shape a developer's .env comes in
ENVD="$TMP/envs"; mkdir -p "$ENVD"
printf 'FIGMA_TOKEN="%s"\n' "$TOKEN" > "$ENVD/quoted.env"
printf 'FIGMA_TOKEN=%s\n' "$TOKEN" > "$ENVD/bare.env"
printf 'FIGMA_TOKEN="%s"\r\n' "$TOKEN" > "$ENVD/crlf.env"
printf 'export FIGMA_TOKEN=%s\n' "$TOKEN" > "$ENVD/export.env"
printf 'FIGMA_TOKEN=%s # personal, read-only\n' "$TOKEN" > "$ENVD/comment.env"
for v in quoted bare crlf export comment; do
  CFGSAVE="$TMP/cfg2-$v"; : > "$CFGSAVE"
  DV="$(new_repo "tok-file-$v" '.claude/')"
  rc=0; CURL_CFG_SAVE="$CFGSAVE" FR_TOKEN="" \
    fr "$DV" "$URL_D" --out "$DV/.claude/x" --env "$ENVD/$v.env" >"$O" 2>"$E" || rc=$?
  if [ "$rc" -eq 0 ] && grep -qx "header = \"X-Figma-Token: $TOKEN\"" "$CFGSAVE"; then ok
  else bad "F2-dotenv-$v" "rc=$rc cfg=$(head -c 120 "$CFGSAVE" 2>/dev/null | od -c | head -2 | tr '\n' ' ')"; fi
done
# the process env wins over the file, the way every other fnd credential resolves
CFGSAVE="$TMP/cfg2-prec"; : > "$CFGSAVE"
DP="$(new_repo tok-precedence '.claude/')"
printf 'FIGMA_TOKEN=figd_FROMFILE\n' > "$DP/dot.env"
rc=0; CURL_CFG_SAVE="$CFGSAVE" fr "$DP" "$URL_D" --out "$DP/.claude/x" --env "$DP/dot.env" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qx "header = \"X-Figma-Token: $TOKEN\"" "$CFGSAVE"; then ok
else bad F2-env-wins "rc=$rc cfg=$(head -c 120 "$CFGSAVE")"; fi

# a value that could inject a SECOND curl directive, or smuggle an option into the config
ARGV="$TMP/argv3"
for bad_tok in 'figd_"x' "$(printf 'figd_x\nheader = "X-Evil: 1"')" 'figd_ x' "$(printf 'figd_x\ty')"; do
  : > "$ARGV"
  rc=0; CURL_ARGV="$ARGV" FR_TOKEN="$bad_tok" fr "$REPO" "$URL_D" --out "$OUT" >"$O" 2>"$E" || rc=$?
  assert F2-invalid-token 3 "$rc" "$E" "error=invalid_figma_token source=env"
  if [ ! -s "$ARGV" ]; then ok; else bad F2-invalid-no-request "a malformed token still hit the network"; fi
  if ! grep -qF 'X-Evil' "$E" && ! grep -qF 'X-Evil' "$O"; then ok
  else bad F2-invalid-echoed "the refusal echoed the value"; fi
  # BOTH exit-3 outcomes carry the one setup hint: figma-reader quotes that line verbatim into
  # needs_clarification without first asking which of the two it was
  if [ "$(grep -c '^hint=' "$E")" = 1 ] && grep -qF 'references/figma-rest.md' "$E"; then ok
  else bad F2-invalid-hint "a malformed token got $(grep -c '^hint=' "$E") hint lines"; fi
done
# `source=` names where THAT value came from — a bad token in a .env must not send the developer
# hunting through their shell profile
printf 'FIGMA_TOKEN=figd_ bad\n' > "$ENVD/bad.env"
rc=0; FR_TOKEN="" fr "$REPO" "$URL_D" --out "$OUT" --env "$ENVD/bad.env" >"$O" 2>"$E" || rc=$?
assert F2-token-source-file 3 "$rc" "$E" "error=invalid_figma_token source=file"

# ============================================================ 3. --check =====================
rc=0; fr "$REPO" --check >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qx "ok=1 figma_user=ada token_source=env" "$O"; then ok
else bad F3-check-ok "rc=$rc out=$(cat "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
if ! grep -qF 'ada@example.com' "$O"; then ok; else bad F3-check-email "--check printed the account email"; fi
rc=0; FR_TOKEN="" fr "$REPO" --check --env "$ENVD/bare.env" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qF 'token_source=file' "$O"; then ok
else bad F3-check-source-file "rc=$rc out=$(cat "$O")"; fi
rc=0; FAKE_HTTP_ME=403 fr "$REPO" --check >"$O" 2>"$E" || rc=$?
assert F3-check-403 4 "$rc" "$E" "error=token_rejected http=403"
if grep -qF 'references/figma-rest.md' "$E"; then ok
else bad F3-check-403-hint "the rejection does not point at the walk-through"; fi
rc=0; FAKE_HTTP_ME=500 fr "$REPO" --check >"$O" 2>"$E" || rc=$?
assert F3-check-500 4 "$rc" "$E" "error=figma_request_failed http=500 path=me"
rc=0; FR_TOKEN="" fr "$NOTOK" --check >"$O" 2>"$E" || rc=$?
assert F3-check-no-token 3 "$rc" "$E" "error=no_figma_token"
# --check has no out dir to gate: it must answer from a checkout with nothing ignored
D3="$(new_repo check-nogit)"
rc=0; fr "$D3" --check >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qF 'ok=1' "$O"; then ok
else bad F3-check-no-outdir-gate "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# ============================================================ 4. --policy ====================
# The reader's rung 0: NO network, no out-dir gate, and it always answers.
POLARGV="$TMP/argv-policy"
pol() { : > "$POLARGV"; CURL_ARGV="$POLARGV" fr "$@"; }
rc=0; pol "$D3" --policy >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qx 'policy=auto token=present token_source=env' "$O" && [ ! -s "$POLARGV" ]; then ok
else bad F4-policy-default "rc=$rc out=$(cat "$O") argv=$(cat "$POLARGV")"; fi
for v in mcp rest auto; do
  rc=0; FR_SOURCE="$v" pol "$D3" --policy >"$O" 2>"$E" || rc=$?
  if [ "$rc" -eq 0 ] && grep -qx "policy=$v token=present token_source=env" "$O" && [ ! -s "$POLARGV" ]; then ok
  else bad "F4-policy-$v" "rc=$rc out=$(cat "$O")"; fi
done
rc=0; FR_SOURCE=sideways pol "$D3" --policy >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qx 'policy=auto token=present token_source=env' "$O" \
   && grep -qF 'note=invalid_figma_source value=sideways' "$E"; then ok
else bad F4-policy-invalid "rc=$rc out=$(cat "$O") err=$(head -c 120 "$E" | tr '\n' ' ')"; fi
# the GLOBAL domaine env file carries it — FND_FIGMA_SOURCE is global-only, so a client repo's
# committable project file must NOT be able to answer for it
PXDG="$TMP/polxdg"; mkdir -p "$PXDG/domaine"
printf 'FND_FIGMA_SOURCE=rest\n' > "$PXDG/domaine/env"
D4="$(new_repo policy-proj '.claude/')"; mkdir -p "$D4/.claude"
printf 'FND_FIGMA_SOURCE=mcp\n' > "$D4/.claude/domaine.env"
rc=0; FR_XDG="$PXDG" pol "$D4" --policy >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qx 'policy=rest token=present token_source=env' "$O"; then ok
else bad F4-policy-global-only "rc=$rc out=$(cat "$O")"; fi
# …and with no global file at all, the project file still cannot set it
D4b="$(new_repo policy-proj-only '.claude/')"; mkdir -p "$D4b/.claude"
printf 'FND_FIGMA_SOURCE=mcp\n' > "$D4b/.claude/domaine.env"
rc=0; pol "$D4b" --policy >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qx 'policy=auto token=present token_source=env' "$O"; then ok
else bad F4-policy-project-ignored "rc=$rc out=$(cat "$O")"; fi
rc=0; FR_TOKEN="" pol "$NOTOK" --policy >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qx 'policy=auto token=missing token_source=none' "$O"; then ok
else bad F4-policy-no-token "rc=$rc out=$(cat "$O")"; fi
rc=0; FR_TOKEN="" pol "$REPO" --policy --env "$ENVD/bare.env" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qx 'policy=auto token=present token_source=file' "$O"; then ok
else bad F4-policy-token-file "rc=$rc out=$(cat "$O")"; fi
# a typo in .env must not look like "Figma is down": the rung is still reported, and the value
# itself never is. `invalid` is its own word — a value IS there and needs repairing, which is a
# different errand from writing one that does not exist yet — and `token_source=` names the file to
# open, which `token=missing token_source=none` could never do.
rc=0; FR_TOKEN='figd_ bad' pol "$REPO" --policy >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qx 'policy=auto token=invalid token_source=env' "$O" \
   && grep -qF 'note=invalid_figma_token source=env' "$E" && ! grep -qF 'figd_' "$O"; then ok
else bad F4-policy-malformed "rc=$rc out=$(cat "$O") err=$(head -c 120 "$E" | tr '\n' ' ')"; fi
# …and the same value in the dotenv names the FILE, not the environment
ENVBAD="$TMP/envs/bad-token.env"; printf 'FIGMA_TOKEN="figd_ bad"\n' > "$ENVBAD"
rc=0; FR_TOKEN="" pol "$REPO" --policy --env "$ENVBAD" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qx 'policy=auto token=invalid token_source=file' "$O"; then ok
else bad F4-policy-malformed-file "rc=$rc out=$(cat "$O")"; fi
# --policy is a probe, not a fetch: no out dir is created even in a repo that would refuse one
D4c="$(new_repo policy-nogate)"
rc=0; pol "$D4c" --policy >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ ! -d "$D4c/.claude" ]; then ok
else bad F4-policy-no-outdir "rc=$rc dirs=$(ls -a "$D4c" | tr '\n' ' ')"; fi

# ============================================================ 5. the node request ============
D5="$(new_repo nodes '.claude/')"; OUT5="$D5/.claude/tasks/ELC-1/tmp/figma"
rc=0; FAKE_HTTP_NODES=404 fr "$D5" "$URL_D" --out "$OUT5" >"$O" 2>"$E" || rc=$?
assert F5-404 4 "$rc" "$E" "error=node_not_found"
rc=0; FAKE_HTTP_NODES=403 fr "$D5" "$URL_D" --out "$OUT5" >"$O" 2>"$E" || rc=$?
assert F5-403 4 "$rc" "$E" "error=token_rejected http=403"
if grep -qF 'references/figma-rest.md' "$E"; then ok
else bad F5-403-hint "the rejection does not point at the walk-through"; fi
rc=0; FAKE_HTTP_NODES=500 fr "$D5" "$URL_D" --out "$OUT5" >"$O" 2>"$E" || rc=$?
assert F5-500 4 "$rc" "$E" "error=figma_request_failed http=500"
# 200 with a null node: a body that parses perfectly and carries no design at all
rc=0; FAKE_NODE_NULL=1 fr "$D5" "$URL_D" --out "$OUT5" >"$O" 2>"$E" || rc=$?
assert F5-null-node 4 "$rc" "$E" "error=node_not_found"
if [ -z "$(find "$OUT5" -name '*.part' 2>/dev/null)" ] \
   && [ -z "$(find "$OUT5" -name '*.nodes.json' 2>/dev/null)" ]; then ok
else bad F5-null-node-file "a null-node answer was left on disk: $(ls "$OUT5" | tr '\n' ' ')"; fi
rc=0; FAKE_NODES_RAW='<html>nope</html>' fr "$D5" "$URL_D" --out "$OUT5" >"$O" 2>"$E" || rc=$?
assert F5-nonjson 4 "$rc" "$E" "error=node_not_found"

# 429 once, honouring Retry-After, then a good answer
SLP="$TMP/sleep5"; : > "$SLP"
D5b="$(new_repo nodes-429 '.claude/')"; OUT5B="$D5b/.claude/tasks/ELC-1/tmp/figma"
rc=0; SLEEP_LOG="$SLP" FAKE_HTTP_NODES=429,200 FAKE_RETRY_AFTER=7 \
  fr "$D5b" "$URL_D" --out "$OUT5B" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(row nodes status "$O")" = saved ] && [ "$(cat "$SLP")" = 7 ] \
   && grep -qF 'note=rate_limited_retry after=7s' "$E"; then ok
else bad F5-429-retry "rc=$rc status=$(row nodes status "$O") sleeps=$(tr '\n' ' ' < "$SLP")"; fi
# the wait is capped: a server asking for an hour is asking for a later run, not a sleeping script
SLP="$TMP/sleep5b"; : > "$SLP"
D5c="$(new_repo nodes-429cap '.claude/')"
rc=0; SLEEP_LOG="$SLP" FAKE_HTTP_NODES=429,200 FAKE_RETRY_AFTER=3600 \
  fr "$D5c" "$URL_D" --out "$D5c/.claude/x" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$SLP")" = 60 ]; then ok
else bad F5-429-cap "rc=$rc sleeps=$(tr '\n' ' ' < "$SLP")"; fi
# the note is the wait TAKEN, not the header as it arrived — a skill waiting on the script is not
# told "instantly" and then held for a minute
if grep -qF 'note=rate_limited_retry after=60s' "$E" && ! grep -qF 'after=3600s' "$E"; then ok
else bad F5-429-cap-note "the note announced a wait the script did not take: $(grep -F rate_limited_retry "$E" | tr '\n' ' ')"; fi
# `Retry-After: 0` is a server saying "retry now": it clamps to the FLOOR, never to the ceiling
SLP="$TMP/sleep5d"; : > "$SLP"
D5d="$(new_repo nodes-429zero '.claude/')"
rc=0; SLEEP_LOG="$SLP" FAKE_HTTP_NODES=429,200 FAKE_RETRY_AFTER=0 \
  fr "$D5d" "$URL_D" --out "$D5d/.claude/x" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$SLP")" = 1 ] && grep -qF 'note=rate_limited_retry after=1s' "$E"; then ok
else bad F5-429-zero "rc=$rc sleeps=$(tr '\n' ' ' < "$SLP") note=$(grep -F rate_limited_retry "$E" | tr '\n' ' ')"; fi
# no Retry-After header at all → the script's own 5 s, announced as such
SLP="$TMP/sleep5e"; : > "$SLP"
D5e="$(new_repo nodes-429nohdr '.claude/')"
rc=0; SLEEP_LOG="$SLP" FAKE_HTTP_NODES=429,200 FAKE_RETRY_AFTER=x \
  fr "$D5e" "$URL_D" --out "$D5e/.claude/x" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$SLP")" = 5 ] && grep -qF 'note=rate_limited_retry after=5s' "$E"; then ok
else bad F5-429-no-header "rc=$rc sleeps=$(tr '\n' ' ' < "$SLP")"; fi
# twice throttled = one retry and out, never a loop
SLP="$TMP/sleep5c"; : > "$SLP"
rc=0; SLEEP_LOG="$SLP" FAKE_HTTP_NODES=429 fr "$D5" "$URL_D" --out "$OUT5" >"$O" 2>"$E" || rc=$?
assert F5-429-twice 4 "$rc" "$E" "error=rate_limited http=429"
if [ "$(wc -l < "$SLP" | tr -d ' ')" = 1 ]; then ok
else bad F5-429-once "the retry looped: $(wc -l < "$SLP" | tr -d ' ') sleeps"; fi

# ============================================================ 6. a good run ==================
D6="$(new_repo good '.claude/')"; OUT6="$D6/.claude/tasks/ELC-1/tmp/figma"
ARGV="$TMP/argv6"; CFGL="$TMP/cfglog6"; : > "$ARGV"; : > "$CFGL"
rc=0; CURL_ARGV="$ARGV" CFG_LOG="$CFGL" fr "$D6" "$URL_D" --out "$OUT6" >"$O" 2>"$E" || rc=$?
assert F6-run 0 "$rc" "$E" "ok=1 saved=3 cached=0 unavailable=0 failed=0"
if [ "$(row nodes status "$O")" = saved ] && [ "$(row variables status "$O")" = saved ] \
   && [ "$(row image status "$O")" = saved ]; then ok
else bad F6-statuses "$(cat "$O")"; fi
# the file names on disk are colon-free — `:` is legal here and illegal where these get copied
if [ -s "$OUT6/$KEY-1-2.nodes.json" ] && [ -s "$OUT6/$KEY.variables.json" ] \
   && [ -s "$OUT6/$KEY-1-2@2x.png" ] && [ -z "$(find "$OUT6" -name '*:*' 2>/dev/null)" ]; then ok
else bad F6-files "$(ls "$OUT6" 2>&1 | tr '\n' ' ')"; fi
if [ "$(row nodes path "$O")" = "$OUT6/$KEY-1-2.nodes.json" ] \
   && [ "$(row image bytes "$O")" = 512 ]; then ok
else bad F6-paths "$(cat "$O")"; fi
if [ "$(meta last_modified "$O")" = "2026-09-01T10:00:00Z" ] && [ "$(meta_name "$O")" = "Hero Frame" ]; then ok
else bad F6-meta "$(grep '^kind=meta' "$O")"; fi
# `name=` is LAST, and it is the only field a Figma layer can put spaces into. A frame called
# `Hero last_modified=1999… name=x` in FRONT of the real fields would shadow both of them for any
# reader that splits the line on whitespace — including this suite's own `meta()`.
D6M="$(new_repo meta-order '.claude/')"; OUT6M="$D6M/.claude/tasks/ELC-1/tmp/figma"
HOSTILE_NAME='Hero last_modified=1999-01-01T00:00:00Z name=x'
rc=0; FAKE_NODES_RAW="$(printf '{"name":"File","lastModified":"2026-09-01T10:00:00Z","nodes":{"1:2":{"document":{"id":"1:2","name":"%s","type":"FRAME"}}}}' "$HOSTILE_NAME")" \
  fr "$D6M" "$URL_D" --out "$OUT6M" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(meta last_modified "$O")" = "2026-09-01T10:00:00Z" ] \
   && [ "$(meta node_id "$O")" = "1:2" ] && [ "$(meta_name "$O")" = "$HOSTILE_NAME" ] \
   && grep -qF "kind=meta file_key=$KEY node_id=1:2 last_modified=2026-09-01T10:00:00Z name=$HOSTILE_NAME" "$O"; then ok
else bad F6-meta-name-last "rc=$rc $(grep '^kind=meta' "$O")"; fi
# no staging file survives a good run: the out dir holds the three artifacts and nothing else
if [ "$(ls "$OUT6" | wc -l | tr -d ' ')" = 3 ]; then ok
else bad F6-part-left "a staging stub survived: $(ls "$OUT6" | tr '\n' ' ')"; fi
# Staging is PER PROCESS. figma-reader runs one per Figma URL in parallel, and two frames of the
# SAME file share both --out and the file key, so a fixed `<key>.variables.json.part` would have
# two curls writing one file — one run reporting a corrupt body as `saved`, the other dying on the
# rename with nothing on stdout. The `-o` path the script hands curl is the evidence.
staged="$(grep -oE -- '-o [^ ]+' "$ARGV" | awk '{ print $2 }' | grep -F "$OUT6/" || true)"
if [ "$(printf '%s\n' "$staged" | grep -c '\.[A-Za-z0-9]\{6\}$')" = 3 ] \
   && ! printf '%s\n' "$staged" | grep -q '\.part$'; then ok
else bad F6-staging-unique "the staging paths are not per-process siblings: $(printf '%s' "$staged" | tr '\n' ' ')"; fi

# …and two runs on two frames of ONE file, at once, both come back whole: every row printed, the
# summary printed, and the shared variables file still parses
DPAR="$(new_repo parallel '.claude/')"; OUTPAR="$DPAR/.claude/tasks/ELC-9/tmp/figma"
mkdir -p "$TMP/st-a" "$TMP/st-b"
( FR_STATE="$TMP/st-a" fr "$DPAR" "https://www.figma.com/design/$KEY/L?node-id=1-2" --out "$OUTPAR" \
    >"$TMP/par-a.out" 2>"$TMP/par-a.err"; echo "$?" > "$TMP/par-a.rc" ) &
( FR_STATE="$TMP/st-b" fr "$DPAR" "https://www.figma.com/design/$KEY/L?node-id=3-4" --out "$OUTPAR" \
    >"$TMP/par-b.out" 2>"$TMP/par-b.err"; echo "$?" > "$TMP/par-b.rc" ) &
wait
if [ "$(cat "$TMP/par-a.rc")" = 0 ] && [ "$(cat "$TMP/par-b.rc")" = 0 ]; then ok
else bad F6-parallel-rc "a=$(cat "$TMP/par-a.rc") b=$(cat "$TMP/par-b.rc") :: $(head -c 160 "$TMP/par-b.err" | tr '\n' ' ')"; fi
if [ "$(row nodes path "$TMP/par-a.out")" = "$OUTPAR/$KEY-1-2.nodes.json" ] \
   && [ "$(row nodes path "$TMP/par-b.out")" = "$OUTPAR/$KEY-3-4.nodes.json" ] \
   && grep -qF 'ok=1 ' "$TMP/par-a.err" && grep -qF 'ok=1 ' "$TMP/par-b.err"; then ok
else bad F6-parallel-rows "a=$(cat "$TMP/par-a.out" | tr '\n' '|') b=$(cat "$TMP/par-b.out" | tr '\n' '|')"; fi
if jq -e . "$OUTPAR/$KEY.variables.json" >/dev/null 2>&1 \
   && [ -z "$(find "$OUTPAR" -name '*.json.[A-Za-z0-9]*' 2>/dev/null)" ]; then ok
else bad F6-parallel-variables "the shared variables file did not survive two writers: $(ls "$OUTPAR" | tr '\n' ' ')"; fi
# one host for everything authenticated, and the transport bounds
if [ "$(grep -c 'https://api.figma.com/' "$ARGV")" = 3 ]; then ok
else bad F6-one-host "$(grep -oE 'https://[^ ]*' "$ARGV" | tr '\n' ' ')"; fi
for want in '--proto =https' '--proto-redir =https' '--connect-timeout 10' '--max-time 120'; do
  if grep -qF -- "$want" "$ARGV"; then ok; else bad F6-curl-flag "argv is missing '$want'"; fi
done
# …and the ONE call that gets a longer bound. `variables/local` serialises the file's whole variable
# library — 66 s for 656 KB on a real read — so 120 s is barely 2x headroom and a slow network would
# turn an optional artifact into `note=variables_failed` + exit 1. It gets 300 s; nothing else does.
varsline="$(grep -F '/variables/local' "$ARGV" | head -1)"
if [ -n "$varsline" ] && printf '%s' "$varsline" | grep -qF -- '--max-time 300'; then ok
else bad F6-variables-max-time "the variables call did not carry --max-time 300: $varsline"; fi
otherlong="$(grep -F -- '--max-time 300' "$ARGV" | grep -vF '/variables/local' || true)"
if [ -z "$otherlong" ]; then ok
else bad F6-long-timeout-scoped "--max-time 300 leaked onto another call: $otherlong"; fi
for u in '/nodes?' '/v1/images/' 'https://s3.example.com/'; do
  l="$(grep -F "$u" "$ARGV" | head -1)"
  if [ -n "$l" ] && printf '%s' "$l" | grep -qF -- '--max-time 120'; then ok
  else bad F6-short-max-time "the $u call did not carry --max-time 120: $l"; fi
done
# `-L` must never ride the config: a redirect would carry the token off api.figma.com
if ! grep -E -- '(^| )-K ' "$ARGV" | grep -qE -- '(^| )-L( |$)'; then ok
else bad F6-follow-with-config "a -K call also passed -L: $(grep -E -- '(^| )-K ' "$ARGV" | head -1)"; fi
if ! grep -qF -- '--location-trusted' "$ARGV"; then ok
else bad F6-location-trusted "--location-trusted would hand the token to the render host"; fi

# THE S3 HOP: pre-signed, needs no credential, and must not be handed one
s3line="$(grep -F 'https://s3.example.com/' "$ARGV" | head -1)"
if [ -n "$s3line" ] && ! printf '%s' "$s3line" | grep -qE -- '(^| )-K ' \
   && ! printf '%s' "$s3line" | grep -qF 'X-Figma-Token'; then ok
else bad F6-s3-tokenless "the render download carried the config: $s3line"; fi
# the config pairing, read off the shim's own per-URL log: S3 with no config, api.figma.com never
# without one
if [ -z "$(awk -F'\t' '$1 ~ /s3\.example\.com/ && $2 != "" { print }' "$CFGL")" ] \
   && [ -z "$(awk -F'\t' '$1 ~ /api\.figma\.com/ && $2 == "" { print }' "$CFGL")" ]; then ok
else bad F6-cfg-pairing "$(cat "$CFGL")"; fi
# the render scale reaches the images call, and a bad one never gets that far
IMGL="$TMP/imgurl6"; : > "$IMGL"
D6b="$(new_repo good-scale '.claude/')"
rc=0; IMG_URL_LOG="$IMGL" fr "$D6b" "$URL_D" --out "$D6b/.claude/x" --scale 3 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qF 'format=png&scale=3' "$IMGL"; then ok
else bad F6-scale "rc=$rc img=$(cat "$IMGL")"; fi
for s in 0 5 x 1.2.3 ''; do
  rc=0; fr "$REPO" "$URL_D" --out "$OUT" --scale "$s" >"$O" 2>"$E" || rc=$?
  assert F6-bad-scale 2 "$rc" "$E" "error=invalid_scale"
done
# the scale is part of the PNG's identity: a run that asks for 4× must not be handed the 2× render
# a previous run left on disk — that is the one thing `--scale 4` exists to avoid
IMGL="$TMP/imgurl6b"; : > "$IMGL"
D6c="$(new_repo scale-cache '.claude/')"; OUT6C="$D6c/.claude/tasks/ELC-1/tmp/figma"
rc=0; IMG_URL_LOG="$IMGL" fr "$D6c" "$URL_D" --out "$OUT6C" --scale 2 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(row image path "$O")" = "$OUT6C/$KEY-1-2@2x.png" ]; then ok
else bad F6-scale-name "rc=$rc $(cat "$O")"; fi
rc=0; IMG_URL_LOG="$IMGL" fr "$D6c" "$URL_D" --out "$OUT6C" --scale 4 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(row image status "$O")" = saved ] \
   && [ "$(row image path "$O")" = "$OUT6C/$KEY-1-2@4x.png" ] \
   && [ "$(grep -c 'scale=4' "$IMGL")" = 1 ] && [ -s "$OUT6C/$KEY-1-2@2x.png" ]; then ok
else bad F6-scale-cache-miss "rc=$rc status=$(row image status "$O") imgurls=$(tr '\n' ' ' < "$IMGL")"; fi
# …and the SAME scale, twice, is still one request
rc=0; fr "$D6c" "$URL_D" --out "$OUT6C" --scale 4 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(row image status "$O")" = cached ]; then ok
else bad F6-scale-cache-hit "rc=$rc status=$(row image status "$O")"; fi

# ============================================================ 7. degradation =================
# 403 on variables is a PLAN, not a failure: the Variables REST API is Enterprise-only
D7="$(new_repo vars403 '.claude/')"; OUT7="$D7/.claude/tasks/ELC-1/tmp/figma"
rc=0; FAKE_HTTP_VARS=403 fr "$D7" "$URL_D" --out "$OUT7" >"$O" 2>"$E" || rc=$?
assert F7-vars-403 0 "$rc" "$E" "note=variables_unavailable http=403"
if [ "$(row variables status "$O")" = unavailable ] && [ -z "$(row variables path "$O")" ] \
   && [ "$(row variables bytes "$O")" = 0 ] && [ ! -e "$OUT7/$KEY.variables.json" ]; then ok
else bad F7-vars-403-row "$(cat "$O")"; fi
assert F7-vars-403-summary 0 "$rc" "$E" "ok=1 saved=2 cached=0 unavailable=1 failed=0"

D7b="$(new_repo vars500 '.claude/')"; OUT7B="$D7b/.claude/tasks/ELC-1/tmp/figma"
rc=0; FAKE_HTTP_VARS=500 fr "$D7b" "$URL_D" --out "$OUT7B" >"$O" 2>"$E" || rc=$?
assert F7-vars-500 1 "$rc" "$E" "note=variables_failed http=500"
if [ "$(row variables status "$O")" = failed ] && [ ! -e "$OUT7B/$KEY.variables.json.part" ] \
   && [ ! -e "$OUT7B/$KEY.variables.json" ]; then ok
else bad F7-vars-500-row "$(cat "$O") files=$(ls "$OUT7B" | tr '\n' ' ')"; fi

# Figma could not render the node: the tree is still the deliverable
D7c="$(new_repo imgnull '.claude/')"; OUT7C="$D7c/.claude/tasks/ELC-1/tmp/figma"
rc=0; FAKE_IMAGE_NULL=1 fr "$D7c" "$URL_D" --out "$OUT7C" >"$O" 2>"$E" || rc=$?
assert F7-img-null 0 "$rc" "$E" "note=image_unavailable"
if [ "$(row image status "$O")" = unavailable ] && [ -z "$(row image path "$O")" ] \
   && [ ! -e "$OUT7C/$KEY-1-2@2x.png" ]; then ok
else bad F7-img-null-row "$(cat "$O")"; fi

# a node Figma can no longer render must not keep answering from a PREVIOUS run's bytes: the
# superseded PNG goes with the `unavailable` row, so the next run cannot report it as `cached`
D7c2="$(new_repo imgnull-stale '.claude/')"; OUT7C2="$D7c2/.claude/tasks/ELC-1/tmp/figma"
rc=0; fr "$D7c2" "$URL_D" --out "$OUT7C2" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ -s "$OUT7C2/$KEY-1-2@2x.png" ]; then ok
else bad F7-stale-setup "rc=$rc $(cat "$O")"; fi
rc=0; FAKE_IMAGE_NULL=1 fr "$D7c2" "$URL_D" --out "$OUT7C2" --force >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(row image status "$O")" = unavailable ] \
   && [ ! -e "$OUT7C2/$KEY-1-2@2x.png" ]; then ok
else bad F7-stale-removed "a superseded render survived an unavailable re-render: $(ls "$OUT7C2" | tr '\n' ' ')"; fi

# the pre-signed URL went stale between the two calls
D7d="$(new_repo imgfail '.claude/')"; OUT7D="$D7d/.claude/tasks/ELC-1/tmp/figma"
rc=0; FAKE_HTTP_S3=403 fr "$D7d" "$URL_D" --out "$OUT7D" >"$O" 2>"$E" || rc=$?
assert F7-img-fail 1 "$rc" "$E" "note=image_failed http=403"
if [ "$(row image status "$O")" = failed ] && [ ! -e "$OUT7D/$KEY-1-2@2x.png" ] \
   && [ -z "$(find "$OUT7D" -name '*.png.*' 2>/dev/null)" ]; then ok
else bad F7-img-fail-row "$(cat "$O") files=$(ls "$OUT7D" | tr '\n' ' ')"; fi
# the /v1/images call itself refused
D7e="$(new_repo imgapifail '.claude/')"
rc=0; FAKE_HTTP_IMAGES=500 fr "$D7e" "$URL_D" --out "$D7e/.claude/x" >"$O" 2>"$E" || rc=$?
assert F7-img-api-fail 1 "$rc" "$E" "note=image_failed http=500"

# --no-variables / --no-image: `skipped`, and not one request for either
D7f="$(new_repo skipped '.claude/')"; OUT7F="$D7f/.claude/tasks/ELC-1/tmp/figma"
ARGV="$TMP/argv7f"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" fr "$D7f" "$URL_D" --out "$OUT7F" --no-variables --no-image >"$O" 2>"$E" || rc=$?
assert F7-skipped 0 "$rc" "$E" "ok=1 saved=1 cached=0 unavailable=0 failed=0"
if [ "$(row variables status "$O")" = skipped ] && [ "$(row image status "$O")" = skipped ] \
   && ! grep -qF '/variables/local' "$ARGV" && ! grep -qF '/v1/images/' "$ARGV" \
   && [ "$(grep -c 'https://' "$ARGV")" = 1 ]; then ok
else bad F7-skipped-requests "$(cat "$O") argv=$(tr '\n' ';' < "$ARGV" | head -c 200)"; fi

# ============================================================ 8. cache + --force =============
ARGV="$TMP/argv8"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" fr "$D6" "$URL_D" --out "$OUT6" >"$O" 2>"$E" || rc=$?
assert F8-cached 0 "$rc" "$E" "ok=1 saved=0 cached=3 unavailable=0 failed=0"
if [ ! -s "$ARGV" ] && [ "$(row nodes status "$O")" = cached ] \
   && [ "$(row variables status "$O")" = cached ] && [ "$(row image status "$O")" = cached ]; then ok
else bad F8-cached-no-request "requests=$(wc -l < "$ARGV" | tr -d ' ') rows=$(cat "$O")"; fi
# last_modified is read off the file on disk in the cached case too — the freshness probe needs it
if [ "$(meta last_modified "$O")" = "2026-09-01T10:00:00Z" ] && [ "$(meta_name "$O")" = "Hero Frame" ]; then ok
else bad F8-cached-meta "$(grep '^kind=meta' "$O")"; fi
# a nodes.json for a DIFFERENT node is not this node's cache
ARGV="$TMP/argv8b"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" fr "$D6" "https://www.figma.com/design/$KEY/L?node-id=9-9" --out "$OUT6" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(row nodes status "$O")" = saved ] && [ -s "$OUT6/$KEY-9-9.nodes.json" ]; then ok
else bad F8-other-node "rc=$rc rows=$(cat "$O")"; fi
# a truncated earlier run is not a cache hit either
printf 'not json' > "$OUT6/$KEY-1-2.nodes.json"
ARGV="$TMP/argv8c"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" fr "$D6" "$URL_D" --out "$OUT6" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(row nodes status "$O")" = saved ] \
   && [ "$(grep -c '/nodes?' "$ARGV")" = 1 ]; then ok
else bad F8-truncated "rc=$rc rows=$(cat "$O") argv=$(tr '\n' ';' < "$ARGV" | head -c 200)"; fi
# a nodes.json whose node is NULL is not a cache hit — it carries no design
printf '{"nodes":{"1:2":null}}' > "$OUT6/$KEY-1-2.nodes.json"
ARGV="$TMP/argv8e"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" fr "$D6" "$URL_D" --out "$OUT6" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(row nodes status "$O")" = saved ] \
   && [ "$(grep -c '/nodes?' "$ARGV")" = 1 ]; then ok
else bad F8-null-cache "rc=$rc rows=$(cat "$O")"; fi
ARGV="$TMP/argv8d"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" fr "$D6" "$URL_D" --out "$OUT6" --force >"$O" 2>"$E" || rc=$?
assert F8-force 0 "$rc" "$E" "ok=1 saved=3 cached=0"
if [ "$(grep -c 'https://api.figma.com/' "$ARGV")" = 3 ]; then ok
else bad F8-force-requests "$(grep -oE 'https://[^ ]*' "$ARGV" | tr '\n' ' ')"; fi

# ============================================================ 9. the out-dir gate ============
# Same gate as jira-attachments.sh, lifted into _shopify-common.sh: the question is put to the
# repository that PHYSICALLY holds the bytes.
D9="$(new_repo gate)"
ARGV="$TMP/argv9"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" fr "$D9" "$URL_D" --out "$D9/downloads" >"$O" 2>"$E" || rc=$?
assert F9-not-ignored 2 "$rc" "$E" "error=out_dir_not_ignored"
if [ ! -d "$D9/downloads" ] && [ ! -s "$ARGV" ]; then ok
else bad F9-not-ignored-side-effects "a refused out dir was still created / requested"; fi
rc=0; fr "$D9" "$URL_D" --out "$TMP/elsewhere" >"$O" 2>"$E" || rc=$?
assert F9-outside-repo 2 "$rc" "$E" "error=out_dir_not_in_repo"
if [ ! -d "$TMP/elsewhere" ]; then ok; else bad F9-outside-created "an out dir outside the repo was created"; fi

# under .claude/tasks/ the script stamps the line task-workspace.md prescribes and goes on — the
# no-workspace default is .claude/tasks/_figma/tmp
D9b="$(new_repo gate-tasks)"
mkdir -p "$D9b/.git/info"; printf '*.local' > "$D9b/.git/info/exclude"
rc=0; fr "$D9b" "$URL_D" >"$O" 2>"$E" || rc=$?
assert F9-default-out 0 "$rc" "$E" "ok=1 saved=3"
if grep -qx '\.claude/tasks/' "$D9b/.git/info/exclude" && grep -qx '\*\.local' "$D9b/.git/info/exclude" \
   && [ -s "$D9b/.claude/tasks/_figma/tmp/$KEY-1-2.nodes.json" ]; then ok
else bad F9-default-dir "exclude=$(tr '\n' '|' < "$D9b/.git/info/exclude") files=$(ls "$D9b/.claude/tasks/_figma/tmp" 2>&1 | tr '\n' ' ')"; fi
if grep -qF "out=$D9b/.claude/tasks/_figma/tmp" "$E"; then ok
else bad F9-default-summary "$(tail -1 "$E")"; fi

# a linked worktree's `.claude/tasks` is a SYMLINK into the main checkout and git refuses to answer
# about anything beyond a symlink: the bytes land where they physically land
mkdir -p "$TMP/nohooks"
git_quiet_commit() { # a sim repo has no project hooks of its own; keep the developer's out of it
  local d="$1" cfg="core.hooksPath"
  git -C "$d" -c "$cfg=$TMP/nohooks" -c user.email=sim@example.com -c user.name=sim \
    commit -q --allow-empty -m init >/dev/null 2>&1
}
D9c="$(new_repo gate-wt-main)"; git_quiet_commit "$D9c"
mkdir -p "$D9c/.claude/tasks"
WT9="$TMP/repos/gate-wt-linked"
git -C "$D9c" worktree add -q "$WT9" -b wt-f >/dev/null 2>&1
mkdir -p "$WT9/.claude"; ln -s "$D9c/.claude/tasks" "$WT9/.claude/tasks"
rc=0; fr "$WT9" "$URL_D" >"$O" 2>"$E" || rc=$?
assert F9-worktree-symlink 0 "$rc" "$E" "ok=1 saved=3"
if [ -s "$D9c/.claude/tasks/_figma/tmp/$KEY-1-2.nodes.json" ] \
   && grep -qF "out=$D9c/.claude/tasks/_figma/tmp" "$E" \
   && [ "$(grep -cxF '.claude/tasks/' "$D9c/.git/info/exclude")" = 1 ]; then ok
else bad F9-worktree-physical "the bytes did not land in the main checkout: $(tail -1 "$E")"; fi

# a glob character in --out is a path segment, not a pattern
D9d="$(new_repo gate-glob '.claude/')"
touch "$D9d/visible.txt"
rc=0; fr "$D9d" "$URL_D" --out '.claude/tasks/*/tmp/figma' >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ -s "$D9d/.claude/tasks/*/tmp/figma/$KEY-1-2.nodes.json" ]; then ok
else bad F9-glob-out "rc=$rc dirs=$(find "$D9d/.claude" -maxdepth 3 -type d 2>/dev/null | tr '\n' ' ')"; fi

# ============================================================ 10. --json =====================
D10="$(new_repo json '.claude/')"; OUT10="$D10/.claude/tasks/ELC-1/tmp/figma"
rc=0; fr "$D10" "$URL_D" --out "$OUT10" --json >"$O" 2>"$E" || rc=$?
assert F10-json-run 0 "$rc" "$E"
if jq -e --arg k "$KEY" --arg p "$OUT10/$KEY-1-2.nodes.json" '
      .file_key == $k and .node_id == "1:2" and .name == "Hero Frame"
      and .last_modified == "2026-09-01T10:00:00Z"
      and .nodes.status == "saved" and .nodes.path == $p and (.nodes.bytes | type) == "number"
      and .variables.status == "saved" and .image.status == "saved"' "$O" >/dev/null 2>&1; then ok
else bad F10-json-shape "$(head -c 300 "$O")"; fi
# a degraded run has the same SHAPE: the optional members carry an empty path and zero bytes
# rather than going missing, so a caller reads one contract either way
D10b="$(new_repo json-degraded '.claude/')"; OUT10B="$D10b/.claude/tasks/ELC-1/tmp/figma"
rc=0; FAKE_HTTP_VARS=403 FAKE_IMAGE_NULL=1 fr "$D10b" "$URL_D" --out "$OUT10B" --json >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && jq -e '.variables.status == "unavailable" and .variables.path == ""
      and .variables.bytes == 0 and .image.status == "unavailable" and .image.path == ""
      and .nodes.status == "saved"' "$O" >/dev/null 2>&1; then ok
else bad F10-json-degraded "rc=$rc $(head -c 300 "$O")"; fi
# …and the cached run reports `cached`, not a second save
rc=0; fr "$D10" "$URL_D" --out "$OUT10" --json >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && jq -e '.nodes.status == "cached" and .variables.status == "cached"
      and .image.status == "cached"' "$O" >/dev/null 2>&1; then ok
else bad F10-json-cached "rc=$rc $(head -c 300 "$O")"; fi

# ============================================================ 11. preconditions ==============
BINNJ="$TMP/bin-nojq"; mkdir -p "$BINNJ"
BINNC="$TMP/bin-nocurl"; mkdir -p "$BINNC"
for b in bash sh git awk sed tr grep head tail wc sort cat cp mv rm mkdir chmod mktemp dirname \
         basename ls env find; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$BINNJ/$b"
  [ -n "$p" ] && ln -sf "$p" "$BINNC/$b"
done
ln -sf "$(command -v jq)" "$BINNC/jq"
# jq is the only parser this script has; without it there is nothing to check a body with
rc=0; FR_PATH_OVERRIDE="$SHIM:$BINNJ" fr "$REPO" "$URL_D" --out "$OUT" >"$O" 2>"$E" || rc=$?
assert F11-no-jq 2 "$rc" "$E" "error=jq_not_found"
rc=0; FR_PATH_OVERRIDE="$BINNC" fr "$REPO" "$URL_D" --out "$OUT" >"$O" 2>"$E" || rc=$?
assert F11-no-curl 2 "$rc" "$E" "error=curl_not_found"
# the library the credential discipline lives in is not optional
LONE="$TMP/lone"; mkdir -p "$LONE"
cp "$FR" "$LONE/figma-rest.sh"
rc=0; ( cd "$REPO" && PATH="$FR_PATH" "$BASH_BIN" "$LONE/figma-rest.sh" --policy ) >"$O" 2>"$E" || rc=$?
assert F11-no-common-lib 2 "$rc" "$E" "error=common_lib_not_found"
# the 0600 curl config is a PRECONDITION, not a detail: a temp dir that refuses the mode stamp (a
# TMPDIR with no mode bits, a read-only mount) must refuse the run, never demote the token onto an
# argv to get it through. `chmod` is the first thing curl_config_write does, so a failing one is
# that filesystem — and nothing may go out afterwards.
BINNM="$TMP/bin-nochmod"; mkdir -p "$BINNM"
for b in bash sh jq git awk sed tr grep head tail wc sort cat cp mv rm mkdir rmdir touch \
         mktemp dirname basename ls env printf date find od; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$BINNM/$b"
done
printf '#!/usr/bin/env bash\nexit 1\n' > "$BINNM/chmod"; "$BIN/chmod" +x "$BINNM/chmod"
ARGV="$TMP/argv-nocfg"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" FR_PATH_OVERRIDE="$SHIM:$BINNM" fr "$REPO" "$URL_D" --out "$OUT" >"$O" 2>"$E" || rc=$?
assert F11-cfg-unwritable 2 "$rc" "$E" "error=curl_config_unwritable"
if [ ! -s "$ARGV" ]; then ok; else bad F11-cfg-unwritable-quiet "a request went out with no config: $(cat "$ARGV")"; fi

# ============================================================ 12. --probe ====================
# The freshness probe: it asks FIGMA when the file last changed. A cached run's `last_modified` is
# the cached file's own value — comparing it with itself can only ever say "fresh" — so this is the
# one mode a `source: rest` workspace file can be checked with.
PRARGV="$TMP/argv-probe"; : > "$PRARGV"
rc=0; CURL_ARGV="$PRARGV" fr "$REPO" "$URL_D" --probe >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] \
   && grep -qx "ok=1 file_key=$KEY node_id=1:2 last_modified=2026-09-01T10:00:00Z" "$O"; then ok
else bad F12-probe-ok "rc=$rc out=$(cat "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
# one request, and it is the FILE's meta at depth=1 — never the node tree, never the render
if [ "$(grep -c 'https://' "$PRARGV")" = 1 ] && grep -qF "/v1/files/$KEY?depth=1" "$PRARGV" \
   && ! grep -qF '/nodes?' "$PRARGV" && ! grep -qF '/v1/images/' "$PRARGV"; then ok
else bad F12-probe-request "$(grep -oE 'https://[^ ]*' "$PRARGV" | tr '\n' ' ')"; fi
# a newer stamp is what tells the caller to re-read — the probe reports what Figma says, every time
rc=0; FAKE_LAST_MODIFIED=2026-09-11T08:30:00Z fr "$REPO" "$URL_D" --probe >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qF 'last_modified=2026-09-11T08:30:00Z' "$O"; then ok
else bad F12-probe-newer "rc=$rc out=$(cat "$O")"; fi
# the node-id is optional here (the file is what carries the version) and so is the URL form
rc=0; fr "$REPO" "https://www.figma.com/design/$KEY/Loyalty" --probe >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qx "ok=1 file_key=$KEY last_modified=2026-09-01T10:00:00Z" "$O"; then ok
else bad F12-probe-no-node "rc=$rc out=$(cat "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
rc=0; fr "$REPO" --probe --file "$KEY" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qF "file_key=$KEY" "$O"; then ok
else bad F12-probe-explicit "rc=$rc out=$(cat "$O")"; fi
rc=0; fr "$REPO" --probe >"$O" 2>"$E" || rc=$?
assert F12-probe-no-target 2 "$rc" "$E" "error=missing_file_key"
rc=0; fr "$REPO" --probe --file '../../etc' >"$O" 2>"$E" || rc=$?
assert F12-probe-bad-key 2 "$rc" "$E" "error=invalid_file_key"
# nothing is written and no out dir is gated: a probe is a question, not a fetch
D12="$(new_repo probe-nogate)"
rc=0; fr "$D12" "$URL_D" --probe >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ ! -d "$D12/.claude" ]; then ok
else bad F12-probe-no-outdir "rc=$rc dirs=$(ls -a "$D12" | tr '\n' ' ')"; fi
rc=0; FAKE_HTTP_PROBE=403 fr "$REPO" "$URL_D" --probe >"$O" 2>"$E" || rc=$?
assert F12-probe-403 4 "$rc" "$E" "error=token_rejected http=403"
rc=0; FAKE_HTTP_PROBE=404 fr "$REPO" "$URL_D" --probe >"$O" 2>"$E" || rc=$?
assert F12-probe-404 4 "$rc" "$E" "error=file_not_found"
rc=0; FAKE_HTTP_PROBE=500 fr "$REPO" "$URL_D" --probe >"$O" 2>"$E" || rc=$?
assert F12-probe-500 4 "$rc" "$E" "error=figma_request_failed http=500"
# a 2xx body with no version in it answers nothing — better a named refusal than an empty field
rc=0; FAKE_PROBE_NO_LM=1 fr "$REPO" "$URL_D" --probe >"$O" 2>"$E" || rc=$?
assert F12-probe-no-stamp 4 "$rc" "$E" "error=figma_request_failed"
PRARGV="$TMP/argv-probe-notoken"; : > "$PRARGV"
rc=0; CURL_ARGV="$PRARGV" FR_TOKEN="" fr "$NOTOK" "$URL_D" --probe >"$O" 2>"$E" || rc=$?
assert F12-probe-no-token 3 "$rc" "$E" "error=no_figma_token"
if [ ! -s "$PRARGV" ]; then ok; else bad F12-probe-no-token-request "a probe went out with no token"; fi

# ============================================================ 13. the credential sweep =======
# Nothing above may have written the fixture token anywhere a human or a log can read it.
leaked=""
for f in "$TMP"/argv* "$TMP"/cfglog* "$TMP"/ids-* "$TMP"/imgurl* "$O" "$E"; do
  [ -f "$f" ] || continue
  grep -qF "$TOKEN" "$f" && leaked="$leaked ${f##*/}"
done
if [ -z "$leaked" ]; then ok; else bad F13-token-sweep "the token reached:$leaked"; fi
if [ -z "$(grep -rlF "$TOKEN" "$TMP/repos" 2>/dev/null | head -3)" ]; then ok
else bad F13-token-on-disk "the token was written into a payload dir"; fi

echo "figma-rest-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
