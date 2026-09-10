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
# VIDEOS: a screen recording cannot be `Read`, so each one is additionally cut into evenly spaced
# PNG frames when ffmpeg is on PATH — an OPTIONAL backend: absent, the video is still saved and one
# `note=ffmpeg_not_found` line says why there are no frames. ffprobe supplies the duration; with no
# ffprobe the spacing assumes 60 s.
#
# Usage:
#   jira-attachments.sh <ISSUE-KEY> [--out <dir>] [--ids <id,id>] [--all] [--max-mb <N>] [--force]
#                       [--no-frames] [--frames <N>] [--env <dotenv>] [--site <host>]
#                       [--cloud-id <uuid>] [--json]
#   jira-attachments.sh --check [--env <dotenv>] [--site <host>] [--cloud-id <uuid>]
#
#   --out        download dir (default .claude/tasks/<KEY>/tmp/attachments)
#   --ids        only these attachment ids (comma-separated)
#   --all        lift the image/* + video/* type filter
#   --max-mb     per-file size cap (default 25)
#   --force      re-download and re-cut frames even when the file is already on disk
#   --no-frames  leave videos unframed
#   --frames     frames per video (default 8)
#   --env        dotenv holding JIRA_EMAIL / JIRA_API_TOKEN (default ./.env)
#   --site       site host for the cloudId lookup (default $JIRA_SITE, else meetdomaine.atlassian.net)
#   --cloud-id   skip that lookup
#   --check      probe the credentials only: `ok=1 jira_user=… cloud_id=… ffmpeg=…`
#   --json       emit the rows as a JSON array (frames as a path list) instead of TSV
#
# stdout — one row per attachment, header first:
#   id  status  kind  mime  size  created  author  path  frames  filename
#   status = saved | cached | skipped_type | skipped_size | failed; kind = image | video | other;
#   path empty unless saved/cached; frames = `<dir>:<count>` or empty.
# stderr — notes, then always a last summary line:
#   ok=1 saved=N cached=N skipped=N failed=N frames=N out=<dir>
#
# Exit: 0 ok · 1 at least one download failed (the rows name them) · 2 usage/precondition ·
#       3 credentials missing or malformed · 4 the API rejected the request (auth, unknown issue) ·
#       5 transport failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
[ -f "$SCRIPT_DIR/_shopify-common.sh" ] || { echo "error=common_lib_not_found path=$SCRIPT_DIR/_shopify-common.sh" >&2; exit 2; }
. "$SCRIPT_DIR/_shopify-common.sh"
REFERENCE="$(dirname "$SCRIPT_DIR")/references/jira-attachments.md"

KEY=""; OUT_DIR=""; IDS=""; ALL=0; MAX_MB=25; FORCE=0; FRAMES=8; DO_FRAMES=1
ENV_FILE=".env"; SITE=""; CLOUD_ID=""; CHECK=0; JSON=0
US="$(printf '\037')"   # the row separator between the metadata fields (see the jq call below)

# a value flag must not be the last arg — a bare `shift 2` would exit silently under set -e
need_val() { [ "$1" -ge 2 ] || { echo "error=missing_value flag=$2" >&2; exit 2; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out)       need_val $# "$1"; OUT_DIR="$2"; shift 2 ;;
    --ids)       need_val $# "$1"; IDS="$2"; shift 2 ;;
    --all)       ALL=1; shift ;;
    --max-mb)    need_val $# "$1"; MAX_MB="$2"; shift 2 ;;
    --force)     FORCE=1; shift ;;
    --no-frames) DO_FRAMES=0; shift ;;
    --frames)    need_val $# "$1"; FRAMES="$2"; shift 2 ;;
    --env)       need_val $# "$1"; ENV_FILE="$2"; shift 2 ;;
    --site)      need_val $# "$1"; SITE="$2"; shift 2 ;;
    --cloud-id)  need_val $# "$1"; CLOUD_ID="$2"; shift 2 ;;
    --check)     CHECK=1; shift ;;
    --json)      JSON=1; shift ;;
    -*) echo "error=unknown_arg arg=$1" >&2; exit 2 ;;
    *) [ -z "$KEY" ] || { echo "error=unexpected_arg arg=$1" >&2; exit 2; }; KEY="$1"; shift ;;
  esac
done

case "$MAX_MB" in ''|*[!0-9]*) echo "error=invalid_max_mb value=$MAX_MB" >&2; exit 2 ;; esac
case "$FRAMES" in ''|*[!0-9]*) echo "error=invalid_frames value=$FRAMES" >&2; exit 2 ;; esac
[ "$FRAMES" -ge 1 ] || { echo "error=invalid_frames value=$FRAMES" >&2; exit 2; }
MAX_BYTES=$((MAX_MB * 1024 * 1024))

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
chmod 600 "$CFG"
printf 'user = "%s:%s"\n' "$EMAIL" "$TOKEN" > "$CFG"

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

# Absolute and lexically normalised — the dir need not exist yet (the gate runs before mkdir), and
# `..` has to be folded away here, while the segments are still text: once resolve_phys() below
# follows the symlinks, a `..` would climb the physical tree instead of the one the caller wrote.
abs_dir() { # $1 = path
  local p="$1" out="" seg reglob=0
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  # the split below is an unquoted expansion: without `set -f` a `*` or `[…]` in a segment (of
  # --out or of $PWD) would glob against the cwd and silently re-point the download dir
  case "$-" in *f*) ;; *) reglob=1; set -f ;; esac
  local IFS=/
  for seg in $p; do
    case "$seg" in ''|.) ;; ..) out="${out%/*}" ;; *) out="$out/$seg" ;; esac
  done
  [ "$reglob" -eq 0 ] || set +f
  printf '%s' "${out:-/}"
}

# WHERE THE DIR PHYSICALLY IS. `git check-ignore` cannot look past a symbolic link — asked about a
# path under one it dies `fatal: pathspec '…' is beyond a symbolic link` (rc 128), which a bare
# `if !` reads as "not ignored". A git worktree's `.claude/tasks` IS such a symlink (worktree-
# setup.sh points it at the main checkout's), so the lexical question refused runs whose dir git
# ignores perfectly well. The nearest EXISTING ancestor is therefore resolved with `cd … && pwd -P`
# and the not-yet-existing segments are re-appended: the result names the repository that holds the
# bytes, which is the only one whose answer means anything.
resolve_phys() { # $1 = absolute lexical path → PHYS_BASE (existing, resolved) + PHYS_OUT
  local base="$1" rest=""
  while [ ! -d "$base" ]; do
    case "$base" in
      */?*) rest="${base##*/}${rest:+/$rest}"; base="${base%/*}"; [ -n "$base" ] || base=/ ;;
      *) base=/; break ;;
    esac
  done
  PHYS_BASE="$(cd "$base" 2>/dev/null && pwd -P)" || return 1
  [ -n "$PHYS_BASE" ] || return 1
  case "$rest" in
    '') PHYS_OUT="$PHYS_BASE" ;;
    *)  case "$PHYS_BASE" in /) PHYS_OUT="/$rest" ;; *) PHYS_OUT="$PHYS_BASE/$rest" ;; esac ;;
  esac
}

# git prints the common dir relative to ITS cwd when that cwd is the repo top, absolute otherwise —
# and it is resolved here too, so the two repositories the stamp rule compares are comparable.
git_common_dir() { # $1 = a dir → its repo's physical common dir on stdout, non-zero if none
  local out res
  out="$(git -C "$1" rev-parse --git-common-dir 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  case "$out" in /*) ;; *) out="$1/$out" ;; esac
  res="$(cd "$out" 2>/dev/null && pwd -P)" || return 1
  [ -n "$res" ] || return 1
  printf '%s' "$res"
}

# the one-liner task-workspace.md prescribes, with the newline care worktree-setup.sh pays: an
# exclude file whose last byte is not a newline is legal, and appending blind would glue the
# pattern onto the developer's last rule — breaking theirs and never adding ours.
stamp_exclude() { # $1 = the repo's physical common dir
  local cdir="$1" exclude
  mkdir -p "$cdir/info" 2>/dev/null || return 0
  exclude="$cdir/info/exclude"
  # the pattern is root-anchored: a deeper `.claude/tasks/` stays unignored and re-enters here on
  # every retry, so a blind append would grow the developer's file one duplicate line per run
  grep -qxF '.claude/tasks/' "$exclude" 2>/dev/null && return 0
  if [ -s "$exclude" ] && [ -n "$(tail -c 1 "$exclude" 2>/dev/null)" ]; then printf '\n' >> "$exclude"; fi
  printf '.claude/tasks/\n' >> "$exclude"
}

PHYS_BASE=""; PHYS_OUT=""
resolve_phys "$(abs_dir "$OUT_DIR")" \
  || { echo "error=out_dir_not_writable out=$(abs_dir "$OUT_DIR")" >&2; exit 2; }
# every later path is the physical one: it is what the gate below cleared, and it says out loud
# which checkout a worktree's symlinked .claude/tasks really wrote to
OUT_ABS="$PHYS_OUT"

OUT_COMMON="$(git_common_dir "$PHYS_BASE" || true)"
[ -n "$OUT_COMMON" ] || {
  echo "error=out_dir_not_in_repo out=$OUT_ABS (it resolves outside every git repository — use a path under .claude/tasks/ in a checkout)" >&2
  exit 2
}
if ! git -C "$PHYS_BASE" check-ignore -q "$OUT_ABS" 2>/dev/null; then
  # the stamp is this repo's to write, so it is offered only when the bytes land in the SAME
  # repository the caller is standing in — a worktree and its main checkout share one common dir,
  # a different checkout's `.claude/tasks` gets no line from us and is refused by the re-check
  case "$OUT_ABS/" in
    */.claude/tasks/*)
      CWD_COMMON="$(git_common_dir "$PWD" || true)"
      if [ -n "$CWD_COMMON" ] && [ "$CWD_COMMON" = "$OUT_COMMON" ]; then stamp_exclude "$OUT_COMMON"; fi ;;
  esac
  git -C "$PHYS_BASE" check-ignore -q "$OUT_ABS" 2>/dev/null || {
    echo "error=out_dir_not_ignored out=$OUT_ABS (git would track it — use a path under .claude/tasks/, or ignore it first)" >&2
    exit 2
  }
fi
mkdir -p "$OUT_ABS" 2>/dev/null || { echo "error=out_dir_not_writable out=$OUT_ABS" >&2; exit 2; }

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

cut_frames() { # $1 = video file, $2 = frames dir
  local dur=60 fps
  if [ "$HAVE_FFPROBE" -eq 1 ]; then
    dur="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$1" 2>/dev/null | head -1 || true)"
  fi
  case "$dur" in ''|*[!0-9.]*) dur=60 ;; esac
  fps="$(awk -v n="$FRAMES" -v d="$dur" 'BEGIN { if (d + 0 <= 0) d = 60; printf "%.6f", n / d }')"
  ffmpeg -loglevel error -y -i "$1" -vf "fps=$fps,scale=960:-2" -frames:v "$FRAMES" "$2/%02d.png" >/dev/null 2>&1
}

frame_files() { for f in "$1"/[0-9]*.png; do if [ -f "$f" ]; then printf '%s\n' "$f"; fi; done; }

saved=0; cached=0; skipped=0; failed=0; frames_total=0; videos_unframed=0
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

  if [ "$ALL" -eq 0 ] && [ "$kind" = other ]; then status=skipped_type
  elif [ "$size" -gt "$MAX_BYTES" ]; then status=skipped_size
  fi

  if [ -z "$status" ]; then
    # size equality, not mere existence — it also catches a run truncated halfway through
    if [ "$FORCE" -eq 0 ] && [ -f "$target" ] && [ "$(file_size "$target")" = "$size" ]; then
      status=cached; path="$target"
    else
      code="$(dl_get "attachment/content/$id" "$target.part")" || code=000
      case "$code" in
        2*) mv -f "$target.part" "$target"; status=saved; path="$target" ;;
        # one failed download is reported and never fatal to the others; the stub is removed so a
        # later run cannot read it back as a cached file
        *) rm -f "$target.part"; status=failed
           echo "note=download_failed id=$id http=$code" >&2 ;;
      esac
    fi
  fi

  if [ "$kind" = video ] && [ "$DO_FRAMES" -eq 1 ] && [ -n "$path" ]; then
    if [ "$HAVE_FFMPEG" -eq 1 ]; then
      fdir="$target.frames"
      if [ "$FORCE" -eq 1 ] || [ ! -f "$fdir/done" ]; then
        rm -rf "$fdir"; mkdir -p "$fdir"
        if cut_frames "$target" "$fdir"; then touch "$fdir/done"; else rm -rf "$fdir"; fdir=""; fi
      fi
      if [ -n "$fdir" ]; then fcount="$(frame_files "$fdir" | wc -l | tr -d ' ')"; fi
      # a cut that "succeeded" with no frames is a failed cut — the row must not point at an empty dir
      if [ -n "$fdir" ] && [ "$fcount" -eq 0 ]; then rm -rf "$fdir"; fdir=""; fi
      if [ -z "$fdir" ]; then echo "note=frames_failed id=$id" >&2
      else frames_total=$((frames_total + fcount)); fi
    else
      videos_unframed=$((videos_unframed + 1))
    fi
  fi

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

if [ "$videos_unframed" -gt 0 ]; then echo "note=ffmpeg_not_found videos=$videos_unframed" >&2; fi
echo "ok=1 saved=$saved cached=$cached skipped=$skipped failed=$failed frames=$frames_total out=$OUT_ABS" >&2
[ "$failed" -eq 0 ] || exit 1
