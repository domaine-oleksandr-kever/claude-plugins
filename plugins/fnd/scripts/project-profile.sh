#!/usr/bin/env bash
# project-profile.sh — what KIND of checkout a directory is, in one word.
#
#   usage   project-profile.sh [dir]        (default: the working directory)
#   out     exactly one of foundation|theme|none on stdout, exit 0
#   errors  a `dir` that is not a directory → `error=no_such_dir dir=<path>` on stderr, exit 2; more than one argument → usage on stderr, exit 2
#   switch  FND_PROFILE forces the answer — process env (an exported EMPTY value counts as set), else the nearest `.claude/domaine.env` walking up the PHYSICAL path, else `~/.config/domaine/env`; anything but the three words falls back to detection and warns on stderr
#
# Every host's session wiring and hooks/subagent-conventions.sh re-validate the word this prints
# against those same three values, so no wiring re-implements the detection in a one-liner.
# FAIL-OPEN: a session-start probe may never cost a caller its session — what it cannot read is
# simply not a marker. Builtins only: it survives `set -u` and a stripped environment.
set -u
unset CDPATH 2>/dev/null || CDPATH=

# JS `String.trim()` strips U+FEFF, so a BOM'd first line has to parse the same way here.
printf -v _ppbom '\357\273\277'

# Trim ASCII whitespace off both ends of $1 into `_ppv` — the env-file.cjs dialect's trim, not
# the shell's word splitting, so a caller's exotic IFS cannot change what a config line means.
_pp_trim() {
  _ppv="${1:-}"
  while :; do case "$_ppv" in [[:space:]]*) _ppv="${_ppv#?}" ;; *) break ;; esac; done
  while :; do case "$_ppv" in *[[:space:]]) _ppv="${_ppv%?}" ;; *) break ;; esac; done
}

# The first FND_PROFILE assignment in $1 → `_ppval`; returns 0 when the file CARRIES the key
# (empty value included — that layer still wins, as it does for every other switch), 1 when it
# does not. `while … done < file` needs no subshell and `read` is a builtin, so a lookup on a
# hot path forks nothing. The braces put fd 2 on /dev/null before the redirection is attempted:
# an unreadable file must cost this probe nothing but its layer.
_pp_read() {
  _ppval=""
  { [ -f "$1" ] && [ -r "$1" ]; } || return 1
  { while IFS= read -r _ppl || [ -n "$_ppl" ]; do
      case "$_ppl" in *FND_PROFILE*) ;; *) continue ;; esac
      _ppl="${_ppl#"$_ppbom"}"
      _pp_trim "$_ppl"; _ppl="$_ppv"
      case "$_ppl" in ''|'#'*) continue ;; esac
      case "$_ppl" in *=*) ;; *) continue ;; esac
      _pp_trim "${_ppl%%=*}"
      [ "$_ppv" = FND_PROFILE ] || continue
      _pp_trim "${_ppl#*=}"
      _ppval="$_ppv"
      return 0
    done < "$1"; } 2>/dev/null
  return 1
}

# The PHYSICAL directory of $1 into `_ppv`: env-file.cjs's projectPath() resolves against
# process.cwd(), which the kernel reports physically, so only `cd -P` finds the same
# `.claude/domaine.env` files both readers see. `cd` is a builtin — no fork on a hot path.
_pp_resolve() {
  _ppold="${PWD:-}"
  if cd -P -- "$1" 2>/dev/null; then
    _ppv="$PWD"
    [ -n "$_ppold" ] && { cd -- "$_ppold" 2>/dev/null || :; }
  else
    case "$1" in /*) _ppv="$1" ;; *) _ppv="${_ppold:-.}/$1" ;; esac
  fi
}

if [ "$#" -gt 1 ]; then
  printf 'usage: project-profile.sh [dir]\n' >&2
  exit 2
fi
dir="${1-.}"
if [ ! -d "$dir" ]; then
  printf 'error=no_such_dir dir=%s\n' "$dir" >&2
  exit 2
fi
_pp_resolve "$dir"; _ppdir="$_ppv"

# An exported-but-EMPTY FND_PROFILE is a value the process env carries, so the file layers are
# not consulted at all — that is env-file.cjs's `process.env[key] === undefined` gate, and the
# empty word then falls through to detection below.
profile="${FND_PROFILE-}"
if [ -z "${FND_PROFILE+x}" ]; then
  # The NEAREST existing `.claude/domaine.env` IS the project layer, whether or not it carries
  # this key — env-file.cjs reads that one file and then the global one, so a walk that kept
  # climbing would let an ancestor's file govern a checkout whose own file is simply silent about
  # the profile. 50 hops is env-file.cjs's own ceiling.
  _ppd="$_ppdir"
  _ppi=0; _ppfound=0
  while [ "$_ppi" -lt 50 ]; do
    if [ -e "$_ppd/.claude/domaine.env" ]; then
      if _pp_read "$_ppd/.claude/domaine.env"; then profile="$_ppval"; _ppfound=1; fi
      break
    fi
    [ "$_ppd" = / ] && break
    _ppd="${_ppd%/*}"; [ -n "$_ppd" ] || _ppd=/
    _ppi=$((_ppi + 1))
  done
  # Only when no project layer carried the key at all — one that carries it EMPTY still wins,
  # the way it does for every other switch in this dialect.
  if [ "$_ppfound" -eq 0 ] && _pp_read "${XDG_CONFIG_HOME:-${HOME:-}/.config}/domaine/env"; then
    profile="$_ppval"
  fi
fi

case "$profile" in
  '') ;;
  foundation|theme|none) printf '%s\n' "$profile"; exit 0 ;;
  *) printf 'warn=bad_profile value=%s — detecting\n' "$profile" >&2 ;;
esac

# Detection climbs like the env layer does, so a hook running in a subdirectory answers about the
# checkout rather than about the folder it happens to stand in — and stops at the repo boundary,
# because a marker outside this repo describes somebody else's project. Globs, not `find`: the
# markers all sit at a fixed depth, and an unmatched pattern stays literal, which no `-f` accepts.
_ppd="$_ppdir"
_ppi=0
while [ "$_ppi" -lt 50 ]; do
  for _ppp in "$_ppd"/snippets/@*.liquid "$_ppd"/sections/core-*.liquid "$_ppd"/blocks/core-*.liquid; do
    if [ -f "$_ppp" ]; then printf 'foundation\n'; exit 0; fi
  done
  if [ -d "$_ppd/src/entry/core" ]; then printf 'foundation\n'; exit 0; fi
  if [ -f "$_ppd/layout/theme.liquid" ]; then printf 'theme\n'; exit 0; fi
  [ -e "$_ppd/.git" ] && break
  [ "$_ppd" = / ] && break
  _ppd="${_ppd%/*}"; [ -n "$_ppd" ] || _ppd=/
  _ppi=$((_ppi + 1))
done
printf 'none\n'
exit 0
