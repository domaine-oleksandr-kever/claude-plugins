# Shared helpers for create-preview-theme.sh, theme-json.sh and shopify-admin-gql.sh — sourced,
# never executed (mode 644 on purpose; install.sh only ever symlinks whole directories, so a caller
# finds this file next to itself without a readlink loop). Every helper reads the caller's $TOML —
# through the ONE environment block toml_resolve_env picked, which every caller settles before its
# first read of the file.

# WHICH `[environments.<name>]` block the readers below take their keys from. A multi-environment
# shopify.theme.toml holds one store, token and theme id PER BLOCK, so a file-order read hands the
# CLI one environment's store with another's token — a preview theme pushed to the production store.
# The rules are session-theme.sh's pin_toml rules, deliberately: read and pin must land on the same
# block or the pinned id belongs to a store the run never touched.
#   explicit name → that block (absent → env_not_found)
#   else `dev`, else `development` — by NAME, never by count
#   else the top-level keys, when an uncommented `theme =`/`store =` precedes the first header (`-`)
#   else `*` when every uncommented `store =` in the file names the SAME store (a multi-block file
#        that cannot target the wrong one — file-order reading is safe there, and it is what the
#        single-store configs in the field have always relied on); pin_toml still refuses to WRITE
#   else ambiguous_env — refuse before any network call or write, never guess
TOML_ENV=""          # resolved block: a name, `-` (top-level keys) or `*` (single-store, file-wide)
TOML_ENV_FROM=0      # line range the block's keys live in; 0 0 = the whole file
TOML_ENV_TO=0
TOML_TOP_TO=0        # last line before the first section header (0 = the file has none)
TOML_ONE_STORE=1     # every uncommented `store =` in the file names one store
TOML_ENVS=""         # the block names present, space-separated
TOML_ENV_WANT=""
TOML_ENV_ERR=""      # env_not_found | ambiguous_env — the caller owns the message (toml_env_error)
TOML_ENV_DONE=0
toml_resolve_env() { # $1 = wanted block name ("" = the default resolution above)
  local want="${1:-}" out st
  TOML_ENV=""; TOML_ENV_FROM=0; TOML_ENV_TO=0; TOML_TOP_TO=0; TOML_ONE_STORE=1
  TOML_ENVS=""; TOML_ENV_ERR=""; TOML_ENV_WANT="$want"
  out="$(awk -v want="$want" '
    function nocr(s) { sub(/\r$/, "", s); return s }
    function valof(s, k,   v, q, p, h) {
      v = s
      sub("^[ \t]*" k "[ \t]*=[ \t]*", "", v)
      q = substr(v, 1, 1)
      if (q == "\"" || q == SQ) {
        v = substr(v, 2); p = index(v, q); if (p > 0) v = substr(v, 1, p - 1)
      } else {
        h = index(v, "#"); if (h > 0) v = substr(v, 1, h - 1); sub(/[ \t\r]+$/, "", v)
      }
      return v
    }
    # the comparison store_handle()/store_domain() make below, so `acme`, `acme.myshopify.com` and
    # its https:// URL are ONE store and only a genuinely different handle reads as two
    function shop(v) {
      sub(/^[hH][tT][tT][pP][sS]?:\/\//, "", v); sub(/\/+$/, "", v)
      if (v !~ /\.myshopify\.com$/) v = v ".myshopify.com"
      return tolower(v)
    }
    BEGIN { SQ = "\047" }
    { line[++n] = $0 }
    END {
      nenv = 0; nh = 0; firsthdr = 0; envs = ""; ns = 0; one = 1; s1 = ""
      for (i = 1; i <= n; i++) {
        s = nocr(line[i])
        if (s ~ /^[ \t]*#/) continue
        if (s ~ /^[ \t]*\[/) {
          if (firsthdr == 0) firsthdr = i
          hline[++nh] = i
          nm = s; sub(/^[ \t]*\[[ \t]*/, "", nm); sub(/[ \t]*\].*$/, "", nm)
          if (index(nm, "environments.") == 1) {
            nenv++; ename[nenv] = substr(nm, 14); eline[nenv] = i
            envs = (envs == "") ? ename[nenv] : envs " " ename[nenv]
          }
          continue
        }
        if (s ~ /^[ \t]*store[ \t]*=/) {
          v = shop(valof(s, "store")); ns++
          if (ns == 1) s1 = v; else if (v != s1) one = 0
        }
      }
      print "stores=" (one ? "one" : "many")
      print "envs=" envs
      toplevel = 0
      toplim = (firsthdr > 0) ? firsthdr - 1 : n
      for (i = 1; i <= toplim; i++) {
        s = nocr(line[i])
        if (s ~ /^[ \t]*#/) continue
        if (s ~ /^[ \t]*(theme|store)[ \t]*=/) { toplevel = 1; break }
      }
      print "topto=" (firsthdr > 0 ? firsthdr - 1 : n)
      hdr = -1; used = "-"
      if (want != "") {
        for (j = 1; j <= nenv; j++) if (ename[j] == want) { hdr = eline[j]; used = want }
        if (hdr < 0) { print "status=env_not_found"; exit 0 }
      } else if (nenv == 0) {
        hdr = 0
      } else {
        for (j = 1; j <= nenv; j++) if (ename[j] == "dev") { hdr = eline[j]; used = "dev" }
        if (hdr < 0) for (j = 1; j <= nenv; j++) if (ename[j] == "development") { hdr = eline[j]; used = "development" }
        if (hdr < 0 && toplevel) hdr = 0
        if (hdr < 0) {
          if (one) { print "status=ok"; print "env=*"; print "from=0"; print "to=0"; exit 0 }
          print "status=ambiguous_env"; exit 0
        }
      }
      if (hdr > 0) {
        rstart = hdr + 1; rend = n
        for (j = 1; j <= nh; j++) if (hline[j] > hdr) { rend = hline[j] - 1; break }
      } else {
        rstart = 1; rend = (firsthdr > 0) ? firsthdr - 1 : n
        # section headers but no top-level keys: an empty range, so the file-wide step below is
        # what answers — and with no environment block in the file it cannot cross into one
        if (toplevel == 0 && firsthdr > 0) { rstart = n + 1; rend = n + 1 }
      }
      print "status=ok"; print "env=" used; print "from=" rstart; print "to=" rend
    }
  ' "$TOML" 2>/dev/null || true)"
  case "$out" in *"stores=many"*) TOML_ONE_STORE=0 ;; esac
  TOML_ENVS="$(printf '%s\n' "$out" | sed -n 's/^envs=//p' | head -1)"
  TOML_TOP_TO="$(printf '%s\n' "$out" | sed -n 's/^topto=//p' | head -1)"
  case "$TOML_TOP_TO" in ''|*[!0-9]*) TOML_TOP_TO=0 ;; esac
  st="$(printf '%s\n' "$out" | sed -n 's/^status=//p' | head -1)"
  case "$st" in
    ok)
      TOML_ENV="$(printf '%s\n' "$out" | sed -n 's/^env=//p' | head -1)"
      TOML_ENV_FROM="$(printf '%s\n' "$out" | sed -n 's/^from=//p' | head -1)"
      TOML_ENV_TO="$(printf '%s\n' "$out" | sed -n 's/^to=//p' | head -1)"
      case "$TOML_ENV_FROM" in ''|*[!0-9]*) TOML_ENV_FROM=0 ;; esac
      case "$TOML_ENV_TO" in ''|*[!0-9]*) TOML_ENV_TO=0 ;; esac
      return 0 ;;
    env_not_found|ambiguous_env) TOML_ENV_ERR="$st"; return 1 ;;
  esac
  # an absent or unreadable file answers nothing: read it whole and let the caller's own
  # "no store" / "no token" error be the one the developer sees
  TOML_ENV="-"; return 0
}

# One resolution per run, whichever reader gets there first. With no explicit name the Shopify
# CLI's own selector is the default, so `SHOPIFY_FLAG_ENVIRONMENT=staging` picks the same block
# here as it does for `shopify theme dev`.
toml_env_ready() { # [$1 = explicit block name] → 0, or 1 with TOML_ENV_ERR set
  if [ "$TOML_ENV_DONE" -eq 1 ]; then
    [ -z "$TOML_ENV_ERR" ] || return 1
    return 0
  fi
  TOML_ENV_DONE=1
  toml_resolve_env "${1:-${SHOPIFY_FLAG_ENVIRONMENT:-}}"
}

# A store fixed on the command line (or in the environment) already answers the question an
# ambiguous file could not: take the block that NAMES that store, so the escape hatch the refusal
# advertises actually works instead of refusing a run whose store is no longer in doubt. Several
# blocks naming it are still one store, so the first is as good as any — their tokens all
# authenticate it. No match leaves the refusal exactly as it stood.
# A name the file does not carry stays an error: that is a typo, not an open question a store can
# settle.
toml_env_pick_by_store() { # $1 = store handle or domain → 0 with TOML_ENV* set to that block
  local want n v hit="" names prev="$TOML_ENV_WANT"
  [ "$TOML_ENV_ERR" = "ambiguous_env" ] || return 1
  [ -n "${1:-}" ] || return 1
  names="$TOML_ENVS"
  [ -n "$names" ] || return 1
  want="$(toml_store_key "$1")"
  for n in $names; do
    toml_resolve_env "$n" || continue
    v="$(toml_scan store "$TOML_ENV_FROM" "$TOML_ENV_TO" || true)"
    [ -n "$v" ] || continue
    [ "$(toml_store_key "$v")" = "$want" ] || continue
    hit="$n"; break
  done
  if [ -n "$hit" ]; then
    toml_resolve_env "$hit"
    return 0
  fi
  toml_resolve_env "$prev" || true   # the refusal the caller was about to print, put back
  return 1
}
# One spelling for "the same store": handle, domain and https:// URL all collapse to it.
toml_store_key() { printf '%s' "$(store_domain "$(store_handle "$1" || true)")" | tr 'A-Z' 'a-z'; }

# The refusal line for a block that could not be resolved, in the caller's own vocabulary:
# $1 = how THIS script lets a developer name the block (its --env means a dotenv path in two of
# the three). Prints `<key> <message>`; the caller adds its own error= prefix and channel.
toml_env_error() {
  if [ "$TOML_ENV_ERR" = "env_not_found" ]; then
    printf 'env_not_found env=%s toml=%s — no `[environments.%s]` block in it (present: %s)' \
      "$TOML_ENV_WANT" "$TOML" "$TOML_ENV_WANT" "${TOML_ENVS:-none}"
  else
    printf 'ambiguous_env envs=%s toml=%s — its environment blocks name different stores and none is named `dev`/`development`, so which store and token this repo works against cannot be guessed; %s' \
      "${TOML_ENVS:-none}" "$TOML" "$1"
  fi
}

# TOML scalar reader: handles "…" / '…' / bare values, drops a trailing comment only OUTSIDE quotes,
# tolerates CRLF. All three shapes occur in real shopify.theme.toml files, and a `"`-only sed
# (`s/^[^"]*"([^"]*)".*/\1/`) silently returns the WHOLE LINE for the other two — the store then
# reaches the CLI as `store = 'x'` and a single-quoted password= is exported as the access token.
toml_scan() { # $1 = key, $2/$3 = line range (0 0 = whole file), first uncommented value to stdout
  awk -v k="$1" -v from="$2" -v to="$3" '
    BEGIN { SQ = "\047" }
    from > 0 && NR < from { next }
    to > 0 && NR > to { exit }
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
# The resolved block's value for a key, else the top-level keys (an environment block legitimately
# carries only what it overrides), else anywhere in the file. Both fallbacks leave the block, so
# `store` and `password` — the two halves of ONE credential, minted per store — take them only in a
# file whose every `store =` is the same store: there is no other store to cross into there, and it
# is what single-store multi-block configs have always relied on. Where the stores differ, a value
# from outside the block is the wrong-store pairing this resolver exists to prevent, so the key
# stays absent and the caller's own "no store"/"no token" error is what the developer sees.
toml_value() { # $1 = key, value to stdout (empty when absent)
  local v outside=1
  [ -f "$TOML" ] || return 0
  case "$1" in store|password) [ "$TOML_ONE_STORE" -eq 1 ] || outside=0 ;; esac
  # every scan is `|| true`: an existing but unreadable config must degrade to "no value" and let
  # the caller print its own error, never abort the run under `set -e` with raw awk noise
  v="$(toml_scan "$1" "$TOML_ENV_FROM" "$TOML_ENV_TO" || true)"
  if [ -z "$v" ] && [ "$outside" -eq 1 ] && [ "$TOML_ENV_FROM" -gt 1 ] && [ "$TOML_TOP_TO" -gt 0 ]; then
    v="$(toml_scan "$1" 1 "$TOML_TOP_TO" || true)"
  fi
  if [ -z "$v" ] && [ "$outside" -eq 1 ] && [ "$TOML_ENV_FROM" -gt 0 ] && [ "$TOML_ONE_STORE" -eq 1 ]; then
    v="$(toml_scan "$1" 0 0 || true)"
  fi
  printf '%s' "$v"
}

# Domaine env files (process env wins): nearest .claude/domaine.env above cwd — tuning keys only,
# see below — then the global ~/.config/domaine/env; read per key, never sourced. Same dialect as
# scripts/env-file.cjs and hooks/spill-access.sh: leading whitespace and spaces around the `=` are
# allowed, the value is trimmed on both sides (a CRLF file's \r with it), first line wins, and the
# first layer that CARRIES the key wins even when its value is empty. Callers fill an UNSET
# variable only, and read an empty answer as "no value".
domaine_env() {
  local d="$PWD" f pf="" v
  # PROJECT_OK, mirrored by hand from scripts/env-file.cjs: the project file is committable by a
  # client repo, so only these tuning keys are read from it. Every other switch — the guards, the
  # spill dir, the verify gates — comes from the environment or the global file, default-deny.
  case "$1" in
    FND_LEAN|FND_PROFILE|FND_CTX_MONITOR|FND_CTX_WARN|FND_CTX_WINDOW|FND_MCP_SLIM_DEBUG|FND_WHALE_GUIDE|FND_NOGAIN_MEMO|FND_GQL_PROBE_CACHE|FND_CPT_THROTTLE_WAITS|FND_CPT_OVERLAY_VERIFY_WAIT|FND_THEME_JSON_VERIFY_WAIT|SHOPIFY_ADMIN_GQL_QUIET)
      while :; do
        if [ -f "$d/.claude/domaine.env" ]; then pf="$d/.claude/domaine.env"; break; fi
        [ "$d" = "/" ] && break
        d="$(dirname "$d")"
      done ;;
  esac
  for f in "$pf" "${XDG_CONFIG_HOME:-$HOME/.config}/domaine/env"; do
    [ -n "$f" ] && [ -f "$f" ] || continue
    # a carried-but-empty value has to be told apart from "no such line" — hence the `=` sentinel
    # the value is printed behind and stripped off again
    v="$(sed -n "/^[[:space:]]*$1[[:space:]]*=/{
      s/^[^=]*=[[:space:]]*//
      s/[[:space:]]*\$//
      s/^/=/
      p
      q
    }" "$f" 2>/dev/null || true)"
    case "$v" in =*) printf '%s' "${v#=}"; return 0 ;; esac
  done
  return 0
}

# Theme Access token held by the toml: the resolved block's token-shaped password= (see
# toml_value), else the first shp*_… anywhere in the file — but that last resort only where every
# `store =` in the file is the same store, since a token is minted PER STORE and one taken from a
# block naming another store cannot authenticate this run, it can only authenticate the wrong one.
# Prints nothing when it has none and returns 0 either way: the caller owns the "no token" error,
# and a no-match grep must not abort it under set -e
theme_token_from_toml() {
  local t
  t="$(toml_value password || true)"
  case "$t" in shp[a-z]*_[A-Za-z0-9]*) ;; *) t="" ;; esac
  if [ -z "$t" ] && [ "$TOML_ONE_STORE" -eq 1 ]; then
    t="$(grep -oE 'shp[a-z]+_[A-Za-z0-9]+' "$TOML" 2>/dev/null | head -1 || true)"
  fi
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
