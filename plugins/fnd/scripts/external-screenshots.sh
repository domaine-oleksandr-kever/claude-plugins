#!/usr/bin/env bash
# external-screenshots.sh — download the screenshots a ticket LINKS instead of attaching: prnt.sc /
# Lightshot, imgur, Gyazo, CleanShot and snipboard pages pasted into a comment or a description.
#
# WHY: QA evidence often arrives as `https://prnt.sc/<id>` smart-links with an EMPTY `attachment`
# field — jira-attachments.sh sees no rows and the caller is told "no attachments" while the FAIL
# comment's whole case sits behind four links. This resolves such a page to its image (the page's
# `og:image`, or the URL itself on a direct image host), downloads it, and downscales it to a width
# a model can look at without paying for a 3000-px 16-bit PNG.
#
# THE ALLOW-LIST IS THE SECURITY BOUNDARY. A URL is outside content — a ticket can carry ANY link,
# and a fetcher that followed arbitrary ones would be an SSRF / exfiltration surface driven by
# ticket text. So: `https://` only; the page host must be one of PAGE_HOSTS / DIRECT_HOSTS below,
# EXACTLY (no wildcards); the image URL a page resolves to must be `https://` on a host under one of
# IMAGE_HOST_SUFFIXES; the answer must carry an `image/*` content type; the bytes are capped
# (--max-mb, and the cap is re-checked on disk because curl's --max-filesize cannot stop a chunked
# answer on every version). Anything else is a `skipped_host` row and NO request. No credential is
# involved anywhere — these are public services.
#
# USER-AGENT: prnt.sc answers curl's default agent with a bot-challenge page (HTTP 520, text/plain,
# no og:image — measured 2026-09-25) and a browser one with the real page, so every request carries
# a browser User-Agent. Requests are spaced --delay seconds apart (default 1).
#
# DOWNSCALE: a Lightshot PNG is ~3000 px wide at 16-bit RGBA. After the download a PNG / JPEG is
# resampled IN PLACE so its width is at most --max-width (default 1600; never upscaled): ffmpeg when
# on PATH (the tool the video frames already use), else macOS `sips`, else it is left as downloaded
# with `note=downscale_skipped`. `--max-width 0` keeps every original. GIF / WebP / SVG are kept as is.
#
# WHERE THE BYTES LAND: --out is gated exactly like jira-attachments.sh's (out_dir_gate in
# _shopify-common.sh): a path git ignores, judged at its physical location; under `.claude/tasks/`
# the info/exclude line task-workspace.md prescribes is stamped. The file is
# `<host>-<slug>.<ext>` — the slug is the URL's path with everything but [A-Za-z0-9._-] folded to
# `_`, so a page URL can never name a path outside the out dir.
#
# CACHE: a URL whose `<host>-<slug>.*` file is already on disk is `cached` — no request; --force
# re-downloads it. A run never leaves a `.part` behind: it is deleted on every failure.
#
# Usage:
#   external-screenshots.sh --out <dir> [--max-mb <N>] [--max-width <px>] [--delay <s>] [--force] [--json] <url> [<url> …]
#   external-screenshots.sh --hosts
#
#   --out         download dir — required; must be a path git ignores
#   --max-mb      per-image size cap (default 25)
#   --max-width   resample width ceiling in px, 0 = keep every original (default 1600)
#   --delay       whole seconds between two requests (default 1)
#   --force       re-download an image already on disk
#   --json        emit the rows as a JSON array instead of TSV
#   --hosts       print the hosts this script fetches from, one per line, and exit 0
#
# `--help` / `-h` — bare or anywhere in the args — prints that Usage block to stdout and exits 0.
#
# stdout — one row per URL, in argv order, header first:
#   url  host  status  image_url  mime  size  path  filename
#   status = saved | cached | skipped_host | failed; image_url = what was actually fetched (the
#   og:image, or the URL itself on a direct host) — empty for a skipped row; path = the file on
#   disk, empty unless saved/cached; size = its bytes on disk (after the downscale).
# stderr — notes, then always a last summary line:
#   ok=1 saved=N cached=N skipped=N failed=N out=<dir>
#
# Exit: 0 ok · 1 at least one allow-listed URL failed (a fetch, no og:image, a non-image answer,
#       over the cap — the rows name them; a skipped_host row is never a failure) ·
#       2 usage/precondition.
set -euo pipefail

# The `# Usage:` block above, verbatim — the suite pins the two together.
USAGE='Usage:
  external-screenshots.sh --out <dir> [--max-mb <N>] [--max-width <px>] [--delay <s>] [--force] [--json] <url> [<url> …]
  external-screenshots.sh --hosts'

for _a in ${1+"$@"}; do
  case "$_a" in
    --help|-h) printf '%s\n' "$USAGE" "Full contract: the header of $0"; exit 0 ;;
  esac
done
unset _a

# Page hosts: the URL is an HTML page whose og:image is the screenshot. Direct hosts: the URL IS the
# image. Both lists are exact host names. IMAGE_HOST_SUFFIXES bounds where a page's og:image may
# point — its own CDN, never an arbitrary host (`prnt.sc` → `img.lightshot.app`, measured).
PAGE_HOSTS="prnt.sc prntscr.com imgur.com gyazo.com share.cleanshot.com snipboard.io"
DIRECT_HOSTS="img.lightshot.app i.imgur.com i.gyazo.com"
IMAGE_HOST_SUFFIXES="lightshot.app prnt.sc prntscr.com imgur.com gyazo.com cleanshot.com cleanshot.cloud snipboard.io"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

for _a in ${1+"$@"}; do
  case "$_a" in
    --hosts) printf '%s\n' $PAGE_HOSTS $DIRECT_HOSTS; exit 0 ;;
  esac
done
unset _a

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
[ -f "$SCRIPT_DIR/_shopify-common.sh" ] || { echo "error=common_lib_not_found path=$SCRIPT_DIR/_shopify-common.sh" >&2; exit 2; }
. "$SCRIPT_DIR/_shopify-common.sh"

OUT_DIR=""; MAX_MB=25; MAX_WIDTH=1600; DELAY=1; FORCE=0; JSON=0
URLS=()

need_val() { [ "$1" -ge 2 ] || { echo "error=missing_value flag=$2" >&2; exit 2; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out)       need_val $# "$1"; OUT_DIR="$2"; shift 2 ;;
    --max-mb)    need_val $# "$1"; MAX_MB="$2"; shift 2 ;;
    --max-width) need_val $# "$1"; MAX_WIDTH="$2"; shift 2 ;;
    --delay)     need_val $# "$1"; DELAY="$2"; shift 2 ;;
    --force)     FORCE=1; shift ;;
    --json)      JSON=1; shift ;;
    -*) echo "error=unknown_arg arg=$1 (--help prints usage)" >&2; exit 2 ;;
    *) URLS+=("$1"); shift ;;
  esac
done

case "$MAX_MB" in ''|*[!0-9]*) echo "error=invalid_max_mb value=$MAX_MB" >&2; exit 2 ;; esac
case "$MAX_WIDTH" in ''|*[!0-9]*) echo "error=invalid_max_width value=$MAX_WIDTH" >&2; exit 2 ;; esac
case "$DELAY" in ''|*[!0-9]*) echo "error=invalid_delay value=$DELAY" >&2; exit 2 ;; esac
[ -n "$OUT_DIR" ] || { echo "error=missing_out (usage: external-screenshots.sh --out <dir> <url> [<url> …])" >&2; exit 2; }
[ "${#URLS[@]}" -gt 0 ] || { echo "error=missing_url (usage: external-screenshots.sh --out <dir> <url> [<url> …])" >&2; exit 2; }
MAX_BYTES=$((MAX_MB * 1024 * 1024))

command -v curl >/dev/null 2>&1 || { echo "error=curl_not_found" >&2; exit 2; }
command -v jq   >/dev/null 2>&1 || { echo "error=jq_not_found" >&2; exit 2; }
HAVE_FFMPEG=0; command -v ffmpeg >/dev/null 2>&1 && HAVE_FFMPEG=1
HAVE_SIPS=0;   command -v sips   >/dev/null 2>&1 && HAVE_SIPS=1

out_dir_gate "$OUT_DIR" || exit 2
OUT_ABS="$OUT_DIR_ABS"

SCRATCH="$(mktemp)"; ROWS_TSV="$(mktemp)"; ROWS_JSON="$(mktemp)"
trap 'rm -f "$SCRATCH" "$ROWS_TSV" "$ROWS_JSON"' EXIT

# --- requests ---------------------------------------------------------------------------------
# `--proto =https --proto-redir =https` keep every hop on TLS; --max-filesize is the first cap, the
# on-disk re-check below the one that always holds.
CURL_OPTS=(-sS -L --connect-timeout 10 --max-time 60 --proto =https --proto-redir =https -A "$UA")

fetch() { # $1 = url, $2 = out file, $3 = byte cap → "<http code> <content type>" on stdout
  curl "${CURL_OPTS[@]}" --max-filesize "$3" -o "$2" -w '%{http_code} %{content_type}' "$1"
}

in_list() { # $1 = word, $2 = space-separated list
  case " $2 " in *" $1 "*) return 0 ;; esac; return 1
}
host_allowed_suffix() { # $1 = host → 0 when it is, or sits under, one of IMAGE_HOST_SUFFIXES
  local s
  for s in $IMAGE_HOST_SUFFIXES; do
    [ "$1" = "$s" ] && return 0
    case "$1" in *".$s") return 0 ;; esac
  done
  return 1
}
url_host() { # $1 = https url → its host, lower-cased (empty when the URL is not https://host[/…])
  local h
  h="${1#https://}"
  [ "$h" != "$1" ] || { printf ''; return 0; }
  h="${h%%/*}"; h="${h%%\?*}"; h="${h%%\#*}"
  case "$h" in *[!A-Za-z0-9.-]*|'') printf '' ;; *) printf '%s' "$h" | tr 'A-Z' 'a-z' ;; esac
}
# A remote value that is echoed back (a note, a row) may not forge a line of its own, and one that
# reaches curl's argv may not carry a separator: control characters, whitespace and quotes are out.
clean_url() { # $1 = raw url → 0 with CLEAN set, 1 when it carries what no URL has
  CLEAN="$1"
  case "$CLEAN" in *[[:space:][:cntrl:]]*|*\"*|*\'*|*\\*) return 1 ;; esac
  return 0
}

mime_ext() { # $1 = content type → extension, "" when it is not an image type this script names
  case "$1" in
    image/png) printf png ;;
    image/jpeg|image/jpg) printf jpg ;;
    image/gif) printf gif ;;
    image/webp) printf webp ;;
    image/svg+xml) printf svg ;;
    image/*) printf img ;;
  esac
}

# `<host>-<slug>`: the URL's path with every separator folded away, a trailing image extension
# dropped (the content type names the real one), capped at 60 chars.
slug_of() { # $1 = url → the path after the host, folded
  local p
  p="${1#https://}"
  case "$p" in */*) p="${p#*/}" ;; *) p="" ;; esac
  p="${p%%\?*}"; p="${p%%\#*}"
  p="$(printf '%s' "$p" | LC_ALL=C tr -c 'A-Za-z0-9._-' '_' | sed -e 's/__*/_/g' -e 's/^[._]*//' -e 's/[._]*$//')"
  p="$(printf '%s' "$p" | sed -E 's/\.([Pp][Nn][Gg]|[Jj][Pp][Ee]?[Gg]|[Gg][Ii][Ff]|[Ww][Ee][Bb][Pp]|[Ss][Vv][Gg])$//')"
  [ -n "$p" ] || p=index
  printf '%s' "${p:0:60}"
}

cached_file() { # $1 = out dir, $2 = <host>-<slug> → the file on disk, "" when none
  local f
  for f in "$1/$2".*; do
    case "$f" in *.part) continue ;; esac
    if [ -s "$f" ]; then printf '%s' "$f"; return 0; fi
  done
  printf ''
}

file_size() { wc -c < "$1" 2>/dev/null | tr -d ' '; }

# these are public services: one breath between two requests, never before the first
pace() { if [ "$requested" -gt 0 ] && [ "$DELAY" -gt 0 ]; then sleep "$DELAY"; fi; requested=$((requested + 1)); }

# In place, PNG / JPEG only, width capped at MAX_WIDTH, aspect kept — ffmpeg first (the same
# resampler the video frames go through; `-pix_fmt rgba` turns a 16-bit Lightshot PNG into an 8-bit
# one, which halves it again), else sips, which only ever shrinks under -Z.
downscale() { # $1 = file, $2 = ext → 0 done, 1 no tool
  local tmp
  case "$2" in png|jpg) ;; *) return 0 ;; esac
  if [ "$HAVE_FFMPEG" -eq 1 ]; then
    tmp="$1.resized.$2"
    if ffmpeg -nostdin -loglevel error -y -i "$1" -vf "scale='min($MAX_WIDTH,iw)':-2" \
         -pix_fmt "$( [ "$2" = png ] && printf rgba || printf yuvj420p )" -q:v 3 "$tmp" >/dev/null 2>&1 </dev/null \
       && [ -s "$tmp" ]; then
      mv -f "$tmp" "$1"; return 0
    fi
    rm -f "$tmp"
  fi
  if [ "$HAVE_SIPS" -eq 1 ]; then
    sips -Z "$MAX_WIDTH" "$1" >/dev/null 2>&1 && return 0
  fi
  return 1
}

saved=0; cached=0; skipped=0; failed=0; requested=0; downscale_missing=0
for url in "${URLS[@]}"; do
  host=""; status=""; image_url=""; mime=""; size=""; path=""; fname=""
  # a URL is echoed back in its row, so one that could forge a line is folded before anything else
  url_shown="$(printf '%s' "$url" | tr -d '[:cntrl:]' | tr -s '[:space:]' '_')"
  if clean_url "$url"; then host="$(url_host "$url")"; fi
  if [ -z "$host" ] || ! { in_list "$host" "$PAGE_HOSTS" || in_list "$host" "$DIRECT_HOSTS"; }; then
    status=skipped_host; host="${host:-}"
  else
    slug="$(slug_of "$url")"
    stem="$host-$slug"
    have="$(cached_file "$OUT_ABS" "$stem")"
    if [ "$FORCE" -eq 0 ] && [ -n "$have" ]; then
      status=cached; path="$have"; fname="${have##*/}"; size="$(file_size "$have")"
      ext="${fname##*.}"
      case "$ext" in png) mime=image/png ;; jpg) mime=image/jpeg ;; gif) mime=image/gif ;; webp) mime=image/webp ;; svg) mime=image/svg+xml ;; esac
    else
      if in_list "$host" "$DIRECT_HOSTS"; then
        image_url="$url"
      else
        # the page: 2 MiB is more than any of these hosts' HTML, and the cap keeps a misbehaving
        # answer from filling the disk
        pace
        rc=0; ans="$(fetch "$url" "$SCRATCH" $((2 * 1024 * 1024)))" || rc=$?
        code="${ans%% *}"
        case "$code" in
          2*) ;;
          *) status=failed; echo "note=page_fetch_failed url=$url_shown http=${code:-000}" >&2 ;;
        esac
        if [ -z "$status" ]; then
          # attribute order and quote style vary by host; the first og:image tag wins
          image_url="$(LC_ALL=C grep -o '<meta[^>]*og:image[^>]*>' "$SCRATCH" 2>/dev/null | head -1 \
                       | sed -n "s/.*content=[\"']\([^\"']*\)[\"'].*/\1/p" | sed 's/&amp;/\&/g' \
                       | tr -d '[:cntrl:]' || true)"
          if [ -z "$image_url" ]; then
            status=failed; echo "note=no_og_image url=$url_shown" >&2
          fi
        fi
      fi
      if [ -z "$status" ]; then
        # the og:image is remote data: it may only point at the service's own image hosts, over TLS
        ih=""
        if clean_url "$image_url"; then ih="$(url_host "$image_url")"; fi
        if [ -z "$ih" ]; then
          # prnt.sc answers an UNKNOWN id with a 200 page whose og:image is a protocol-relative
          # placeholder (`//st.prntscr.com/…`, measured) — "no such screenshot", said with the value
          status=failed
          echo "note=image_url_not_https url=$url_shown image=$(printf '%s' "$image_url" | tr -d '[:cntrl:]' | tr -s '[:space:]' '_' | cut -c1-120)" >&2
          image_url=""
        elif ! host_allowed_suffix "$ih"; then
          status=failed
          echo "note=image_host_not_allowed url=$url_shown host=$ih" >&2
          image_url=""
        fi
      fi
      if [ -z "$status" ]; then
        part="$OUT_ABS/$stem.part"
        pace
        rc=0; ans="$(fetch "$image_url" "$part" "$MAX_BYTES")" || rc=$?
        code="${ans%% *}"; ctype="${ans#* }"; ctype="${ctype%%;*}"; ctype="$(printf '%s' "$ctype" | tr -d '[:space:][:cntrl:]' | tr 'A-Z' 'a-z')"
        ext="$(mime_ext "$ctype")"
        case "$code" in
          2*)
            if [ -z "$ext" ]; then
              status=failed; rm -f "$part"
              echo "note=not_an_image url=$url_shown type=${ctype:-unknown}" >&2
            elif [ "$(file_size "$part")" -gt "$MAX_BYTES" ]; then
              status=failed; got="$(file_size "$part")"; rm -f "$part"
              echo "note=over_cap url=$url_shown size=$got max_mb=$MAX_MB" >&2
            else
              target="$OUT_ABS/$stem.$ext"
              mv -f "$part" "$target"
              if [ "$MAX_WIDTH" -gt 0 ] && ! downscale "$target" "$ext"; then
                downscale_missing=$((downscale_missing + 1))
                echo "note=downscale_skipped path=$target" >&2
              fi
              status=saved; path="$target"; fname="$stem.$ext"; mime="$ctype"; size="$(file_size "$target")"
            fi ;;
          *) status=failed; rm -f "$part"
             echo "note=image_fetch_failed url=$url_shown http=${code:-000}" >&2 ;;
        esac
      fi
    fi
  fi

  case "$status" in
    saved)  saved=$((saved + 1)) ;;
    cached) cached=$((cached + 1)) ;;
    failed) failed=$((failed + 1)) ;;
    *)      skipped=$((skipped + 1)) ;;
  esac
  image_shown="$(printf '%s' "$image_url" | tr -d '[:cntrl:]' | tr -s '[:space:]' '_')"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$url_shown" "$host" "$status" "$image_shown" "$mime" "$size" "$path" "$fname" >> "$ROWS_TSV"
  if [ "$JSON" -eq 1 ]; then
    jq -nc --arg url "$url_shown" --arg host "$host" --arg status "$status" --arg image_url "$image_shown" \
      --arg mime "$mime" --argjson size "${size:-0}" --arg path "$path" --arg filename "$fname" \
      '{url: $url, host: $host, status: $status, image_url: $image_url, mime: $mime, size: $size,
        path: $path, filename: $filename}' >> "$ROWS_JSON"
  fi
done

if [ "$JSON" -eq 1 ]; then
  jq -s '.' "$ROWS_JSON"
else
  printf 'url\thost\tstatus\timage_url\tmime\tsize\tpath\tfilename\n'
  cat "$ROWS_TSV"
fi

if [ "$downscale_missing" -gt 0 ]; then echo "note=downscale_tool_not_found images=$downscale_missing (ffmpeg or sips would resample them to ${MAX_WIDTH}px)" >&2; fi
echo "ok=1 saved=$saved cached=$cached skipped=$skipped failed=$failed out=$OUT_ABS" >&2
[ "$failed" -eq 0 ] || exit 1
