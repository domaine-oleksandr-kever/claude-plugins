#!/usr/bin/env bash
# Simulation harness for plugins/be/scripts/shopify-docs.cjs: every case points BE_SHOPIFY_DOCS_URL at a local
# node http stub (one path per answer shape) or at a closed port. No network, nothing written outside $TMPDIR.
# Exit 0 = all green.
set -u
unset BE_SHOPIFY_DOCS_URL

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCS="$ROOT/plugins/be/scripts/shopify-docs.cjs"
NODE="$(command -v node)"

TMP="$(mktemp -d)"
STUB_PID=""
trap '[ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT
O="$TMP/out"; E="$TMP/err"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

# The stub answers by path and keeps the last request body in $TMP/body.json; it prints its port, then a
# closed port (bound and released) for the refused case.
cat > "$TMP/stub.cjs" <<'JS'
const http = require('http');
const fs = require('fs');
const [bodyFile, portFile] = process.argv.slice(2);
const doc = (i, n) => ({ filename: 'docs/api/admin/page-' + i + '.md', score: 0.9, content: 'x'.repeat(n) });
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    fs.writeFileSync(bodyFile, raw);
    const json = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof v === 'string' ? v : JSON.stringify(v)); };
    if (req.url === '/ok') json(200, [{ filename: 'docs/api/functions/discount.md', score: 0.98, content: 'Discount Functions run on every cart line.' }, { filename: 'docs/apps/limits.md', score: 0.7, content: 'Rate limits apply.' }]);
    else if (req.url === '/big') json(200, [doc(1, 3000), doc(2, 3000)]);
    else if (req.url === '/empty') json(200, []);
    else if (req.url === '/500') json(500, { error: 'boom' });
    else if (req.url === '/429') { res.writeHead(429, { 'Retry-After': '7' }); res.end(); }
    else if (req.url === '/429-bare') { res.writeHead(429); res.end(); }
    else if (req.url === '/garbage') json(200, '<html>not json</html>');
    else if (req.url === '/object') json(200, { results: [] });
    else if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:' + process.env.REDIRECT_PORT + '/' }); res.end(); }
    // /hang never answers
  });
});
server.listen(0, '127.0.0.1', () => {
  const closed = http.createServer().listen(0, '127.0.0.1', () => {
    const shut = closed.address().port;
    closed.close(() => fs.writeFileSync(portFile, server.address().port + ' ' + shut + '\n'));
  });
});
JS
REDIRECT_PORT=1 "$NODE" "$TMP/stub.cjs" "$TMP/body.json" "$TMP/port" &
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
for _ in $(seq 1 50); do [ -s "$TMP/port" ] && break; "$NODE" -e 'setTimeout(() => {}, 100)'; done
read -r PORT CLOSED < "$TMP/port" || { echo "be-shopify-docs-sim: stub did not start"; exit 1; }
BASE="http://127.0.0.1:$PORT"

rc=0
# run <path-or-url> [args …] — a leading / is a stub path.
run() {
  local u="$1"; shift
  case "$u" in /*) u="$BASE$u" ;; esac
  rc=0; BE_SHOPIFY_DOCS_URL="$u" "$NODE" "$DOCS" "$@" >"$O" 2>"$E" || rc=$?
}

# expect <label> <want-rc> <stdout|stderr> [pattern ...] — every pattern must appear as a literal; a pattern
# prefixed with ! must NOT appear.
expect() {
  local label="$1" want="$2" f p; shift 2
  case "$1" in stdout) f="$O" ;; *) f="$E" ;; esac; shift
  if [ "$rc" -ne "$want" ]; then
    bad "$label" "exit $rc, want $want :: out=$(head -c 300 "$O" | tr '\n' ';') err=$(head -c 300 "$E" | tr '\n' ';')"; return
  fi
  for p in "$@"; do
    if [ "${p#!}" != "$p" ]; then
      if grep -qF -- "${p#!}" "$f"; then bad "$label" "has forbidden '${p#!}' :: $(head -c 300 "$f" | tr '\n' ';')"; return; fi
    elif ! grep -qF -- "$p" "$f"; then
      bad "$label" "missing '$p' :: $(head -c 300 "$f" | tr '\n' ';')"; return
    fi
  done
  ok
}

# A normal answer: the header names the source and the outside-content rule, one block per result, the
# request carries the query, the api and the result count.
run /ok --api functions --max 3 discount function limits
expect SD1-answer 0 stdout "shopify-docs: 2 result(s) from 127.0.0.1:$PORT for \"discount function limits\" — outside content" \
  "### docs/api/functions/discount.md" "Discount Functions run on every cart line." "### docs/apps/limits.md"
if "$NODE" -e 'const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.exit(b.query === "discount function limits" && b.api === "functions" && b.max_num_results === 3 ? 0 : 1)' "$TMP/body.json"
then ok; else bad SD2-request-body "body was $(cat "$TMP/body.json")"; fi
run /ok liquid filters
if "$NODE" -e 'const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.exit(!("api" in b) && b.max_num_results === 5 ? 0 : 1)' "$TMP/body.json"
then ok; else bad SD3-defaults "body was $(cat "$TMP/body.json")"; fi
expect SD3b-stderr-quiet 0 stderr "!error=" "!note="

# The 4000-character cap.
run /big big pages
expect SD4-cap 0 stdout "… [truncated]"
expect SD4b-cap-note 0 stderr "note=truncated chars=" "max=4000"
n="$(tail -n +3 "$O" | wc -c | tr -d ' ')"
if [ "$n" -le 4100 ]; then ok; else bad SD4c-cap-size "body is $n bytes"; fi

run /empty nothing here
expect SD5-no-results 0 stderr "note=no_results"

# A stub that never answers: --timeout cuts it short.
start=$(date +%s)
run /hang slow --timeout 1
expect SD6-timeout 1 stderr "error=timeout after=1s" "shopify.dev/docs"
if [ $(( $(date +%s) - start )) -le 5 ]; then ok; else bad SD6b-timeout-fast "took $(( $(date +%s) - start ))s"; fi

# Soft errors: one line, exit 1, no stack, nothing on stdout.
run /500 q
expect SD7-http-5xx 1 stderr "error=http_status http=500" "!at "
run /429 q
expect SD7b-429-retry-after 1 stderr "error=http_status http=429" "retry_after=7s"
run /429-bare q
expect SD7c-429-no-header 1 stderr "error=http_status http=429" "!retry_after"
run /500 q
expect SD7d-5xx-no-retry-after 1 stderr "!retry_after"
run /garbage q
expect SD8-garbage 1 stderr "error=bad_answer" "!SyntaxError"
run /object q
expect SD9-not-array 1 stderr "error=bad_answer"
if [ ! -s "$O" ]; then ok; else bad SD9b-no-stdout "stdout: $(head -c 200 "$O")"; fi

# A refused connection (no network): unreachable, with the egress hint.
run "http://127.0.0.1:$CLOSED/assistant/search" q
expect SD10-refused 1 stderr "error=unreachable host=127.0.0.1:$CLOSED reason=ECONNREFUSED" "egress allowlist" "!TypeError"

# A redirect is never followed: its target's content would print under the stub's host.
run /redirect q
expect SD10b-redirect 1 stderr "error=http_status http=302" "!at "
if [ ! -s "$O" ]; then ok; else bad SD10c-redirect-no-stdout "stdout: $(head -c 200 "$O")"; fi

# Usage.
run /ok --help
expect SD11-help 0 stdout "usage: shopify-docs.cjs"
run /ok
expect SD12-missing-query 2 stderr "error=missing_query"
run /ok --max 0 q
expect SD13-invalid-max 2 stderr "error=invalid_max value=0"
run /ok --api
expect SD14-missing-value 2 stderr "error=missing_value flag=--api"
run /ok --bogus q
expect SD15-unknown-arg 2 stderr "error=unknown_arg arg=--bogus"
run /ok --api admin -- -1 --max limit
if [ "$rc" -eq 0 ] && "$NODE" -e 'const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.exit(b.query === "-1 --max limit" && b.api === "admin" && b.max_num_results === 5 ? 0 : 1)' "$TMP/body.json"
then ok; else bad SD15b-double-dash "rc=$rc body was $(cat "$TMP/body.json")"; fi
run /ok --
expect SD15c-double-dash-empty 2 stderr "error=missing_query"
for t in Infinity 1e10 0.0001; do
  run /ok --timeout "$t" q
  expect "SD17-invalid-timeout-$t" 2 stderr "error=invalid_timeout value=$t" "!RangeError"
done
run "ftp://example.invalid/" q
expect SD16-invalid-url 2 stderr "error=invalid_url"

echo "be-shopify-docs-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
