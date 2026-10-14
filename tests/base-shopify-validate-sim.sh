#!/usr/bin/env bash
# Simulation harness for plugins/base/scripts/shopify-validate.cjs. Every case puts a fake `npx` first on
# PATH: a tiny node stdio JSON-RPC server whose answer shape SV_FAKE picks (valid, invalid, noise, hang, …)
# and which records its argv, env and the tool arguments it received in $TMP/rec. No network.
# SIM_LIVE=1 adds two cases against the real `npx -y @shopify/dev-mcp@latest`. Exit 0 = all green.
set -u
unset BASE_SHOPIFY_VALIDATE BASE_SHOPIFY_VALIDATE_TIMEOUT

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SV="$ROOT/plugins/base/scripts/shopify-validate.cjs"
NODE="$(command -v node)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
O="$TMP/out"; E="$TMP/err"; REC="$TMP/rec"; SHIM="$TMP/shim"
mkdir -p "$SHIM" "$TMP/empty"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }
show() { printf 'rc=%s out=%s err=%s' "$rc" "$(tr '\n' ';' < "$O" | head -c 300)" "$(tr '\n' ';' < "$E" | head -c 200)"; }

cat > "$SHIM/npx" <<JS
#!$NODE
const fs = require('fs');
const rec = process.env.SV_REC;
const mode = process.env.SV_FAKE || 'valid';
const log = (o) => fs.appendFileSync(rec, JSON.stringify(o) + '\n');
log({ pid: process.pid, argv: process.argv.slice(2), liquid: process.env.LIQUID, optOut: process.env.OPT_OUT_INSTRUMENTATION });
if (mode === 'exit') process.exit(4);
// hang = npx still installing: silent, ends on stdin EOF. stall = up, then silent: only the kill ends it.
// The self-exit at 15 s keeps a regressed script from stalling the suite.
if (mode === 'hang' || mode === 'stall') setTimeout(() => process.exit(9), 15000);
process.stdin.on('end', () => { log({ eof: true }); process.exit(0); });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const text = (id, t, isError) => out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) } });
const CID = '11111111-2222-4333-8444-555555555555';
const summary = (s) => '## Validation Summary\n\n**Overall Status:** ' + s + '\n**Total Code Blocks:** 1\n\n**Details:** ' +
  (s.includes('INVALID') ? 'Cannot query field "nope" on type "Shop".' : 'Successfully validated GraphQL query against schema.') + '\n\n';
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (mode === 'hang' || (mode === 'stall' && m.method === 'tools/call')) continue;
    if (mode === 'die' && m.method === 'tools/call') process.exit(5);
    if (m.method === 'initialize') {
      if (mode === 'rpcerror') { out({ jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'unsupported protocol' } }); continue; }
      if (mode === 'noise') { process.stdout.write('npm WARN something\n{not json\n'); out({ jsonrpc: '2.0', method: 'notifications/message', params: {} }); out({ jsonrpc: '2.0', id: 999, result: {} }); }
      out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } });
    } else if (m.method === 'notifications/initialized') log({ initialized: true });
    else if (m.method === 'tools/call') {
      log({ tool: m.params.name, args: m.params.arguments });
      if (m.params.name === 'learn_shopify_api') text(m.id, mode === 'nocid' ? 'no id here' : '**SAVE THIS CONVERSATION ID:** ' + CID + '\nlong docs…');
      else if (mode === 'toolerror') text(m.id, 'MCP error -32602: Input validation error', true);
      else if (mode === 'malformed') text(m.id, 'something that is not a summary');
      else if (mode === 'plaininvalid') text(m.id, summary('INVALID'));
      else text(m.id, summary(mode === 'invalid' ? '❌ INVALID' : '✅ VALID'));
    }
  }
});
JS
chmod +x "$SHIM/npx"

# sv <args…> — runs the script with the fake on PATH; stdin is empty unless the caller redirects it
sv() { rc=0; : > "$REC"; SV_REC="$REC" PATH="$SHIM:$PATH" "$NODE" "$SV" "$@" >"$O" 2>"$E" </dev/null || rc=$?; }
recq() { "$NODE" -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  process.stdout.write(String((function (r) { return eval(process.argv[2]); })(lines)));' "$REC" "$1" 2>/dev/null; }
first() { head -1 "$O"; }
dead() { local p; p="$(recq 'r[0].pid')"; [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; }

# ------------------------------------------------------------------------------- usage --
sv --help
if [ "$rc" -eq 0 ] && grep -q '^usage: shopify-validate.cjs' "$O" && [ ! -s "$E" ] && [ ! -s "$REC" ]; then ok; else bad V1-help "$(show)"; fi
sv --bogus;                       r1="$rc"; e1="$(cat "$E")"
sv --api storefront --code 'x';   r2="$rc"; e2="$(cat "$E")"
sv --version 26-10 --code 'x';    r3="$rc"; e3="$(cat "$E")"
sv --timeout 0 --code 'x';        r4="$rc"; e4="$(cat "$E")"
sv --file a --code 'x';           r5="$rc"; e5="$(cat "$E")"
sv --file "$TMP/missing.graphql"; r6="$rc"; e6="$(cat "$E")"
sv --version;                     r7="$rc"; e7="$(cat "$E")"
if [ "$r1$r2$r3$r4$r5$r6$r7" = 2222222 ] && [[ "$e1" == *error=unknown_arg\ arg=--bogus* ]] \
   && [[ "$e2" == *error=unsupported_api\ value=storefront* ]] && [[ "$e3" == *error=invalid_version* ]] \
   && [[ "$e4" == *error=invalid_timeout\ value=0* ]] && [[ "$e5" == *error=conflicting_input* ]] \
   && [[ "$e6" == *error=unreadable_input*ENOENT* ]] && [[ "$e7" == *error=missing_value\ flag=--version* ]] \
   && [ ! -s "$REC" ]; then ok
else bad V2-usage-errors "rc=$r1$r2$r3$r4$r5$r6$r7 e1=$e1 e2=$e2 e3=$e3 e4=$e4 e5=$e5 e6=$e6 e7=$e7"; fi

# V3: empty stdin is a usage error, and the server is never spawned
sv
if [ "$rc" -eq 2 ] && grep -q 'error=empty_code' "$E" && [ ! -s "$REC" ]; then ok; else bad V3-empty-stdin "$(show)"; fi

# V4: BASE_SHOPIFY_VALIDATE=0 answers unavailable without spawning anything
rc=0; : > "$REC"; BASE_SHOPIFY_VALIDATE=0 SV_REC="$REC" PATH="$SHIM:$PATH" "$NODE" "$SV" --code 'query { shop { name } }' >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 3 ] && [ "$(cat "$O")" = "result=unavailable" ] && grep -q '^error=disabled' "$E" && [ ! -s "$REC" ]; then ok
else bad V4-disabled "$(show)"; fi

# ---------------------------------------------------------------------------- protocol --
# V5: valid — the handshake order, the constant prompt, model none, the manifest's argv and env, the code verbatim
sv --code 'query { shop { name } }'
if [ "$rc" -eq 0 ] && [ "$(first)" = "result=valid" ] && grep -q 'Overall Status:\*\* ✅ VALID' "$O" \
   && [ "$(recq 'r[0].argv.join(" ")')" = "-y @shopify/dev-mcp@latest" ] \
   && [ "$(recq 'r[0].liquid + "," + r[0].optOut')" = "true,true" ] \
   && [ "$(recq 'r.slice(1).map(x => x.initialized ? "init" : x.tool).join(",")')" = "init,learn_shopify_api,validate" ] \
   && [ "$(recq 'JSON.stringify(r[2].args)')" = '{"api":"admin","model":"none","user_prompt":"base shopify validate","version":"2026-10"}' ] \
   && [ "$(recq 'JSON.stringify(r[3].args)')" = '{"conversationId":"11111111-2222-4333-8444-555555555555","api":"admin","version":"2026-10","code":[{"content":"query { shop { name } }"}]}' ] \
   && dead; then ok
else bad V5-valid "$(show) rec=$(tr '\n' ';' < "$REC" | head -c 600)"; fi

# V6: invalid → exit 1, the server's error text verbatim
SV_FAKE=invalid sv --code 'query { shop { nope } }' --version 2026-04
if [ "$rc" -eq 1 ] && [ "$(first)" = "result=invalid" ] && grep -qF 'Cannot query field "nope" on type "Shop".' "$O" \
   && [ "$(recq 'r[3].args.version')" = "2026-04" ]; then ok
else bad V6-invalid "$(show)"; fi

# V6b: a status line without the emoji still parses, INVALID before VALID
SV_FAKE=plaininvalid sv --code 'query { shop { nope } }'
if [ "$rc" -eq 1 ] && [ "$(first)" = "result=invalid" ]; then ok; else bad V6b-plain-invalid "$(show)"; fi

# V7: --file and stdin carry the document byte for byte
printf 'mutation {\n  x\n}\n' > "$TMP/op.graphql"
sv --file "$TMP/op.graphql"; r7a="$rc"; c7a="$(recq 'JSON.stringify(r[3].args.code[0].content)')"
rc=0; : > "$REC"; SV_REC="$REC" PATH="$SHIM:$PATH" "$NODE" "$SV" < "$TMP/op.graphql" >"$O" 2>"$E" || rc=$?
c7b="$(recq 'JSON.stringify(r[3].args.code[0].content)')"
if [ "$r7a" -eq 0 ] && [ "$rc" -eq 0 ] && [ "$c7a" = '"mutation {\n  x\n}\n"' ] && [ "$c7b" = "$c7a" ]; then ok
else bad V7-file-stdin "rc=$r7a/$rc a=$c7a b=$c7b"; fi

# V8: --json prints the raw tool result after the verdict line
sv --code 'query { shop { name } }' --json
if [ "$rc" -eq 0 ] && [ "$(first)" = "result=valid" ] \
   && sed -n 2p "$O" | "$NODE" -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); if (!j.content[0].text.includes("VALID")) process.exit(1)'; then ok
else bad V8-json "$(show)"; fi

# V9: non-JSON lines, notifications and stray ids on stdout are skipped
SV_FAKE=noise sv --code 'query { shop { name } }'
if [ "$rc" -eq 0 ] && [ "$(first)" = "result=valid" ]; then ok; else bad V9-noise "$(show)"; fi

# V10: every unavailable shape exits 3 with result=unavailable and its own error= code
v10=""
for c in "malformed:bad_answer" "toolerror:tool_error" "nocid:no_conversation_id" "rpcerror:protocol" "die:server_exited code=5"; do
  SV_FAKE="${c%%:*}" sv --code 'query { shop { name } }'
  if [ "$rc" -ne 3 ] || [ "$(cat "$O")" != "result=unavailable" ] || ! grep -q "^error=${c#*:}" "$E"; then v10="$v10 ${c%%:*}[$(show)]"; fi
done
if [ -z "$v10" ]; then ok; else bad V10-unavailable "$v10"; fi

# V10b: npx exiting before the server speaks names the _npx dir of the spec under the npm cache
rc=0; : > "$REC"; npm_config_cache="$TMP/npmc" SV_FAKE=exit SV_REC="$REC" PATH="$SHIM:$PATH" "$NODE" "$SV" --code 'x' >"$O" 2>"$E" </dev/null || rc=$?
if [ "$rc" -eq 3 ] && grep -q "^error=server_exited_early code=4 .*delete $TMP/npmc/_npx/8f00c70bd5114901 " "$E"; then ok
else bad V10b-exit-early "$(show)"; fi

# V11: a server that answered and then stalls is abandoned at --timeout, and killed
start=$SECONDS
SV_FAKE=stall sv --code 'query { shop { name } }' --timeout 1
if [ "$rc" -eq 3 ] && grep -q '^error=timeout seconds=1$' "$E" && dead && [ "$(recq 'r.some(x => x.eof)')" = false ] \
   && [ $((SECONDS - start)) -lt 10 ]; then ok
else bad V11-timeout "$(show) seconds=$((SECONDS - start))"; fi

# V11b: npx silent at --timeout (still installing) is never killed: stdin closes and it ends on EOF
start=$SECONDS
SV_FAKE=hang sv --code 'query { shop { name } }' --timeout 1
for _ in 1 2 3 4 5 6 7 8 9 10; do [ "$(recq 'r.some(x => x.eof)')" = true ] && break; sleep 0.2; done
if [ "$rc" -eq 3 ] && grep -q '^error=timeout seconds=1 phase=install' "$E" && [ "$(recq 'r.some(x => x.eof)')" = true ] \
   && [ $((SECONDS - start)) -lt 10 ]; then ok
else bad V11b-install-timeout "$(show) rec=$(tr '\n' ';' < "$REC" | head -c 300)"; fi

# V12: BASE_SHOPIFY_VALIDATE_TIMEOUT sets the budget; --timeout outranks it
rc=0; : > "$REC"; start=$SECONDS
BASE_SHOPIFY_VALIDATE_TIMEOUT=1 SV_FAKE=hang SV_REC="$REC" PATH="$SHIM:$PATH" "$NODE" "$SV" --code 'x' >"$O" 2>"$E" || rc=$?
r12a="$rc"; e12a="$(cat "$E")"
rc=0; BASE_SHOPIFY_VALIDATE_TIMEOUT=600 SV_FAKE=hang SV_REC="$REC" PATH="$SHIM:$PATH" "$NODE" "$SV" --code 'x' --timeout 1 >"$O" 2>"$E" || rc=$?
if [ "$r12a" -eq 3 ] && [[ "$e12a" == error=timeout\ seconds=1* ]] && [ "$rc" -eq 3 ] && [ $((SECONDS - start)) -lt 10 ]; then ok
else bad V12-env-timeout "rc=$r12a/$rc e=$e12a"; fi

# V13: no npx on PATH → unavailable, never a stack
rc=0; PATH="$TMP/empty" "$NODE" "$SV" --code 'x' >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 3 ] && [ "$(cat "$O")" = "result=unavailable" ] && grep -q '^error=npx_missing' "$E" && ! grep -q '    at ' "$E"; then ok
else bad V13-no-npx "$(show)"; fi

# -------------------------------------------------------------------------------- live --
if [ "${SIM_LIVE:-}" = 1 ]; then
  rc=0; "$NODE" "$SV" --code 'query { shop { name } }' >"$O" 2>"$E" || rc=$?
  if [ "$rc" -eq 0 ] && [ "$(first)" = "result=valid" ]; then ok; else bad L1-live-valid "$(show)"; fi
  rc=0; "$NODE" "$SV" --code 'query { shop { nonExistentFieldXyz } }' >"$O" 2>"$E" || rc=$?
  if [ "$rc" -eq 1 ] && [ "$(first)" = "result=invalid" ] && grep -q 'nonExistentFieldXyz' "$O"; then ok; else bad L2-live-invalid "$(show)"; fi
fi

echo "base-shopify-validate-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
