#!/usr/bin/env bash
# jira-attachments.sh — download a Jira issue's image/video attachments into the task workspace.
#
# WHY A SCRIPT AT ALL: the Atlassian MCP server returns attachment METADATA (id, filename,
# mimeType, size) and no tool that returns the BYTES, so a screenshot on a ticket is invisible to
# the model. This fetches them with curl and leaves them on disk for the caller to `Read`.
#
# CREDENTIALS — a per-developer, READ-ONLY SCOPED API token, never a classic one:
#   JIRA_EMAIL + JIRA_API_TOKEN, process env first, else the --env dotenv (default ./.env,
#   gitignored). Same discipline as shopify-admin-gql.sh's token engine: the value is NEVER
#   printed and NEVER on the argv — it rides a private 0600 curl config file (`user =
#   "<email>:<token>"`) removed on exit — and a value carrying whitespace, a quote or a control
#   character is refused before curl runs rather than smuggled into that file as a second
#   directive. Skills and agents must call THIS script and must NOT `Read` the .env themselves.
#   Setup walk-through: references/jira-attachments.md.
#
# ONE HOST: every authenticated request goes to the api.atlassian.com gateway
# (`/ex/jira/<cloudId>/rest/api/3/…`) — a scoped token 401s on the site host, so the site host is
# used for exactly one UNAUTHENTICATED lookup: `_edge/tenant_info`, to discover <cloudId> when the
# caller has not passed --cloud-id (the reader reads it out of the response's `self` URLs).
# `-L` follows the 302 to the media host and curl drops the credentials cross-host by itself;
# --location-trusted, which would not, is never passed.
#
# WHERE THE BYTES LAND: --out must be a path git ignores, judged at its PHYSICAL location — the
# dir is resolved through symlinks and the question is put to the repository that actually holds
# the bytes, because a git worktree's `.claude/tasks` is a SYMLINK into the main checkout and git
# refuses to answer about anything beyond a symlink at all. "Never reaches a commit" is a
# requirement, and the same gate is what keeps a ticket that says "save to ~/…" inside a repo's
# scratch: a physical location in no repository at all is refused (out_dir_not_in_repo). Under
# `.claude/tasks/` the script stamps the info/exclude line task-workspace.md prescribes — only
# when that physical repo is the cwd's own (a worktree and its main checkout share one common
# dir, so the symlink case still stamps) — and proceeds; any other unignored dir is refused.
#
# VIDEOS ARE TRANSIENT: a screen recording cannot be `Read` — only its frames can — and one is tens
# of MB, so the bytes are a means, never the deliverable. A video is downloaded to `<target>.part`,
# cut into PNG frames under `<target>.frames/`, and the video is then DELETED: the row's path column
# is EMPTY and the frames dir is the whole result (`frames=<dir>:<count>`). --keep-video keeps the
# original next to the frames; --no-frames keeps it WITHOUT cutting (it implies --keep-video).
#   · a failed cut (ffmpeg non-zero, or zero frames produced) takes the frames dir with it: the row
#     is `failed` with an empty path and `note=frames_failed id=<id>` on stderr. Under --keep-video
#     the file the caller asked for survives and the row stays `saved`, frames empty.
#   · no ffmpeg on PATH → a video is NOT DOWNLOADED at all, because nothing here could turn it into
#     something the model can look at: `skipped_no_ffmpeg`, empty path and frames, and one
#     `note=ffmpeg_not_found videos=<N>` line. With --keep-video or --no-frames the developer asked
#     for the FILE, so it is downloaded and kept, unframed (`note=ffmpeg_not_found_unframed`).
#   · CACHE: a transient video is `cached` when `<target>.frames/done` records `size=<bytes>` equal
#     to the attachment's metadata size — then no request and no cut. A done marker with no size
#     line is a previous version's and counts as stale (re-download + re-cut). Images and a KEPT
#     video keep the old rule: the file on disk, its size equal to the metadata size — and a kept
#     video already there at that size is never re-fetched merely to redo a stale or missing cut,
#     since those bytes ARE the bytes the request would bring back: only the cut is redone, off
#     the file, and the row still says `cached`. A failed download only ever removes what THIS
#     run judged stale — a frames dir whose marker still matches outlives it (row `failed`; the
#     next plain run reports it `cached` again).
#   · FRAMES: the count adapts to the duration — N = clamp(ceil(duration / 4), 8, 24), i.e. ≤32 s →
#     8 frames, one more per 4 s above that, ≥96 s → 24; --frames <N> pins a fixed 1..99 instead
#     (a frame's ordinal is two digits, so a 100th would sort ahead of the 99th). The instants
#     are BIN CENTRES, t_i = (i + 0.5) · duration / N, so the last frame sits near the END of the
#     recording (a plain grid starting at 0 never samples the last 1/N of it). Each frame is one
#     `ffmpeg -ss <t> -i … -frames:v 1 -vf scale='min(1440,iw)':-2` — width capped at 1440, aspect
#     kept, even height, no crop — landing as `<NN>-<MM>m<SS>s.png` (e.g. `05-00m20s.png`).
#     The duration comes from ffprobe, else from the CONTAINER's own `Duration:` line in
#     `ffmpeg -i <file>` (anchored: an attachment is untrusted, and a `title` metadata tag reading
#     `Duration: 99:00:00.00` must not stand in for it — nor may anything above 24 h), else 60 s is
#     ASSUMED and said out loud (`note=duration_unknown`); a cut that yields fewer frames than
#     intended is reported too (`note=frames_short`), never silently shortened.
#
# Usage:
#   jira-attachments.sh <ISSUE-KEY> [--out <dir>] [--ids <id,id>] [--all] [--max-mb <N>]
#                       [--max-video-mb <N>] [--force] [--no-frames] [--keep-video] [--frames <N>]
#                       [--env <dotenv>] [--site <host>] [--cloud-id <uuid>] [--json]
#   jira-attachments.sh --check [--env <dotenv>] [--site <host>] [--cloud-id <uuid>]
#
#   --out           download dir (default .claude/tasks/<KEY>/tmp/attachments)
#   --ids           only these attachment ids (comma-separated)
#   --all           lift the image/* + video/* type filter
#   --max-mb        per-file size cap for everything but videos (default 25)
#   --max-video-mb  per-video size cap (default 200 — the video bytes are transient)
#   --force         re-download and re-cut even when the frames (or the file) are already on disk
#   --no-frames     keep the video, do not cut it (implies --keep-video)
#   --keep-video    keep the video file next to its frames (default: delete it after a good cut)
#   --frames        fixed frames per video, 1..99 (default: adaptive, 8…24 by duration)
#   --env           dotenv holding JIRA_EMAIL / JIRA_API_TOKEN (default ./.env)
#   --site          site host for the cloudId lookup (default $JIRA_SITE, else meetdomaine.atlassian.net)
#   --cloud-id      skip that lookup
#   --check         probe the credentials only: `ok=1 jira_user=… cloud_id=… ffmpeg=…`
#   --json          emit the rows as a JSON array (frames as a path list) instead of TSV
#
# stdout — one row per attachment, header first:
#   id  status  kind  mime  size  created  author  path  frames  filename
#   status = saved | cached | skipped_type | skipped_size | skipped_no_ffmpeg | failed;
#   kind = image | video | other; path = the file on disk — EMPTY for a transient video (its frames
#   dir is the result) and for every row that is not saved/cached; frames = `<dir>:<count>` or empty.
# stderr — notes, then always a last summary line:
#   ok=1 saved=N cached=N skipped=N failed=N frames=N out=<dir>
#
# Exit: 0 ok · 1 at least one attachment failed — a download or a frame cut (the rows name them) ·
#       2 usage/precondition · 3 credentials missing or malformed ·
#       4 the API rejected the request (auth, unknown issue) ·
#       5 transport failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
[ -f "$SCRIPT_DIR/_shopify-common.sh" ] || { echo "error=common_lib_not_found path=$SCRIPT_DIR/_shopify-common.sh" >&2; exit 2; }
. "$SCRIPT_DIR/_shopify-common.sh"
REFERENCE="$(dirname "$SCRIPT_DIR")/references/jira-attachments.md"

KEY=""; OUT_DIR=""; IDS=""; ALL=0; MAX_MB=25; MAX_VIDEO_MB=200; FORCE=0
# FRAMES is the pinned count and only means anything with FRAMES_FIXED — the default is the
# duration-adaptive rule, which no number could stand in for
FRAMES=0; FRAMES_FIXED=0; DO_FRAMES=1; KEEP_VIDEO=0
ENV_FILE=".env"; SITE=""; CLOUD_ID=""; CHECK=0; JSON=0
US="$(printf '\037')"   # the row separator between the metadata fields (see the jq call below)

# a value flag must not be the last arg — a bare `shift 2` would exit silently under set -e
need_val() { [ "$1" -ge 2 ] || { echo "error=missing_value flag=$2" >&2; exit 2; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out)          need_val $# "$1"; OUT_DIR="$2"; shift 2 ;;
    --ids)          need_val $# "$1"; IDS="$2"; shift 2 ;;
    --all)          ALL=1; shift ;;
    --max-mb)       need_val $# "$1"; MAX_MB="$2"; shift 2 ;;
    --max-video-mb) need_val $# "$1"; MAX_VIDEO_MB="$2"; shift 2 ;;
    --force)        FORCE=1; shift ;;
    --no-frames)    DO_FRAMES=0; shift ;;
    --keep-video)   KEEP_VIDEO=1; shift ;;
    --frames)       need_val $# "$1"; FRAMES="$2"; FRAMES_FIXED=1; shift 2 ;;
    --env)          need_val $# "$1"; ENV_FILE="$2"; shift 2 ;;
    --site)         need_val $# "$1"; SITE="$2"; shift 2 ;;
    --cloud-id)     need_val $# "$1"; CLOUD_ID="$2"; shift 2 ;;
    --check)        CHECK=1; shift ;;
    --json)         JSON=1; shift ;;
    -*) echo "error=unknown_arg arg=$1" >&2; exit 2 ;;
    *) [ -z "$KEY" ] || { echo "error=unexpected_arg arg=$1" >&2; exit 2; }; KEY="$1"; shift ;;
  esac
done

case "$MAX_MB" in ''|*[!0-9]*) echo "error=invalid_max_mb value=$MAX_MB" >&2; exit 2 ;; esac
case "$MAX_VIDEO_MB" in ''|*[!0-9]*) echo "error=invalid_max_video_mb value=$MAX_VIDEO_MB" >&2; exit 2 ;; esac
if [ "$FRAMES_FIXED" -eq 1 ]; then
  # 1..99, because the ordinal in a frame's name is TWO digits (`<NN>-<MM>m<SS>s.png`) and every
  # reader of that dir — frame_files() here included — takes the lexical order for the chronological
  # one: with a 100th frame `100-…` sorts ahead of `99-…` and the order silently stops being true.
  case "$FRAMES" in ''|*[!0-9]*) echo "error=invalid_frames value=$FRAMES" >&2; exit 2 ;; esac
  # the compound is the left side of `||`, so a value too large for the shell's integer compare
  # fails it and lands in the same refusal instead of taking the script down under set -e
  { [ "$FRAMES" -ge 1 ] && [ "$FRAMES" -le 99 ]; } 2>/dev/null \
    || { echo "error=invalid_frames value=$FRAMES" >&2; exit 2; }
fi
# "do not cut" is a request for the FILE: nothing else would be left of the attachment
[ "$DO_FRAMES" -eq 1 ] || KEEP_VIDEO=1
MAX_BYTES=$((MAX_MB * 1024 * 1024))
MAX_VIDEO_BYTES=$((MAX_VIDEO_MB * 1024 * 1024))

# The key rides a URL path and each id rides one too — outside content, gated before anything is
# built out of them. LC_ALL=C so a locale cannot widen A-Z into something a path separator fits in.
if [ "$CHECK" -eq 0 ]; then
  [ -n "$KEY" ] || { echo "error=missing_issue_key (usage: jira-attachments.sh <ISSUE-KEY> [--out <dir>])" >&2; exit 2; }
  printf '%s' "$KEY" | LC_ALL=C grep -qE '^[A-Z][A-Z0-9_]*-[0-9]+$' \
    || { echo "error=invalid_issue_key key=$KEY (expected e.g. ELC-1309)" >&2; exit 2; }
fi
if [ -n "$IDS" ]; then
  printf '%s' "$IDS" | LC_ALL=C grep -qE '^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$' \
    || { echo "error=invalid_ids ids=$IDS" >&2; exit 2; }
fi

command -v curl >/dev/null 2>&1 || { echo "error=curl_not_found" >&2; exit 2; }
command -v jq   >/dev/null 2>&1 || { echo "error=jq_not_found" >&2; exit 2; }

HAVE_FFMPEG=0;  command -v ffmpeg  >/dev/null 2>&1 && HAVE_FFMPEG=1
HAVE_FFPROBE=0; command -v ffprobe >/dev/null 2>&1 && HAVE_FFPROBE=1

# --- credentials ------------------------------------------------------------------------------
HINT="hint=Attachments need a per-developer, READ-ONLY Atlassian API token — JIRA_EMAIL + JIRA_API_TOKEN in <repo>/.env (gitignored). Create it at https://id.atlassian.com/manage-profile/security/api-tokens → \"Create API token with scopes\" (NOT the plain one — that grants write) → app Jira → filters Scope type: Classic + Scope actions: Read → select all 5 (read:jira-work is the one that matters). Walk-through: $REFERENCE"
AUTH_HINT="hint=The token was rejected — it has expired, or it is a plain (unscoped) API token, which 401s on the api.atlassian.com gateway this script speaks to. Regenerate a READ-ONLY scoped one: $REFERENCE"

# one source flag per value: a refusal names where THAT value came from, so the developer edits
# the place that actually holds it
EMAIL="${JIRA_EMAIL:-}"; TOKEN="${JIRA_API_TOKEN:-}"; EMAIL_SRC=env; TOKEN_SRC=env
if [ -f "$ENV_FILE" ]; then
  if [ -z "$EMAIL" ]; then EMAIL="$(dotenv_value JIRA_EMAIL "$ENV_FILE")"; EMAIL_SRC=file; fi
  if [ -z "$TOKEN" ]; then TOKEN="$(dotenv_value JIRA_API_TOKEN "$ENV_FILE")"; TOKEN_SRC=file; fi
fi
# a copy-pasted export often carries surrounding whitespace; an INNER newline is deliberately left
# alone so it reaches the gate below instead of being silently repaired
EMAIL="$(trim_ws "$EMAIL")"; TOKEN="$(trim_ws "$TOKEN")"
if [ -z "$EMAIL" ] || [ -z "$TOKEN" ]; then
  echo "error=no_jira_credentials (JIRA_EMAIL + JIRA_API_TOKEN, from the environment or $ENV_FILE)" >&2
  echo "$HINT" >&2
  exit 3
fi
# Both values land inside a quoted curl-config directive, where a stray quote breaks the value and
# an embedded newline injects a SECOND directive — arbitrary curl options out of a malformed .env.
# The gates are against exactly that. Neither value is ever echoed, not even in the refusal.
case "$TOKEN" in
  *[!A-Za-z0-9_.+/=~-]*)
    echo "error=invalid_jira_credentials source=$TOKEN_SRC field=token (contains whitespace, a quote or another character no Atlassian API token has)" >&2
    exit 3 ;;
esac
case "$EMAIL" in
  *[[:space:]]*|*[[:cntrl:]]*|*\"*|*\'*|*\\*)
    echo "error=invalid_jira_credentials source=$EMAIL_SRC field=email (contains whitespace, a quote or a control character)" >&2
    exit 3 ;;
esac

if [ -z "$SITE" ]; then SITE="${JIRA_SITE:-}"; fi
if [ -z "$SITE" ] && [ -f "$ENV_FILE" ]; then SITE="$(dotenv_value JIRA_SITE "$ENV_FILE")"; fi
SITE="$(trim_ws "$SITE")"
[ -n "$SITE" ] || SITE="meetdomaine.atlassian.net"
case "$SITE" in ''|*[!A-Za-z0-9.-]*) echo "error=invalid_site site=$SITE" >&2; exit 2 ;; esac

CFG="$(mktemp)"; LISTF="$(mktemp)"; ROWS_TSV="$(mktemp)"; ROWS_JSON="$(mktemp)"; SCRATCH="$(mktemp)"
trap 'rm -f "$CFG" "$LISTF" "$ROWS_TSV" "$ROWS_JSON" "$SCRATCH"' EXIT
# the 0600 writer lives in _shopify-common.sh — figma-rest.sh holds a token the same way, and one
# copy of "the credential rides a file, never the argv" is the only one that can be kept true
curl_config_write "$CFG" "$(printf 'user = "%s:%s"' "$EMAIL" "$TOKEN")" \
  || { echo "error=curl_config_unwritable" >&2; exit 2; }

# --- requests ---------------------------------------------------------------------------------
# The timeouts are bounds, not tuning: without them a stalled Jira call hangs every skill waiting
# on it. `--proto =https --proto-redir =https` keep the redirect chain to the media host on TLS.
CURL_OPTS=(-sS -L --connect-timeout 10 --max-time 120 --proto =https --proto-redir =https)

api_get() { # $1 = path under /rest/api/3, $2 = out file → http code on stdout
  curl "${CURL_OPTS[@]}" -K "$CFG" -H 'Accept: application/json' \
    -o "$2" -w '%{http_code}' "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/$1"
}
dl_get() { # $1 = path under /rest/api/3, $2 = out file → http code on stdout (bytes, no Accept)
  curl "${CURL_OPTS[@]}" -K "$CFG" \
    -o "$2" -w '%{http_code}' "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/$1"
}

if [ -z "$CLOUD_ID" ]; then
  # the ONE request that touches the site host, and the one that carries no credentials
  code="$(curl "${CURL_OPTS[@]}" -o "$SCRATCH" -w '%{http_code}' "https://$SITE/_edge/tenant_info")" || code=000
  case "$code" in 2*) CLOUD_ID="$(jq -r '.cloudId // empty' "$SCRATCH" 2>/dev/null || true)" ;; esac
  if [ -z "$CLOUD_ID" ]; then
    echo "error=cloud_id_lookup_failed site=$SITE http=$code (pass --cloud-id <uuid>)" >&2
    exit 2
  fi
fi
case "$CLOUD_ID" in *[!A-Za-z0-9-]*) echo "error=invalid_cloud_id" >&2; exit 2 ;; esac

reject_auth() { # $1 = http code
  echo "error=jira_auth_rejected http=$1" >&2
  echo "$AUTH_HINT" >&2
  exit 4
}

if [ "$CHECK" -eq 1 ]; then
  code="$(api_get myself "$SCRATCH")" || { echo "error=curl_transport_failed" >&2; exit 5; }
  case "$code" in
    2*) ;;
    401|403) reject_auth "$code" ;;
    *) echo "error=jira_request_failed http=$code path=myself" >&2; exit 4 ;;
  esac
  ff=no; [ "$HAVE_FFMPEG" -eq 1 ] && ff=yes
  printf 'ok=1 jira_user=%s cloud_id=%s ffmpeg=%s\n' \
    "$(jq -r '.displayName // "unknown"' "$SCRATCH" 2>/dev/null || echo unknown)" "$CLOUD_ID" "$ff"
  exit 0
fi

# --- the download dir must be a path git ignores (D5) ------------------------------------------
[ -n "$OUT_DIR" ] || OUT_DIR=".claude/tasks/$KEY/tmp/attachments"

# The whole gate — lexical normalisation, the physical resolution symlinked worktrees need, the
# `.claude/tasks/` stamp and the three refusals — lives in _shopify-common.sh, because
# figma-rest.sh writes into the same workspace under the same rule and a second copy would be a
# second rule. Every later path is the PHYSICAL one the gate cleared.
out_dir_gate "$OUT_DIR" || exit 2
OUT_ABS="$OUT_DIR_ABS"

# --- the attachment table ----------------------------------------------------------------------
code="$(api_get "issue/$KEY?fields=attachment" "$LISTF")" || { echo "error=curl_transport_failed" >&2; exit 5; }
case "$code" in
  2*) ;;
  401|403) reject_auth "$code" ;;
  404) echo "error=issue_not_found key=$KEY" >&2; exit 4 ;;
  *) echo "error=jira_request_failed http=$code key=$KEY" >&2; exit 4 ;;
esac

# U+001F between the fields, not a tab: bash collapses runs of an IFS *whitespace* character, so an
# empty author would silently shift every later column of the row. A control character inside a
# value would break the row the same way, and is flattened here.
jq -r '
  def c: (. // "") | tostring | gsub("[[:cntrl:]]"; " ");
  (.fields.attachment // [])[]
  | [(.id|c), (.filename|c), (.mimeType|c), ((.size // 0)|tostring), (.created|c), (.author.displayName|c)]
  | join("\u001f")
' "$LISTF" 2>/dev/null | LC_ALL=C sort -t "$US" -k1,1n > "$SCRATCH" \
  || { echo "error=attachment_list_unparseable key=$KEY" >&2; exit 4; }

mime_ext() { # $1 = mime → the extension a name without one gets
  case "$1" in
    image/png) printf png ;;
    image/jpeg|image/jpg) printf jpg ;;
    image/gif) printf gif ;;
    image/webp) printf webp ;;
    image/svg+xml) printf svg ;;
    video/mp4) printf mp4 ;;
    video/quicktime) printf mov ;;
    video/webm) printf webm ;;
    application/pdf) printf pdf ;;
  esac
}

# The filename is outside content and becomes a path segment: everything but [A-Za-z0-9._-] becomes
# `_` (so no separator survives), runs collapse, leading dots go, and the result is capped at 80
# chars with the extension kept — a Jira filename can be a whole sentence.
sanitize_name() { # $1 = raw filename, $2 = mime
  local n base ext max
  n="$(printf '%s' "$1" | LC_ALL=C tr -c 'A-Za-z0-9._-' '_' | sed -e 's/__*/_/g' -e 's/^\.*//')"
  case "$n" in
    *.*) base="${n%.*}"; ext="${n##*.}" ;;
    *)   base="$n"; ext="" ;;
  esac
  [ -n "$ext" ] || ext="$(mime_ext "$2")"
  [ -n "$base" ] || base=file
  max=80
  if [ -n "$ext" ]; then max=$((80 - ${#ext} - 1)); fi
  [ "$max" -ge 1 ] || max=1
  base="${base:0:$max}"
  if [ -n "$ext" ]; then printf '%s.%s' "$base" "$ext"; else printf '%s' "$base"; fi
}

file_size() { wc -c < "$1" 2>/dev/null | tr -d ' '; }

# The duration decides BOTH the frame count and where the instants fall, so a wrong one is not a
# cosmetic slip: too long and half the timestamps land past the end of the recording. ffprobe first,
# then the `Duration: HH:MM:SS.xx` line real ffmpeg prints on stderr when it is handed an input and
# no output (and exits non-zero doing it); "" means neither could say.
probe_duration() { # $1 = video file → seconds on stdout, "" when unknown
  local d=""
  if [ "$HAVE_FFPROBE" -eq 1 ]; then
    d="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$1" 2>/dev/null | head -1 || true)"
    case "$d" in ''|*[!0-9.]*|.) d="" ;; esac
  fi
  if [ -z "$d" ]; then
    # ANCHORED at the start of the line: ffmpeg prints the container's `Metadata:` block BEFORE its
    # own `  Duration:` line, and an attachment is untrusted third-party content — a recording
    # whose `title` tag reads `Duration: 99:00:00.00` would otherwise supply the first match and
    # scatter every instant past the end of the file. A metadata key is padded ahead of its colon
    # (`    title           : …`), so `^ *Duration:` can only ever be the container's own line.
    # LC_ALL=C on the awk: `printf "%.3f"` honours LC_NUMERIC, and a comma decimal would fail the
    # digits-and-dots gate below (silently becoming the 60 s assumption).
    d="$(ffmpeg -hide_banner -i "$1" </dev/null 2>&1 \
         | LC_ALL=C sed -n 's/^ *Duration: *\([0-9][0-9]*\):\([0-9][0-9]\):\([0-9][0-9]*\(\.[0-9]*\)\{0,1\}\).*/\1 \2 \3/p' \
         | head -1 | LC_ALL=C awk 'NF == 3 { printf "%.3f", $1 * 3600 + $2 * 60 + $3 }' || true)"
    case "$d" in ''|*[!0-9.]*|.) d="" ;; esac
  fi
  # a screen recording is minutes long, never a day: a duration outside (0, 24 h] is a misread or a
  # forged one, and "unknown" — 60 s, said out loud — beats 24 instants past the end of the file
  if [ -n "$d" ]; then
    LC_ALL=C awk -v d="$d" 'BEGIN { exit !(d + 0 > 0 && d + 0 <= 86400) }' || d=""
  fi
  printf '%s' "$d"
}

adaptive_frames() { # $1 = duration in seconds → clamp(ceil(duration / 4), 8, 24)
  LC_ALL=C awk -v d="$1" 'BEGIN {
    d = d + 0; if (d <= 0) d = 60        # + 0 pins the numeric reading on every awk
    n = int(d / 4); if (n * 4 < d) n++
    if (n < 8) n = 8; if (n > 24) n = 24
    print n }'
}

# One ffmpeg per frame with INPUT seeking (-ss before -i): the instants are bin CENTRES,
# t_i = (i + 0.5) * duration / N, so the last one sits half a bin from the end instead of the whole
# recording's tail going unsampled — which is what an fps filter grid starting at 0 does. A frame
# ffmpeg refuses to produce is a gap, never fatal: the caller counts what actually landed.
cut_frames() { # $1 = video file, $2 = frames dir, $3 = attachment id (for the notes)
  local dur n plan t name got
  dur="$(probe_duration "$1")"
  if [ -z "$dur" ]; then
    dur=60
    echo "note=duration_unknown id=$3 assumed=${dur}s" >&2
  fi
  if [ "$FRAMES_FIXED" -eq 1 ]; then n="$FRAMES"; else n="$(adaptive_frames "$dur")"; fi
  # LC_ALL=C is load-bearing, not hygiene: `printf "%.3f"` honours LC_NUMERIC, and on a machine
  # whose region uses a comma decimal every instant would reach ffmpeg as `0,781` — which it
  # refuses ("Invalid duration for option ss"), so EVERY frame fails and the recording is lost
  plan="$(LC_ALL=C awk -v n="$n" -v d="$dur" 'BEGIN {
            d = d + 0; n = n + 0; if (d <= 0) d = 60
            for (i = 0; i < n; i++) {
              t = (i + 0.5) * d / n; s = int(t)
              printf "%.3f %02d-%02dm%02ds.png\n", t, i + 1, int(s / 60), s % 60
            } }')"
  # -nostdin, AND the `</dev/null` for builds predating it: this loop is fed by `<<< "$plan"`, so
  # every ffmpeg inherits the here-string as its stdin — and ffmpeg without -nostdin reads stdin for
  # keyboard commands, swallowing the rest of the plan. The `read` would then hit EOF and a whole
  # recording would come out ONE frame long. (probe_duration guards its own ffmpeg the same way.)
  while read -r t name; do
    [ -n "$name" ] || continue
    ffmpeg -nostdin -loglevel error -y -ss "$t" -i "$1" -frames:v 1 -vf "scale='min(1440,iw)':-2" \
      "$2/$name" >/dev/null 2>&1 </dev/null || true
  done <<< "$plan"
  got="$(frame_files "$2" | wc -l | tr -d ' ')"
  # the count is never allowed to come out short in silence — that is the symptom of a duration
  # longer than the recording, and a caller reading the row would never see it otherwise
  if [ "$got" -gt 0 ] && [ "$got" -lt "$n" ]; then
    echo "note=frames_short id=$3 want=$n got=$got" >&2
  fi
}

# `<NN>-<MM>m<SS>s.png`, so the ordinal prefix keeps the glob's lexical order the chronological one
frame_files() { for f in "$1"/[0-9]*.png; do if [ -f "$f" ]; then printf '%s\n' "$f"; fi; done; }

frames_cached() { # $1 = frames dir, $2 = the attachment's metadata size → 0 when this cut is current
  [ -f "$1/done" ] || return 1
  # a done marker with no size line is the previous version's: it says a cut happened, never of
  # what — and the video it was cut from is long gone, so the only safe reading is "stale"
  LC_ALL=C grep -qxF "size=$2" "$1/done" 2>/dev/null || return 1
  [ -n "$(frame_files "$1" | head -1)" ] || return 1
}

file_cached() { # $1 = file, $2 = expected size — equality, not mere existence: it catches a
  [ -f "$1" ] && [ "$(file_size "$1")" = "$2" ]  # run truncated halfway through
}

saved=0; cached=0; skipped=0; failed=0; frames_total=0; videos_no_ffmpeg=0; videos_unframed=0
while IFS="$US" read -r id name mime size created author; do
  [ -n "$id" ] || continue
  # the id is outside content too, and it becomes BOTH a URL path segment and a filename prefix —
  # the same gate --ids gets, or a `/` in it writes the bytes outside the ignored out dir
  case "$id" in *[!A-Za-z0-9_-]*) echo "note=invalid_attachment_id id=$id" >&2; continue ;; esac
  if [ -n "$IDS" ]; then
    case ",$IDS," in *",$id,"*) ;; *) continue ;; esac
  fi
  kind=other
  case "$mime" in image/*) kind=image ;; video/*) kind=video ;; esac
  case "$size" in ''|*[!0-9]*) size=0 ;; esac
  fname="$(sanitize_name "$name" "$mime")"
  target="$OUT_ABS/$id-$fname"
  status=""; path=""; fdir=""; fcount=0

  # a video's bytes are transient, so they answer to their own (much larger) cap
  cap="$MAX_BYTES"; [ "$kind" = video ] && cap="$MAX_VIDEO_BYTES"
  # do_cut = this row's video is to be framed · keep = its bytes stay on disk afterwards
  do_cut=0; keep=1
  if [ "$kind" = video ]; then
    keep="$KEEP_VIDEO"
    if [ "$DO_FRAMES" -eq 1 ] && [ "$HAVE_FFMPEG" -eq 1 ]; then do_cut=1; fi
  fi

  if [ "$ALL" -eq 0 ] && [ "$kind" = other ]; then status=skipped_type
  elif [ "$size" -gt "$cap" ]; then status=skipped_size
  elif [ "$kind" = video ] && [ "$do_cut" -eq 0 ] && [ "$keep" -eq 0 ]; then
    # no ffmpeg and no request for the file itself: downloading tens of MB nothing on this machine
    # can turn into frames would buy the caller exactly nothing
    status=skipped_no_ffmpeg; videos_no_ffmpeg=$((videos_no_ffmpeg + 1))
  fi

  if [ -z "$status" ] && [ "$do_cut" -eq 1 ]; then
    fd="$target.frames"
    # WHY the cache missed decides what a failed download is allowed to destroy, so the verdict is
    # taken BEFORE the request: only the marker makes a frames dir STALE. `--force`, and a
    # --keep-video run whose file went missing, both walk past a cut that is still perfectly
    # current — and a transient video's bytes are long gone, so those frames are the whole artifact
    stale=0; frames_cached "$fd" "$size" || stale=1
    have_file=0; if file_cached "$target" "$size"; then have_file=1; fi
    if [ "$FORCE" -eq 0 ] && [ "$stale" -eq 0 ] \
       && { [ "$keep" -eq 0 ] || [ "$have_file" -eq 1 ]; }; then
      status=cached; fdir="$fd"
      fcount="$(frame_files "$fd" | wc -l | tr -d ' ')"
      # the `.part` of an interrupted run is reaped here or never: every later run takes this same
      # cache-hit branch, and nothing ever reads a `.part` back — it would just sit there
      if [ "$keep" -eq 1 ]; then path="$target"; rm -f "$target.part"
      else rm -f "$target" "$target.part"; fi
    elif [ "$FORCE" -eq 0 ] && [ "$keep" -eq 1 ] && [ "$have_file" -eq 1 ]; then
      # --keep-video (or --no-frames' implied keep) with the video already here at the metadata
      # size: those bytes ARE the bytes the request would bring back, so a stale — or missing —
      # frames dir buys a re-CUT off the file on disk, never tens of MB over the network again.
      # Nothing was fetched, so the row is `cached`.
      rm -rf "$fd"; mkdir -p "$fd"
      cut_frames "$target" "$fd" "$id"
      fcount="$(frame_files "$fd" | wc -l | tr -d ' ')"
      status=cached; path="$target"; rm -f "$target.part"
      if [ "$fcount" -eq 0 ]; then
        # a failed cut under a kept video, exactly as on the download path: the file the flag asked
        # for survives, the empty dir does not, and the row carries no frames
        rm -rf "$fd"; fcount=0
        echo "note=frames_failed id=$id" >&2
      else
        printf 'size=%s\nframes=%s\n' "$size" "$fcount" > "$fd/done"
        fdir="$fd"
      fi
    else
      code="$(dl_get "attachment/content/$id" "$target.part")" || code=000
      case "$code" in
        2*)
          # the cut reads the .part: until the frames exist there is nothing to keep the video for
          rm -rf "$fd"; mkdir -p "$fd"
          cut_frames "$target.part" "$fd" "$id"
          fcount="$(frame_files "$fd" | wc -l | tr -d ' ')"
          if [ "$fcount" -eq 0 ]; then
            rm -rf "$fd"
            echo "note=frames_failed id=$id" >&2
            if [ "$keep" -eq 1 ]; then mv -f "$target.part" "$target"; status=saved; path="$target"
            else rm -f "$target.part"; status=failed; fi
          else
            printf 'size=%s\nframes=%s\n' "$size" "$fcount" > "$fd/done"
            status=saved; fdir="$fd"
            if [ "$keep" -eq 1 ]; then mv -f "$target.part" "$target"; path="$target"
            # transient: the frames are the deliverable, and an older run's video goes with the .part
            else rm -f "$target.part" "$target"; fi
          fi ;;
        # one failed download is reported and never fatal to the others; the stub goes so a later
        # run cannot read it back as a cached file, and so does a frames dir THIS run judged stale —
        # leaving it would hand the caller frames of a video the row denies. A dir whose marker
        # still matches survives: it is the only copy of a recording whose bytes were deleted on
        # purpose, and the next plain run reports it `cached` again.
        *) rm -f "$target.part"
           [ "$stale" -eq 0 ] || rm -rf "$fd"
           status=failed
           echo "note=download_failed id=$id http=$code" >&2 ;;
      esac
    fi
  elif [ -z "$status" ]; then
    # images, the --all extras, and a video the caller asked to keep unframed: the file itself is
    # the deliverable, so its size on disk is the cache
    if [ "$FORCE" -eq 0 ] && file_cached "$target" "$size"; then
      status=cached; path="$target"
    else
      code="$(dl_get "attachment/content/$id" "$target.part")" || code=000
      case "$code" in
        2*) mv -f "$target.part" "$target"; status=saved; path="$target" ;;
        *) rm -f "$target.part"; status=failed
           echo "note=download_failed id=$id http=$code" >&2 ;;
      esac
    fi
    # --keep-video (or --no-frames' implied keep) on a machine with no ffmpeg: the file is here, the
    # frames the caller can actually look at are not
    if [ "$kind" = video ] && [ "$DO_FRAMES" -eq 1 ] && [ "$HAVE_FFMPEG" -eq 0 ] && [ -n "$path" ]; then
      videos_unframed=$((videos_unframed + 1))
    fi
  fi
  if [ -n "$fdir" ]; then frames_total=$((frames_total + fcount)); fi

  case "$status" in
    saved)  saved=$((saved + 1)) ;;
    cached) cached=$((cached + 1)) ;;
    failed) failed=$((failed + 1)) ;;
    *)      skipped=$((skipped + 1)) ;;
  esac

  frames_col=""
  if [ -n "$fdir" ]; then frames_col="$fdir:$fcount"; fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$id" "$status" "$kind" "$mime" "$size" "$created" "$author" "$path" "$frames_col" "$fname" >> "$ROWS_TSV"
  if [ "$JSON" -eq 1 ]; then
    fjson='[]'
    if [ -n "$fdir" ]; then fjson="$(frame_files "$fdir" | jq -R -s 'split("\n") | map(select(length > 0))')"; fi
    jq -nc --arg id "$id" --arg status "$status" --arg kind "$kind" --arg mime "$mime" \
      --argjson size "$size" --arg created "$created" --arg author "$author" --arg path "$path" \
      --argjson frames "$fjson" --arg filename "$fname" \
      '{id: $id, status: $status, kind: $kind, mime: $mime, size: $size, created: $created,
        author: $author, path: $path, frames: $frames, filename: $filename}' >> "$ROWS_JSON"
  fi
done < "$SCRATCH"

if [ "$JSON" -eq 1 ]; then
  jq -s '.' "$ROWS_JSON"
else
  printf 'id\tstatus\tkind\tmime\tsize\tcreated\tauthor\tpath\tframes\tfilename\n'
  cat "$ROWS_TSV"
fi

if [ "$videos_no_ffmpeg" -gt 0 ]; then echo "note=ffmpeg_not_found videos=$videos_no_ffmpeg" >&2; fi
if [ "$videos_unframed" -gt 0 ]; then echo "note=ffmpeg_not_found_unframed videos=$videos_unframed" >&2; fi
echo "ok=1 saved=$saved cached=$cached skipped=$skipped failed=$failed frames=$frames_total out=$OUT_ABS" >&2
[ "$failed" -eq 0 ] || exit 1
