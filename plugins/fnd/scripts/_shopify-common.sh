# Shared helpers for create-preview-theme.sh, theme-json.sh and shopify-admin-gql.sh — sourced,
# never executed (mode 644 on purpose; install.sh only ever symlinks whole directories, so a caller
# finds this file next to itself without a readlink loop). Every helper reads the caller's $TOML.

# TOML scalar reader: handles "…" / '…' / bare values, drops a trailing comment only OUTSIDE quotes,
# tolerates CRLF. All three shapes occur in real shopify.theme.toml files, and a `"`-only sed
# (`s/^[^"]*"([^"]*)".*/\1/`) silently returns the WHOLE LINE for the other two — the store then
# reaches the CLI as `store = 'x'` and a single-quoted password= is exported as the access token.
toml_value() { # $1 = key, first uncommented value to stdout (empty when absent)
  [ -f "$TOML" ] || return 0
  awk -v k="$1" '
    BEGIN { SQ = "\047" }
    /^[ \t]*#/ { next }
    $0 ~ "^[ \t]*" k "[ \t]*=" {
      v = $0
      sub("^[ \t]*" k "[ \t]*=[ \t]*", "", v)
      q = substr(v, 1, 1)
      if (q == "\"" || q == SQ) {
        v = substr(v, 2)
        p = index(v, q)
        if (p > 0) v = substr(v, 1, p - 1)
      } else {
        h = index(v, "#"); if (h > 0) v = substr(v, 1, h - 1)
        sub(/[ \t\r]+$/, "", v)
      }
      print v; exit
    }
  ' "$TOML" 2>/dev/null
}

# Domaine env files (process env wins): nearest .claude/domaine.env above cwd — tuning keys only,
# see below — then the global ~/.config/domaine/env; same dialect as scripts/env-file.cjs, read per
# key, never sourced. Callers fill an UNSET variable only — a set-but-empty value stays exactly
# that, and an empty value in the file cannot be expressed here.
domaine_env() {
  local d="$PWD" f v
  # PROJECT_OK, mirrored by hand from scripts/env-file.cjs: the project file is committable by a
  # client repo, so only these tuning keys are read from it. Every other switch — the guards, the
  # spill dir, the verify gates — comes from the environment or the global file, default-deny.
  case "$1" in
    FND_LEAN|FND_CTX_MONITOR|FND_CTX_WARN|FND_CTX_WINDOW|FND_MCP_SLIM_DEBUG|FND_WHALE_GUIDE|FND_NOGAIN_MEMO|FND_GQL_PROBE_CACHE|FND_CPT_THROTTLE_WAITS|FND_CPT_OVERLAY_VERIFY_WAIT|FND_THEME_JSON_VERIFY_WAIT|SHOPIFY_ADMIN_GQL_QUIET)
      while :; do
        f="$d/.claude/domaine.env"
        if [ -f "$f" ]; then
          v="$(grep -m1 "^$1=" "$f" 2>/dev/null | cut -d= -f2-)"
          [ -n "$v" ] && { printf '%s' "$v"; return; }
          break
        fi
        [ "$d" = "/" ] && break
        d="$(dirname "$d")"
      done ;;
  esac
  grep -m1 "^$1=" "${XDG_CONFIG_HOME:-$HOME/.config}/domaine/env" 2>/dev/null | cut -d= -f2- || true
}

# Theme Access token held by the toml: a token-shaped password=, else the first shp*_… anywhere in
# the file. Prints nothing when it has none and returns 0 either way: the caller owns the "no token"
# error, and a no-match grep must not abort it under set -e
theme_token_from_toml() {
  local t
  t="$(toml_value password || true)"
  case "$t" in shp[a-z]*_[A-Za-z0-9]*) ;; *) t="" ;; esac
  [ -n "$t" ] || t="$(grep -oE 'shp[a-z]+_[A-Za-z0-9]+' "$TOML" 2>/dev/null | head -1 || true)"
  printf '%s' "$t"; return 0
}

# Shop handle: `shopify --store` documents the https:// URL form as valid and real tomls carry it,
# so the scheme is stripped, not refused. What is left must be a handle or domain — a mis-parse
# handed to the CLI is an opaque error at best and the WRONG STORE at worst. Always prints the
# stripped value (the caller's error line quotes it); returns 1 when it cannot be a handle.
store_handle() { # $1 = raw store value
  local s="$1"
  s="${s#http://}"; s="${s#https://}"; s="${s%/}"
  printf '%s' "$s"
  case "$s" in ''|*[!A-Za-z0-9.-]*) return 1 ;; esac
  return 0
}
store_domain() { case "$1" in *.myshopify.com) printf '%s' "$1" ;; *) printf '%s.myshopify.com' "$1" ;; esac; }

# `shopify theme list --json` filter: the CLI can print a deprecation/upgrade banner before the JSON,
# and a banner is enough to make jq fail on the whole document. Drop every byte before the first
# `[`/`{` — BYTE-anchored, not line-anchored, because a spinner artifact or stray ANSI can share the
# JSON's own line (--no-color trims most of it, the cut handles the rest).
theme_list_trim() { awk 'f{print;next} match($0,/[[{]/){print substr($0,RSTART);f=1}'; }

# One field of the listed theme with this id, empty when absent: `// empty` so a listed-but-fieldless
# object never yields a literal `null` that a `[ -n … ]` guard would accept. `.. | objects` reads a
# bare array and a wrapped listing alike; `| head -1` is load-bearing (a `first(…)` rewrite returns
# empty for the wrapping object).
theme_list_field() { # $1 = listing json, $2 = theme id, $3 = field
  printf '%s' "$1" | jq -r --arg id "$2" --arg f "$3" \
    '.. | objects | select((.id|tostring)==$id) | .[$f] // empty' 2>/dev/null | head -1 || true
}

# The CLI spells the published theme's role `live`; `main` (the GraphQL enum) is accepted too so a
# spelling change cannot silently disarm a live-theme guard.
role_is_live() { case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in live|main) return 0 ;; esac; return 1; }
