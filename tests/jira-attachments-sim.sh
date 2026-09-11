#!/usr/bin/env bash
# Simulation harness for scripts/jira-attachments.sh. No network and no Jira: `curl`, `ffmpeg` and
# `ffprobe` are PATH shims, and the PATH itself is a dir of symlinks to exactly the tools the
# script uses — the only way to make `command -v ffmpeg` fail on a machine that has one installed.
# Exit 0 = all green.
set -u

# Hermetic env: a developer with a real scoped token exported would otherwise have their own
# credential reach the fake curl (and this suite's argv log) instead of the fixture value, and an
# exported JIRA_SITE would re-target the cloudId lookup every case pins.
unset JIRA_EMAIL JIRA_API_TOKEN JIRA_SITE

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JA="$ROOT/plugins/fnd/scripts/jira-attachments.sh"
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

SHIM_FULL="$TMP/shim-full"; SHIM_NOPROBE="$TMP/shim-noprobe"; SHIM_NOFF="$TMP/shim-noff"
mkdir -p "$SHIM_FULL" "$SHIM_NOPROBE" "$SHIM_NOFF"

cat > "$SHIM_NOFF/curl" <<'FAKE'
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

cat > "$SHIM_NOPROBE/ffmpeg" <<'FAKE'
#!/usr/bin/env bash
# Two shapes, both real ffmpeg's:
#   · the DURATION PROBE (`-i <file>` with no output file) prints the header block on stderr and
#     exits 1 — that is how a machine with no ffprobe still learns how long the recording is;
#   · the CUT (`-ss <t> -i <file> -frames:v 1 -vf <filter> <out.png>`) writes one stub PNG at the
#     path it is handed, so frame listing, ordering and the timecode names are the real ones.
# FFMPEG_FAIL makes every cut fail; FFMPEG_EOF_AT makes a seek at or past that instant produce
# nothing, exactly like a real seek past the end of the recording.
# A cut handed no -nostdin also DRAINS its stdin, which is what real ffmpeg does with it (it reads
# stdin for keyboard commands): in a loop fed by a here-string that eats the rest of the frame plan,
# so the regression shows up here as a recording one frame long.
[ -n "${FFMPEG_LOG:-}" ] && printf '%s\n' "$*" >> "$FFMPEG_LOG"
ss=""; frames=""; out=""; prev=""
for a in "$@"; do
  case "$prev" in -ss) ss="$a" ;; -frames:v) frames="$a" ;; esac
  out="$a"; prev="$a"
done
if [ -z "$frames" ]; then
  printf 'Input #0, mov,mp4,m4a, from %s:\n' "$out" >&2
  # real ffmpeg prints the container's Metadata block ABOVE its own Duration line, and the tags in
  # it are attacker-supplied: FAKE_FFMPEG_META plants one that competes with the real duration
  [ -n "${FAKE_FFMPEG_META:-}" ] \
    && printf '  Metadata:\n    title           : %s\n' "$FAKE_FFMPEG_META" >&2
  printf '  Duration: %s, start: 0.000000, bitrate: 1200 kb/s\n' \
    "${FAKE_FFMPEG_DURATION:-00:00:50.00}" >&2
  printf 'At least one output file must be specified\n' >&2
  exit 1
fi
case " $* " in
  *" -nostdin "*) ;;
  *) [ -t 0 ] || cat >/dev/null 2>&1 ;;   # exactly what the missing flag costs
esac
[ -n "${FFMPEG_FAIL:-}" ] && exit 1
if [ -n "${FFMPEG_EOF_AT:-}" ] \
   && awk -v t="$ss" -v e="$FFMPEG_EOF_AT" 'BEGIN { exit !(t + 0 >= e + 0) }'; then
  exit 1
fi
dir="${out%/*}"; mkdir -p "$dir"
printf 'PNG' > "$out"
exit 0
FAKE

cat > "$SHIM_FULL/ffprobe" <<'FAKE'
#!/usr/bin/env bash
[ -n "${FFPROBE_LOG:-}" ] && printf '%s\n' "$*" >> "$FFPROBE_LOG"
printf '%s\n' "${FAKE_DURATION:-12.5}"
exit 0
FAKE

cp "$SHIM_NOFF/curl" "$SHIM_NOPROBE/curl"; cp "$SHIM_NOFF/curl" "$SHIM_FULL/curl"
cp "$SHIM_NOPROBE/ffmpeg" "$SHIM_FULL/ffmpeg"
chmod +x "$SHIM_NOFF/curl" "$SHIM_NOPROBE/curl" "$SHIM_NOPROBE/ffmpeg" \
         "$SHIM_FULL/curl" "$SHIM_FULL/ffmpeg" "$SHIM_FULL/ffprobe"

# ------------------------------------------------------------------------ fixtures + runner --
CLOUD="11111111-2222-3333-4444-555555555555"
EMAIL="dev.secret@example.com"
TOKEN="ATATT3xFfGF0secret-value_09=="
SIZES="101:1234,102:5678,103:999,104:31457280"

FIX="$TMP/fixtures"; mkdir -p "$FIX"
# out of id order on purpose (the rows come back sorted), and 102 has no author displayName — an
# empty middle field is what a tab-separated row would silently shift
cat > "$FIX/list.json" <<'JSON'
{"key":"ELC-1309","fields":{"attachment":[
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
printf '{"key":"ELC-1309","fields":{"attachment":[]}}' > "$FIX/empty.json"
# the two caps meet here: a 30 MB video clears the 200 MB video cap while a 30 MB image does not
# clear the 25 MB one, and a 300 MB video clears neither. The BYTES the fake curl hands back are
# tiny on purpose (FAKE_SIZES) — a transient video's cache is its done marker, not its file size.
cat > "$FIX/videos.json" <<'JSON'
{"key":"ELC-1309","fields":{"attachment":[
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
jq -n --arg long "$LONG.png" '{key:"ELC-1309",fields:{attachment:[
  {id:"../../../../pwn",filename:"a.png",mimeType:"image/png",size:10,created:"c",author:{displayName:"A"}},
  {id:"201",filename:"../../evil.png",mimeType:"image/png",size:10,created:"c",author:{displayName:"A"}},
  {id:"202",filename:"Screenshot 2026-09-10 at 3.26.09 PM.png",mimeType:"image/png",size:10,created:"c",author:{displayName:"A"}},
  {id:"203",filename:"noext",mimeType:"image/png",size:10,created:"c",author:{displayName:"A"}},
  {id:"204",filename:$long,mimeType:"image/png",size:10,created:"c",author:{displayName:"A"}}
]}}' > "$FIX/names.json"

JA_PATH="$SHIM_FULL:$BIN"
ja() { # ja <cwd> <args…> — every knob below is a one-shot prefix on the call
  local cwd="$1"; shift
  ( cd "$cwd" && PATH="${JA_PATH_OVERRIDE:-$JA_PATH}" \
      CURL_ARGV="${CURL_ARGV:-/dev/null}" CURL_CFG_SAVE="${CURL_CFG_SAVE:-}" \
      CONTENT_LOG="${CONTENT_LOG:-/dev/null}" FFMPEG_LOG="${FFMPEG_LOG:-/dev/null}" \
      FFPROBE_LOG="${FFPROBE_LOG:-/dev/null}" FFMPEG_FAIL="${FFMPEG_FAIL:-}" \
      FAKE_LIST="${FAKE_LIST:-$FIX/list.json}" FAKE_SIZES="${FAKE_SIZES:-$SIZES}" \
      FAKE_CLOUD_ID="${FAKE_CLOUD_ID:-$CLOUD}" FAKE_FAIL_IDS="${FAKE_FAIL_IDS:-}" \
      FAKE_HTTP_TENANT="${FAKE_HTTP_TENANT:-200}" FAKE_HTTP_ISSUE="${FAKE_HTTP_ISSUE:-200}" \
      FAKE_HTTP_MYSELF="${FAKE_HTTP_MYSELF:-200}" FAKE_DURATION="${FAKE_DURATION:-12.5}" \
      FAKE_FFMPEG_DURATION="${FAKE_FFMPEG_DURATION:-00:00:50.00}" FFMPEG_EOF_AT="${FFMPEG_EOF_AT:-}" \
      FAKE_FFMPEG_META="${FAKE_FFMPEG_META:-}" \
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

# the frame file names of a frames dir, in the order the glob hands them over
frame_names() { ls "$1" 2>/dev/null | LC_ALL=C grep -E '^[0-9]+-[0-9]+m[0-9]+s\.png$' | LC_ALL=C sort; }
# every `-ss <t>` the script asked ffmpeg for, in call order — the sampled instants themselves
ffmpeg_ss() { awk '{ for (i = 1; i < NF; i++) if ($i == "-ss") print $(i + 1) }' "$1"; }

O="$TMP/out"; E="$TMP/err"
REPO="$(new_repo main '.claude/')"
OUT="$REPO/.claude/tasks/ELC-1309/tmp/attachments"

# ------------------------------------------------------ 1. no credentials: hint, no request --
NOCRED="$(new_repo nocred '.claude/')"
ARGV="$TMP/argv1"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" JA_EMAIL="" JA_TOKEN="" ja "$NOCRED" ELC-1309 >"$O" 2>"$E" || rc=$?
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
  ja "$REPO" ELC-1309 --out "$OUT" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
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
    ja "$REPO" ELC-1309 --out "$OUT" --cloud-id "$CLOUD" --env "$ENVD/$v.env" >"$O" 2>"$E" || rc=$?
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
rc=0; CURL_ARGV="$ARGV" JA_PATH_OVERRIDE="$SHIM_FULL:$BINNM" \
  ja "$REPO" ELC-1309 --out "$OUT" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J2-cfg-unwritable 2 "$rc" "$E" "error=curl_config_unwritable"
if [ ! -s "$ARGV" ]; then ok; else bad J2-cfg-unwritable-quiet "a request went out with no config: $(cat "$ARGV")"; fi

# ---------------------------------------- 3. a value that could inject a second curl directive --
ARGV="$TMP/argv3"
for bad_tok in 'ATATT"x' "$(printf 'ATATTx\nuser = "evil:evil"')" 'ATATT x'; do
  : > "$ARGV"
  rc=0; CURL_ARGV="$ARGV" JA_TOKEN="$bad_tok" \
    ja "$REPO" ELC-1309 --out "$OUT" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
  assert J3-invalid-token 3 "$rc" "$E" "error=invalid_jira_credentials"
  if [ ! -s "$ARGV" ]; then ok; else bad J3-no-request "a malformed credential still hit the network"; fi
done
: > "$ARGV"
rc=0; CURL_ARGV="$ARGV" JA_EMAIL="$(printf 'dev@example.com\nuser = "evil:evil"')" \
  ja "$REPO" ELC-1309 --out "$OUT" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J3-invalid-email 3 "$rc" "$E" "error=invalid_jira_credentials"
if [ ! -s "$ARGV" ]; then ok; else bad J3-email-no-request "a malformed email still hit the network"; fi

# `source=` names where THAT value came from — a bad token from the environment must not send the
# developer editing a .env that only holds the email
ENVD3="$TMP/env3"; mkdir -p "$ENVD3"
printf 'JIRA_EMAIL=%s\n' "$EMAIL" > "$ENVD3/email-only.env"
rc=0; JA_TOKEN='ATATT bad' JA_EMAIL="" \
  ja "$REPO" ELC-1309 --out "$OUT" --cloud-id "$CLOUD" --env "$ENVD3/email-only.env" >"$O" 2>"$E" || rc=$?
assert J3-token-source 3 "$rc" "$E" "error=invalid_jira_credentials source=env field=token"

# ------------------------------------------------------------------- 4. cloudId + the one host --
ARGV="$TMP/argv4"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" ja "$REPO" ELC-1309 --out "$OUT" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J4-cloud-id-given 0 "$rc" "$E"
if ! grep -qF 'tenant_info' "$ARGV"; then ok; else bad J4-no-lookup "--cloud-id still paid the tenant_info lookup"; fi
if ! grep -qE 'https://[^ ]*atlassian\.net' "$ARGV"; then ok
else bad J4-gateway-only "a request went to the site host: $(grep -oE 'https://[^ ]*' "$ARGV" | head -3 | tr '\n' ' ')"; fi

ARGV="$TMP/argv4b"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" ja "$REPO" ELC-1309 --out "$OUT" >"$O" 2>"$E" || rc=$?
n_lookup="$(grep -cF 'tenant_info' "$ARGV" || true)"
if [ "$rc" -eq 0 ] && [ "$n_lookup" = 1 ] && grep -qF "/ex/jira/$CLOUD/rest/api/3/issue/ELC-1309" "$ARGV"; then ok
else bad J4b-lookup-once "rc=$rc lookups=$n_lookup argv=$(head -c 200 "$ARGV" | tr '\n' ' ')"; fi
# the default site is the single home jira-field-ids.md hard-codes
if grep -qF 'https://meetdomaine.atlassian.net/_edge/tenant_info' "$ARGV"; then ok
else bad J4c-default-site "the lookup did not go to the default site: $(grep -oE 'https://[^ ]*tenant_info' "$ARGV" | head -1)"; fi

rc=0; FAKE_HTTP_TENANT=503 ja "$REPO" ELC-1309 --out "$OUT" >"$O" 2>"$E" || rc=$?
assert J4d-lookup-failed 2 "$rc" "$E" "error=cloud_id_lookup_failed"

# --------------------------------------------------------------- 5. the key rides a URL path --
ARGV="$TMP/argv5"
for k in '../x' 'elc-1309' 'ELC-1309/../../x' 'ELC'; do
  : > "$ARGV"
  rc=0; CURL_ARGV="$ARGV" ja "$REPO" "$k" --out "$OUT" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
  assert "J5-bad-key" 2 "$rc" "$E" "error=invalid_issue_key"
  if [ ! -s "$ARGV" ]; then ok; else bad J5-no-request "a bad key '$k' reached the network"; fi
done

# ------------------------------------------------------- 6. type filter, size cap, --ids, --all --
D6="$(new_repo six '.claude/')"; OUT6="$D6/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; ja "$D6" ELC-1309 --out "$OUT6" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J6-default-run 0 "$rc" "$E" "ok=1 saved=2 cached=0 skipped=2 failed=0"
if [ "$(field 101 2 "$O")" = saved ] && [ "$(field 102 2 "$O")" = saved ] \
   && [ "$(field 103 2 "$O")" = skipped_type ] && [ "$(field 104 2 "$O")" = skipped_size ]; then ok
else bad J6-statuses "$(cat "$O")"; fi
if [ "$(field 101 3 "$O")" = image ] && [ "$(field 102 3 "$O")" = video ] \
   && [ "$(field 103 3 "$O")" = other ]; then ok
else bad J6-kinds "$(cat "$O")"; fi
# the rows come back in id order whatever order Jira listed them in, header first
if [ "$(head -1 "$O")" = "$(printf 'id\tstatus\tkind\tmime\tsize\tcreated\tauthor\tpath\tframes\tfilename')" ] \
   && [ "$(awk 'NR > 1 { printf "%s ", $1 }' "$O")" = "101 102 103 104 " ]; then ok
else bad J6-order "$(head -2 "$O" | tr '\n' ';')"; fi
# an attachment with no author displayName must not shift the later columns
if [ "$(field 102 10 "$O")" = recording.mov ] && [ "$(field 102 5 "$O")" = 5678 ]; then ok
else bad J6-empty-author "row 102 columns shifted: $(field 102 0 "$O"; grep '^102' "$O")"; fi
# the image is a file; the VIDEO is a frames dir and nothing else — its bytes were a means to it
if [ -s "$OUT6/101-Screenshot_2026-09-10_at_3.26.09_PM.png" ] && [ ! -e "$OUT6/102-recording.mov" ] \
   && [ ! -e "$OUT6/102-recording.mov.part" ] && [ -d "$OUT6/102-recording.mov.frames" ] \
   && [ ! -e "$OUT6/103-spec.pdf" ]; then ok
else bad J6-files "$(ls "$OUT6" 2>&1 | tr '\n' ' ')"; fi
# a transient video's row: saved, empty path, the frames dir as the whole result
if [ -z "$(field 102 8 "$O")" ] && [ "$(field 102 9 "$O")" = "$OUT6/102-recording.mov.frames:8" ]; then ok
else bad J6-video-row "path='$(field 102 8 "$O")' frames='$(field 102 9 "$O")'"; fi

D6b="$(new_repo six-all '.claude/')"; OUT6B="$D6b/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; ja "$D6b" ELC-1309 --out "$OUT6B" --cloud-id "$CLOUD" --all >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 103 2 "$O")" = saved ] && [ -s "$OUT6B/103-spec.pdf" ]; then ok
else bad J6-all "rc=$rc row=$(grep '^103' "$O")"; fi

D6c="$(new_repo six-big '.claude/')"; OUT6C="$D6c/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; ja "$D6c" ELC-1309 --out "$OUT6C" --cloud-id "$CLOUD" --ids 104 --max-mb 40 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 104 2 "$O")" = saved ] \
   && [ "$(awk 'NR > 1' "$O" | wc -l | tr -d ' ')" = 1 ]; then ok
else bad J6-max-mb "rc=$rc out=$(cat "$O")"; fi

D6d="$(new_repo six-ids '.claude/')"; OUT6D="$D6d/.claude/tasks/ELC-1309/tmp/attachments"
CONTENT="$TMP/content6d"; : > "$CONTENT"
rc=0; CONTENT_LOG="$CONTENT" ja "$D6d" ELC-1309 --out "$OUT6D" --cloud-id "$CLOUD" --ids 101 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(awk 'NR > 1 { printf "%s ", $1 }' "$O")" = "101 " ] \
   && [ "$(cat "$CONTENT")" = 101 ]; then ok
else bad J6-ids "rc=$rc rows=$(awk 'NR>1{printf "%s ", $1}' "$O") content=$(tr '\n' ' ' < "$CONTENT")"; fi

# ------------------------------------------------------------ 7. idempotence, truncation, --force --
CONTENT="$TMP/content7"; FFLOG="$TMP/ff7"; : > "$CONTENT"; : > "$FFLOG"
rc=0; CONTENT_LOG="$CONTENT" FFMPEG_LOG="$FFLOG" \
  ja "$D6" ELC-1309 --out "$OUT6" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J7-rerun-cached 0 "$rc" "$E" "ok=1 saved=0 cached=2 skipped=2 failed=0"
# the image is cached by its size on disk, the video by its done marker — neither pays a request,
# and the video pays no second cut either (there is no video left on disk to cut)
if [ ! -s "$CONTENT" ] && [ ! -s "$FFLOG" ]; then ok
else bad J7-no-work "a cached re-run still fetched/framed: content=$(tr '\n' ' ' < "$CONTENT") ffmpeg=$(wc -l < "$FFLOG")"; fi
if [ "$(field 101 2 "$O")" = cached ] && [ "$(field 102 2 "$O")" = cached ]; then ok
else bad J7-cached-rows "$(cat "$O")"; fi
# a cached transient video keeps the transient contract: empty path, the frames dir, the same count
if [ -z "$(field 102 8 "$O")" ] && [ "$(field 102 9 "$O")" = "$OUT6/102-recording.mov.frames:8" ] \
   && [ ! -e "$OUT6/102-recording.mov" ]; then ok
else bad J7-cached-video-row "path='$(field 102 8 "$O")' frames='$(field 102 9 "$O")'"; fi

# a file whose size does not match the metadata is a truncated earlier run, not a cache hit
printf 'short' > "$OUT6/101-Screenshot_2026-09-10_at_3.26.09_PM.png"
: > "$CONTENT"
rc=0; CONTENT_LOG="$CONTENT" ja "$D6" ELC-1309 --out "$OUT6" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 101 2 "$O")" = saved ] && [ "$(grep -c '^101$' "$CONTENT")" = 1 ] \
   && [ "$(wc -c < "$OUT6/101-Screenshot_2026-09-10_at_3.26.09_PM.png" | tr -d ' ')" = 1234 ]; then ok
else bad J7-truncated "rc=$rc row=$(grep '^101' "$O") content=$(tr '\n' ' ' < "$CONTENT")"; fi

: > "$CONTENT"; : > "$FFLOG"
rc=0; CONTENT_LOG="$CONTENT" FFMPEG_LOG="$FFLOG" \
  ja "$D6" ELC-1309 --out "$OUT6" --cloud-id "$CLOUD" --force >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(grep -c '^10[12]$' "$CONTENT")" = 2 ] && [ -s "$FFLOG" ]; then ok
else bad J7-force "rc=$rc content=$(tr '\n' ' ' < "$CONTENT") ffmpeg=$(wc -l < "$FFLOG" | tr -d ' ')"; fi
# --force re-downloads AND re-cuts AND re-deletes: the video is transient on every run, not just the first
if [ ! -e "$OUT6/102-recording.mov" ] && [ ! -e "$OUT6/102-recording.mov.part" ] \
   && [ "$(field 102 9 "$O")" = "$OUT6/102-recording.mov.frames:8" ]; then ok
else bad J7-force-transient "the forced re-cut left the video behind: $(ls "$OUT6" | tr '\n' ' ')"; fi

# ------------------------------------------------------------------- 8. one failed download --
D8="$(new_repo eight '.claude/')"; OUT8="$D8/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; FAKE_FAIL_IDS=101 ja "$D8" ELC-1309 --out "$OUT8" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J8-partial-failure 1 "$rc" "$E" "ok=1 saved=1 cached=0 skipped=2 failed=1"
if [ "$(field 101 2 "$O")" = failed ] && [ -z "$(field 101 8 "$O")" ] \
   && [ "$(field 102 2 "$O")" = saved ]; then ok
else bad J8-rows "$(cat "$O")"; fi
if [ -z "$(find "$OUT8" -name '*.part' 2>/dev/null)" ]; then ok
else bad J8-part-left "a .part stub survived a failed download"; fi
if grep -qF 'note=download_failed id=101 http=404' "$E"; then ok
else bad J8-note "no per-id failure note: $(head -c 200 "$E" | tr '\n' ' ')"; fi

# ----------------------------------------------------------------------- 9. filename hygiene --
D9="$(new_repo nine '.claude/')"; OUT9="$D9/.claude/tasks/ELC-1309/tmp/attachments"
CONTENT="$TMP/content9"; : > "$CONTENT"
rc=0; FAKE_LIST="$FIX/names.json" FAKE_SIZES="201:10,202:10,203:10,204:10" CONTENT_LOG="$CONTENT" \
  ja "$D9" ELC-1309 --out "$OUT9" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J9-names-run 0 "$rc" "$E"
# an id is a URL path segment AND the filename prefix: a traversal one is refused, not written
if grep -qF 'note=invalid_attachment_id' "$E" && ! grep -q 'pwn' "$O" \
   && ! grep -q 'pwn' "$CONTENT" && [ -z "$(find "$TMP/repos" -maxdepth 2 -name '*pwn*' 2>/dev/null)" ]; then ok
else bad J9-bad-id "a traversal attachment id was fetched or written: $(find "$TMP/repos" -maxdepth 2 -name '*pwn*' | tr '\n' ' ')"; fi
if [ "$(field 201 10 "$O")" = '_.._evil.png' ]; then ok
else bad J9-traversal "'$(field 201 10 "$O")' still carries a path separator or a leading dot"; fi
if [ "$(field 202 10 "$O")" = 'Screenshot_2026-09-10_at_3.26.09_PM.png' ]; then ok
else bad J9-spaces "'$(field 202 10 "$O")'"; fi
if [ "$(field 203 10 "$O")" = 'noext.png' ]; then ok
else bad J9-mime-ext "'$(field 203 10 "$O")' — an extensionless name takes one from the mime"; fi
n204="$(field 204 10 "$O")"
if [ "${#n204}" -le 80 ] && [ "${n204##*.}" = png ]; then ok
else bad J9-cap "'$n204' (${#n204} chars) — cap 80, extension kept"; fi
outside="$(awk -F'\t' -v o="$OUT9/" 'NR > 1 && $8 != "" && index($8, o) != 1 { print $8 }' "$O")"
if [ -z "$outside" ]; then ok; else bad J9-inside-out "a file landed outside the out dir: $outside"; fi
if [ "$(ls "$OUT9" | wc -l | tr -d ' ')" = 4 ]; then ok
else bad J9-file-count "$(ls "$OUT9" | tr '\n' ' ')"; fi

# ------------------------------------------------------------------ 10. the out dir must be ignored --
D10="$(new_repo ten)"
ARGV="$TMP/argv10"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" ja "$D10" ELC-1309 --out "$D10/downloads" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J10-not-ignored 2 "$rc" "$E" "error=out_dir_not_ignored"
if [ ! -d "$D10/downloads" ] && [ ! -s "$ARGV" ]; then ok
else bad J10-no-side-effects "a refused out dir was still created / requested"; fi

# a refused run must not grow the developer's exclude file one duplicate line per retry
D10d="$(new_repo ten-retry)"
mkdir -p "$D10d/sub"
for _ in 1 2 3; do
  rc=0; ja "$D10d" ELC-1309 --out "$D10d/sub/.claude/tasks/K/tmp/a" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
done
if [ "$rc" -eq 2 ] && [ "$(grep -cxF '.claude/tasks/' "$D10d/.git/info/exclude")" = 1 ]; then ok
else bad J10d-exclude-dupes "rc=$rc lines=$(grep -cxF '.claude/tasks/' "$D10d/.git/info/exclude")"; fi

# outside the repo entirely — the anti-injection half of the same gate: no repository holds that
# path, so there is no ignore rule that could ever cover it
rc=0; ja "$D10" ELC-1309 --out "$TMP/elsewhere" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J10b-outside-repo 2 "$rc" "$E" "error=out_dir_not_in_repo"
if [ ! -d "$TMP/elsewhere" ]; then ok; else bad J10b-created "an out dir outside the repo was created"; fi

# a `.claude/tasks` belonging to ANOTHER checkout is refused with no stamp anywhere: theirs is not
# ours to edit, and ours is not the file that would make their path ignored
D10o="$(new_repo ten-other)"
mkdir -p "$D10o/.claude/tasks" "$D10o/.git/info"; printf '*.local\n' > "$D10o/.git/info/exclude"
rc=0; ja "$D10" ELC-1309 --out "$D10o/.claude/tasks/K/tmp/a" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J10b2-other-repo 2 "$rc" "$E" "error=out_dir_not_ignored"
if ! grep -qxF '.claude/tasks/' "$D10o/.git/info/exclude" \
   && ! grep -qxF '.claude/tasks/' "$D10/.git/info/exclude" 2>/dev/null; then ok
else bad J10b2-stamped "other=$(tr '\n' '|' < "$D10o/.git/info/exclude") ours=$(tr '\n' '|' < "$D10/.git/info/exclude" 2>/dev/null)"; fi

# under .claude/tasks/ the script stamps the line task-workspace.md prescribes and goes on — even
# when the developer's exclude file does not end in a newline
D10c="$(new_repo ten-tasks)"
mkdir -p "$D10c/.git/info"; printf '*.local' > "$D10c/.git/info/exclude"
rc=0; ja "$D10c" ELC-1309 --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J10c-stamped 0 "$rc" "$E" "ok=1 saved=2"
if grep -qx '\.claude/tasks/' "$D10c/.git/info/exclude" && grep -qx '\*\.local' "$D10c/.git/info/exclude"; then ok
else bad J10c-exclude-line "exclude = $(tr '\n' '|' < "$D10c/.git/info/exclude")"; fi
if [ -s "$D10c/.claude/tasks/ELC-1309/tmp/attachments/101-Screenshot_2026-09-10_at_3.26.09_PM.png" ]; then ok
else bad J10c-default-out "the default out dir did not receive the files: $(ls "$D10c/.claude/tasks/ELC-1309/tmp/attachments" 2>&1 | tr '\n' ' ')"; fi

# a glob character in --out (or in $PWD) is a path segment, not a pattern: the download must land
# in the directory the caller named, not in whatever the cwd happens to match
D10e="$(new_repo ten-glob '.claude/')"
touch "$D10e/visible.txt" "$D10e/zz.txt"
rc=0; ja "$D10e" ELC-1309 --out '.claude/tasks/*/tmp/attachments' --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
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
rc=0; ja "$WT10f" ELC-1309 --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J10f-worktree-symlink 0 "$rc" "$E" "ok=1 saved=2"
if [ -s "$D10f/.claude/tasks/ELC-1309/tmp/attachments/101-Screenshot_2026-09-10_at_3.26.09_PM.png" ] \
   && grep -qF "out=$D10f/.claude/tasks/ELC-1309/tmp/attachments" "$E"; then ok
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
rc=0; ja "$WT10g" ELC-1309 --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J10g-worktree-stamp 0 "$rc" "$E" "ok=1 saved=2"
if [ "$(grep -cxF '.claude/tasks/' "$D10g/.git/info/exclude")" = 1 ] \
   && [ ! -f "$D10g/.git/worktrees/ten-wt-nostamp-linked/info/exclude" ] \
   && [ -s "$D10g/.claude/tasks/ELC-1309/tmp/attachments/101-Screenshot_2026-09-10_at_3.26.09_PM.png" ]; then ok
else bad J10g-stamp "exclude=$(tr '\n' '|' < "$D10g/.git/info/exclude" 2>&1) files=$(ls "$D10g/.claude/tasks/ELC-1309/tmp/attachments" 2>&1 | tr '\n' ' ')"; fi

# the escape the physical rule closes: an out dir that is lexically ignored inside the repo but
# resolves, through a symlink, to a place no repository holds
D10h="$(new_repo ten-symlink-escape '.claude/')"
mkdir -p "$D10h/.claude" "$TMP/outside-nonrepo"
ln -s "$TMP/outside-nonrepo" "$D10h/.claude/tasks"
ARGV="$TMP/argv10h"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" ja "$D10h" ELC-1309 --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J10h-symlink-escape 2 "$rc" "$E" "error=out_dir_not_in_repo"
if [ ! -e "$TMP/outside-nonrepo/ELC-1309" ] && [ ! -s "$ARGV" ]; then ok
else bad J10h-escaped "bytes left the repo through a symlink: $(ls -a "$TMP/outside-nonrepo" | tr '\n' ' ')"; fi

# ------------------------------------------------------------------------ 11. the curl argv --
ARGV="$TMP/argv11"; : > "$ARGV"
rc=0; CURL_ARGV="$ARGV" ja "$REPO" ELC-1309 --out "$OUT" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
for want in ' -L ' '--proto-redir =https' '--proto =https' '--connect-timeout 10' '--max-time 120'; do
  if grep -qF -- "$want" "$ARGV"; then ok; else bad J11-curl-flag "argv is missing '$want': $(head -1 "$ARGV")"; fi
done
if ! grep -qF -- '--location-trusted' "$ARGV"; then ok
else bad J11-location-trusted "--location-trusted would hand the credential to the media host"; fi

# --------------------------------------------------------------------------- 12. --check --
rc=0; ja "$REPO" --check --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qF "ok=1 jira_user=Ada Lovelace cloud_id=$CLOUD ffmpeg=yes" "$O"; then ok
else bad J12-check-ok "rc=$rc out=$(cat "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
rc=0; JA_PATH_OVERRIDE="$SHIM_NOFF:$BIN" ja "$REPO" --check --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qF 'ffmpeg=no' "$O"; then ok
else bad J12b-check-no-ffmpeg "rc=$rc out=$(cat "$O")"; fi
rc=0; FAKE_HTTP_MYSELF=401 ja "$REPO" --check --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
assert J12c-check-401 4 "$rc" "$E" "error=jira_auth_rejected http=401"
if grep -qF 'references/jira-attachments.md' "$E"; then ok
else bad J12c-hint "the rejection does not point at the walk-through"; fi
rc=0; JA_EMAIL="" JA_TOKEN="" ja "$NOCRED" --check >"$O" 2>"$E" || rc=$?
assert J12d-check-no-creds 3 "$rc" "$E" "error=no_jira_credentials"

# ----------------------------------------------------------------------------- 13. --json --
rc=0; ja "$D6" ELC-1309 --out "$OUT6" --cloud-id "$CLOUD" --json >"$O" 2>"$E" || rc=$?
assert J13-json-run 0 "$rc" "$E"
if jq -e 'length == 4 and (map(.id) == ["101","102","103","104"])' "$O" >/dev/null 2>&1; then ok
else bad J13-json-shape "$(head -c 200 "$O")"; fi
rc=0; ja "$D6" ELC-1309 --out "$OUT6" --cloud-id "$CLOUD" >"$TMP/tsv13" 2>/dev/null || rc=$?
mismatch=""
for id in 101 102 103 104; do
  for pair in "2:status" "3:kind" "4:mime" "8:path" "10:filename"; do
    col="${pair%%:*}"; key="${pair#*:}"
    a="$(field "$id" "$col" "$TMP/tsv13")"
    b="$(jq -r --arg id "$id" --arg k "$key" '.[] | select(.id == $id) | .[$k]' "$O")"
    [ "$a" = "$b" ] || mismatch="$mismatch $id.$key('$a' vs '$b')"
  done
done
if [ -z "$mismatch" ]; then ok; else bad J13-json-matches-tsv "$mismatch"; fi
# frames are a path list in JSON and `<dir>:<count>` in the TSV — same dir, same count
if jq -e '.[] | select(.id == "102") | (.frames | length) == 8 and (.frames[0] | endswith("/01-00m00s.png"))
             and (.path == "")' "$O" >/dev/null 2>&1 \
   && [ "$(field 102 9 "$TMP/tsv13")" = "$OUT6/102-recording.mov.frames:8" ]; then ok
else bad J13-json-frames "$(jq -c '.[] | select(.id=="102") | .frames' "$O") vs $(field 102 9 "$TMP/tsv13")"; fi
# an issue with no attachments is a header row and an empty array, not a failure
rc=0; FAKE_LIST="$FIX/empty.json" ja "$D6" ELC-1309 --out "$OUT6" --cloud-id "$CLOUD" --json >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$O")" = "[]" ]; then ok
else bad J13-empty "rc=$rc out=$(cat "$O")"; fi

# ------------------------------------------------- 14. frames: a video is a means to its frames --
# The contract: download to <target>.part, cut, DELETE the video. The row is saved|cached with an
# EMPTY path and `frames=<dir>:<count>`; the frames dir is the whole deliverable.
D14="$(new_repo fourteen '.claude/')"; OUT14="$D14/.claude/tasks/ELC-1309/tmp/attachments"
FD="$OUT14/102-recording.mov.frames"
FFLOG="$TMP/ff14"; : > "$FFLOG"
rc=0; FFMPEG_LOG="$FFLOG" ja "$D14" ELC-1309 --out "$OUT14" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = saved ] && [ -z "$(field 102 8 "$O")" ] \
   && [ "$(field 102 9 "$O")" = "$FD:8" ] && [ ! -e "$OUT14/102-recording.mov" ] \
   && [ ! -e "$OUT14/102-recording.mov.part" ]; then ok
else bad J14-transient "rc=$rc row=$(grep '^102' "$O") files=$(ls "$OUT14" 2>&1 | tr '\n' ' ')"; fi
assert J14-frames-summary 0 "$rc" "$E" "frames=8"
# every frame name carries its ordinal AND its timecode, and the glob order stays chronological
if [ "$(frame_names "$FD" | tr '\n' ' ')" = "01-00m00s.png 02-00m02s.png 03-00m03s.png 04-00m05s.png 05-00m07s.png 06-00m08s.png 07-00m10s.png 08-00m11s.png " ]; then ok
else bad J14-frame-names "$(ls "$FD" 2>&1 | tr '\n' ' ')"; fi
# BIN CENTRES: t_i = (i + 0.5) * 12.5 / 8 — the last one sits at 11.7 s of a 12.5 s recording,
# where the old fps grid starting at 0 never sampled the final eighth at all
if [ "$(ffmpeg_ss "$FFLOG" | tr '\n' ' ')" = "0.781 2.344 3.906 5.469 7.031 8.594 10.156 11.719 " ]; then ok
else bad J14-bin-centres "instants: $(ffmpeg_ss "$FFLOG" | tr '\n' ' ')"; fi
# one invocation per frame, INPUT seeking (-ss before -i), width capped at 1440 with an even height
if [ "$(grep -cE -- '-ss [0-9.]+ -i ' "$FFLOG")" = 8 ] && [ "$(grep -c -- '-frames:v 1' "$FFLOG")" = 8 ] \
   && [ "$(grep -cF -- "-vf scale='min(1440,iw)':-2" "$FFLOG")" = 8 ] \
   && ! grep -qF 'fps=' "$FFLOG" && ! grep -qF 'scale=960' "$FFLOG"; then ok
else bad J14-ffmpeg-argv "$(cat "$FFLOG")"; fi
# the done marker records the SOURCE size — that, not the (deleted) file, is what makes a cache hit
if grep -qx 'size=5678' "$FD/done"; then ok
else bad J14-done-marker "done = $(cat "$FD/done" 2>&1 | tr '\n' ' ')"; fi

# a second run is `cached` off that marker: no content request, no cut, same transient row
CONTENT="$TMP/content14i"; FFLOG="$TMP/ff14i"; : > "$CONTENT"; : > "$FFLOG"
rc=0; CONTENT_LOG="$CONTENT" FFMPEG_LOG="$FFLOG" \
  ja "$D14" ELC-1309 --out "$OUT14" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = cached ] && [ ! -s "$CONTENT" ] && [ ! -s "$FFLOG" ] \
   && [ -z "$(field 102 8 "$O")" ] && [ "$(field 102 9 "$O")" = "$FD:8" ]; then ok
else bad J14i-cached-by-marker "rc=$rc row=$(grep '^102' "$O") content=$(tr '\n' ' ' < "$CONTENT") ffmpeg=$(wc -l < "$FFLOG" | tr -d ' ')"; fi

# a done marker written by the PREVIOUS version is an empty file: it says a cut happened, never of
# what, so it is stale — re-download, re-cut, re-delete
: > "$FD/done"
CONTENT="$TMP/content14j"; FFLOG="$TMP/ff14j"; : > "$CONTENT"; : > "$FFLOG"
rc=0; CONTENT_LOG="$CONTENT" FFMPEG_LOG="$FFLOG" \
  ja "$D14" ELC-1309 --out "$OUT14" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = saved ] && [ "$(cat "$CONTENT")" = 102 ] \
   && [ -s "$FFLOG" ] && grep -qx 'size=5678' "$FD/done" && [ ! -e "$OUT14/102-recording.mov" ]; then ok
else bad J14j-stale-marker "rc=$rc row=$(grep '^102' "$O") content=$(tr '\n' ' ' < "$CONTENT")"; fi

# a done marker whose size belongs to a DIFFERENT source is stale too (the attachment was replaced)
printf 'size=9999\n' > "$FD/done"
CONTENT="$TMP/content14j2"; : > "$CONTENT"
rc=0; CONTENT_LOG="$CONTENT" ja "$D14" ELC-1309 --out "$OUT14" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = saved ] && [ "$(cat "$CONTENT")" = 102 ]; then ok
else bad J14j2-marker-size "rc=$rc row=$(grep '^102' "$O") content=$(tr '\n' ' ' < "$CONTENT")"; fi

# ----------------------------------------------------- 14b. no ffmpeg: the video is NOT fetched --
D14b="$(new_repo fourteen-noff '.claude/')"; OUT14B="$D14b/.claude/tasks/ELC-1309/tmp/attachments"
CONTENT="$TMP/content14b"; : > "$CONTENT"
rc=0; JA_PATH_OVERRIDE="$SHIM_NOFF:$BIN" CONTENT_LOG="$CONTENT" \
  ja "$D14b" ELC-1309 --out "$OUT14B" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
assert J14b-no-ffmpeg 0 "$rc" "$E" "note=ffmpeg_not_found videos=1"
assert J14b-summary 0 "$rc" "$E" "ok=1 saved=0 cached=0 skipped=1 failed=0"
if [ "$(field 102 2 "$O")" = skipped_no_ffmpeg ] && [ -z "$(field 102 8 "$O")" ] \
   && [ -z "$(field 102 9 "$O")" ]; then ok
else bad J14b-row "the video row is not skipped_no_ffmpeg: $(grep '^102' "$O")"; fi
# tens of MB nothing here could cut are never fetched at all — the whole point of the skip
if [ ! -s "$CONTENT" ] && [ -z "$(ls -A "$OUT14B" 2>/dev/null)" ]; then ok
else bad J14b-no-request "content=$(tr '\n' ' ' < "$CONTENT") files=$(ls "$OUT14B" 2>&1 | tr '\n' ' ')"; fi
# images on the same machine are untouched by any of it
rc=0; JA_PATH_OVERRIDE="$SHIM_NOFF:$BIN" \
  ja "$D14b" ELC-1309 --out "$OUT14B" --cloud-id "$CLOUD" --ids 101 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 101 2 "$O")" = saved ] \
   && [ -s "$OUT14B/101-Screenshot_2026-09-10_at_3.26.09_PM.png" ]; then ok
else bad J14b-images "an image was affected by the missing ffmpeg: $(grep '^101' "$O")"; fi

# ------------------------------------------------- 14c. --no-frames keeps the video, uncut --
D14c="$(new_repo fourteen-noframes '.claude/')"; OUT14C="$D14c/.claude/tasks/ELC-1309/tmp/attachments"
FFLOG="$TMP/ff14c"; : > "$FFLOG"
rc=0; FFMPEG_LOG="$FFLOG" \
  ja "$D14c" ELC-1309 --out "$OUT14C" --cloud-id "$CLOUD" --ids 102 --no-frames >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ ! -s "$FFLOG" ] && [ -z "$(field 102 9 "$O")" ] \
   && [ "$(field 102 8 "$O")" = "$OUT14C/102-recording.mov" ] && [ -s "$OUT14C/102-recording.mov" ] \
   && [ ! -d "$OUT14C/102-recording.mov.frames" ] && ! grep -qF 'ffmpeg_not_found' "$E"; then ok
else bad J14c-no-frames "rc=$rc ffmpeg=$(cat "$FFLOG") row=$(grep '^102' "$O")"; fi
# a kept video is cached the old way: the file on disk, its size equal to the metadata size
CONTENT="$TMP/content14c"; : > "$CONTENT"
rc=0; CONTENT_LOG="$CONTENT" \
  ja "$D14c" ELC-1309 --out "$OUT14C" --cloud-id "$CLOUD" --ids 102 --no-frames >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = cached ] && [ ! -s "$CONTENT" ]; then ok
else bad J14c-kept-cache "rc=$rc row=$(grep '^102' "$O") content=$(tr '\n' ' ' < "$CONTENT")"; fi
# --no-frames without ffmpeg is still a request for the FILE: it is downloaded and kept
D14c2="$(new_repo fourteen-noframes-noff '.claude/')"; OUT14C2="$D14c2/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; JA_PATH_OVERRIDE="$SHIM_NOFF:$BIN" \
  ja "$D14c2" ELC-1309 --out "$OUT14C2" --cloud-id "$CLOUD" --ids 102 --no-frames >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = saved ] && [ -s "$OUT14C2/102-recording.mov" ] \
   && ! grep -qF 'ffmpeg_not_found' "$E"; then ok
else bad J14c2-noframes-noff "rc=$rc row=$(grep '^102' "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# --------------------------------------------------- 14d. --frames pins the count (no adaptive) --
D14d="$(new_repo fourteen-three '.claude/')"; OUT14D="$D14d/.claude/tasks/ELC-1309/tmp/attachments"
FFLOG="$TMP/ff14d"; : > "$FFLOG"
rc=0; FAKE_DURATION=200 FFMPEG_LOG="$FFLOG" \
  ja "$D14d" ELC-1309 --out "$OUT14D" --cloud-id "$CLOUD" --ids 102 --frames 3 >"$O" 2>"$E" || rc=$?
# 200 s would ask for 24 adaptively — the flag wins, and the 3 instants are still bin centres
if [ "$rc" -eq 0 ] && [ "$(field 102 9 "$O")" = "$OUT14D/102-recording.mov.frames:3" ] \
   && [ "$(frame_names "$OUT14D/102-recording.mov.frames" | tr '\n' ' ')" = "01-00m33s.png 02-01m40s.png 03-02m46s.png " ] \
   && [ "$(ffmpeg_ss "$FFLOG" | tr '\n' ' ')" = "33.333 100.000 166.667 " ]; then ok
else bad J14d-frames-n "rc=$rc row=$(field 102 9 "$O") names=$(frame_names "$OUT14D/102-recording.mov.frames" | tr '\n' ' ') ss=$(ffmpeg_ss "$FFLOG" | tr '\n' ' ')"; fi
rc=0; ja "$D14d" ELC-1309 --out "$OUT14D" --cloud-id "$CLOUD" --ids 102 --frames 0 >"$O" 2>"$E" || rc=$?
assert J14d-frames-zero 2 "$rc" "$E" "error=invalid_frames"
# the ceiling is the frame NAME's two-digit ordinal: at 100 the lexical glob every reader of that
# dir goes by would put `100-…` ahead of `99-…`, so the count is refused instead of ordered wrongly
rc=0; ja "$D14d" ELC-1309 --out "$OUT14D" --cloud-id "$CLOUD" --ids 102 --frames 100 >"$O" 2>"$E" || rc=$?
assert J14d-frames-over-99 2 "$rc" "$E" "error=invalid_frames value=100"
D14d9="$(new_repo fourteen-ninetynine '.claude/')"; OUT14D9="$D14d9/.claude/tasks/ELC-1309/tmp/attachments"
FD14D9="$OUT14D9/102-recording.mov.frames"
rc=0; ja "$D14d9" ELC-1309 --out "$OUT14D9" --cloud-id "$CLOUD" --ids 102 --frames 99 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 9 "$O")" = "$FD14D9:99" ] \
   && [ "$(frame_names "$FD14D9" | head -1)" = 01-00m00s.png ] \
   && [ "$(frame_names "$FD14D9" | tail -1)" = 99-00m12s.png ]; then ok
else bad J14d-frames-99 "rc=$rc row=$(field 102 9 "$O") first=$(frame_names "$FD14D9" | head -1) last=$(frame_names "$FD14D9" | tail -1)"; fi

# ------------------------------------------ 14e. no ffprobe: the duration comes from ffmpeg -i --
D14e="$(new_repo fourteen-noprobe '.claude/')"; OUT14E="$D14e/.claude/tasks/ELC-1309/tmp/attachments"
FFLOG="$TMP/ff14e"; : > "$FFLOG"
rc=0; JA_PATH_OVERRIDE="$SHIM_NOPROBE:$BIN" FFMPEG_LOG="$FFLOG" FAKE_FFMPEG_DURATION=00:00:50.00 \
  ja "$D14e" ELC-1309 --out "$OUT14E" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
FD14E="$OUT14E/102-recording.mov.frames"
# `Duration: 00:00:50.00` parsed off the probe call → 50 s → ceil(50 / 4) = 13 frames, not the
# 60 s fallback (which would be 15) and not a silently shortened 8
if [ "$rc" -eq 0 ] && [ "$(field 102 9 "$O")" = "$FD14E:13" ] \
   && grep -qE -- '^-hide_banner -i ' "$FFLOG" && ! grep -qF 'duration_unknown' "$E"; then ok
else bad J14e-ffmpeg-duration "rc=$rc row=$(field 102 9 "$O") probe=$(head -1 "$FFLOG") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
if [ "$(ffmpeg_ss "$FFLOG" | head -1)" = 1.923 ] && [ "$(ffmpeg_ss "$FFLOG" | tail -1)" = 48.077 ] \
   && [ -f "$FD14E/13-00m48s.png" ]; then ok
else bad J14e-instants "first=$(ffmpeg_ss "$FFLOG" | head -1) last=$(ffmpeg_ss "$FFLOG" | tail -1)"; fi
# neither probe can answer → 60 s is assumed AND said out loud, never silently
D14e2="$(new_repo fourteen-noduration '.claude/')"; OUT14E2="$D14e2/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; JA_PATH_OVERRIDE="$SHIM_NOPROBE:$BIN" FAKE_FFMPEG_DURATION=unknown \
  ja "$D14e2" ELC-1309 --out "$OUT14E2" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
assert J14e2-duration-unknown 0 "$rc" "$E" "note=duration_unknown id=102 assumed=60s"
if [ "$(field 102 9 "$O")" = "$OUT14E2/102-recording.mov.frames:15" ]; then ok
else bad J14e2-assumed "60 s assumed should still ask for ceil(60/4)=15 frames: $(field 102 9 "$O")"; fi

# --------------------------------------------- 14f. a failed cut keeps nothing (transient video) --
D14f="$(new_repo fourteen-fail '.claude/')"; OUT14F="$D14f/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; FFMPEG_FAIL=1 ja "$D14f" ELC-1309 --out "$OUT14F" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
assert J14f-frames-failed 1 "$rc" "$E" "note=frames_failed id=102"
if [ "$(field 102 2 "$O")" = failed ] && [ -z "$(field 102 8 "$O")" ] && [ -z "$(field 102 9 "$O")" ] \
   && [ ! -d "$OUT14F/102-recording.mov.frames" ] && [ ! -e "$OUT14F/102-recording.mov" ] \
   && [ ! -e "$OUT14F/102-recording.mov.part" ]; then ok
else bad J14f-row "$(grep '^102' "$O") files=$(ls "$OUT14F" 2>&1 | tr '\n' ' ')"; fi
assert J14f-summary 1 "$rc" "$E" "ok=1 saved=0 cached=0 skipped=0 failed=1"
# a cut that "succeeds" with zero frames is a failed cut too — the row must not point at an empty dir
D14f2="$(new_repo fourteen-empty-cut '.claude/')"; OUT14F2="$D14f2/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; FFMPEG_EOF_AT=0 ja "$D14f2" ELC-1309 --out "$OUT14F2" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
assert J14f2-zero-frames 1 "$rc" "$E" "note=frames_failed id=102"
if [ "$(field 102 2 "$O")" = failed ] && [ ! -d "$OUT14F2/102-recording.mov.frames" ]; then ok
else bad J14f2-row "$(grep '^102' "$O")"; fi

# ------------------------------------------------------- 14g. --keep-video keeps both, and only --
D14g="$(new_repo fourteen-keep '.claude/')"; OUT14G="$D14g/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; ja "$D14g" ELC-1309 --out "$OUT14G" --cloud-id "$CLOUD" --ids 102 --keep-video >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = saved ] \
   && [ "$(field 102 8 "$O")" = "$OUT14G/102-recording.mov" ] && [ -s "$OUT14G/102-recording.mov" ] \
   && [ "$(field 102 9 "$O")" = "$OUT14G/102-recording.mov.frames:8" ]; then ok
else bad J14g-keep-video "rc=$rc row=$(grep '^102' "$O") files=$(ls "$OUT14G" | tr '\n' ' ')"; fi
# cached under --keep-video wants BOTH halves back: the frames marker and the file itself
CONTENT="$TMP/content14g"; : > "$CONTENT"
rc=0; CONTENT_LOG="$CONTENT" \
  ja "$D14g" ELC-1309 --out "$OUT14G" --cloud-id "$CLOUD" --ids 102 --keep-video >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = cached ] && [ ! -s "$CONTENT" ] \
   && [ "$(field 102 8 "$O")" = "$OUT14G/102-recording.mov" ]; then ok
else bad J14g-keep-cache "rc=$rc row=$(grep '^102' "$O") content=$(tr '\n' ' ' < "$CONTENT")"; fi
rm -f "$OUT14G/102-recording.mov"
CONTENT="$TMP/content14g2"; : > "$CONTENT"
rc=0; CONTENT_LOG="$CONTENT" \
  ja "$D14g" ELC-1309 --out "$OUT14G" --cloud-id "$CLOUD" --ids 102 --keep-video >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = saved ] && [ "$(cat "$CONTENT")" = 102 ] \
   && [ -s "$OUT14G/102-recording.mov" ]; then ok
else bad J14g2-keep-refetch "a kept video that went missing was not re-fetched: rc=$rc row=$(grep '^102' "$O")"; fi

# under --keep-video a failed cut still hands the developer the file they asked for
D14h="$(new_repo fourteen-keep-fail '.claude/')"; OUT14H="$D14h/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; FFMPEG_FAIL=1 \
  ja "$D14h" ELC-1309 --out "$OUT14H" --cloud-id "$CLOUD" --ids 102 --keep-video >"$O" 2>"$E" || rc=$?
assert J14h-keep-failed-cut 0 "$rc" "$E" "note=frames_failed id=102"
if [ "$(field 102 2 "$O")" = saved ] && [ "$(field 102 8 "$O")" = "$OUT14H/102-recording.mov" ] \
   && [ -z "$(field 102 9 "$O")" ] && [ ! -d "$OUT14H/102-recording.mov.frames" ]; then ok
else bad J14h-row "$(grep '^102' "$O")"; fi

# --keep-video with no ffmpeg: the file is what was asked for, so it comes down — unframed, and
# the stderr says so in its own note (the videos=<N> line is for the ones that were NOT fetched)
D14k="$(new_repo fourteen-keep-noff '.claude/')"; OUT14K="$D14k/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; JA_PATH_OVERRIDE="$SHIM_NOFF:$BIN" \
  ja "$D14k" ELC-1309 --out "$OUT14K" --cloud-id "$CLOUD" --ids 102 --keep-video >"$O" 2>"$E" || rc=$?
assert J14k-keep-noff 0 "$rc" "$E" "note=ffmpeg_not_found_unframed videos=1"
if [ "$(field 102 2 "$O")" = saved ] && [ -s "$OUT14K/102-recording.mov" ] \
   && [ -z "$(field 102 9 "$O")" ] && ! grep -qE '^note=ffmpeg_not_found videos=' "$E"; then ok
else bad J14k-row "rc=$rc row=$(grep '^102' "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# ------------------------------------------------------- 14l. the adaptive count and its table --
# ≤32 s → 8 · one frame per 4 s above that · ≥96 s → 24
n_frames_for() { # n_frames_for <repo-name> <duration> → the frames count of the row
  local d="$2" dir out
  dir="$(new_repo "$1" '.claude/')"; out="$dir/.claude/tasks/ELC-1309/tmp/attachments"
  FAKE_DURATION="$d" FFMPEG_LOG="${FFMPEG_LOG:-/dev/null}" \
    ja "$dir" ELC-1309 --out "$out" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || true
  field 102 9 "$O" | sed 's/.*://'
}
for pair in "10:8" "32:8" "36:9" "50:13" "96:24" "200:24"; do
  d="${pair%%:*}"; want="${pair#*:}"
  got="$(n_frames_for "adaptive-$d" "$d")"
  if [ "$got" = "$want" ]; then ok; else bad "J14l-adaptive-${d}s" "duration ${d}s → $got frames, want $want"; fi
done

D14m="$(new_repo fourteen-long '.claude/')"; OUT14M="$D14m/.claude/tasks/ELC-1309/tmp/attachments"
FFLOG="$TMP/ff14m"; : > "$FFLOG"
rc=0; FAKE_DURATION=200 FFMPEG_LOG="$FFLOG" \
  ja "$D14m" ELC-1309 --out "$OUT14M" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
# 24 bins over 200 s: centres at 4.167 … 195.833, and the timecode crosses the minute mark
if [ "$(ffmpeg_ss "$FFLOG" | head -1)" = 4.167 ] && [ "$(ffmpeg_ss "$FFLOG" | tail -1)" = 195.833 ] \
   && [ -f "$OUT14M/102-recording.mov.frames/24-03m15s.png" ] \
   && [ -f "$OUT14M/102-recording.mov.frames/01-00m04s.png" ]; then ok
else bad J14m-long-instants "first=$(ffmpeg_ss "$FFLOG" | head -1) last=$(ffmpeg_ss "$FFLOG" | tail -1) names=$(frame_names "$OUT14M/102-recording.mov.frames" | tr '\n' ' ')"; fi

# a count that comes out short (here: the seek runs past the end of the recording) is REPORTED,
# never silently swallowed — the symptom of a duration longer than the video
D14n="$(new_repo fourteen-short '.claude/')"; OUT14N="$D14n/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; FAKE_DURATION=200 FFMPEG_EOF_AT=20 \
  ja "$D14n" ELC-1309 --out "$OUT14N" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
assert J14n-frames-short 0 "$rc" "$E" "note=frames_short id=102 want=24 got=2"
if [ "$(field 102 2 "$O")" = saved ] && [ "$(field 102 9 "$O")" = "$OUT14N/102-recording.mov.frames:2" ]; then ok
else bad J14n-row "$(grep '^102' "$O")"; fi

# ------------------------------------------------------------- 14o. --max-mb vs --max-video-mb --
# video bytes are transient, so they get their own, far larger cap: 30 MB of video is fetched where
# 30 MB of PNG is not, and neither flag lifts the other's ceiling
D14o="$(new_repo fourteen-caps '.claude/')"; OUT14O="$D14o/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; FAKE_LIST="$FIX/videos.json" FAKE_SIZES="$VID_SIZES" \
  ja "$D14o" ELC-1309 --out "$OUT14O" --cloud-id "$CLOUD" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 301 2 "$O")" = saved ] && [ "$(field 302 2 "$O")" = skipped_size ] \
   && [ "$(field 303 2 "$O")" = skipped_size ]; then ok
else bad J14o-default-caps "rc=$rc $(awk 'NR>1{printf "%s=%s ", $1, $2}' "$O")"; fi
D14o2="$(new_repo fourteen-caps-small '.claude/')"; OUT14O2="$D14o2/.claude/tasks/ELC-1309/tmp/attachments"
CONTENT="$TMP/content14o"; : > "$CONTENT"
rc=0; FAKE_LIST="$FIX/videos.json" FAKE_SIZES="$VID_SIZES" CONTENT_LOG="$CONTENT" \
  ja "$D14o2" ELC-1309 --out "$OUT14O2" --cloud-id "$CLOUD" --max-video-mb 10 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 301 2 "$O")" = skipped_size ] && [ ! -s "$CONTENT" ]; then ok
else bad J14o2-video-cap-down "rc=$rc row=$(grep '^301' "$O") content=$(tr '\n' ' ' < "$CONTENT")"; fi
D14o3="$(new_repo fourteen-caps-wide '.claude/')"; OUT14O3="$D14o3/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; FAKE_LIST="$FIX/videos.json" FAKE_SIZES="$VID_SIZES" \
  ja "$D14o3" ELC-1309 --out "$OUT14O3" --cloud-id "$CLOUD" --max-video-mb 400 --max-mb 40 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 302 2 "$O")" = saved ] && [ "$(field 303 2 "$O")" = saved ] \
   && [ "$(field 302 9 "$O")" = "$OUT14O3/302-long_recording.mp4.frames:8" ]; then ok
else bad J14o3-caps-raised "rc=$rc $(awk 'NR>1{printf "%s=%s ", $1, $2}' "$O")"; fi
# the image cap alone leaves the video cap where it was
D14o4="$(new_repo fourteen-caps-image '.claude/')"; OUT14O4="$D14o4/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; FAKE_LIST="$FIX/videos.json" FAKE_SIZES="$VID_SIZES" \
  ja "$D14o4" ELC-1309 --out "$OUT14O4" --cloud-id "$CLOUD" --max-mb 400 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 303 2 "$O")" = saved ] && [ "$(field 302 2 "$O")" = skipped_size ]; then ok
else bad J14o4-image-cap "rc=$rc $(awk 'NR>1{printf "%s=%s ", $1, $2}' "$O")"; fi
rc=0; ja "$D14o4" ELC-1309 --out "$OUT14O4" --cloud-id "$CLOUD" --max-video-mb x >"$O" 2>"$E" || rc=$?
assert J14o5-bad-video-cap 2 "$rc" "$E" "error=invalid_max_video_mb value=x"

# ------------------------------------ 14p. a failed download never takes a CURRENT frames dir --
# A transient video's bytes are deleted on purpose, so the frames dir IS the recording as far as
# this machine is concerned. Only a dir this run judged stale may go with a failed download —
# `--force` and a missing kept video walk past a cut that is still perfectly current.
D14p="$(new_repo fourteen-refetch-fail '.claude/')"; OUT14P="$D14p/.claude/tasks/ELC-1309/tmp/attachments"
FD14P="$OUT14P/102-recording.mov.frames"
rc=0; ja "$D14p" ELC-1309 --out "$OUT14P" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
assert J14p-seed 0 "$rc" "$E" "frames=8"
rc=0; FAKE_FAIL_IDS=102 \
  ja "$D14p" ELC-1309 --out "$OUT14P" --cloud-id "$CLOUD" --ids 102 --force >"$O" 2>"$E" || rc=$?
assert J14p-force-download-failed 1 "$rc" "$E" "note=download_failed id=102 http=404"
if [ "$(field 102 2 "$O")" = failed ] && [ -d "$FD14P" ] \
   && [ "$(frame_names "$FD14P" | wc -l | tr -d ' ')" = 8 ] && grep -qx 'size=5678' "$FD14P/done" \
   && [ ! -e "$OUT14P/102-recording.mov.part" ]; then ok
else bad J14p-frames-survive "a failed --force re-download destroyed a current cut: $(ls "$OUT14P" 2>&1 | tr '\n' ' ')"; fi
# …and the very next plain run hands those frames straight back: no request, no cut
CONTENT="$TMP/content14p"; FFLOG="$TMP/ff14p"; : > "$CONTENT"; : > "$FFLOG"
rc=0; CONTENT_LOG="$CONTENT" FFMPEG_LOG="$FFLOG" \
  ja "$D14p" ELC-1309 --out "$OUT14P" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = cached ] && [ "$(field 102 9 "$O")" = "$FD14P:8" ] \
   && [ ! -s "$CONTENT" ] && [ ! -s "$FFLOG" ]; then ok
else bad J14p-recovers "rc=$rc row=$(grep '^102' "$O") content=$(tr '\n' ' ' < "$CONTENT")"; fi

# the same, with no --force at all: --keep-video re-fetches a kept video that went missing, and
# that re-fetch failing must not cost the developer the frames they already have
D14p2="$(new_repo fourteen-keep-refetch-fail '.claude/')"; OUT14P2="$D14p2/.claude/tasks/ELC-1309/tmp/attachments"
FD14P2="$OUT14P2/102-recording.mov.frames"
rc=0; ja "$D14p2" ELC-1309 --out "$OUT14P2" --cloud-id "$CLOUD" --ids 102 --keep-video >"$O" 2>"$E" || rc=$?
assert J14p2-seed 0 "$rc" "$E" "frames=8"
rm -f "$OUT14P2/102-recording.mov"
rc=0; FAKE_FAIL_IDS=102 \
  ja "$D14p2" ELC-1309 --out "$OUT14P2" --cloud-id "$CLOUD" --ids 102 --keep-video >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 1 ] && [ "$(field 102 2 "$O")" = failed ] && [ -d "$FD14P2" ] \
   && [ "$(frame_names "$FD14P2" | wc -l | tr -d ' ')" = 8 ]; then ok
else bad J14p2-frames-survive "rc=$rc row=$(grep '^102' "$O") files=$(ls "$OUT14P2" 2>&1 | tr '\n' ' ')"; fi

# the other half of the rule: a dir this run DID judge stale still goes, so a failed run can never
# leave frames behind that belong to a video the row denies
D14p3="$(new_repo fourteen-stale-refetch-fail '.claude/')"; OUT14P3="$D14p3/.claude/tasks/ELC-1309/tmp/attachments"
FD14P3="$OUT14P3/102-recording.mov.frames"
rc=0; ja "$D14p3" ELC-1309 --out "$OUT14P3" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
printf 'size=9999\n' > "$FD14P3/done"
rc=0; FAKE_FAIL_IDS=102 \
  ja "$D14p3" ELC-1309 --out "$OUT14P3" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 1 ] && [ "$(field 102 2 "$O")" = failed ] && [ ! -d "$FD14P3" ]; then ok
else bad J14p3-stale-dir-goes "rc=$rc row=$(grep '^102' "$O") files=$(ls "$OUT14P3" 2>&1 | tr '\n' ' ')"; fi

# ------------------------------------------ 14q. an interrupted run's `.part` is reaped, once --
# A run killed mid-download leaves `<target>.part` next to a still-valid frames dir; every later
# run is the same cache hit, so if the cache-hit branch does not reap it, nothing ever will —
# up to --max-video-mb of dead bytes contradicting "a transient video leaves only its frames dir"
D14q="$(new_repo fourteen-part-cache '.claude/')"; OUT14Q="$D14q/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; ja "$D14q" ELC-1309 --out "$OUT14Q" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
head -c 2000 /dev/zero | tr '\0' 'x' > "$OUT14Q/102-recording.mov.part"
CONTENT="$TMP/content14q"; : > "$CONTENT"
rc=0; CONTENT_LOG="$CONTENT" \
  ja "$D14q" ELC-1309 --out "$OUT14Q" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = cached ] && [ ! -s "$CONTENT" ] \
   && [ ! -e "$OUT14Q/102-recording.mov.part" ] && [ ! -e "$OUT14Q/102-recording.mov" ]; then ok
else bad J14q-part-reaped "a cache hit left the partial download behind: $(ls "$OUT14Q" 2>&1 | tr '\n' ' ')"; fi
# same on the --keep-video side: the kept video stays, the dead `.part` does not
D14q2="$(new_repo fourteen-part-cache-keep '.claude/')"; OUT14Q2="$D14q2/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; ja "$D14q2" ELC-1309 --out "$OUT14Q2" --cloud-id "$CLOUD" --ids 102 --keep-video >"$O" 2>"$E" || rc=$?
head -c 2000 /dev/zero | tr '\0' 'x' > "$OUT14Q2/102-recording.mov.part"
rc=0; ja "$D14q2" ELC-1309 --out "$OUT14Q2" --cloud-id "$CLOUD" --ids 102 --keep-video >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = cached ] \
   && [ ! -e "$OUT14Q2/102-recording.mov.part" ] && [ -s "$OUT14Q2/102-recording.mov" ]; then ok
else bad J14q2-part-reaped-keep "$(ls "$OUT14Q2" 2>&1 | tr '\n' ' ')"; fi

# ---------------------------------------------- 14r. a comma-decimal locale must not break it --
# `printf "%.3f"` honours LC_NUMERIC, and ffmpeg refuses `-ss 0,781` ("Invalid duration for option
# ss") — unpinned, EVERY frame of EVERY recording fails on a German/French/Spanish machine and the
# transient video is deleted with nothing to show for it. (Where the locale is not installed the
# assertion is simply the C behaviour again — it can only ever fail on a real comma locale.)
D14r="$(new_repo fourteen-locale '.claude/')"; OUT14R="$D14r/.claude/tasks/ELC-1309/tmp/attachments"
FFLOG="$TMP/ff14r"; : > "$FFLOG"
rc=0; ( unset LC_ALL; export LC_NUMERIC=de_DE.UTF-8 LANG=de_DE.UTF-8
        FFMPEG_LOG="$FFLOG" ja "$D14r" ELC-1309 --out "$OUT14R" --cloud-id "$CLOUD" --ids 102 ) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(ffmpeg_ss "$FFLOG" | tr '\n' ' ')" = "0.781 2.344 3.906 5.469 7.031 8.594 10.156 11.719 " ] \
   && [ "$(field 102 9 "$O")" = "$OUT14R/102-recording.mov.frames:8" ]; then ok
else bad J14r-locale-instants "rc=$rc instants=$(ffmpeg_ss "$FFLOG" | tr '\n' ' ') row=$(grep '^102' "$O")"; fi
# the ffprobe-less duration parse runs through awk too: a comma there voids the whole reading and
# silently falls back to the 60 s assumption
D14r2="$(new_repo fourteen-locale-noprobe '.claude/')"; OUT14R2="$D14r2/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; ( unset LC_ALL; export LC_NUMERIC=de_DE.UTF-8 LANG=de_DE.UTF-8
        JA_PATH_OVERRIDE="$SHIM_NOPROBE:$BIN" FAKE_FFMPEG_DURATION=00:00:50.00 \
          ja "$D14r2" ELC-1309 --out "$OUT14R2" --cloud-id "$CLOUD" --ids 102 ) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 9 "$O")" = "$OUT14R2/102-recording.mov.frames:13" ] \
   && ! grep -qF 'duration_unknown' "$E"; then ok
else bad J14r2-locale-duration "rc=$rc row=$(field 102 9 "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# ----------------------------------- 14s. the duration an attachment's own metadata cannot forge --
# ffmpeg prints the container's Metadata block ABOVE its Duration line, and anyone with ticket
# access can attach a file whose `title` tag reads `Duration: 99:00:00.00`. An unanchored match
# takes the tag: 24 instants past the end of the recording → zero frames → the video deleted.
D14s="$(new_repo fourteen-forged-duration '.claude/')"; OUT14S="$D14s/.claude/tasks/ELC-1309/tmp/attachments"
FFLOG="$TMP/ff14s"; : > "$FFLOG"
rc=0; JA_PATH_OVERRIDE="$SHIM_NOPROBE:$BIN" FFMPEG_LOG="$FFLOG" \
  FAKE_FFMPEG_DURATION=00:00:50.00 FAKE_FFMPEG_META='Duration: 99:00:00.00, start' \
  ja "$D14s" ELC-1309 --out "$OUT14S" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 9 "$O")" = "$OUT14S/102-recording.mov.frames:13" ] \
   && [ "$(ffmpeg_ss "$FFLOG" | tail -1)" = 48.077 ] && ! grep -qF 'duration_unknown' "$E"; then ok
else bad J14s-forged-duration "the metadata tag beat the container's own line: row=$(field 102 9 "$O") last=$(ffmpeg_ss "$FFLOG" | tail -1)"; fi
# the quiet direction of the same lever: a forged SHORT duration would cram every frame into the
# first hundredth of a second and never trip frames_short
D14s2="$(new_repo fourteen-forged-short '.claude/')"; OUT14S2="$D14s2/.claude/tasks/ELC-1309/tmp/attachments"
FFLOG="$TMP/ff14s2"; : > "$FFLOG"
rc=0; JA_PATH_OVERRIDE="$SHIM_NOPROBE:$BIN" FFMPEG_LOG="$FFLOG" \
  FAKE_FFMPEG_DURATION=00:00:50.00 FAKE_FFMPEG_META='Duration: 00:00:00.01, start' \
  ja "$D14s2" ELC-1309 --out "$OUT14S2" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(ffmpeg_ss "$FFLOG" | head -1)" = 1.923 ]; then ok
else bad J14s2-forged-short "first instant came from the tag: $(ffmpeg_ss "$FFLOG" | head -1)"; fi
# a duration no screen recording has (here 99 h, container line and all) is a misread, not a plan
# for 24 seeks past the end of the file: it degrades to the stated 60 s assumption
D14s3="$(new_repo fourteen-absurd-duration '.claude/')"; OUT14S3="$D14s3/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; JA_PATH_OVERRIDE="$SHIM_NOPROBE:$BIN" FAKE_FFMPEG_DURATION=99:00:00.00 \
  ja "$D14s3" ELC-1309 --out "$OUT14S3" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
assert J14s3-absurd-duration 0 "$rc" "$E" "note=duration_unknown id=102 assumed=60s"
if [ "$(field 102 9 "$O")" = "$OUT14S3/102-recording.mov.frames:15" ]; then ok
else bad J14s3-absurd-count "$(field 102 9 "$O")"; fi
# ffprobe is unforgeable (it reads the container, not the tags) but the same clamp covers it
D14s4="$(new_repo fourteen-absurd-probe '.claude/')"; OUT14S4="$D14s4/.claude/tasks/ELC-1309/tmp/attachments"
rc=0; FAKE_DURATION=999999 \
  ja "$D14s4" ELC-1309 --out "$OUT14S4" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
assert J14s4-absurd-probe 0 "$rc" "$E" "note=duration_unknown id=102 assumed=60s"

# ------------------------------------- 14t. the cut must not eat its own frame plan off stdin --
# The cut loop is fed by `<<< "$plan"`, so every ffmpeg inherits that here-string as its stdin —
# and ffmpeg without -nostdin reads stdin for keyboard commands, swallowing the rest of the plan:
# the next `read` hits EOF and a whole recording comes out ONE frame long. The shim models that
# drain, so dropping -nostdin (and the `</dev/null` behind it) fails this case with frames:1.
D14t="$(new_repo fourteen-cut-stdin '.claude/')"; OUT14T="$D14t/.claude/tasks/ELC-1309/tmp/attachments"
FFLOG="$TMP/ff14t"; : > "$FFLOG"
rc=0; FFMPEG_LOG="$FFLOG" \
  ja "$D14t" ELC-1309 --out "$OUT14T" --cloud-id "$CLOUD" --ids 102 >"$O" 2>"$E" || rc=$?
# the flag, not the path: every argv line carries the out dir, so the match is anchored on a space
n_cut="$(grep -c -- '-frames:v 1' "$FFLOG" || true)"
n_nostdin="$(grep -cE -- '(^| )-nostdin ' "$FFLOG" || true)"
if [ "$rc" -eq 0 ] && [ "$(field 102 9 "$O")" = "$OUT14T/102-recording.mov.frames:8" ] \
   && [ "$n_cut" = 8 ] && [ "$n_nostdin" = 8 ]; then ok
else bad J14t-nostdin "rc=$rc row=$(field 102 9 "$O") cuts=$n_cut nostdin=$n_nostdin"; fi

# --------------------------- 14u. a video already on disk is re-cut, never re-downloaded --
# Under --keep-video the bytes stay, and bytes at the metadata size ARE the bytes a request would
# bring back: a stale (here: deleted) frames dir is a reason to re-CUT, never to re-fetch.
D14u="$(new_repo fourteen-keep-recut '.claude/')"; OUT14U="$D14u/.claude/tasks/ELC-1309/tmp/attachments"
FD14U="$OUT14U/102-recording.mov.frames"
rc=0; ja "$D14u" ELC-1309 --out "$OUT14U" --cloud-id "$CLOUD" --ids 102 --keep-video >"$O" 2>"$E" || rc=$?
assert J14u-seed 0 "$rc" "$E" "frames=8"
rm -rf "$FD14U"
CONTENT="$TMP/content14u"; FFLOG="$TMP/ff14u"; : > "$CONTENT"; : > "$FFLOG"
rc=0; CONTENT_LOG="$CONTENT" FFMPEG_LOG="$FFLOG" \
  ja "$D14u" ELC-1309 --out "$OUT14U" --cloud-id "$CLOUD" --ids 102 --keep-video >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = cached ] && [ ! -s "$CONTENT" ] \
   && [ "$(grep -c -- '-frames:v 1' "$FFLOG")" = 8 ] \
   && [ "$(field 102 8 "$O")" = "$OUT14U/102-recording.mov" ] \
   && [ "$(field 102 9 "$O")" = "$FD14U:8" ] && grep -qx 'size=5678' "$FD14U/done"; then ok
else bad J14u-recut-no-request "rc=$rc row=$(grep '^102' "$O") content=$(tr '\n' ' ' < "$CONTENT") cuts=$(grep -c -- '-frames:v 1' "$FFLOG")"; fi

# --no-frames on the same file wants no cut either: neither a request nor an ffmpeg, just `cached`
D14u2="$(new_repo fourteen-noframes-cached '.claude/')"; OUT14U2="$D14u2/.claude/tasks/ELC-1309/tmp/attachments"
mkdir -p "$OUT14U2"; head -c 5678 /dev/zero | tr '\0' 'x' > "$OUT14U2/102-recording.mov"
CONTENT="$TMP/content14u2"; FFLOG="$TMP/ff14u2"; : > "$CONTENT"; : > "$FFLOG"
rc=0; CONTENT_LOG="$CONTENT" FFMPEG_LOG="$FFLOG" \
  ja "$D14u2" ELC-1309 --out "$OUT14U2" --cloud-id "$CLOUD" --ids 102 --no-frames >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 102 2 "$O")" = cached ] && [ ! -s "$CONTENT" ] && [ ! -s "$FFLOG" ] \
   && [ "$(field 102 8 "$O")" = "$OUT14U2/102-recording.mov" ] && [ -z "$(field 102 9 "$O")" ] \
   && [ ! -d "$OUT14U2/102-recording.mov.frames" ]; then ok
else bad J14u2-noframes-cached "rc=$rc row=$(grep '^102' "$O") content=$(tr '\n' ' ' < "$CONTENT") ffmpeg=$(wc -l < "$FFLOG" | tr -d ' ')"; fi

echo "jira-attachments-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
