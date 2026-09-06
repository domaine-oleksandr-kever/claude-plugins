#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash) — deterministic guard for the Domaine
# commit rule: never bypass git hooks. Models rationalize `--no-verify`
# the moment a pre-commit hook fails on something pre-existing ("not my
# files — bypass"), which also silently skips every other guard the repo
# hooks carry. Blocking the call is the only outcome that can't lose that
# argument; the developer can still bypass by hand in their own terminal.
#
# stdin: PreToolUse event JSON ({"tool_name":"Bash","tool_input":{"command":…}}).
# `command` is a STRING on Claude Code and Cursor and an ARGV ARRAY on Codex's
# shell / local_shell tools — both are normalized to one line below.
# Exit 2 + stderr blocks the call and feeds the message back to the model;
# exit 0 lets it through. A missing or broken `awk`/`sed`/`tr` degrades the
# scan to a shorter pipeline and then to the raw command; a `grep` that cannot
# run swaps the segment matchers for a coarse bash-native rail; an event the
# extraction toolbox cannot read is scanned as raw text. A tool failure must
# never disarm the guard, and must never block a plain commit on its own.
#
# Best-effort by design — tests/no-verify-bypass-matrix.sh is the FP/FN
# contract; run it after any regex change. Known residual FPs: restoring a hook
# by copying a file ONTO it (`cp backup .husky/pre-commit`), which reads the same
# as neutering it, a hook path that ends a copy span as an OPTION's value
# rather than as its destination (`rsync … --exclude .husky`), a hook BACKUP
# whose destination is followed by an option or a comment (`cp .husky/pre-commit
# -t /tmp/`, `cd .husky && cp pre-commit /tmp/bak -v`), which is the same span
# shape as the GNU operand permutation it has to catch, and a non-git-verb
# command carrying the flag as an option token before a `--` (`git grep -n
# --no-verify -- src/`), which reads as an alias invocation; bare prose
# containing `git commit -n` outside quotes (echo args, heredoc bodies);
# `HUSKY=0` in front of a NON-git command in the same line as a commit; a
# `-F -` heredoc body that names a hook file (`-m "<msg>"` is the safe
# spelling — the message span is stripped, the stdin body cannot be); and an
# argv ARRAY whose message element carries whitespace (["git","commit","-m",
# "fix: never use --no-verify"]) — joining the elements loses the argv
# boundary that told the message apart from the flags, so the words after the
# first are read as command text. The `["bash","-lc","<one string>"]` spelling
# Codex's shell tool actually uses keeps its quoting and is unaffected. On a host
# with no working `sed` the raw command stands in for the normalized scan, so a
# commit MESSAGE naming the flag false-blocks. With no working `grep` the
# bash-native rail reads each commit span coarsely, so a hook path or a read-only
# `--get core.hooksPath` next to a commit false-blocks. With the extraction
# toolbox unusable (no jq AND no sed, or no `cat`) the raw event text is scanned,
# whose JSON escapes defeat the message strip — the same message FP as no-sed.
# Known residual FNs: flags smuggled via variable expansion ($FLAG), hook
# config rewritten in an earlier, separate Bash call, a hook path a `|`
# separates from its verb (`… | xargs rm`, a `sed -i` script using `|` as
# its own delimiter), a copy verb outside `cp` / `rsync` / `dd of=` (`scp`,
# macOS `ditto`, GNU `cp -t <hook dir>`, whose destination is not the last
# operand), `-n` bundled onto an alias INVOCATION (`git z -n -m x` — only the
# alias's own definition says whether that is --no-verify), a plain backslash
# inside the flag word (`--no-\verify`
# — the shell drops it, the scan does not; the ANSI-C escape FORMS are
# decoded), and `git` AND the subcommand BOTH split by quoting
# (`g"it" com"mit" -n`) — the fast reject below reads the raw event, where
# that carries no trigger word at all (matrix XQ cases).
set -u

input="$(cat 2>/dev/null || true)"
# A `cat` that cannot run empties the event before any matcher sees it, so the builtin reads
# stdin in its place. No fork and no read on the normal path, where `input` already arrived.
[ -n "$input" ] || IFS= read -r -d '' input || true

# Host-proof log via an EXIT trap: every path out (fast rejects included) is recorded from the
# status this guard actually returned; a missing helper is simply never called. `${0%/*}`, not a
# `dirname` fork — this hook runs on every Bash call.
case "$0" in */*) _ht="${0%/*}/host-trace.sh" ;; *) _ht="./host-trace.sh" ;; esac
[ -f "$_ht" ] && . "$_ht" 2>/dev/null
command -v fnd_trace_on_exit >/dev/null 2>&1 \
  && trap 'fnd_trace_on_exit PreToolUse no-verify-bypass' EXIT

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

# An ARGV ARRAY is joined into one space-separated line before anything below reads it:
# `jq -r` on an array prints one element PER LINE, which puts `git` and its subcommand on
# different lines, and every matcher here is per-line (grep -o) — so the array spelling of a
# bypass would walk straight past all of them. The string path is untouched.
cmd=""
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | jq -r '(.tool_input.command // empty)
    | if type == "array" then map(select(type == "string")) | join(" ") else . end' 2>/dev/null || true)"
fi
if [ -z "$cmd" ]; then
  # No (working) jq: pull the "command" JSON value with sed and unescape
  # just enough to scan. Approximate, but far better than fail-open.
  cmd="$(printf '%s' "$input" | tr '\n' ' ' \
    | sed -nE 's/.*"command"[[:space:]]*:[[:space:]]*"((\\.|[^"\\])*)".*/\1/p' \
    | sed -E 's/\\n/ /g; s/\\t/ /g; s/\\"/"/g; s/\\\\/\\/g' || true)"
fi
if [ -z "$cmd" ]; then
  # …and the array form with that same toolbox: take the bracket span, then join its elements
  # on the JSON element separator. `","` cannot appear unescaped inside a JSON string, so it
  # only ever splits elements. A span holding a bracket of its own (a `[` or `]` inside an
  # argument) is not extractable this way and yields nothing — the fail-closed branch owns it.
  arr="$(printf '%s' "$input" | tr '\n' ' ' \
    | sed -nE 's/.*"command"[[:space:]]*:[[:space:]]*\[([^][]*)\].*/\1/p' || true)"
  if [ -n "$arr" ]; then
    cmd="$(printf '%s' "$arr" \
      | sed -E 's/^[[:space:]]*"//; s/"[[:space:]]*$//; s/"[[:space:]]*,[[:space:]]*"/ /g' \
      | sed -E 's/\\n/ /g; s/\\t/ /g; s/\\"/"/g; s/\\\\/\\/g' || true)"
  fi
fi
if [ -z "$cmd" ]; then
  # An argv array this toolbox could not read is the one unreadable payload that may NOT exit 0:
  # the event is a shell call, and a bracket inside an argument is exactly what a crafted bypass
  # would carry. Blocked only when the raw event names a git verb; every other unreadable
  # payload (no command key at all, a shape nobody has seen) stays fail-open.
  case "$input" in *'"command"'*)
    if printf '%s' "$input" | tr '\n' ' ' | grep -qE '"command"[[:space:]]*:[[:space:]]*\['; then
      case "$input" in *git*|*commit*|*push*|*merge*|*pull*)
        echo "Domaine convention (references/commit-message-format.md): this call carries an argv-array command the fnd commit guard could not parse, so the git command inside it is blocked rather than run unchecked. Re-run it as a single command string (e.g. bash -lc '<command>'). Never bypass the repo git hooks (--no-verify, core.hooksPath, HUSKY=0) — they are quality gates." >&2
        exit 2 ;;
      esac
    fi ;;
  esac
fi
# Neither extraction path could read a payload that nevertheless carries a command: scan the raw
# event text instead of nothing. JSON punctuation only ever adds separators the matchers already
# stop at, and its escapes cost the message strip (a residual FP above), not the verdict.
if [ -z "$cmd" ]; then
  case "$input" in *'"command"'*) cmd="$input" ;; esac
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
# A non-empty command that normalizes to NOTHING means a tool in that pipeline is missing or
# broken, not that there is nothing left to scan — so a shorter pipeline stands in rather than
# leaving every matcher below an empty string to agree with. The strip pass alone still dequotes
# and still drops the message spans (only the continuation join is lost); the raw command keeps
# both, which costs the quote-split spellings and false-blocks a message naming the flag.
if [ -z "$scan" ]; then
  scan="$(printf '%s\n' "$cmd" | strip_msg_spans)"
  [ -n "$scan" ] || scan="$cmd"
fi

# The segment shape and the flag shape are read by two engines — `grep -E` below and bash's own
# `[[ =~ ]]` on the no-grep rail — so each is spelled once: a copy that drifts is a hole nobody sees.
git_seg_re='(^|[^[:alnum:]_.-])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+'
# Down to `--no-v`: git resolves an unambiguous prefix, and `am` — which has no `--verbose` for
# `--no-verbose` to collide with — accepts every prefix the other verbs reject as ambiguous.
no_verify_re='--no-v(e(r(i(f(y)?)?)?)?)?([^[:alnum:]-]|$)'
bundle_re='(^|[[:space:]])-[a-zA-Z]*n[a-zA-Z]*([^[:alnum:]-]|$)'
# The head of an alias DEFINITION, in the spellings git accepts: `-c alias.<name>=<value>`,
# `config [scope…] alias.<name> <value>`, `GIT_CONFIG_PARAMETERS='alias.<name>=<value>'` and the
# GIT_CONFIG_* env pair, whose VALUE carries the definition wherever its KEY sits (the two are
# matched by index, not by order on the line).
# Quotes are already gone by here, so the value simply runs on to the end of the span — its first
# token is the verb the two rules below pair a flag with.
alias_head='((^|[^[:alnum:]_.-])git[[:space:]][^|&;]*alias\.[^[:space:]|&;=]+|(^|[^[:alnum:]_])GIT_CONFIG_PARAMETERS=[^|&;]*alias\.[^[:space:]|&;=]+|(^|[^[:alnum:]_])GIT_CONFIG_VALUE_[0-9]+)[=[:space:]]+'
# A VALUE may open with git global options of its own (`-p commit --no-verify`, `-c core.pager=cat
# commit -n`): git strips them before the verb, so the verb the flag rules pair with is the first
# token that is not one of them. Same shape as $git_seg_re's option run — a dash token plus at most
# one value token — but bounded by the command separators the alias rules read spans between.
alias_opts='(-[^|&;[:space:]]+([[:space:]]+[^-|&;[:space:]][^|&;[:space:]]*)?[[:space:]]+)*'
# The mirror case: an alias INVOCATION spells the flag in the open and hides the VERB instead
# (`git z --no-verify` after `git config alias.z commit`). Any word that is not one of the five
# reads as an alias here — `git rebase --no-verify` blocks with them, which is right, pre-rebase is
# a hook too. Only --no-verify pairs with such a word: `-n` means whatever the alias's own
# definition makes it mean, which nothing on this line can know. The flag has to stand as its own
# token, and not behind a bare `--`: after that marker git reads arguments as paths and patterns
# (`git grep -- --no-verify`, `git checkout -- --no-verify.txt`), never as options.
alias_invoke_re="$git_seg_re[^-|&;[:space:]][^|&;[:space:]]*([[:space:]]+(-?[^-|&;[:space:]][^|&;[:space:]]*|--[^|&;[:space:]]+))*[[:space:]]+$no_verify_re"
# Isolate each `git … <subcommand> …` segment. Any run of global options
# may sit between git and the subcommand — each a dash token plus at most one value
# token (-C <path>, -c <k>=<v>, --git-dir=…). grep -o is per-line, so heredoc
# bodies on later lines never match; the leading boundary keeps `legit commit` out
# while allowing /usr/bin/git, `\git`, `$(git …)`. $1 is interpolated into the ERE, so
# an alternation has to arrive PARENTHESIZED or it would split the whole pattern.
git_segments() { # $1 = subcommand (ERE)
  printf '%s' "$scan" \
    | grep -oE "$git_seg_re$1[^|&;]*" || true
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
# Every matcher below the segment split is a grep, so empty segments on a host whose grep cannot
# run mean the tool failed — not that the command is clean. A grep that is ABSENT and one that
# exits nonzero leave the same empty result, so the probe is a real grep rather than a PATH
# lookup; the two cheap tests in front keep that fork off the normal path (segments are non-empty
# there, and the regex needs a git verb). The plain spellings then get a bash-native rail instead
# of a free pass — spans coarser than the segments a grep would cut, so it over-blocks rather
# than under-blocks. nocasematch because git reads config keys case-insensitively and HUSKY is
# spelled in caps.
# An alias definition joins the gate on its own: it carries no commit segment for the first half
# to match, and it is exactly where the coarse rail's flag test earns its keep.
nogrep_seg="$git_seg_re(commit|push|merge|am|pull)|$alias_head|$alias_invoke_re"
if [ -z "$segs$psegs$msegs" ] && [[ $scan =~ $nogrep_seg ]] && ! printf 'g\n' | grep -q g 2>/dev/null; then
  shopt -s nocasematch 2>/dev/null || true
  nogrep_bundle='(^|[[:space:]])-[[:alpha:]]*n[[:alpha:]]*([^[:alnum:]-]|$)'
  nogrep_disable='(core\.hookspath|\.husky|\.git/hooks|husky=0)'
  # `-n` is --no-verify on a commit and something else everywhere else, so the bundle test walks
  # the commit spans the way git_segments would: read against the whole scan it takes a
  # neighbouring `git log -n 5`, `git push -n` or `find -name` for a bypass. Parameter expansion,
  # not `[[ ]]`, so nocasematch cannot make the loop match a word it then fails to strip.
  bundled=""
  rest="$scan"
  while [ "$rest" != "${rest#*[Cc]ommit}" ]; do
    rest="${rest#*[Cc]ommit}"
    span="${rest%%[\|\&\;]*}"
    [[ $span =~ $nogrep_bundle ]] && { bundled=1; break; }
  done
  if [[ $scan =~ $no_verify_re ]] || [[ $scan =~ $nogrep_disable ]] || [ -n "$bundled" ]; then
    echo "Domaine convention (references/commit-message-format.md): git hooks are quality gates — never commit, push, merge or am with --no-verify (-n on a commit), and never disable them (core.hooksPath, .husky / .git/hooks, HUSKY=0). This host has no working \`grep\`, so the guard is running a reduced text scan that cannot tell a commit message apart from the command: if those words only appear inside your -m message, rephrase it — otherwise re-run the plain git command and let the hooks run." >&2
    exit 2
  fi
  shopt -u nocasematch 2>/dev/null || true
fi
# An alias hides the flag in its VALUE, where the segment split above can never find it: after
# `git -c alias.z="commit --no-verify" z`, `git config alias.z "commit -n"` or the GIT_CONFIG_*
# env pair that spells the same definition, the invoked verb is the alias NAME, and nothing on the
# line reads as a commit segment. The value's first token is the git verb, so the flag rules pair
# with it exactly as they do on a real segment — the -n bundle on commit only, --no-verify on any
# of them. $scan, not $cmd: a -m message quoting an alias definition has already been stripped,
# which keeps this off the prose path.
alias_bypass=""
case "$scan" in *[Aa][Ll][Ii][Aa][Ss].*)
  printf '%s' "$scan" | grep -qiE -- \
    "$alias_head$alias_opts(commit|push|merge|am|pull)[^|&;]*($no_verify_re)|$alias_head${alias_opts}commit[^|&;]*($bundle_re)" \
    && alias_bypass=1 ;;
esac
# …and the invocation side of the same move, which needs no `alias` word on the line at all — the
# definition may have run in an earlier call. Gated on the flag's own opening, so the ordinary
# commit path never pays this grep.
case "$scan" in *no-v*)
  printf '%s' "$scan" | grep -qE -- "$alias_invoke_re" && alias_bypass=1 ;;
esac
[ -n "$segs$psegs$msegs$alias_bypass" ] || exit 0

# --no-verify — including the prefixes git accepts (--no-v…) — skips the
# pre-commit hooks on a commit, the pre-push hook on a push, and the commit-msg /
# pre-merge-commit hooks on a merge, an `am` or a pull. `-n` in a short-flag bundle
# (-n / -an / -anm) is that same flag for `git commit` ONLY: elsewhere it is another
# option entirely (--dry-run on push, --no-stat on merge and pull), so the bundle rule
# stays on the commit segments. Double-dash options never match the bundle pattern,
# which is what keeps `--no-verify-signatures` — a pull/fetch flag about GPG, not hooks —
# out of both (the trailing boundary rejects the `-` that follows it).
if [ -n "$alias_bypass" ] \
  || printf '%s\n%s\n%s' "$segs" "$psegs" "$msegs" | grep -qE -- "$no_verify_re" \
  || printf '%s' "$segs" | grep -qE -- "$bundle_re"; then
  echo "Domaine convention (references/commit-message-format.md): git hooks are quality gates — never commit, push, merge or am with --no-verify (-n on a commit), in any flow, and never hide one behind a git alias — neither in its definition nor on its invocation. Re-run the same git command and let the hooks run. If a hook fails on a pre-existing repo defect your change didn't touch, report it to the developer (in auto flows: ESCALATE) instead of bypassing — only the developer may bypass, by hand." >&2
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
# Same rule as $scan above: empty out of a non-empty command is a failed tool. The newline
# flattening alone is tried first, then the raw command — whose newlines stay real, which only
# tightens the per-line greps below (a span can no longer fuse two lines); what is lost is the
# message strip, so a quoted message naming a hook path can false-block in that state.
if [ -z "$flat" ]; then
  flat="$(printf '%s' "$cmd" | tr '\n' ';')"
  [ -n "$flat" ] || flat="$cmd"
fi

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
#    .husky/pre-commit` is how a hook gets RESTORED, which this must not block. A COPY verb
#    (cp / rsync, and dd's `of=`) is read for its DESTINATION — the last operand — so backing a
#    hook up (`cp .husky/pre-commit /tmp/bak`, `cp -r .husky /tmp/`) stays a read while
#    `cp /dev/null .husky/pre-commit` does not; restoring one with cp is over-blocked, because
#    nothing here can tell the restored bytes from an `exit 0`;
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
# An operand is last when a separator, the end of the span or a REDIRECT follows it: every other
# verb here stays blocked through a trailing `2>/dev/null`, and a copy must not be the one form
# that idiom walks past. A destination that begins with a digit is the redirect's own fd, not a
# file (`cp pre-commit /tmp/bak 2>log`), so the bare form takes a non-digit first character.
# A trailing COMMENT and a trailing option end that operand too — `cp /dev/null .husky/pre-commit
# # x` and, because GNU cp permutes its operands, `cp /dev/null .husky/pre-commit -f`. Both walk
# past a separator-or-redirect-only rule while every other verb here stays blocked through them.
copy_end='([[:space:]]*([0-9]*[<>]|[|&;]|$)|[[:space:]]+(#|-[[:alnum:]-]))'
copy_dest='(\.husky|\.git/hooks)(/[^|&;[:space:]]*)*'"$copy_end" # a hook path as the LAST operand
copy_bare='(cp|rsync)[[:space:]][^|&;]*[[:space:]][^0-9/|&;<>[:space:]][^/|&;<>[:space:]]*'"$copy_end" # …that operand, bare
if printf '%s' "$flat" | grep -qiE \
  "core\.hookspath\
|(^|[^[:alnum:]_.-])($verbs)[[:space:]][^|&;]*$hook_file\
|(^|[^[:alnum:]_.-])(cp|rsync)[[:space:]][^|&;]*$copy_dest\
|(^|[^[:alnum:]_.-])dd[[:space:]][^|&;]*of=[^|&;[:space:]]*$hook_file\
|(^|[^[:alnum:]_.-])chmod([[:space:]]+-[a-zA-Z]+)*[[:space:]]+($chmod_off)[[:space:]][^|&;]*$hook_file\
|(^|[^[:alnum:]_.-])sed[[:space:]]([^|&;]*[[:space:]])?$sed_i[^|&;]*$hook_file\
|(^|[^[:alnum:]_.-])find[[:space:]][^|&;]*$hook_file[^|&;]*(-delete|-exec)\
|(^|[^[:alnum:]_.-])(cd|pushd)[[:space:]]+[^|&;]*$hook_file[^|&;]*[|&;]*[[:space:]]*(($verbs|chmod)[[:space:]]|sed[^|&;]*[[:space:]]$sed_i|$copy_bare|$redir_bare)\
|>[[:space:]]*[^[:space:]|&;]*$hook_file\
|(^|[^[:alnum:]_])HUSKY=0([^[:alnum:]_.-]|$)"; then
  echo "Domaine convention (references/commit-message-format.md): git hooks are quality gates — never disable them to get a commit or push through: no core.hooksPath / GIT_CONFIG_* redirect, no removing / chmod-ing / truncating / overwriting .husky or .git/hooks files, no HUSKY=0. Restore the hooks and re-run the plain git command. If a hook fails on a pre-existing repo defect your change didn't touch, report it to the developer (in auto flows: ESCALATE) — only the developer may bypass, by hand." >&2
  exit 2
fi
exit 0
