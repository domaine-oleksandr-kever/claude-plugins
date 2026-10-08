#!/usr/bin/env bash
# Simulation harness for plugins/base/scripts/jira-attachments.sh (jira-attachments-sim.sh covers
# fnd's copy). No network and no Jira: `curl` is a PATH shim, and the PATH itself is a dir of
# symlinks to exactly the tools the script uses. `ffmpeg`, `ffprobe` and `sips` are tripwires that
# log any call: base's script only downloads — slim's `view` resizes and cuts frames.
# Exit 0 = all green.
set -u

# Hermetic env: a developer with a real scoped token exported would otherwise have their own
# credential reach the fake curl (and this suite's argv log) instead of the fixture value, and an
# exported JIRA_SITE would re-target the cloudId lookup every case pins.
unset JIRA_EMAIL JIRA_API_TOKEN JIRA_SITE

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JA="$ROOT/plugins/base/scripts/jira-attachments.sh"
BASH_BIN="$(command -v bash)"

# physical, not logical: on macOS `mktemp -d` hands back a /var/… path whose real home is
# /private/var, and the script compares its own $PWD-derived out dir against what git reports
TMP="$(mktemp -d)"; TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
export XDG_CONFIG_HOME="$TMP/xdg"

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
         mktemp dirname basename ls env printf date; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$BIN/$b"
done

SHIM="$TMP/shim"; mkdir -p "$SHIM"

cat > "$SHIM/curl" <<'FAKE'
#!/usr/bin/env bash
# Answers by URL: tenant_info → the cloudId JSON, myself → a displayName, issue/<KEY> → the
# fixture list, attachment/content/<id> → FAKE_SIZES bytes. CURL_ARGV records the argv as handed
# over (the transport flags live nowhere else); CURL_CFG_SAVE copies the private -K config out, so
# a case can assert the auth line is exactly `user = "<email>:<token>"`.
[ -n "${CURL_ARGV:-}" ] && printf '%s\n' "$*" >> "$CURL_ARGV"
out=""; cfg=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w|-H|-K) [ "$1" = -K ] && cfg="$2"; shift 2 ;;
    --connect-timeout|--max-time|--proto|--proto-redir) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ -n "$cfg" ] && [ -n "${CURL_CFG_SAVE:-}" ] && cp "$cfg" "$CURL_CFG_SAVE"
code=200
case "$url" in
  */_edge/tenant_info)
    code="${FAKE_HTTP_TENANT:-200}"
    printf '{"cloudId":"%s"}' "${FAKE_CLOUD_ID:-11111111-2222-3333-4444-555555555555}" > "${out:-/dev/null}" ;;
  */rest/api/3/myself)
    code="${FAKE_HTTP_MYSELF:-200}"
    printf '{"displayName":"Ada Lovelace","accountId":"a1"}' > "${out:-/dev/null}" ;;
  */rest/api/3/issue/*)
    code="${FAKE_HTTP_ISSUE:-200}"
    cat "${FAKE_LIST:-/dev/null}" > "${out:-/dev/null}" ;;
  */rest/api/3/attachment/content/*)
    id="${url##*/}"
    [ -n "${CONTENT_LOG:-}" ] && printf '%s\n' "$id" >> "$CONTENT_LOG"
    case ",${FAKE_FAIL_IDS:-}," in
      *",$id,"*) code=404; : > "${out:-/dev/null}" ;;
      *) n="$(awk -v id="$id" -v m="${FAKE_SIZES:-}" 'BEGIN {
                k = split(m, a, ","); for (i = 1; i <= k; i++) { split(a[i], b, ":"); if (b[1] == id) { print b[2]; exit } }
                print 0 }')"
         head -c "$n" /dev/zero | tr '\0' 'x' > "${out:-/dev/null}" ;;
    esac ;;
  *) code=599; : > "${out:-/dev/null}" ;;
esac
printf '%s' "${FAKE_HTTP:-$code}"
FAKE

for t in ffmpeg ffprobe sips; do
  printf '#!/usr/bin/env bash\n[ -n "${FFMPEG_LOG:-}" ] && printf "%%s %%s\\n" "$(basename "$0")" "$*" >> "$FFMPEG_LOG"\nexit 0\n' > "$SHIM/$t"
done
chmod +x "$SHIM/curl" "$SHIM/ffmpeg" "$SHIM/ffprobe" "$SHIM/sips"

# ------------------------------------------------------------------------ fixtures + runner --
CLOUD="11111111-2222-3333-4444-555555555555"
EMAIL="dev.secret@example.com"
TOKEN="ATATT3xFfGF0secret-value_09=="
SIZES="101:1234,102:5678,103:999,104:31457280"

FIX="$TMP/fixtures"; mkdir -p "$FIX"
# out of id order on purpose (the rows come back sorted), and 102 has no author displayName — an
# empty middle field is what a tab-separated row would silently shift
cat > "$FIX/list.json" <<'JSON'
{"key":"ABC-101","fields":{"attachment":[
 {"id":"103","filename":"spec.pdf","mimeType":"application/pdf","size":999,
  "created":"2026-09-10T10:03:00.000+0000","author":{"displayName":"Ada Lovelace"}},
 {"id":"101","filename":"Screenshot 2026-09-10 at 3.26.09 PM.png","mimeType":"image/png","size":1234,
  "created":"2026-09-10T10:01:00.000+0000","author":{"displayName":"Ada Lovelace"}},
 {"id":"104","filename":"huge.png","mimeType":"image/png","size":31457280,
  "created":"2026-09-10T10:04:00.000+0000","author":{"displayName":"Grace Hopper"}},
 {"id":"102","filename":"recording.mov","mimeType":"video/quicktime","size":5678,
  "created":"2026-09-10T10:02:00.000+0000","author":{}}
]}}
JSON
printf '{"key":"ABC-101","fields":{"attachment":[]}}' > "$FIX/empty.json"
# the two caps meet here: a 30 MB video clears the 200 MB video cap while a 30 MB image does not
# clear the 25 MB one, and a 300 MB video clears neither. The BYTES the fake curl hands back are
# tiny on purpose (FAKE_SIZES): the caps read the metadata size, never the bytes.
cat > "$FIX/videos.json" <<'JSON'
{"key":"ABC-101","fields":{"attachment":[
 {"id":"301","filename":"screen recording.mp4","mimeType":"video/mp4","size":31457280,
  "created":"2026-09-10T10:01:00.000+0000","author":{"displayName":"Ada Lovelace"}},
 {"id":"302","filename":"long recording.mp4","mimeType":"video/mp4","size":314572800,
  "created":"2026-09-10T10:02:00.000+0000","author":{"displayName":"Ada Lovelace"}},
 {"id":"303","filename":"big.png","mimeType":"image/png","size":31457280,
  "created":"2026-09-10T10:03:00.000+0000","author":{"displayName":"Ada Lovelace"}}
]}}
JSON
VID_SIZES="301:1000,302:1000,303:1000"
LONG="$(awk 'BEGIN { s = ""; for (i = 0; i < 200; i++) s = s "a"; print s }')"
jq -n --arg long "$LONG.png" '{key:"ABC-101",fields:{attachment:[
  {id:"../../../../pwn",filename:"a.png",mimeType:"image/png",size:10,created:"c",author:{displayName:"A"}},
  {id:"201",filename:"../../evil.png",mimeType:"image/png",size:10,created:"c",author:{displayName:"A"}},
  {id:"202",filename:"Screenshot 2026-09-10 at 3.26.09 PM.png",mimeType:"image/png",size:10,created:"c",author:{displayName:"A"}},
  {id:"203",filename:"noext",mimeType:"image/png",size:10,created:"c",author:{displayName:"A"}},
  {id:"204",filename:$long,mimeType:"image/png",size:10,created:"c",author:{displayName:"A"}}
]}}' > "$FIX/names.json"

JA_PATH="$SHIM:$BIN"
ja() { # ja <cwd> <args…> — every knob below is a one-shot prefix on the call
  local cwd="$1"; shift
  ( cd "$cwd" && PATH="${JA_PATH_OVERRIDE:-$JA_PATH}" \
      CURL_ARGV="${CURL_ARGV:-/dev/null}" CURL_CFG_SAVE="${CURL_CFG_SAVE:-}" \
      CONTENT_LOG="${CONTENT_LOG:-/dev/null}" FFMPEG_LOG="${FFMPEG_LOG:-/dev/null}" \
      FAKE_LIST="${FAKE_LIST:-$FIX/list.json}" FAKE_SIZES="${FAKE_SIZES:-$SIZES}" \
      FAKE_CLOUD_ID="${FAKE_CLOUD_ID:-$CLOUD}" FAKE_FAIL_IDS="${FAKE_FAIL_IDS:-}" \
      FAKE_HTTP_TENANT="${FAKE_HTTP_TENANT:-200}" FAKE_HTTP_ISSUE="${FAKE_HTTP_ISSUE:-200}" \
      FAKE_HTTP_MYSELF="${FAKE_HTTP_MYSELF:-200}" \
      JIRA_EMAIL="${JA_EMAIL-$EMAIL}" JIRA_API_TOKEN="${JA_TOKEN-$TOKEN}" JIRA_SITE="${JA_SITE-}" \
      TMPDIR="$TMP/jatmp" \
      "$BASH_BIN" "$JA" "$@" )
}
mkdir -p "$TMP/jatmp"

new_repo() { # new_repo <name> [gitignore-line] → prints the path of a fresh git repo
  local d="$TMP/repos/$1"
  mkdir -p "$d"
  git -C "$d" init -q 2>/dev/null
  [ -n "${2-}" ] && printf '%s\n' "$2" > "$d/.gitignore"
  printf '%s' "$d"
}

field() { # field <tsv> <id> <1-based column>
  awk -F'\t' -v id="$1" -v c="$2" '$1 == id { print $c }' "$3"
}


O="$TMP/out"; E="$TMP/err"
REPO="$(new_repo main '.claude/')"
OUT="$REPO/.claude/tasks/ABC-101/tmp/attachments"

# ------------------------------------------------------ 1. no credentials: hint, no request --
NOCRED="$(new_repo nocred '.claude/')"
ARGV="$TMP/argv1"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" JA_EMAIL="" JA_TOKEN="" ja "$NOCRED" ABC-101 >"$O" 2>"$E" || rc=$?
assert J1-no-credentials 3 "$rc" "$E" "error=no_jira_credentials"
for want in "https://id.atlassian.com/manage-profile/security/api-tokens" \
            "Create API token with scopes" "READ-ONLY" "read:jira-work" \
            "references/jira-attachments.md"; do
  if grep -qF "$want" "$E"; then ok; else bad J1-hint "hint does not name '$want'"; fi
done
if [ ! -s "$ARGV" ]; then ok; else bad J1-no-request "a request went out with no credentials: $(cat "$ARGV")"; fi

# ---------------------------------------------- 2. the credential never leaves the config file --
CFGSAVE="$TMP/cfg2"; ARGV="$TMP/argv2"; : > "$ARGV"; : > "$CFGSAVE"
rc=0; CURL_ARGV="$ARGV" CURL_CFG_SAVE="$CFGSAVE" \
  ja "$REPO" ABC-101 --out "$OUT" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J2-env-credentials 0 "$rc" "$E"
if grep -qx "user = \"$EMAIL:$TOKEN\"" "$CFGSAVE" && [ "$(wc -l < "$CFGSAVE" | tr -d ' ')" = 1 ]; then ok
else bad J2-config-line "config file is not the single user line: $(head -c 200 "$CFGSAVE" 2>/dev/null)"; fi
for f in "$ARGV" "$O" "$E"; do
  if grep -qF "$TOKEN" "$f" || grep -qF "$EMAIL" "$f"; then
    bad "J2-leak-${f##*/}" "the credential reached ${f##*/}"
  else ok; fi
done

# the dotenv dialect the shared reader owns — every shape a developer's .env comes in
ENVD="$TMP/envs"; mkdir -p "$ENVD"
printf 'JIRA_EMAIL="%s"\nJIRA_API_TOKEN="%s"\n' "$EMAIL" "$TOKEN" > "$ENVD/quoted.env"
printf 'JIRA_EMAIL=%s\nJIRA_API_TOKEN=%s\n' "$EMAIL" "$TOKEN" > "$ENVD/bare.env"
printf 'JIRA_EMAIL="%s"\r\nJIRA_API_TOKEN="%s"\r\n' "$EMAIL" "$TOKEN" > "$ENVD/crlf.env"
printf 'export JIRA_EMAIL=%s\nexport JIRA_API_TOKEN=%s\n' "$EMAIL" "$TOKEN" > "$ENVD/export.env"
printf 'JIRA_EMAIL=%s\nJIRA_API_TOKEN=%s # scoped, read-only, expires 2026-10-10\n' "$EMAIL" "$TOKEN" > "$ENVD/comment.env"
for v in quoted bare crlf export comment; do
  CFGSAVE="$TMP/cfg2-$v"; : > "$CFGSAVE"
  rc=0; CURL_CFG_SAVE="$CFGSAVE" JA_EMAIL="" JA_TOKEN="" \
    ja "$REPO" ABC-101 --out "$OUT" --cloud-id "$CLOUD" --env "$ENVD/$v.env" >"$O" 2>"$E" || rc=$?
  if [ "$rc" -eq 0 ] && grep -qx "user = \"$EMAIL:$TOKEN\"" "$CFGSAVE"; then ok
  else bad "J2-dotenv-$v" "rc=$rc cfg=$(head -c 200 "$CFGSAVE" 2>/dev/null | od -c | head -2 | tr '\n' ' ')"; fi
done

# The config file is a PRECONDITION, not a detail. A temp dir that refuses the 0600 stamp or the
# write — a TMPDIR on a filesystem with no mode bits, a read-only mount — must take the run down
# with a named refusal, never fall back to putting the credential on curl's argv to get through.
# `chmod` is the first thing curl_config_write does, so a failing one IS that filesystem; the shim
# is the only hermetic way to have one on a machine where /tmp works.
BINNM="$TMP/bin-nochmod"; mkdir -p "$BINNM"
for b in bash sh jq git awk sed tr grep head tail wc sort cat cp mv rm mkdir rmdir touch \
         mktemp dirname basename ls env printf date; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$BINNM/$b"
done
printf '#!/usr/bin/env bash\nexit 1\n' > "$BINNM/chmod"; "$BIN/chmod" +x "$BINNM/chmod"
ARGV="$TMP/argv-nocfg"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" JA_PATH_OVERRIDE="$SHIM:$BINNM" \
  ja "$REPO" ABC-101 --out "$OUT" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J2-cfg-unwritable 2 "$rc" "$E" "error=curl_config_unwritable"
if [ ! -s "$ARGV" ]; then ok; else bad J2-cfg-unwritable-quiet "a request went out with no config: $(cat "$ARGV")"; fi

# ---------------------------------------- 3. a value that could inject a second curl directive --
ARGV="$TMP/argv3"
for bad_tok in 'ATATT"x' "$(printf 'ATATTx\nuser = "evil:evil"')" 'ATATT x'; do
  : > "$ARGV"
  rc=0; CURL_ARGV="$ARGV" JA_TOKEN="$bad_tok" \
    ja "$REPO" ABC-101 --out "$OUT" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
  assert J3-invalid-token 3 "$rc" "$E" "error=invalid_jira_credentials"
  if [ ! -s "$ARGV" ]; then ok; else bad J3-no-request "a malformed credential still hit the network"; fi
done
: > "$ARGV"
rc=0; CURL_ARGV="$ARGV" JA_EMAIL="$(printf 'dev@example.com\nuser = "evil:evil"')" \
  ja "$REPO" ABC-101 --out "$OUT" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J3-invalid-email 3 "$rc" "$E" "error=invalid_jira_credentials"
if [ ! -s "$ARGV" ]; then ok; else bad J3-email-no-request "a malformed email still hit the network"; fi

# `source=` names where THAT value came from — a bad token from the environment must not send the
# developer editing a .env that only holds the email
ENVD3="$TMP/env3"; mkdir -p "$ENVD3"
printf 'JIRA_EMAIL=%s\n' "$EMAIL" > "$ENVD3/email-only.env"
rc=0; JA_TOKEN='ATATT bad' JA_EMAIL="" \
  ja "$REPO" ABC-101 --out "$OUT" --cloud-id "$CLOUD" --env "$ENVD3/email-only.env" >"$O" 2>"$E" || rc=$?
assert J3-token-source 3 "$rc" "$E" "error=invalid_jira_credentials source=env field=token"

# ------------------------------------------------------------------- 4. cloudId + the one host --
ARGV="$TMP/argv4"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" ja "$REPO" ABC-101 --out "$OUT" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J4-cloud-id-given 0 "$rc" "$E"
if ! grep -qF 'tenant_info' "$ARGV"; then ok; else bad J4-no-lookup "--cloud-id still paid the tenant_info lookup"; fi
if ! grep -qE 'https://[^ ]*atlassian\.net' "$ARGV"; then ok
else bad J4-gateway-only "a request went to the site host: $(grep -oE 'https://[^ ]*' "$ARGV" | head -3 | tr '\n' ' ')"; fi

ARGV="$TMP/argv4b"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" ja "$REPO" ABC-101 --out "$OUT" >"$O" 2>"$E" || rc=$?
n_lookup="$(grep -cF 'tenant_info' "$ARGV" || true)"
if [ "$rc" -eq 0 ] && [ "$n_lookup" = 1 ] && grep -qF "/ex/jira/$CLOUD/rest/api/3/issue/ABC-101" "$ARGV"; then ok
else bad J4b-lookup-once "rc=$rc lookups=$n_lookup argv=$(head -c 200 "$ARGV" | tr '\n' ' ')"; fi
# the default site is the single home jira-field-ids.md hard-codes
if grep -qF 'https://meetdomaine.atlassian.net/_edge/tenant_info' "$ARGV"; then ok
else bad J4c-default-site "the lookup did not go to the default site: $(grep -oE 'https://[^ ]*tenant_info' "$ARGV" | head -1)"; fi

rc=0; FAKE_HTTP_TENANT=503 ja "$REPO" ABC-101 --out "$OUT" >"$O" 2>"$E" || rc=$?
assert J4d-lookup-failed 2 "$rc" "$E" "error=cloud_id_lookup_failed"

# --------------------------------------------------------------- 5. the key rides a URL path --
ARGV="$TMP/argv5"
for k in '../x' 'abc-101' 'ABC-101/../../x' 'ABC'; do
  : > "$ARGV"
  rc=0; CURL_ARGV="$ARGV" ja "$REPO" "$k" --out "$OUT" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
  assert "J5-bad-key" 2 "$rc" "$E" "error=invalid_issue_key"
  if [ ! -s "$ARGV" ]; then ok; else bad J5-no-request "a bad key '$k' reached the network"; fi
done

# ------------------------------------------------------- 6. type filter, size cap, --ids, --all --
D6="$(new_repo six '.claude/')"; OUT6="$D6/.claude/tasks/ABC-101/tmp/attachments"
rc=0; ja "$D6" ABC-101 --out "$OUT6" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J6-default-run 0 "$rc" "$E" "ok=1 saved=2 cached=0 skipped=2 failed=0"
if [ "$(field 101 2 "$O")" = saved ] && [ "$(field 102 2 "$O")" = saved ] \
   && [ "$(field 103 2 "$O")" = skipped_type ] && [ "$(field 104 2 "$O")" = skipped_size ]; then ok
else bad J6-statuses "$(cat "$O")"; fi
if [ "$(field 101 3 "$O")" = image ] && [ "$(field 102 3 "$O")" = video ] \
   && [ "$(field 103 3 "$O")" = other ]; then ok
else bad J6-kinds "$(cat "$O")"; fi
# the rows come back in id order whatever order Jira listed them in, header first
if [ "$(head -1 "$O")" = "$(printf 'id\tstatus\tkind\tmime\tsize\tcreated\tauthor\tpath\tfilename')" ] \
   && [ "$(awk 'NR > 1 { printf "%s ", $1 }' "$O")" = "101 102 103 104 " ]; then ok
else bad J6-order "$(head -2 "$O" | tr '\n' ';')"; fi
# an attachment with no author displayName must not shift the later columns
if [ "$(field 102 9 "$O")" = recording.mov ] && [ "$(field 102 5 "$O")" = 5678 ]; then ok
else bad J6-empty-author "row 102 columns shifted: $(field 102 0 "$O"; grep '^102' "$O")"; fi
# the image AND the video are files on disk, whole: frames are slim's to cut, never this script's
if [ -s "$OUT6/101-Screenshot_2026-09-10_at_3.26.09_PM.png" ] \
   && [ "$(wc -c < "$OUT6/102-recording.mov" | tr -d ' ')" = 5678 ] \
   && [ ! -e "$OUT6/102-recording.mov.part" ] && [ ! -e "$OUT6/102-recording.mov.frames" ] \
   && [ ! -e "$OUT6/103-spec.pdf" ]; then ok
else bad J6-files "$(ls "$OUT6" 2>&1 | tr '\n' ' ')"; fi
if [ "$(field 102 8 "$O")" = "$OUT6/102-recording.mov" ]; then ok
else bad J6-video-row "path='$(field 102 8 "$O")'"; fi

D6b="$(new_repo six-all '.claude/')"; OUT6B="$D6b/.claude/tasks/ABC-101/tmp/attachments"
rc=0; ja "$D6b" ABC-101 --out "$OUT6B" --cloud-id "$CLOUD" --all >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 103 2 "$O")" = saved ] && [ -s "$OUT6B/103-spec.pdf" ]; then ok
else bad J6-all "rc=$rc row=$(grep '^103' "$O")"; fi

D6c="$(new_repo six-big '.claude/')"; OUT6C="$D6c/.claude/tasks/ABC-101/tmp/attachments"
rc=0; ja "$D6c" ABC-101 --out "$OUT6C" --cloud-id "$CLOUD" --ids 104 --max-mb 40 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 104 2 "$O")" = saved ] \
   && [ "$(awk 'NR > 1' "$O" | wc -l | tr -d ' ')" = 1 ]; then ok
else bad J6-max-mb "rc=$rc out=$(cat "$O")"; fi

D6d="$(new_repo six-ids '.claude/')"; OUT6D="$D6d/.claude/tasks/ABC-101/tmp/attachments"
CONTENT="$TMP/content6d"; : > "$CONTENT"
rc=0; CONTENT_LOG="$CONTENT" ja "$D6d" ABC-101 --out "$OUT6D" --cloud-id "$CLOUD" --ids 101 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(awk 'NR > 1 { printf "%s ", $1 }' "$O")" = "101 " ] \
   && [ "$(cat "$CONTENT")" = 101 ]; then ok
else bad J6-ids "rc=$rc rows=$(awk 'NR>1{printf "%s ", $1}' "$O") content=$(tr '\n' ' ' < "$CONTENT")"; fi

# ------------------------------------------------------------ 7. idempotence, truncation, --force --
CONTENT="$TMP/content7"; FFLOG="$TMP/ff7"; : > "$CONTENT"; : > "$FFLOG"
rc=0; CONTENT_LOG="$CONTENT" FFMPEG_LOG="$FFLOG" \
  ja "$D6" ABC-101 --out "$OUT6" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J7-rerun-cached 0 "$rc" "$E" "ok=1 saved=0 cached=2 skipped=2 failed=0"
# both are cached by their size on disk — neither pays a request
if [ ! -s "$CONTENT" ] && [ ! -s "$FFLOG" ]; then ok
else bad J7-no-work "a cached re-run still fetched: content=$(tr '\n' ' ' < "$CONTENT") ffmpeg=$(wc -l < "$FFLOG")"; fi
if [ "$(field 101 2 "$O")" = cached ] && [ "$(field 102 2 "$O")" = cached ]; then ok
else bad J7-cached-rows "$(cat "$O")"; fi
if [ "$(field 102 8 "$O")" = "$OUT6/102-recording.mov" ]; then ok
else bad J7-cached-video-row "path='$(field 102 8 "$O")'"; fi

# an interrupted run's `.part` is reaped by the next cache hit — nothing else would ever read it
printf 'half' > "$OUT6/102-recording.mov.part"
rc=0; ja "$D6" ABC-101 --out "$OUT6" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = cached ] && [ ! -e "$OUT6/102-recording.mov.part" ]; then ok
else bad J7-part-reaped "rc=$rc row=$(grep '^102' "$O") files=$(ls "$OUT6" | tr '\n' ' ')"; fi

# a file whose size does not match the metadata is a truncated earlier run, not a cache hit
printf 'short' > "$OUT6/101-Screenshot_2026-09-10_at_3.26.09_PM.png"
: > "$CONTENT"
rc=0; CONTENT_LOG="$CONTENT" ja "$D6" ABC-101 --out "$OUT6" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 101 2 "$O")" = saved ] && [ "$(grep -c '^101$' "$CONTENT")" = 1 ] \
   && [ "$(wc -c < "$OUT6/101-Screenshot_2026-09-10_at_3.26.09_PM.png" | tr -d ' ')" = 1234 ]; then ok
else bad J7-truncated "rc=$rc row=$(grep '^101' "$O") content=$(tr '\n' ' ' < "$CONTENT")"; fi

: > "$CONTENT"; : > "$FFLOG"
rc=0; CONTENT_LOG="$CONTENT" FFMPEG_LOG="$FFLOG" \
  ja "$D6" ABC-101 --out "$OUT6" --cloud-id "$CLOUD" --force >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(grep -c '^10[12]$' "$CONTENT")" = 2 ] && [ ! -s "$FFLOG" ]; then ok
else bad J7-force "rc=$rc content=$(tr '\n' ' ' < "$CONTENT") ffmpeg=$(wc -l < "$FFLOG" | tr -d ' ')"; fi
if [ "$(field 102 2 "$O")" = saved ] && [ "$(field 102 8 "$O")" = "$OUT6/102-recording.mov" ] \
   && [ ! -e "$OUT6/102-recording.mov.part" ]; then ok
else bad J7-force-video "$(grep '^102' "$O") files=$(ls "$OUT6" | tr '\n' ' ')"; fi

# ------------------------------------------------------------------- 8. one failed download --
D8="$(new_repo eight '.claude/')"; OUT8="$D8/.claude/tasks/ABC-101/tmp/attachments"
rc=0; FAKE_FAIL_IDS=101 ja "$D8" ABC-101 --out "$OUT8" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J8-partial-failure 1 "$rc" "$E" "ok=1 saved=1 cached=0 skipped=2 failed=1"
if [ "$(field 101 2 "$O")" = failed ] && [ -z "$(field 101 8 "$O")" ] \
   && [ "$(field 102 2 "$O")" = saved ]; then ok
else bad J8-rows "$(cat "$O")"; fi
if [ -z "$(find "$OUT8" -name '*.part' 2>/dev/null)" ]; then ok
else bad J8-part-left "a .part stub survived a failed download"; fi
if grep -qF 'note=download_failed id=101 http=404' "$E"; then ok
else bad J8-note "no per-id failure note: $(head -c 200 "$E" | tr '\n' ' ')"; fi

# ----------------------------------------------------------------------- 9. filename hygiene --
D9="$(new_repo nine '.claude/')"; OUT9="$D9/.claude/tasks/ABC-101/tmp/attachments"
CONTENT="$TMP/content9"; : > "$CONTENT"
rc=0; FAKE_LIST="$FIX/names.json" FAKE_SIZES="201:10,202:10,203:10,204:10" CONTENT_LOG="$CONTENT" \
  ja "$D9" ABC-101 --out "$OUT9" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J9-names-run 0 "$rc" "$E"
# an id is a URL path segment AND the filename prefix: a traversal one is refused, not written
if grep -qF 'note=invalid_attachment_id' "$E" && ! grep -q 'pwn' "$O" \
   && ! grep -q 'pwn' "$CONTENT" && [ -z "$(find "$TMP/repos" -maxdepth 2 -name '*pwn*' 2>/dev/null)" ]; then ok
else bad J9-bad-id "a traversal attachment id was fetched or written: $(find "$TMP/repos" -maxdepth 2 -name '*pwn*' | tr '\n' ' ')"; fi
if [ "$(field 201 9 "$O")" = '_.._evil.png' ]; then ok
else bad J9-traversal "'$(field 201 9 "$O")' still carries a path separator or a leading dot"; fi
if [ "$(field 202 9 "$O")" = 'Screenshot_2026-09-10_at_3.26.09_PM.png' ]; then ok
else bad J9-spaces "'$(field 202 9 "$O")'"; fi
if [ "$(field 203 9 "$O")" = 'noext.png' ]; then ok
else bad J9-mime-ext "'$(field 203 9 "$O")' — an extensionless name takes one from the mime"; fi
n204="$(field 204 9 "$O")"
if [ "${#n204}" -le 80 ] && [ "${n204##*.}" = png ]; then ok
else bad J9-cap "'$n204' (${#n204} chars) — cap 80, extension kept"; fi
outside="$(awk -F'\t' -v o="$OUT9/" 'NR > 1 && $8 != "" && index($8, o) != 1 { print $8 }' "$O")"
if [ -z "$outside" ]; then ok; else bad J9-inside-out "a file landed outside the out dir: $outside"; fi
if [ "$(ls "$OUT9" | wc -l | tr -d ' ')" = 4 ]; then ok
else bad J9-file-count "$(ls "$OUT9" | tr '\n' ' ')"; fi

# ------------------------------------------------------------------ 10. the out dir must be ignored --
D10="$(new_repo ten)"
ARGV="$TMP/argv10"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" ja "$D10" ABC-101 --out "$D10/downloads" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J10-not-ignored 2 "$rc" "$E" "error=out_dir_not_ignored"
if [ ! -d "$D10/downloads" ] && [ ! -s "$ARGV" ]; then ok
else bad J10-no-side-effects "a refused out dir was still created / requested"; fi

# a refused run must not grow the developer's exclude file one duplicate line per retry
D10d="$(new_repo ten-retry)"
mkdir -p "$D10d/sub"
for _ in 1 2 3; do
  rc=0; ja "$D10d" ABC-101 --out "$D10d/sub/.claude/tasks/K/tmp/a" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
done
if [ "$rc" -eq 2 ] && [ "$(grep -cxF '.claude/tasks/' "$D10d/.git/info/exclude")" = 1 ]; then ok
else bad J10d-exclude-dupes "rc=$rc lines=$(grep -cxF '.claude/tasks/' "$D10d/.git/info/exclude")"; fi

# outside the repo entirely — the anti-injection half of the same gate: no repository holds that
# path, so there is no ignore rule that could ever cover it
rc=0; ja "$D10" ABC-101 --out "$TMP/elsewhere" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J10b-outside-repo 2 "$rc" "$E" "error=out_dir_not_in_repo"
if [ ! -d "$TMP/elsewhere" ]; then ok; else bad J10b-created "an out dir outside the repo was created"; fi

# a `.claude/tasks` belonging to ANOTHER checkout is refused with no stamp anywhere: theirs is not
# ours to edit, and ours is not the file that would make their path ignored
D10o="$(new_repo ten-other)"
mkdir -p "$D10o/.claude/tasks" "$D10o/.git/info"; printf '*.local\n' > "$D10o/.git/info/exclude"
rc=0; ja "$D10" ABC-101 --out "$D10o/.claude/tasks/K/tmp/a" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J10b2-other-repo 2 "$rc" "$E" "error=out_dir_not_ignored"
if ! grep -qxF '.claude/tasks/' "$D10o/.git/info/exclude" \
   && ! grep -qxF '.claude/tasks/' "$D10/.git/info/exclude" 2>/dev/null; then ok
else bad J10b2-stamped "other=$(tr '\n' '|' < "$D10o/.git/info/exclude") ours=$(tr '\n' '|' < "$D10/.git/info/exclude" 2>/dev/null)"; fi

# under .claude/tasks/ the script stamps the line task-workspace.md prescribes and goes on — even
# when the developer's exclude file does not end in a newline
D10c="$(new_repo ten-tasks)"
mkdir -p "$D10c/.git/info"; printf '*.local' > "$D10c/.git/info/exclude"
rc=0; ja "$D10c" ABC-101 --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J10c-stamped 0 "$rc" "$E" "ok=1 saved=2"
if grep -qx '\.claude/tasks/' "$D10c/.git/info/exclude" && grep -qx '\*\.local' "$D10c/.git/info/exclude"; then ok
else bad J10c-exclude-line "exclude = $(tr '\n' '|' < "$D10c/.git/info/exclude")"; fi
if [ -s "$D10c/.claude/tasks/ABC-101/tmp/attachments/101-Screenshot_2026-09-10_at_3.26.09_PM.png" ]; then ok
else bad J10c-default-out "the default out dir did not receive the files: $(ls "$D10c/.claude/tasks/ABC-101/tmp/attachments" 2>&1 | tr '\n' ' ')"; fi

# a glob character in --out (or in $PWD) is a path segment, not a pattern: the download must land
# in the directory the caller named, not in whatever the cwd happens to match
D10e="$(new_repo ten-glob '.claude/')"
touch "$D10e/visible.txt" "$D10e/zz.txt"
rc=0; ja "$D10e" ABC-101 --out '.claude/tasks/*/tmp/attachments' --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ -s "$D10e/.claude/tasks/*/tmp/attachments/101-Screenshot_2026-09-10_at_3.26.09_PM.png" ] \
   && [ ! -d "$D10e/.claude/tasks/visible.txt" ]; then ok
else bad J10e-glob-out "rc=$rc dirs=$(find "$D10e/.claude" -maxdepth 3 -type d 2>/dev/null | tr '\n' ' ')"; fi

# a linked worktree's `.claude/tasks` is a SYMLINK into the main checkout (worktree-setup.sh makes
# it one) and git refuses to answer about anything beyond a symlink — `check-ignore` on the lexical
# path dies rc 128 and a lexical gate reads that as "not ignored". The question belongs to the
# repository that physically holds the bytes.
mkdir -p "$TMP/nohooks"
git_commit() { git -C "$1" -c core.hooksPath="$TMP/nohooks" -c user.email=sim@example.com \
                 -c user.name=sim commit -q --allow-empty -m init >/dev/null 2>&1; }

D10f="$(new_repo ten-wt-main)"; git_commit "$D10f"
mkdir -p "$D10f/.git/info"; printf '.claude/tasks/\n' > "$D10f/.git/info/exclude"
mkdir -p "$D10f/.claude/tasks"
WT10f="$TMP/repos/ten-wt-linked"
git -C "$D10f" worktree add -q "$WT10f" -b wt-f >/dev/null 2>&1
mkdir -p "$WT10f/.claude"; ln -s "$D10f/.claude/tasks" "$WT10f/.claude/tasks"
rc=0; ja "$WT10f" ABC-101 --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J10f-worktree-symlink 0 "$rc" "$E" "ok=1 saved=2"
if [ -s "$D10f/.claude/tasks/ABC-101/tmp/attachments/101-Screenshot_2026-09-10_at_3.26.09_PM.png" ] \
   && grep -qF "out=$D10f/.claude/tasks/ABC-101/tmp/attachments" "$E"; then ok
else bad J10f-physical-out "the bytes did not land in the main checkout: $(tail -1 "$E")"; fi
if [ "$(grep -cxF '.claude/tasks/' "$D10f/.git/info/exclude")" = 1 ]; then ok
else bad J10f-exclude-dupes "lines=$(grep -cxF '.claude/tasks/' "$D10f/.git/info/exclude")"; fi

# same shape, no exclude line yet: the stamp lands once in the common dir the worktree shares with
# its main checkout — same repository, so it IS ours to write
D10g="$(new_repo ten-wt-nostamp)"; git_commit "$D10g"
mkdir -p "$D10g/.claude/tasks"
WT10g="$TMP/repos/ten-wt-nostamp-linked"
git -C "$D10g" worktree add -q "$WT10g" -b wt-g >/dev/null 2>&1
mkdir -p "$WT10g/.claude"; ln -s "$D10g/.claude/tasks" "$WT10g/.claude/tasks"
rc=0; ja "$WT10g" ABC-101 --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J10g-worktree-stamp 0 "$rc" "$E" "ok=1 saved=2"
if [ "$(grep -cxF '.claude/tasks/' "$D10g/.git/info/exclude")" = 1 ] \
   && [ ! -f "$D10g/.git/worktrees/ten-wt-nostamp-linked/info/exclude" ] \
   && [ -s "$D10g/.claude/tasks/ABC-101/tmp/attachments/101-Screenshot_2026-09-10_at_3.26.09_PM.png" ]; then ok
else bad J10g-stamp "exclude=$(tr '\n' '|' < "$D10g/.git/info/exclude" 2>&1) files=$(ls "$D10g/.claude/tasks/ABC-101/tmp/attachments" 2>&1 | tr '\n' ' ')"; fi

# the escape the physical rule closes: an out dir that is lexically ignored inside the repo but
# resolves, through a symlink, to a place no repository holds
D10h="$(new_repo ten-symlink-escape '.claude/')"
mkdir -p "$D10h/.claude" "$TMP/outside-nonrepo"
ln -s "$TMP/outside-nonrepo" "$D10h/.claude/tasks"
ARGV="$TMP/argv10h"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" ja "$D10h" ABC-101 --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J10h-symlink-escape 2 "$rc" "$E" "error=out_dir_not_in_repo"
if [ ! -e "$TMP/outside-nonrepo/ABC-101" ] && [ ! -s "$ARGV" ]; then ok
else bad J10h-escaped "bytes left the repo through a symlink: $(ls -a "$TMP/outside-nonrepo" | tr '\n' ' ')"; fi

# ------------------------------------------------------------------------ 11. the curl argv --
ARGV="$TMP/argv11"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" ja "$REPO" ABC-101 --out "$OUT" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
for want in ' -L ' '--proto-redir =https' '--proto =https' '--connect-timeout 10' '--max-time 120'; do
  if grep -qF -- "$want" "$ARGV"; then ok; else bad J11-curl-flag "argv is missing '$want': $(head -1 "$ARGV")"; fi
done
if ! grep -qF -- '--location-trusted' "$ARGV"; then ok
else bad J11-location-trusted "--location-trusted would hand the credential to the media host"; fi

# --------------------------------------------------------------------------- 12. --check --
rc=0; ja "$REPO" --check --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qxF "ok=1 jira_user=Ada Lovelace cloud_id=$CLOUD" "$O"; then ok
else bad J12-check-ok "rc=$rc out=$(cat "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
# no media tool is consulted: the check says nothing about one
if ! grep -q 'ffmpeg' "$O"; then ok
else bad J12b-check-no-media-tool "out=$(cat "$O")"; fi
rc=0; FAKE_HTTP_MYSELF=401 ja "$REPO" --check --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J12c-check-401 4 "$rc" "$E" "error=jira_auth_rejected http=401"
if grep -qF 'references/jira-attachments.md' "$E"; then ok
else bad J12c-hint "the rejection does not point at the walk-through"; fi
rc=0; JA_EMAIL="" JA_TOKEN="" ja "$NOCRED" --check >"$O" 2>"$E" || rc=$?
assert J12d-check-no-creds 3 "$rc" "$E" "error=no_jira_credentials"

# ----------------------------------------------------------------------------- 13. --json --
rc=0; ja "$D6" ABC-101 --out "$OUT6" --cloud-id "$CLOUD" --json >"$O" 2>"$E" || rc=$?
assert J13-json-run 0 "$rc" "$E"
if jq -e 'length == 4 and (map(.id) == ["101","102","103","104"])' "$O" >/dev/null 2>&1; then ok
else bad J13-json-shape "$(head -c 200 "$O")"; fi
rc=0; ja "$D6" ABC-101 --out "$OUT6" --cloud-id "$CLOUD" >"$TMP/tsv13" 2>/dev/null || rc=$?
mismatch=""
for id in 101 102 103 104; do
  for pair in "2:status" "3:kind" "4:mime" "8:path" "9:filename"; do
    col="${pair%%:*}"; key="${pair#*:}"
    a="$(field "$id" "$col" "$TMP/tsv13")"
    b="$(jq -r --arg id "$id" --arg k "$key" '.[] | select(.id == $id) | .[$k]' "$O")"
    [ "$a" = "$b" ] || mismatch="$mismatch $id.$key('$a' vs '$b')"
  done
done
if [ -z "$mismatch" ]; then ok; else bad J13-json-matches-tsv "$mismatch"; fi
# nine fields per object, the same nine the TSV header names — no frames key
if jq -e 'all(.[]; (keys | sort) == ["author","created","filename","id","kind","mime","path","size","status"])' \
     "$O" >/dev/null 2>&1; then ok
else bad J13-json-keys "$(jq -c '.[0] | keys' "$O")"; fi
# an issue with no attachments is a header row and an empty array, not a failure
rc=0; FAKE_LIST="$FIX/empty.json" ja "$D6" ABC-101 --out "$OUT6" --cloud-id "$CLOUD" --json >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$O")" = "[]" ]; then ok
else bad J13-empty "rc=$rc out=$(cat "$O")"; fi


# --------------------------------------------- 14. a video is downloaded whole, never cut here --
# slim's `view` cuts the frames beside the file, so the script keeps the bytes and never reaches
# for a media tool — not ffmpeg, not ffprobe, not sips — on any run.
D14="$(new_repo fourteen '.claude/')"; OUT14="$D14/.claude/tasks/ABC-101/tmp/attachments"
FFLOG="$TMP/ff14"; : > "$FFLOG"
rc=0; FFMPEG_LOG="$FFLOG" ja "$D14" ABC-101 --out "$OUT14" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = saved ] && [ "$(field 102 3 "$O")" = video ] \
   && [ "$(field 102 8 "$O")" = "$OUT14/102-recording.mov" ] \
   && [ "$(wc -c < "$OUT14/102-recording.mov" | tr -d ' ')" = 5678 ]; then ok
else bad J14-video-whole "rc=$rc row=$(grep '^102' "$O") files=$(ls "$OUT14" 2>&1 | tr '\n' ' ')"; fi
if [ -z "$(find "$OUT14" -name '*.frames' 2>/dev/null)" ] && [ ! -s "$FFLOG" ]; then ok
else bad J14-no-frames "frames=$(find "$OUT14" -name '*.frames' | tr '\n' ' ') media-tool calls=$(tr '\n' ';' < "$FFLOG")"; fi
assert J14-summary 0 "$rc" "$E" "ok=1 saved=1 cached=0 skipped=0 failed=0 out=$OUT14"
if ! grep -qE 'frames=|ffmpeg' "$E"; then ok
else bad J14-no-frame-notes "$(tr '\n' ';' < "$E")"; fi
# fnd's frame flags are not flags here: each is an unknown argument, refused before any request
for fl in --no-frames --keep-video "--frames 8"; do
  rc=0; ARGV="$TMP/argv14f"; : > "$ARGV"
  CURL_ARGV="$ARGV" ja "$D14" ABC-101 --out "$OUT14" --cloud-id "$CLOUD" $fl >"$O" 2>"$E" || rc=$?
  if [ "$rc" -eq 2 ] && grep -qF "error=unknown_arg arg=${fl%% *}" "$E" && [ ! -s "$ARGV" ]; then ok
  else bad "J14-flag-gone[$fl]" "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
done

# ------------------------------------------------------------- 14o. --max-mb vs --max-video-mb --
# videos get their own, far larger cap: 30 MB of video is fetched where 30 MB of PNG is not, and
# neither flag lifts the other's ceiling
D14o="$(new_repo fourteen-caps '.claude/')"; OUT14O="$D14o/.claude/tasks/ABC-101/tmp/attachments"
rc=0; FAKE_LIST="$FIX/videos.json" FAKE_SIZES="$VID_SIZES" \
  ja "$D14o" ABC-101 --out "$OUT14O" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 301 2 "$O")" = saved ] && [ "$(field 302 2 "$O")" = skipped_size ] \
   && [ "$(field 303 2 "$O")" = skipped_size ]; then ok
else bad J14o-default-caps "rc=$rc $(awk 'NR>1{printf "%s=%s ", $1, $2}' "$O")"; fi
D14o2="$(new_repo fourteen-caps-small '.claude/')"; OUT14O2="$D14o2/.claude/tasks/ABC-101/tmp/attachments"
CONTENT="$TMP/content14o"; : > "$CONTENT"
rc=0; FAKE_LIST="$FIX/videos.json" FAKE_SIZES="$VID_SIZES" CONTENT_LOG="$CONTENT" \
  ja "$D14o2" ABC-101 --out "$OUT14O2" --cloud-id "$CLOUD" --max-video-mb 10 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 301 2 "$O")" = skipped_size ] && [ ! -s "$CONTENT" ]; then ok
else bad J14o2-video-cap-down "rc=$rc row=$(grep '^301' "$O") content=$(tr '\n' ' ' < "$CONTENT")"; fi
D14o3="$(new_repo fourteen-caps-wide '.claude/')"; OUT14O3="$D14o3/.claude/tasks/ABC-101/tmp/attachments"
rc=0; FAKE_LIST="$FIX/videos.json" FAKE_SIZES="$VID_SIZES" \
  ja "$D14o3" ABC-101 --out "$OUT14O3" --cloud-id "$CLOUD" --max-video-mb 400 --max-mb 40 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 302 2 "$O")" = saved ] && [ "$(field 303 2 "$O")" = saved ] \
   && [ "$(field 302 8 "$O")" = "$OUT14O3/302-long_recording.mp4" ]; then ok
else bad J14o3-caps-raised "rc=$rc $(awk 'NR>1{printf "%s=%s ", $1, $2}' "$O")"; fi
# the image cap alone leaves the video cap where it was
D14o4="$(new_repo fourteen-caps-image '.claude/')"; OUT14O4="$D14o4/.claude/tasks/ABC-101/tmp/attachments"
rc=0; FAKE_LIST="$FIX/videos.json" FAKE_SIZES="$VID_SIZES" \
  ja "$D14o4" ABC-101 --out "$OUT14O4" --cloud-id "$CLOUD" --max-mb 400 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 303 2 "$O")" = saved ] && [ "$(field 302 2 "$O")" = skipped_size ]; then ok
else bad J14o4-image-cap "rc=$rc $(awk 'NR>1{printf "%s=%s ", $1, $2}' "$O")"; fi
rc=0; ja "$D14o4" ABC-101 --out "$OUT14O4" --cloud-id "$CLOUD" --max-video-mb x >"$O" 2>"$E" || rc=$?
assert J14o5-bad-video-cap 2 "$rc" "$E" "error=invalid_max_video_mb value=x"

# ------------------------------------------------------- 15. --help, and the flags that name it --
# `--help` used to be error=unknown_arg, so the one question a model asks before its first call was
# the one call that could not be answered. It answers before the shared lib, the credential read
# and the cloudId lookup — no dotenv, no token, nothing on the wire — and it prints the header's own
# `# Usage:` block: two hand-maintained copies of a call shape are two copies free to disagree, and
# the header is the one a reader lands on.
JAH="$TMP/ja-usage-header"
awk '/^# Usage:/ { f = 1 } f { if ($0 == "#" || $0 !~ /^#( |$)/) exit; sub(/^# ?/, ""); print }' \
  "$JA" > "$JAH"
for ha in --help -h; do
  rc=0; ARGV="$TMP/argv15$ha"; : > "$ARGV"
  CURL_ARGV="$ARGV" JA_EMAIL="" JA_TOKEN="" ja "$NOCRED" "$ha" >"$O" 2>"$E" || rc=$?
  if [ "$rc" -eq 0 ] && [ ! -s "$E" ] && [ ! -s "$ARGV" ] \
     && [ "$(wc -l < "$JAH" | tr -d ' ')" -eq 5 ] && sed '$d' "$O" | diff -q - "$JAH" >/dev/null; then ok
  else bad "J15-help[$ha]" "rc=$rc diff=$(sed '$d' "$O" | diff - "$JAH" | head -c 300 | tr '\n' ';') err=$(head -c 120 "$E" | tr '\n' ' ')"; fi
done
# J15b: the pointer line that follows it names where the full contract lives
if [ "$(tail -1 "$O")" = "Full contract: the header of $JA" ]; then ok
else bad J15b-help-pointer "tail=$(tail -1 "$O")"; fi
# J15c: --help among a real call's args is still a usage question — no lookup, no download
for hc in "ABC-101 --out $OUT --help" "--check -h" "ABC-101 --ids 101 --help"; do
  rc=0; ARGV="$TMP/argv15c"; : > "$ARGV"; CONTENT="$TMP/content15c"; : > "$CONTENT"
  CURL_ARGV="$ARGV" CONTENT_LOG="$CONTENT" ja "$REPO" $hc >"$O" 2>"$E" || rc=$?
  if [ "$rc" -eq 0 ] && grep -q '^Usage:' "$O" && [ ! -s "$ARGV" ] && [ ! -s "$CONTENT" ]; then ok
  else bad "J15c-help-mid-args[$hc]" "rc=$rc out=$(head -c 120 "$O" | tr '\n' ' ') argv=$(tr '\n' ';' < "$ARGV")"; fi
done
# J15d: …and the refusal a guessed flag gets names the way out in one step
rc=0; ARGV="$TMP/argv15d"; : > "$ARGV"
CURL_ARGV="$ARGV" ja "$REPO" ABC-101 --bogus >"$O" 2>"$E" || rc=$?
assert J15d-unknown-arg-trailer 2 "$rc" "$E" "error=unknown_arg arg=--bogus (--help prints usage)"
if [ ! -s "$ARGV" ]; then ok; else bad J15d-unknown-arg-request "a refused flag still reached the network"; fi

# J15g: a flag VALUE of `-h` is a usage question too — positional matching is what makes the arm
# answer before the parse loop, and the header says so where a reader of the pointer line lands
rc=0; ARGV="$TMP/argv15g"; : > "$ARGV"
CURL_ARGV="$ARGV" ja "$REPO" ABC-101 --site -h >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^Usage:' "$O" && [ ! -s "$ARGV" ] && grep -q 'VALUE of `-h`' "$JA"; then ok
else bad J15g-help-in-value-position "rc=$rc argv=$(tr '\n' ';' < "$ARGV") out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# J15h (drift guard): the REFERENCE carries a third copy of the call shapes, and a third copy is a
# third thing free to disagree. Column alignment is presentation; the flag SET and ORDER are the
# contract, so both copies are squeezed to one line per call shape before the diff.
norm_usage() { # <file> — strips the `<plugin root>/scripts/` prefix and joins continuation lines
  sed 's/^[[:space:]]*//; s|^<plugin root>/scripts/||' "$1" \
    | awk '
        index($0, "jira-attachments.sh ") == 1 { if (c != "") print c; c = $0; next }
        c != "" && NF { c = c " " $0; next }
        { if (c != "") print c; c = "" }
        END { if (c != "") print c }' \
    | sed 's/  */ /g; s/[[:space:]]*$//'
}
JAR="$ROOT/plugins/base/references/jira-attachments.md"
JARB="$TMP/ja-ref-block"
awk '/^## The script$/ { f = 1 } f && /^```bash$/ { b = 1; next } b && /^```$/ { exit } b { print }' \
  "$JAR" > "$JARB"
if [ "$(norm_usage "$JARB" | grep -c .)" -eq 2 ] \
   && norm_usage "$JARB" | diff -q - <(norm_usage "$JAH") >/dev/null; then ok
else bad J15h-reference-matches-usage "diff=$(norm_usage "$JARB" | diff - <(norm_usage "$JAH") | head -c 300 | tr '\n' ';')"; fi

# J15e (bug): `--cloud-id <site host>` — the value a caller reaches for first, since the site host is
# the id they have — used to be a bare `error=invalid_cloud_id` with nothing to act on. The line
# names the value, what the flag takes, and the flag the site host belongs to.
rc=0; ARGV="$TMP/argv15e"; : > "$ARGV"
CURL_ARGV="$ARGV" ja "$REPO" ABC-101 --out "$OUT" --cloud-id meetdomaine.atlassian.net >"$O" 2>"$E" || rc=$?
assert J15e-invalid-cloud-id 2 "$rc" "$E" "error=invalid_cloud_id value=meetdomaine.atlassian.net"
for want in "cloud UUID" "--site" "--check" "drop the flag"; do
  if grep -qF -- "$want" "$E"; then ok; else bad J15e-hint "the refusal never mentions '$want': $(head -c 200 "$E" | tr '\n' ' ')"; fi
done
if [ ! -s "$ARGV" ]; then ok; else bad J15e-no-request "a malformed cloud id still reached the network"; fi
# J15f: the value is echoed back, so it may not forge a line of its own — a cloudId carrying a
# newline reaches this printf from the site's OWN `tenant_info` answer, which is remote data
rc=0; NL="$(printf 'a\nerror=forged')"
ja "$REPO" ABC-101 --out "$OUT" --cloud-id "$NL" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 2 ] && [ "$(grep -c '^error=' "$E")" -eq 1 ] && ! grep -q '^error=forged' "$E"; then ok
else bad J15f-value-cannot-forge "rc=$rc err=$(head -c 200 "$E" | tr '\n' ';')"; fi

echo "base-jira-attachments-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
