#!/usr/bin/env bash
# Simulation harness for scripts/external-screenshots.sh. No network: `curl`, `ffmpeg`, `sips` and
# `sleep` are PATH shims, and the PATH itself is a dir of symlinks to exactly the tools the script
# uses — the only way to make `command -v sips` fail on a Mac. Exit 0 = all green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ES="$ROOT/plugins/fnd/scripts/external-screenshots.sh"
BASH_BIN="$(command -v bash)"

TMP="$(mktemp -d)"; TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }
assert() { # assert <label> <want-rc> <got-rc> <stderr-file> [required-stderr-substring]
  local label="$1" want="$2" got="$3" errf="$4" substr="${5-}"
  if [ "$got" -ne "$want" ]; then
    bad "$label" "exit $got, want $want :: $(head -c 200 "$errf" | tr '\n' ' ')"; return
  fi
  if [ -n "$substr" ] && ! grep -qF -- "$substr" "$errf"; then
    bad "$label" "stderr missing '$substr' :: $(head -c 200 "$errf" | tr '\n' ' ')"; return
  fi
  ok
}

# --------------------------------------------------------------------------- the shims --
BIN="$TMP/bin"; mkdir -p "$BIN"
for b in bash sh jq git awk sed tr grep head tail wc sort cat cp mv rm mkdir rmdir touch chmod \
         mktemp dirname basename ls env printf date cut; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$BIN/$b"
done

SHIM_FULL="$TMP/shim-full"; SHIM_SIPS="$TMP/shim-sips"; SHIM_NONE="$TMP/shim-none"
mkdir -p "$SHIM_FULL" "$SHIM_SIPS" "$SHIM_NONE"

cat > "$SHIM_NONE/curl" <<'FAKE'
#!/usr/bin/env bash
# Answers by URL. A page URL (anything not under an image host) is served from
# $FAKE_PAGES/<last path segment>.html when that file exists, else 404; FAKE_PAGE_HTTP overrides the
# code for every page. An image URL gets FAKE_IMG_SIZE bytes with FAKE_IMG_TYPE and FAKE_IMG_HTTP.
# `-w` is answered as the script formats it: "<code> <content type>". CURL_ARGV records the argv.
[ -n "${CURL_ARGV:-}" ] && printf '%s\n' "$*" >> "$CURL_ARGV"
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w|-A|--max-filesize|--connect-timeout|--max-time|--proto|--proto-redir) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
host="${url#https://}"; host="${host%%/*}"
case "$host" in
  *lightshot.app|*prntscr.com|*imgur.com|*gyazo.com|*cleanshot.cloud|*cleanshot.com|*snipboard.io|*evil.example)
    case "$url" in
      */page/*) ;;   # a page on an image host (imgur.com/<id>) falls through to the page branch
      *)
        code="${FAKE_IMG_HTTP:-200}"
        head -c "${FAKE_IMG_SIZE:-1000}" /dev/zero | tr '\0' 'x' > "${out:-/dev/null}"
        printf '%s %s' "$code" "${FAKE_IMG_TYPE:-image/png}"
        exit 0 ;;
    esac ;;
esac
seg="${url##*/}"; seg="${seg%%\?*}"
code="${FAKE_PAGE_HTTP:-}"
if [ -f "${FAKE_PAGES:-/nonexistent}/$seg.html" ]; then
  cat "$FAKE_PAGES/$seg.html" > "${out:-/dev/null}"; [ -n "$code" ] || code=200
elif [ -n "${FAKE_PAGE_ANY:-}" ]; then
  # every page answers with this one fixture — for the cases about what a URL is NAMED, not served
  cat "$FAKE_PAGE_ANY" > "${out:-/dev/null}"; [ -n "$code" ] || code=200
else
  : > "${out:-/dev/null}"; [ -n "$code" ] || code=404
fi
printf '%s %s' "$code" "text/html; charset=utf-8"
FAKE

cat > "$SHIM_NONE/sleep" <<'FAKE'
#!/usr/bin/env bash
[ -n "${SLEEP_LOG:-}" ] && printf '%s\n' "$*" >> "$SLEEP_LOG"
exit 0
FAKE

cat > "$SHIM_FULL/ffmpeg" <<'FAKE'
#!/usr/bin/env bash
# the resample: `-i <in> -vf <filter> … <out>` — copies the input to the output path
[ -n "${FFMPEG_LOG:-}" ] && printf '%s\n' "$*" >> "$FFMPEG_LOG"
in=""; prev=""; out=""
for a in "$@"; do case "$prev" in -i) in="$a" ;; esac; out="$a"; prev="$a"; done
[ -n "${FFMPEG_FAIL:-}" ] && exit 1
cp "$in" "$out"
FAKE

cat > "$SHIM_SIPS/sips" <<'FAKE'
#!/usr/bin/env bash
[ -n "${SIPS_LOG:-}" ] && printf '%s\n' "$*" >> "$SIPS_LOG"
exit 0
FAKE

chmod +x "$SHIM_NONE"/* "$SHIM_FULL"/* "$SHIM_SIPS"/*
cp "$SHIM_NONE/curl" "$SHIM_NONE/sleep" "$SHIM_FULL/"
cp "$SHIM_NONE/curl" "$SHIM_NONE/sleep" "$SHIM_SIPS/"

# ------------------------------------------------------------------------ fixtures + runner --
PAGES="$TMP/pages"; mkdir -p "$PAGES"
cat > "$PAGES/XlDYChfQ0Wyw.html" <<'HTML'
<html><head><meta charset="utf-8"><title>Screenshot</title>
<meta property="og:image" content="https://img.lightshot.app/n43ljrh9QS6-FmUaf29l4w.png"/>
</head><body></body></html>
HTML
# content before property, single quotes, an entity in the query — the other shapes hosts use
cat > "$PAGES/quoted.html" <<'HTML'
<meta content='https://i.imgur.com/abc123.png?a=1&amp;b=2' property='og:image'>
HTML
cat > "$PAGES/foreign.html" <<'HTML'
<meta property="og:image" content="https://cdn.evil.example/steal.png"/>
HTML
cat > "$PAGES/unknown.html" <<'HTML'
<meta property="og:image" content="//st.prntscr.com/2025/12/17/0541/img/0_173a7b_211be8ff.png"/>
HTML
cat > "$PAGES/challenge.html" <<'HTML'
<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>
HTML
cat > "$PAGES/http.html" <<'HTML'
<meta property="og:image" content="http://img.lightshot.app/plain.png"/>
HTML

ES_PATH="$SHIM_FULL:$BIN"
es() { # es <cwd> <args…>
  local cwd="$1"; shift
  ( cd "$cwd" && PATH="${ES_PATH_OVERRIDE:-$ES_PATH}" \
      CURL_ARGV="${CURL_ARGV:-/dev/null}" SLEEP_LOG="${SLEEP_LOG:-/dev/null}" \
      FFMPEG_LOG="${FFMPEG_LOG:-/dev/null}" SIPS_LOG="${SIPS_LOG:-/dev/null}" FFMPEG_FAIL="${FFMPEG_FAIL:-}" \
      FAKE_PAGES="${FAKE_PAGES:-$PAGES}" FAKE_PAGE_HTTP="${FAKE_PAGE_HTTP:-}" FAKE_PAGE_ANY="${FAKE_PAGE_ANY:-}" \
      FAKE_IMG_HTTP="${FAKE_IMG_HTTP:-200}" FAKE_IMG_TYPE="${FAKE_IMG_TYPE:-image/png}" \
      FAKE_IMG_SIZE="${FAKE_IMG_SIZE:-1000}" TMPDIR="$TMP/estmp" \
      "$BASH_BIN" "$ES" "$@" )
}
mkdir -p "$TMP/estmp"

new_repo() { # new_repo <name> [gitignore-line]
  local d="$TMP/repos/$1"
  mkdir -p "$d"; git -C "$d" init -q 2>/dev/null
  [ -n "${2-}" ] && printf '%s\n' "$2" > "$d/.gitignore"
  printf '%s' "$d"
}
field() { awk -F'\t' -v url="$1" -v c="$2" '$1 == url { print $c }' "$3"; } # field <url> <col> <tsv>
requests() { grep -c . "$1" 2>/dev/null || true; }

O="$TMP/out"; E="$TMP/err"
REPO="$(new_repo main '.claude/')"
OUT="$REPO/.claude/tasks/ELC-1498/tmp/attachments"
P1="https://prnt.sc/XlDYChfQ0Wyw"

# ------------------------------------------------------------------ 1. usage, --hosts, gates --
rc=0; es "$REPO" --help >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qF 'external-screenshots.sh --out <dir>' "$O"; then ok
else bad S1-help "rc=$rc out=$(head -c 120 "$O")"; fi
# the header's `# Usage:` block and the USAGE the script prints are the same text
norm_usage() { sed -e 's/^# *//' -e 's/^ *//' "$1" | grep -E '^external-screenshots\.sh ' | sed 's/  */ /g; s/[[:space:]]*$//'; }
awk '/^# Usage:$/ { f = 1; next } f && /^#$/ { exit } f { print }' "$ES" > "$TMP/hdr"
grep -E '^  external-screenshots\.sh ' "$O" > "$TMP/printed"
if [ "$(norm_usage "$TMP/hdr" | grep -c .)" -eq 2 ] && norm_usage "$TMP/hdr" | diff -q - <(norm_usage "$TMP/printed") >/dev/null; then ok
else bad S1b-usage-pinned "header vs printed: $(norm_usage "$TMP/hdr" | diff - <(norm_usage "$TMP/printed") | head -c 300 | tr '\n' ';')"; fi
JAR="$ROOT/plugins/fnd/references/jira-attachments.md"
awk '/^## Linked screenshots/ { f = 1 } f && /^```bash$/ { b = 1; next } b && /^```$/ { exit } b { print }' "$JAR" \
  | sed 's|<plugin root>/scripts/||' > "$TMP/refusage"
if [ "$(norm_usage "$TMP/refusage" | grep -c .)" -eq 2 ] && norm_usage "$TMP/refusage" | diff -q - <(norm_usage "$TMP/hdr") >/dev/null; then ok
else bad S1c-reference-usage "references/jira-attachments.md's fence differs from the header: $(norm_usage "$TMP/refusage" | diff - <(norm_usage "$TMP/hdr") | head -c 300 | tr '\n' ';')"; fi

rc=0; ARGV="$TMP/argv-hosts"; : > "$ARGV"
CURL_ARGV="$ARGV" es "$REPO" --hosts >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qx 'prnt.sc' "$O" && grep -qx 'img.lightshot.app' "$O" && [ ! -s "$ARGV" ]; then ok
else bad S1d-hosts "rc=$rc out=$(tr '\n' ' ' < "$O")"; fi
# the agent, the reference and the README name every host the script fetches from — one list
for f in "$ROOT/plugins/fnd/agents/jira-reader.md" "$JAR" "$ROOT/README.md"; do
  missing=""
  while read -r h; do grep -qF -- "$h" "$f" || missing="$missing $h"; done < "$O"
  if [ -z "$missing" ]; then ok; else bad "S1e-hosts-${f##*/}" "does not name:$missing"; fi
done

rc=0; es "$REPO" "$P1" >"$O" 2>"$E" || rc=$?;                 assert S1f-missing-out 2 "$rc" "$E" "error=missing_out"
rc=0; es "$REPO" --out "$OUT" >"$O" 2>"$E" || rc=$?;          assert S1g-missing-url 2 "$rc" "$E" "error=missing_url"
rc=0; es "$REPO" --out "$OUT" --bogus "$P1" >"$O" 2>"$E" || rc=$?; assert S1h-unknown-arg 2 "$rc" "$E" "error=unknown_arg"
rc=0; es "$REPO" --out "$OUT" --delay x "$P1" >"$O" 2>"$E" || rc=$?; assert S1i-invalid-delay 2 "$rc" "$E" "error=invalid_delay"
rc=0; es "$REPO" --out "$OUT" --max-width >"$O" 2>"$E" || rc=$?;  assert S1j-missing-value 2 "$rc" "$E" "error=missing_value"

# ------------------------------------------------------------- 2. the out dir must be ignored --
TRACKED="$(new_repo tracked)"
rc=0; ARGV="$TMP/argv2"; : > "$ARGV"
CURL_ARGV="$ARGV" es "$TRACKED" --out "$TRACKED/shots" "$P1" >"$O" 2>"$E" || rc=$?
assert S2-out-not-ignored 2 "$rc" "$E" "error=out_dir_not_ignored"
if [ ! -s "$ARGV" ]; then ok; else bad S2-no-request "a refused out dir still reached the network"; fi
# under .claude/tasks/ the exclude line is stamped and the run goes on
STAMP="$(new_repo stamp)"
rc=0; es "$STAMP" --out "$STAMP/.claude/tasks/ELC-1/tmp/attachments" "$P1" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qF '.claude/tasks/' "$STAMP/.git/info/exclude"; then ok
else bad S2b-stamp "rc=$rc exclude=$(cat "$STAMP/.git/info/exclude" 2>/dev/null | tr '\n' ' ')"; fi

# ------------------------------------------------- 3. only https on an allow-listed host is fetched --
rc=0; ARGV="$TMP/argv3"; : > "$ARGV"
CURL_ARGV="$ARGV" es "$REPO" --out "$OUT" \
  "http://prnt.sc/abc" "https://evil.example/x.png" "https://prnt.sc.evil.example/abc" \
  "https://evil.example/https://prnt.sc/abc" "not a url" 'https://prnt.sc/a"b' "ftp://prnt.sc/abc" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ]; then ok; else bad S3-skips-are-not-failures "rc=$rc err=$(head -c 200 "$E")"; fi
n="$(awk -F'\t' 'NR > 1 && $3 == "skipped_host"' "$O" | wc -l | tr -d ' ')"
if [ "$n" -eq 7 ]; then ok; else bad S3-all-skipped "skipped_host rows=$n of 7: $(cut -f1,3 "$O" | tr '\n' ';')"; fi
if [ ! -s "$ARGV" ]; then ok; else bad S3-no-request "a non-allow-listed URL reached curl: $(head -1 "$ARGV")"; fi
if grep -qF 'ok=1 saved=0 cached=0 skipped=7 failed=0' "$E"; then ok; else bad S3c-summary "$(tail -1 "$E")"; fi
# an upper-cased allow-listed host is that host: fetched, and lower-cased in the row
rm -rf "$OUT"; rc=0
es "$REPO" --out "$OUT" "https://PRNT.sc/XlDYChfQ0Wyw" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 'https://PRNT.sc/XlDYChfQ0Wyw' 2 "$O")" = "prnt.sc" ] && [ -s "$OUT/prnt.sc-XlDYChfQ0Wyw.png" ]; then ok
else bad S3b-host-case "rc=$rc row: $(grep -F 'PRNT' "$O")"; fi
# a URL that could forge a row or a line is folded before it is echoed
NL="$(printf 'https://prnt.sc/a\nhttps://prnt.sc/b')"
rc=0; es "$REPO" --out "$OUT" "$NL" >"$O" 2>"$E" || rc=$?
if [ "$(grep -c . "$O")" -eq 2 ] && [ "$(grep -c '^https://' "$O")" -eq 1 ]; then ok
else bad S3d-newline-folded "rows=$(grep -c . "$O") out=$(tr '\n' ';' < "$O")"; fi

# ---------------------------------------------------------- 4. a page resolves to its og:image --
rm -rf "$OUT"; rc=0; ARGV="$TMP/argv4"; : > "$ARGV"; FFL="$TMP/ffmpeg4"; : > "$FFL"
CURL_ARGV="$ARGV" FFMPEG_LOG="$FFL" es "$REPO" --out "$OUT" "$P1" >"$O" 2>"$E" || rc=$?
assert S4-saved 0 "$rc" "$E" "ok=1 saved=1 cached=0 skipped=0 failed=0"
if [ "$(field "$P1" 3 "$O")" = saved ] && [ "$(field "$P1" 4 "$O")" = "https://img.lightshot.app/n43ljrh9QS6-FmUaf29l4w.png" ] \
   && [ "$(field "$P1" 5 "$O")" = image/png ] && [ "$(field "$P1" 8 "$O")" = "prnt.sc-XlDYChfQ0Wyw.png" ] \
   && [ -s "$OUT/prnt.sc-XlDYChfQ0Wyw.png" ] && [ "$(field "$P1" 7 "$O")" = "$OUT/prnt.sc-XlDYChfQ0Wyw.png" ]; then ok
else bad S4-row "$(grep -F "$P1" "$O")"; fi
if [ "$(requests "$ARGV")" -eq 2 ]; then ok; else bad S4-two-requests "requests=$(requests "$ARGV")"; fi
# the page AND the image go out with a browser agent, on TLS only, capped
for want in '-A Mozilla/5.0' '--proto =https' '--proto-redir =https' '--max-filesize'; do
  if [ "$(grep -cF -- "$want" "$ARGV")" -eq 2 ]; then ok; else bad S4-curl-flag "'$want' not on both requests: $(cat "$ARGV" | tr '\n' ';' | head -c 300)"; fi
done
if grep -qF -- '--max-filesize 2097152' "$ARGV" && grep -qF -- '--max-filesize 26214400' "$ARGV"; then ok
else bad S4-caps "page 2 MiB + image 25 MiB caps not both on the argv"; fi
if ! grep -qF -- '--location-trusted' "$ARGV"; then ok; else bad S4-location-trusted "never"; fi
# the resample ran, capped at the default width, in place
if grep -qF "scale='min(1600,iw)':-2" "$FFL" && grep -qF -- "-pix_fmt rgba" "$FFL"; then ok
else bad S4-downscale "ffmpeg argv: $(head -c 200 "$FFL")"; fi
if [ -z "$(ls "$OUT" | grep -v '^prnt.sc-XlDYChfQ0Wyw.png$')" ]; then ok; else bad S4-leftovers "$(ls "$OUT" | tr '\n' ' ')"; fi
# the other og:image shapes: content-first, single quotes, an entity in the query
rc=0; es "$REPO" --out "$OUT" "https://imgur.com/page/quoted" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field 'https://imgur.com/page/quoted' 4 "$O")" = 'https://i.imgur.com/abc123.png?a=1&b=2' ] \
   && [ -s "$OUT/imgur.com-page_quoted.png" ]; then ok
else bad S4b-og-shapes "rc=$rc row=$(grep -F quoted "$O")"; fi

# --------------------------------------------- 5. an og:image may only point at the service's CDN --
rc=0; ARGV="$TMP/argv5"; : > "$ARGV"
CURL_ARGV="$ARGV" es "$REPO" --out "$OUT" "https://prnt.sc/foreign" >"$O" 2>"$E" || rc=$?
assert S5-foreign-host 1 "$rc" "$E" "note=image_host_not_allowed url=https://prnt.sc/foreign host=cdn.evil.example"
if [ "$(requests "$ARGV")" -eq 1 ] && [ "$(field 'https://prnt.sc/foreign' 3 "$O")" = failed ] && [ -z "$(field 'https://prnt.sc/foreign' 4 "$O")" ]; then ok
else bad S5-no-image-request "requests=$(requests "$ARGV") row=$(grep -F foreign "$O")"; fi
# prnt.sc's "unknown id" page: a protocol-relative placeholder, reported with its value
rc=0; ARGV="$TMP/argv5b"; : > "$ARGV"
CURL_ARGV="$ARGV" es "$REPO" --out "$OUT" "https://prnt.sc/unknown" >"$O" 2>"$E" || rc=$?
assert S5b-protocol-relative 1 "$rc" "$E" "note=image_url_not_https url=https://prnt.sc/unknown image=//st.prntscr.com/"
if [ "$(requests "$ARGV")" -eq 1 ]; then ok; else bad S5b-no-image-request "requests=$(requests "$ARGV")"; fi
rc=0; ARGV="$TMP/argv5c"; : > "$ARGV"
CURL_ARGV="$ARGV" es "$REPO" --out "$OUT" "https://prnt.sc/http" >"$O" 2>"$E" || rc=$?
assert S5c-http-image 1 "$rc" "$E" "note=image_url_not_https"
if [ "$(requests "$ARGV")" -eq 1 ]; then ok; else bad S5c-no-image-request "requests=$(requests "$ARGV")"; fi

# ------------------------------------------------ 6. the page or the image does not come back --
rc=0; es "$REPO" --out "$OUT" "https://prnt.sc/challenge" >"$O" 2>"$E" || rc=$?
assert S6-no-og-image 1 "$rc" "$E" "note=no_og_image url=https://prnt.sc/challenge"
rc=0; FAKE_PAGE_HTTP=520 es "$REPO" --out "$OUT" "https://prnt.sc/challenge" >"$O" 2>"$E" || rc=$?
assert S6b-page-520 1 "$rc" "$E" "note=page_fetch_failed url=https://prnt.sc/challenge http=520"
rc=0; es "$REPO" --out "$OUT" "https://prnt.sc/missing" >"$O" 2>"$E" || rc=$?
assert S6c-page-404 1 "$rc" "$E" "http=404"
rm -rf "$OUT"
rc=0; FAKE_IMG_HTTP=403 es "$REPO" --out "$OUT" "$P1" >"$O" 2>"$E" || rc=$?
assert S6d-image-403 1 "$rc" "$E" "note=image_fetch_failed url=$P1 http=403"
if [ -z "$(ls "$OUT" 2>/dev/null)" ]; then ok; else bad S6d-no-part "a failed fetch left: $(ls "$OUT" | tr '\n' ' ')"; fi
# a 200 that is not an image (a challenge page in disguise) is refused by its content type
rc=0; FAKE_IMG_TYPE="text/html; charset=utf-8" es "$REPO" --out "$OUT" "$P1" >"$O" 2>"$E" || rc=$?
assert S6e-not-an-image 1 "$rc" "$E" "note=not_an_image url=$P1 type=text/html"
if [ -z "$(ls "$OUT" 2>/dev/null)" ]; then ok; else bad S6e-no-file "left: $(ls "$OUT" | tr '\n' ' ')"; fi
# over the cap on disk, whatever curl's own --max-filesize did
rc=0; FAKE_IMG_SIZE=2048 es "$REPO" --out "$OUT" --max-mb 0 "$P1" >"$O" 2>"$E" || rc=$?
assert S6f-over-cap 1 "$rc" "$E" "note=over_cap url=$P1 size=2048 max_mb=0"
if [ -z "$(ls "$OUT" 2>/dev/null)" ]; then ok; else bad S6f-no-file "left: $(ls "$OUT" | tr '\n' ' ')"; fi
# one failure never takes the other rows down, and the exit says one failed
rc=0; es "$REPO" --out "$OUT" "https://prnt.sc/challenge" "$P1" "https://evil.example/" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 1 ] && [ "$(field "$P1" 3 "$O")" = saved ] && grep -qF 'ok=1 saved=1 cached=0 skipped=1 failed=1' "$E"; then ok
else bad S6g-mixed "rc=$rc err=$(tail -1 "$E") rows=$(cut -f1,3 "$O" | tr '\n' ';')"; fi

# ----------------------------------------------------- 7. a direct image host is fetched as is --
rm -rf "$OUT"; rc=0; ARGV="$TMP/argv7"; : > "$ARGV"
CURL_ARGV="$ARGV" FAKE_IMG_TYPE="image/jpeg" es "$REPO" --out "$OUT" "https://i.imgur.com/abc123.png" >"$O" 2>"$E" || rc=$?
assert S7-direct 0 "$rc" "$E" "saved=1"
if [ "$(requests "$ARGV")" -eq 1 ] && [ "$(field 'https://i.imgur.com/abc123.png' 4 "$O")" = "https://i.imgur.com/abc123.png" ] \
   && [ "$(field 'https://i.imgur.com/abc123.png' 8 "$O")" = "i.imgur.com-abc123.jpg" ]; then ok
else bad S7-row "requests=$(requests "$ARGV") row=$(grep -F imgur "$O")"; fi

# ------------------------------------------------------------------ 8. cache, --force, pacing --
rm -rf "$OUT"
rc=0; es "$REPO" --out "$OUT" "$P1" >"$O" 2>"$E" || rc=$?
rc=0; ARGV="$TMP/argv8"; : > "$ARGV"
CURL_ARGV="$ARGV" es "$REPO" --out "$OUT" "$P1" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field "$P1" 3 "$O")" = cached ] && [ "$(field "$P1" 7 "$O")" = "$OUT/prnt.sc-XlDYChfQ0Wyw.png" ] \
   && [ "$(field "$P1" 5 "$O")" = image/png ] && [ ! -s "$ARGV" ] && grep -qF 'cached=1' "$E"; then ok
else bad S8-cached "rc=$rc requests=$(requests "$ARGV") row=$(grep -F "$P1" "$O")"; fi
rc=0; : > "$ARGV"
CURL_ARGV="$ARGV" es "$REPO" --out "$OUT" --force "$P1" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field "$P1" 3 "$O")" = saved ] && [ "$(requests "$ARGV")" -eq 2 ]; then ok
else bad S8b-force "rc=$rc requests=$(requests "$ARGV")"; fi
# a `.part` left by an interrupted run is not a cache hit
rm -rf "$OUT"; mkdir -p "$OUT"; : > "$OUT/prnt.sc-XlDYChfQ0Wyw.part"; printf x > "$OUT/prnt.sc-XlDYChfQ0Wyw.part"
rc=0; es "$REPO" --out "$OUT" "$P1" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(field "$P1" 3 "$O")" = saved ]; then ok; else bad S8c-part-not-cache "row=$(grep -F "$P1" "$O")"; fi
# one breath between REQUESTS — never before the first, none for a cached or skipped row
rm -rf "$OUT"; SL="$TMP/sleep8"; : > "$SL"
rc=0; SLEEP_LOG="$SL" es "$REPO" --out "$OUT" "https://evil.example/" "$P1" "https://i.imgur.com/abc123.png" >"$O" 2>"$E" || rc=$?
if [ "$(grep -c . "$SL")" -eq 2 ] && [ "$(sort -u "$SL")" = "1" ]; then ok
else bad S8d-pacing "sleeps=$(tr '\n' ',' < "$SL") want 2×1 for 3 requests"; fi
: > "$SL"
rc=0; SLEEP_LOG="$SL" es "$REPO" --out "$OUT" --force --delay 3 "$P1" >"$O" 2>"$E" || rc=$?
if [ "$(tr '\n' ',' < "$SL")" = "3," ]; then ok; else bad S8e-delay-flag "sleeps=$(tr '\n' ',' < "$SL")"; fi
: > "$SL"
rc=0; SLEEP_LOG="$SL" es "$REPO" --out "$OUT" --force --delay 0 "$P1" >"$O" 2>"$E" || rc=$?
if [ ! -s "$SL" ]; then ok; else bad S8f-delay-zero "sleeps=$(tr '\n' ',' < "$SL")"; fi

# ---------------------------------------------------------------- 9. the downscale rungs --
rm -rf "$OUT"; SIL="$TMP/sips9"; : > "$SIL"
rc=0; ES_PATH_OVERRIDE="$SHIM_SIPS:$BIN" SIPS_LOG="$SIL" es "$REPO" --out "$OUT" "$P1" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qF -- "-Z 1600 $OUT/prnt.sc-XlDYChfQ0Wyw.png" "$SIL"; then ok
else bad S9-sips "rc=$rc sips=$(head -c 200 "$SIL")"; fi
rm -rf "$OUT"
rc=0; ES_PATH_OVERRIDE="$SHIM_NONE:$BIN" es "$REPO" --out "$OUT" "$P1" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qF "note=downscale_skipped path=$OUT/prnt.sc-XlDYChfQ0Wyw.png" "$E" \
   && grep -qF 'note=downscale_tool_not_found images=1' "$E" && [ -s "$OUT/prnt.sc-XlDYChfQ0Wyw.png" ]; then ok
else bad S9b-no-tool "rc=$rc err=$(tr '\n' ';' < "$E" | head -c 300)"; fi
rm -rf "$OUT"; FFL="$TMP/ffmpeg9"; : > "$FFL"
rc=0; FFMPEG_LOG="$FFL" es "$REPO" --out "$OUT" --max-width 0 "$P1" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ ! -s "$FFL" ] && ! grep -q downscale "$E"; then ok; else bad S9c-width-zero "ffmpeg ran or a note fired: $(tr '\n' ';' < "$E")"; fi
rm -rf "$OUT"; FFL="$TMP/ffmpeg9d"; : > "$FFL"
rc=0; FFMPEG_LOG="$FFL" es "$REPO" --out "$OUT" --max-width 800 "$P1" >"$O" 2>"$E" || rc=$?
if grep -qF "scale='min(800,iw)':-2" "$FFL"; then ok; else bad S9d-width-flag "$(head -c 200 "$FFL")"; fi
# ffmpeg failing leaves the downloaded file, never a .resized stub
rm -rf "$OUT"
rc=0; FFMPEG_FAIL=1 ES_PATH_OVERRIDE="$SHIM_FULL:$BIN" es "$REPO" --out "$OUT" "$P1" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ -s "$OUT/prnt.sc-XlDYChfQ0Wyw.png" ] && [ -z "$(ls "$OUT" | grep resized)" ]; then ok
else bad S9e-ffmpeg-fail "rc=$rc ls=$(ls "$OUT" | tr '\n' ' ')"; fi
# GIF / WebP are kept as they came — no resample
rm -rf "$OUT"; FFL="$TMP/ffmpeg9f"; : > "$FFL"
rc=0; FFMPEG_LOG="$FFL" FAKE_IMG_TYPE=image/gif es "$REPO" --out "$OUT" "$P1" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ ! -s "$FFL" ] && [ -s "$OUT/prnt.sc-XlDYChfQ0Wyw.gif" ]; then ok; else bad S9f-gif "rc=$rc ls=$(ls "$OUT" | tr '\n' ' ')"; fi

# ------------------------------------------------------------------ 10. filename hygiene --
rm -rf "$OUT"
rc=0; FAKE_PAGE_ANY="$PAGES/XlDYChfQ0Wyw.html" es "$REPO" --out "$OUT" "https://prnt.sc/../../pwn" "https://prnt.sc/a/b/c.PNG?x=1#f" "https://prnt.sc/" >"$O" 2>"$E" || rc=$?
for want in "prnt.sc-pwn.png" "prnt.sc-a_b_c.png" "prnt.sc-index.png"; do
  if [ -f "$OUT/$want" ]; then ok; else bad S10-name "$want missing: $(ls "$OUT" | tr '\n' ' ')"; fi
done
if [ -z "$(ls "$OUT" | grep -v '^prnt.sc-')" ] && [ ! -e "$REPO/.claude/pwn.png" ]; then ok; else bad S10-traversal "$(ls "$OUT" | tr '\n' ' ')"; fi

# ----------------------------------------------------------------------------- 11. --json --
rm -rf "$OUT"
rc=0; es "$REPO" --out "$OUT" --json "$P1" "https://evil.example/" "https://prnt.sc/challenge" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 1 ] && jq -e 'length == 3 and map(.status) == ["saved","skipped_host","failed"]
     and (.[0] | .size > 0 and .mime == "image/png" and (.path | endswith("/prnt.sc-XlDYChfQ0Wyw.png")) and .filename == "prnt.sc-XlDYChfQ0Wyw.png")
     and (.[1] | .size == 0 and .path == "" and .image_url == "")' "$O" >/dev/null 2>&1; then ok
else bad S11-json "rc=$rc $(head -c 300 "$O" | tr '\n' ' ')"; fi
rc=0; es "$REPO" --out "$OUT" "$P1" "https://evil.example/" "https://prnt.sc/challenge" >"$TMP/tsv11" 2>/dev/null || rc=$?
rc=0; es "$REPO" --out "$OUT" --json "$P1" "https://evil.example/" "https://prnt.sc/challenge" >"$O" 2>/dev/null || rc=$?
mismatch=""
for u in "$P1" "https://evil.example/" "https://prnt.sc/challenge"; do
  for pair in "2:host" "3:status" "4:image_url" "5:mime" "7:path" "8:filename"; do
    col="${pair%%:*}"; key="${pair#*:}"
    a="$(field "$u" "$col" "$TMP/tsv11")"; b="$(jq -r --arg u "$u" --arg k "$key" '.[] | select(.url == $u) | .[$k]' "$O")"
    [ "$a" = "$b" ] || mismatch="$mismatch $u.$key('$a' vs '$b')"
  done
done
if [ -z "$mismatch" ]; then ok; else bad S11b-json-matches-tsv "$mismatch"; fi

echo "external-screenshots-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
