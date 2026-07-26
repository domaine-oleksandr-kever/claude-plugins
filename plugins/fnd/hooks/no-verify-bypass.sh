#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash) — deterministic guard for the Domaine
# commit rule: never bypass git hooks. Models rationalize `--no-verify`
# the moment a pre-commit hook fails on something pre-existing ("not my
# files — bypass"), which also silently skips every other guard the repo
# hooks carry. Blocking the call is the only outcome that can't lose that
# argument; the developer can still bypass by hand in their own terminal.
#
# stdin: PreToolUse event JSON ({"tool_name":"Bash","tool_input":{"command":…}}).
# Exit 2 + stderr blocks the call and feeds the message back to the model;
# exit 0 lets it through. A hook failure must never block a commit.
#
# Best-effort by design — tests/no-verify-bypass-matrix.sh is the FP/FN
# contract; run it after any regex change. Known residual FPs: bare prose
# containing `git commit -n` outside quotes (echo args, heredoc bodies);
# `HUSKY=0` in front of a NON-git command in the same line as a commit; a
# `-F -` heredoc body that names a hook file (`-m "<msg>"` is the safe
# spelling — the message span is stripped, the stdin body cannot be).
# Known residual FNs: flags smuggled via variable expansion ($FLAG), hook
# config rewritten in an earlier, separate Bash call, a hook path a `|`
# separates from its verb (`… | xargs rm`, a `sed -i` script using `|` as
# its own delimiter), a plain backslash inside the flag word (`--no-\verify`
# — the shell drops it, the scan does not; the ANSI-C escape FORMS are
# decoded), and `git` AND the subcommand BOTH split by quoting
# (`g"it" com"mit" -n`) — the fast reject below reads the raw event, where
# that carries no trigger word at all (matrix XQ cases).
set -u

input="$(cat 2>/dev/null || true)"

# Fast reject, before the jq/sed/grep pipeline this hook pays on EVERY Bash call:
# every block below sits behind a `git … commit|push|merge|am|pull` segment, so an event
# naming none of these keywords can never reach one. `git` earns its place as a trigger
# on its own: without it a quote-split subcommand (`git com"mit" -n`) walks straight
# past a reject the matchers would have caught. Every subcommand is here too, for the
# mirror case — a quote-split `git` (`g"it" am --no-verify`) whose subcommand still spells
# itself out. `am` is two letters, so it comes with its separator attached, the same
# spelling the `$scan` gate below uses. Glob-only on the RAW event — bash 3.2's
# pattern substitution is quadratic (6 s to strip quotes from a 64 KB command), so
# dequoting here would cost far more than the pipeline it saves; the price is the
# split-`git` FN noted above. A `\u`-escaped keyword only exists after the jq
# decode, so anything carrying one stays in.
case "$input" in *git*|*commit*|*push*|*merge*|*pull*|*" am"*|*$'\t'am*|*\\u*) ;; *) exit 0 ;; esac

cmd=""
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
fi
if [ -z "$cmd" ]; then
  # No (working) jq: pull the "command" JSON value with sed and unescape
  # just enough to scan. Approximate, but far better than fail-open.
  cmd="$(printf '%s' "$input" | tr '\n' ' ' \
    | sed -nE 's/.*"command"[[:space:]]*:[[:space:]]*"((\\.|[^"\\])*)".*/\1/p' \
    | sed -E 's/\\n/ /g; s/\\t/ /g; s/\\"/"/g; s/\\\\/\\/g' || true)"
fi
[ -n "$cmd" ] || exit 0

# Normalize before matching:
# 1. drop the `$` of an ANSI-C/locale quote, so $'-n' reassembles like '-n' does
#    (the shell hands git the same flag either way);
# 2. join backslash-newline continuations (a flag split across lines still counts);
# 3. drop -m/-F/--message/--file argument spans, KEEPING the flag token itself
#    (so a bundled `-nm "msg"` keeps its -n) — commit messages may legitimately
#    mention the banned flags. An UNQUOTED value is one token, and it ends at a
#    command separator as well as at whitespace: `-m wip&&rm -rf .husky` glues the
#    next verb onto the message, and eating it would hide the verb from the
#    disable matchers below;
# 4. decode the ANSI-C escape forms of the bytes those flags are spelled from —
#    $'\x2dn' and $'--no-\x76erify' reach git as -n and --no-verify, so the scan
#    has to read them that way. Hex and octal, the dash plus the letters of the
#    flag word; running AFTER rule 3 keeps a message that SPELLS an escape out
#    (`-m "docs: \x2dn is banned"`) from decoding into one. Nine substitutions is
#    nine passes, so they sit behind an address: a line with no backslash anywhere
#    pays one scan for the whole block instead;
# 5. drop the remaining quote characters, so quoted forms ("-n", --no-'verify',
#    sh -c "git commit -n") reassemble into scannable flags.
strip_msg_spans() { # extra `-e` expressions ride in the same sed pass (one fork, not two)
  sed -E "$@" \
    -e "s/\\\$(['\"])/\\1/g" \
    -e "s/(^|[[:space:]])(-[a-zA-Z]*[mF]|--message|--file)(=|[[:space:]]+)'[^']*'/\1\2/g" \
    -e 's/(^|[[:space:]])(-[a-zA-Z]*[mF]|--message|--file)(=|[[:space:]]+)"(\\.|[^"\\])*"/\1\2/g' \
    -e 's/(^|[[:space:]])(-[a-zA-Z]*[mF]|--message|--file)(=|[[:space:]]+)[^-|&;[:space:]][^|&;[:space:]]*/\1\2/g' \
    -e '/\\/{
         s/\\([xX]2[dD]|0?55)/-/g
         s/\\([xX]6[eE]|156)/n/g
         s/\\([xX]6[fF]|157)/o/g
         s/\\([xX]76|166)/v/g
         s/\\([xX]65|145)/e/g
         s/\\([xX]72|162)/r/g
         s/\\([xX]69|151)/i/g
         s/\\([xX]66|146)/f/g
         s/\\([xX]79|171)/y/g
       }' \
    -e "s/['\"]//g"
}
scan="$(printf '%s\n' "$cmd" \
  | awk '{ if (sub(/\\$/, "")) printf "%s ", $0; else print }' \
  | strip_msg_spans)"

# Isolate each `git … <subcommand> …` segment. Any run of global options
# may sit between git and the subcommand — each a dash token plus at most one value
# token (-C <path>, -c <k>=<v>, --git-dir=…). grep -o is per-line, so heredoc
# bodies on later lines never match; the leading boundary keeps `legit commit` out
# while allowing /usr/bin/git, `\git`, `$(git …)`. $1 is interpolated into the ERE, so
# an alternation has to arrive PARENTHESIZED or it would split the whole pattern.
git_segments() { # $1 = subcommand (ERE)
  printf '%s' "$scan" \
    | grep -oE "(^|[^[:alnum:]_.-])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+$1[^|&;]*" || true
}
# One grep per subcommand actually named, gated by glob first: a big command (a heredoc writing a
# file) reaches here whenever it happens to contain the three letters of `git`, and each grep is a
# pass over the whole thing. `git merge` (2.36+), `git am` and `git pull` take --no-verify too, and
# it skips the hooks they run — for pull, the ones of the merge it ends with.
segs=""
psegs=""
msegs=""
case "$scan" in *git*)
  case "$scan" in *commit*) segs="$(git_segments commit)" ;; esac
  case "$scan" in *push*) psegs="$(git_segments push)" ;; esac
  # `am` is two letters, so it is tested with its separator attached — spelled out rather than as
  # [[:space:]], which bash 3.2 matches an order of magnitude slower (25 ms vs 3 on a 200 KB command).
  # A newline cannot be that separator: grep -o below matches per line.
  case "$scan" in *merge*|*pull*|*" am"*|*$'\t'am*) msegs="$(git_segments '(merge|am|pull)')" ;; esac
  ;;
esac
[ -n "$segs$psegs$msegs" ] || exit 0

# --no-verify — including the unique prefixes git accepts (--no-veri…) — skips the
# pre-commit hooks on a commit, the pre-push hook on a push, and the commit-msg /
# pre-merge-commit hooks on a merge, an `am` or a pull. `-n` in a short-flag bundle
# (-n / -an / -anm) is that same flag for `git commit` ONLY: elsewhere it is another
# option entirely (--dry-run on push, --no-stat on merge and pull), so the bundle rule
# stays on the commit segments. Double-dash options never match the bundle pattern,
# which is what keeps `--no-verify-signatures` — a pull/fetch flag about GPG, not hooks —
# out of both (the trailing boundary rejects the `-` that follows it).
if printf '%s\n%s\n%s' "$segs" "$psegs" "$msegs" | grep -qE -- '--no-veri(fy|f)?([^[:alnum:]-]|$)' \
  || printf '%s' "$segs" | grep -qE -- '(^|[[:space:]])-[a-zA-Z]*n[a-zA-Z]*([^[:alnum:]-]|$)'; then
  echo "Domaine convention (references/commit-message-format.md): git hooks are quality gates — never commit, push, merge or am with --no-verify (-n on a commit), in any flow. Re-run the same git command and let the hooks run. If a hook fails on a pre-existing repo defect your change didn't touch, report it to the developer (in auto flows: ESCALATE) instead of bypassing — only the developer may bypass, by hand." >&2
  exit 2
fi

# Disabling the hooks instead of skipping them — same rule, stronger form. Checked
# against the whole command, not per segment, so `<disable> && git commit` can't slip
# through the split. Newlines become `;` rather than spaces: that keeps a multi-line
# quoted message strippable (a per-line strip can't reach it) while still stopping the
# span matchers below at a line boundary, so `rm -rf node_modules⏎…⏎ls .husky` is not
# read as one `rm … .husky`. Read-only `git config` forms are removed first: they NAME
# core.hooksPath without changing it. Two spellings, both of which may carry a run of
# scope flags (`--local --get`, `-f <file> --get`): the read FLAG plus at most one key
# token, and the flagless 2-arg read — recognized only by having NOTHING after the key,
# so `git config core.hooksPath /dev/null` still trips. A write flag can head the run
# (`--unset core.hooksPath`) without being exempted, because a `--get` still has to
# follow it, which is also what keeps `--get core.hooksPath && git config --replace-all
# core.hooksPath …` blocked. The separator that ended a flagless read is kept: dropping
# it would fuse two spans into one for the matchers below. The key is spelled in
# character classes because git reads config keys case-insensitively and so does the
# matcher these exempt from — a `core.hookspath` read must not land in it.
hooks_key='[Cc][Oo][Rr][Ee]\.[Hh][Oo][Oo][Kk][Ss][Pp][Aa][Tt][Hh]'
flat="$(printf '%s' "$cmd" | tr '\n' ';' \
  | strip_msg_spans \
    -e 's/config([[:space:]]+-[a-zA-Z-]+([[:space:]]+[^-|&;[:space:]][^|&;[:space:]]*)?)*[[:space:]]+--get[a-z-]*([[:space:]]+[^-|&;[:space:]][^|&;[:space:]]*)?//g' \
    -e "s/config([[:space:]]+--(local|global|system|worktree))*[[:space:]]+$hooks_key([[:space:]]*[|&;])/\\3/g" \
    -e "s/config([[:space:]]+--(local|global|system|worktree))*[[:space:]]+$hooks_key[[:space:]]*\$//")"

# Every disable form below names a hook path or husky itself, so a command mentioning neither
# substring is done here — that keeps the grep below off the ordinary `git commit -m …` path.
# Read on the DEQUOTED text, the same text those matchers read: a quote split inside the word
# (`core.ho"oks"Path`, `.hus"ky"`) leaves the raw command naming neither substring, and the
# early exit would hand back the bypass the matchers were about to catch. The normalize pass
# it now sits behind is one fork, paid only by commands that reached this far — a command with
# no git commit/push/merge/am/pull segment left above.
shopt -s nocasematch 2>/dev/null || true
case "$flat" in *hooks*|*husky*) ;; *) exit 0 ;; esac

# Forms of the same move, one pass (the clean path pays one grep):
# 1. redirecting hooks away — core.hooksPath via -c / git config / GIT_CONFIG_* env;
# 2. deleting or neutering the hook FILES. Only MUTATING verbs and redirect targets count,
#    so reading a hook (`cat .husky/pre-commit`) stays fine, and the trailing boundary keeps
#    neighbours like `.git/hooks-report.txt` out. `sed`/`find` are mutating only in their
#    in-place / -delete / -exec forms, and each flag is matched at a token boundary so the
#    `-commit` inside a hook PATH can never read as one. chmod is read for its MODE — one
#    that clears the execute bit (a symbolic form carrying `-…x` and no `+`, an `=` form
#    that omits x, or an octal whose every digit is even) — because `chmod +x
#    .husky/pre-commit` is how a hook gets RESTORED, which this must not block;
# 3. `cd` into a hook directory, which separates the verb from the path the rules above pair:
#    the verb has to be the FIRST thing after it, so `cd .husky && ls` stays fine. A redirect
#    counts as one of those verbs — `: > pre-commit`, a bare `> pre-commit`, `echo "" >
#    pre-commit` all empty the file without naming a verb at all. Its target must be a BARE
#    name, the only kind that resolves inside the directory cd landed in: `ls > /tmp/out` after
#    a cd writes somewhere else entirely, and blocking that would be a pure FP;
# 4. HUSKY=0, husky's own kill switch.
# Case-insensitive throughout: config keys are (CORE.HOOKSPATH), and matching a lowercase
# `husky=0` — which would not actually disable anything — is a cheaper price than a second pass.
hook_file='(\.husky|\.git/hooks)([^[:alnum:]_.-]|$)'
verbs='rm|mv|truncate|unlink|shred|ln|tee|install'
chmod_off='[^[:space:]+]*-[^[:space:]+]*x|[ugoa]*=[^x[:space:]]*|[0-7]?[0246][0246][0246]'
sed_i='(-[a-zA-Z]*i|--in-place)([[:space:]]|=|\.)' # -i, -i.bak, -ni, --in-place=
redir_bare='[^|&;>]*>[[:space:]]*[^/|&;[:space:]]'  # … > pre-commit, but not … > /tmp/out
if printf '%s' "$flat" | grep -qiE \
  "core\.hookspath\
|(^|[^[:alnum:]_.-])($verbs)[[:space:]][^|&;]*$hook_file\
|(^|[^[:alnum:]_.-])chmod([[:space:]]+-[a-zA-Z]+)*[[:space:]]+($chmod_off)[[:space:]][^|&;]*$hook_file\
|(^|[^[:alnum:]_.-])sed[[:space:]]([^|&;]*[[:space:]])?$sed_i[^|&;]*$hook_file\
|(^|[^[:alnum:]_.-])find[[:space:]][^|&;]*$hook_file[^|&;]*(-delete|-exec)\
|(^|[^[:alnum:]_.-])(cd|pushd)[[:space:]]+[^|&;]*$hook_file[^|&;]*[|&;]*[[:space:]]*(($verbs|chmod)[[:space:]]|sed[^|&;]*[[:space:]]$sed_i|$redir_bare)\
|>[[:space:]]*[^[:space:]|&;]*$hook_file\
|(^|[^[:alnum:]_])HUSKY=0([^[:alnum:]_.-]|$)"; then
  echo "Domaine convention (references/commit-message-format.md): git hooks are quality gates — never disable them to get a commit or push through: no core.hooksPath / GIT_CONFIG_* redirect, no removing / chmod-ing / truncating / overwriting .husky or .git/hooks files, no HUSKY=0. Restore the hooks and re-run the plain git command. If a hook fails on a pre-existing repo defect your change didn't touch, report it to the developer (in auto flows: ESCALATE) — only the developer may bypass, by hand." >&2
  exit 2
fi
exit 0
