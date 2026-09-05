#!/usr/bin/env bash
# FP/FN contract for the two PreToolUse git guards — every way past the repo's hooks
# (the flag in any spelling, a config redirect, a disabled hook file) and AI attribution:
#   plugins/fnd/hooks/no-verify-bypass.sh   (B/A/R/J/D cases; XP/XQ pin the fast rejects)
#   plugins/fnd/hooks/no-ai-attribution.sh  (N/M/NJ cases)
# Every regex change to either hook re-runs this matrix: `block` rows are the
# bypasses that must stay closed (false negatives), `allow` rows are the
# legitimate commands that must stay unblocked (false positives).
# The whole set runs TWICE per hook — once against the shipped hook, once against
# a copy with the fast rejects stripped out (`nopre-` labels). They are hot-path
# optimizations, so both runs must reach the same verdict on every row — with ONE
# deliberate exception, the XQ pair at the end, where the reject is what leaves the
# bypass open and both verdicts are pinned so a change of mind is conscious.
# Exit 0 = matrix green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/plugins/fnd/hooks/no-verify-bypass.sh"
HOOK_ATTR="$ROOT/plugins/fnd/hooks/no-ai-attribution.sh"
CUR_HOOK="$HOOK"
BASH_BIN="$(command -v bash)"
LBL=""

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

pass=0
fail=0
failures=""

check() { # $1 block|allow  $2 label  $3 command string
  local expect="$1" label="$LBL$2" cmd="$3" ec=0 want=0
  jq -n --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}' \
    | "$BASH_BIN" "$CUR_HOOK" >/dev/null 2>&1 || ec=$?
  [ "$expect" = block ] && want=2
  if [ "$ec" -eq "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failures="${failures}  [$label] expected $expect (exit $want), got exit $ec :: $cmd
"
  fi
}

raw() { # $1 block|allow  $2 label  $3 raw stdin  [$4 PATH override]
  local expect="$1" label="$LBL$2" input="$3" path="${4-}" ec=0 want=0
  if [ -n "$path" ]; then
    printf '%s' "$input" | PATH="$path" "$BASH_BIN" "$CUR_HOOK" >/dev/null 2>&1 || ec=$?
  else
    printf '%s' "$input" | "$BASH_BIN" "$CUR_HOOK" >/dev/null 2>&1 || ec=$?
  fi
  [ "$expect" = block ] && want=2
  if [ "$ec" -eq "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failures="${failures}  [$label] expected $expect (exit $want), got exit $ec :: $input
"
  fi
}

# No jq on PATH → sed fallback must still guard (and still not FP). Only shell
# builtins are allowed in a hook's prefilter, so this shim also proves that.
shim="$TMPD/shim"; mkdir -p "$shim"
for t in cat tr sed grep awk; do ln -s "$(command -v "$t")" "$shim/$t"; done

# One PATH per casualty of the normalization pipeline (D cases). The first group keeps jq: reading
# the command out of the event is the J rows' business, these pin the SCAN pipeline behind it. The
# last three take the EXTRACTION toolbox apart instead — `nojqsed` / `nojqtr` drop jq so the sed
# fallback owns the read and then lose one half of it, `nocat` keeps jq but removes the reader in
# front of it. A tool that is present but BROKEN is the same failure as an absent one — `awk` and
# `grep` here are stubs that exit 3, the shape that shipped these rails — because an empty result,
# not the PATH lookup, is what the hook has to treat as failure.
mkshim() { # $1 dirname  $2… tools to link  → prints the dir
  local d="$TMPD/$1"; shift; mkdir -p "$d"
  local t; for t in "$@"; do ln -s "$(command -v "$t")" "$d/$t"; done
  printf '%s' "$d"
}
noawk="$(mkshim noawk cat tr sed grep jq)"
brokenawk="$(mkshim brokenawk cat tr sed grep jq)"
printf '#!/bin/sh\nexit 3\n' > "$brokenawk/awk"; chmod +x "$brokenawk/awk"
nosed="$(mkshim nosed cat tr grep awk jq)"
notr="$(mkshim notr cat sed grep awk jq)"
nogrep="$(mkshim nogrep cat tr sed awk jq)"
brokengrep="$(mkshim brokengrep cat tr sed awk jq)"
printf '#!/bin/sh\nexit 3\n' > "$brokengrep/grep"; chmod +x "$brokengrep/grep"
nosedgrep="$(mkshim nosedgrep cat tr awk jq)"
nojqsed="$(mkshim nojqsed cat tr grep awk)"
nojqtr="$(mkshim nojqtr cat sed grep awk)"
nocat="$(mkshim nocat tr sed grep awk jq)"

str_ev() { # a Claude-shaped event for a command STRING — check(), for rows that need a PATH override
  jq -nc --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}'
}

# The no-fast-reject twin: every fast reject in both hooks is one `case … esac` line, so dropping
# those lines yields the same hook with none of them. TWO lines go per hook — for no-ai-attribution
# both stdin prefilters, for no-verify-bypass the stdin prefilter AND the in-flow `hooks|husky`
# reject in front of the disable matchers — so the count is asserted exactly: a new reject that
# lands here without a matrix row would otherwise ride untested.
strip_prefilter() { # $1 hook  $2 output  $3 expected removed-line count
  sed '/) exit 0 ;; esac$/d' "$1" > "$2"
  chmod +x "$2"
  local gone=$(( $(grep -c . "$1") - $(grep -c . "$2") ))
  if [ "$gone" -eq "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failures="${failures}  [prefilter-strip-$(basename "$1")] removed $gone fast-reject lines, expected $3
"
  fi
}

no_verify_cases() {
  # --- must BLOCK (closed bypasses) ------------------------------------------
  check block B01-plain-long        'git commit --no-verify -m "x"'
  check block B02-plain-short       'git commit -n -m "x"'
  check block B03-bundled           'git commit -anm "wip"'
  check block B04-quoted-flag       'git commit "-n" -m "x"'
  check block B05-quote-split-flag  "git commit --no-'verify' -m x"
  check block B06-quoted-C-arg      'git -C "." commit -n'
  check block B07-hooksPath-c       'git -c core.hooksPath=/dev/null commit -m x'
  check block B08-hooksPath-env     'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x'
  check block B09-sh-wrap           'sh -c "git commit -n -m x"'
  check block B10-line-continuation $'git commit \\\n  --no-verify -m x'
  check block B11-prefix-verif      'git commit --no-verif -m x'
  check block B12-prefix-veri       'git commit --no-veri -m x'
  check block B13-hooksPath-config  'git config core.hooksPath /dev/null && git commit -m x'
  check block B14-amend             'cd repo && git commit --amend -n'
  check block B15-c-option-run      'git -c commit.gpgsign=false commit -n'
  check block B16-git-dir           'git --git-dir=.git commit --no-verify'
  check block B17-env-prefix        'env git commit -n -m wip'
  check block B18-flag-after-msg    'git commit -m "real msg" -n'
  check block B19-compound          'git stash && git commit -n -m wip'
  check block B20-bare-global-opt   'git -p commit -n'
  check block B21-cmd-subst         'echo "$(git commit -n)"'
  # Documented residual FP, asserted so a fix is a conscious matrix update:
  check block B22-residual-prose-fp 'echo git commit -n is banned'
  # push bypasses the pre-push hook the same way (long form only — see A23–A25)
  check block B23-push-long         'git push --no-verify'
  check block B24-push-long-opts    'git push --force-with-lease --no-verify origin main'
  check block B25-push-prefix       'git push --no-veri origin main'
  check block B26-push-sh-wrap      'sh -c "git push --no-verify"'
  check block B27-push-C-option     'git -C . push --no-verify'
  # `git pull` takes the flag too and skips the hooks of the merge it ends with (long form only)
  check block B27a-pull-long        'git pull --no-verify'
  check block B27b-pull-prefix      'git pull --no-veri'
  # ANSI-C quoting of the flag ($'-n' reaches git as -n)
  check block B28-ansic-short       "git commit \$'-n' -m x"
  check block B29-ansic-long        "git commit \$'--no-verify' -m x"
  check block B30-ansic-split       "git commit --no\$'-verify' -m x"
  # …and its escape forms: the shell hands git the decoded byte, so the scan decodes them too
  check block B30a-ansic-hex-dash   "git commit \$'\\x2dn' -m x"
  check block B30b-ansic-octal-dash "git commit \$'\\055n' -m x"
  check block B30c-ansic-hex-letter "git commit \$'--no-\\x76erify' -m x"
  # removing / disabling the hooks in the same command
  check block B31-rm-husky          'rm .husky/pre-commit && git commit -m "x"'
  check block B32-rm-git-hooks      'rm -f .git/hooks/pre-commit && git commit -m "x"'
  check block B33-chmod-husky       'chmod -x .husky/pre-commit && git commit -m "x"'
  check block B34-chmod-git-hooks   'chmod -x .git/hooks/pre-commit && git commit -m x'
  check block B35-mv-husky          'mv .husky/pre-commit /tmp/ && git commit -m x'
  check block B36-dot-slash-husky   'rm ./.husky/pre-commit && git commit -m x'
  check block B37-truncate-husky    ': > .husky/pre-commit && git commit -m x'
  check block B38-newline-rm-husky  $'rm .husky/pre-commit\ngit commit -m x'
  check block B39-rm-husky-dir      'rm -rf .husky && git commit -m x'
  check block B40-rm-husky-push     'rm .husky/pre-push && git push origin main'
  check block B41-chmod-glob-hooks  'chmod -x .git/hooks/* && git commit -m x'
  check block B41a-chmod-octal      'chmod 644 .husky/pre-commit && git commit -m x'
  check block B41b-chmod-recursive  'chmod -R -x .git/hooks && git commit -m x'
  # symbolic chmod modes clear the execute bit exactly like `-x` does
  check block B41c-chmod-a-x        'chmod a-x .husky/pre-commit && git commit -m x'
  check block B41d-chmod-u-x        'chmod u-x .git/hooks/pre-commit && git commit -m x'
  check block B41e-chmod-ugo-x      'chmod ugo-x .husky/pre-commit && git commit -m x'
  check block B41f-chmod-R-a-x-push 'chmod -R a-x .husky && git push origin main'
  check block B41g-chmod-assign-r   'chmod a=r .git/hooks/pre-commit && git commit -m x'
  check block B41h-chmod-quoted-a-x 'chmod "a-x" .husky/pre-commit && git commit -m x'
  # the rest of the mutating-verb list, one row each (a verb no row exercises is a verb that can rot)
  check block B41i-truncate-hook    'truncate -s 0 .husky/pre-commit && git commit -m x'
  check block B41j-unlink-hook      'unlink .husky/pre-commit && git commit -m x'
  check block B41k-shred-hook       'shred -u .git/hooks/pre-commit && git commit -m x'
  # in-place writers neuter a hook without deleting it
  check block B41l-ln-hook          'ln -sf /bin/true .git/hooks/pre-commit && git commit -m x'
  check block B41m-tee-hook         'printf "exit 0" | tee .husky/pre-commit && git commit -m x'
  check block B41n-install-hook     'install -m 000 /dev/null .husky/pre-commit && git commit -m x'
  check block B41o-sed-inplace      'sed -i "" -e "1s/.*/exit 0/" .husky/pre-commit && git commit -m x'
  check block B41p-find-delete      'find .git/hooks -name "pre-*" -delete && git commit -m x'
  check block B41q-find-exec-rm     $'find .git/hooks -type f -exec rm {} \\;\ngit commit -m x'
  # cd into the hook dir splits the verb from the path — the verb still follows immediately
  check block B41r-cd-then-rm       'cd .husky && rm pre-commit && cd .. && git commit -m x'
  check block B41s-cd-then-chmod    $'cd .git/hooks; chmod a-x pre-commit\ngit commit -m x'
  check block B41t-pushd-then-rm    'pushd .git/hooks && rm pre-commit && git commit -m x'
  check block B41u-cd-then-sed-i    'cd .husky && sed -i "" -e "1s/a/b/" pre-commit && git commit -m x'
  # …and a redirect is the verb-less way to empty the file it lands in (A52a keeps the outside one out)
  check block B41aa-cd-then-truncate 'git commit -m x && cd .git/hooks && : > pre-commit'
  check block B41ab-cd-bare-redirect 'cd .husky && > pre-commit && git commit -m x'
  check block B41ac-cd-echo-redirect 'cd .git/hooks && echo "" > pre-commit && git commit -m x'
  # an UNQUOTED -m value ends at a command separator, so a glued one cannot swallow the next verb
  check block B41ad-glued-amp-then-rm 'git commit -m wip&&rm -rf .husky&&git commit -m real'
  check block B41ae-semi-then-rm      'git commit -m x;rm -rf .husky'
  check block B41v-sed-i-suffix     'sed -i.bak -e "s/a/b/" .git/hooks/pre-commit && git commit -m x'
  check block B41w-sed-in-place     'sed --in-place -e "s/a/b/" .husky/pre-commit && git commit -m x'
  check block B41x-chmod-000        'chmod 000 .husky/pre-commit && git commit -m x'
  check block B41y-chmod-go-x       'chmod go-x .husky/pre-commit && git commit -m x'
  check block B41z-chmod-upper      'chmod A-X .HUSKY/pre-commit && git commit -m x'
  # HUSKY=0 disables husky's hooks without touching a file
  check block B42-husky-env         'HUSKY=0 git commit -m "x"'
  check block B43-husky-env-export  'export HUSKY=0; git commit -m x'
  check block B44-husky-env-quoted  'HUSKY="0" git commit -m x'
  check block B45-husky-env-push    'HUSKY=0 git push origin main'
  # config WRITES to core.hooksPath stay blocked (the read-only exemption must not reach them)
  check block B46-hooksPath-unset   'git config --unset core.hooksPath && git commit -m x'
  check block B47-hooksPath-replace 'git config --replace-all core.hooksPath /dev/null && git commit -m x'
  check block B48-hooksPath-get-write 'git config --get core.hooksPath && git config core.hooksPath /tmp/h && git commit -m x'
  check block B49-hooksPath-scoped-write 'git config --local core.hooksPath /dev/null && git commit -m x'
  check block B49a-hooksPath-scoped-unset 'git config --global --unset core.hooksPath && git commit -m x'
  check block B49b-hooksPath-add     'git config --add core.hooksPath /tmp/x && git commit -m x'
  check block B49c-hooksPath-eq      'git config --local core.hooksPath=/tmp/x && git commit -m x'
  check block B49d-hooksPath-read-write $'git config --local --get core.hooksPath\ngit config --local core.hooksPath /tmp/x\ngit commit -m x'
  # a quote SPLIT inside the key / path word — the gate in front of these matchers reads the same
  # dequoted text they do, so a split cannot buy an early exit
  check block B49e-split-hooksPath-c     'git -c "core.ho"oksPath=/dev/null commit -m x'
  check block B49f-split-hooksPath-config 'git config --local core.hook"s"Path /dev/null && git commit -m x'
  check block B49g-split-hooksPath-env   'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="core.hook"sPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x'
  check block B49h-split-husky-path      'git commit -m x && rm -rf .hus"ky"'
  # `git merge` (2.36+) and `git am` take --no-verify too, and it skips their commit hooks
  check block B50-merge-no-verify   'git merge --no-verify feature/x'
  check block B51-am-no-verify      'git am --no-verify /tmp/p.mbox'
  check block B52-merge-prefix      'git merge --no-veri main'
  check block B53-merge-sh-wrap     'sh -c "git merge --no-verify main"'
  # `am` and `pull` are trigger words of their own, so a quote-split `git` still reaches the matchers
  # (`commit`/`push`/`merge` carry themselves — XQ is what is left when BOTH words are split)
  check block B53a-split-git-am     'g"it" am --no-verify /tmp/p.mbox'
  check block B53b-split-git-pull   'g"it" pull --no-verify'
  # Documented residual FPs of the disable matchers, asserted so a fix is a conscious matrix update:
  # HUSKY=0 in front of a NON-git command disables nothing about the commit that follows…
  check block B54-residual-husky0-npm 'HUSKY=0 npm run build && git commit -m "chore: build"'
  # …and `-F -` hands the message on stdin, so its heredoc body stays in the scanned text (`-m` is the
  # safe spelling for a commit that has to TALK about removing a hook — A57).
  check block B55-residual-heredoc-F $'git commit -F - <<EOF\nchore: drop husky\n\nMigration does rm .husky/pre-commit.\nEOF'
  # A heredoc is not a scanning boundary: the command arrives as ONE string, so `<<'EOF'` anywhere in
  # it leaves the words that follow on the record — the opening line is the command it always was, a
  # body a shell reads still executes, and an unquoted body is expanded before it is written. Exempting
  # quoted bodies would hand every bypass a two-line spelling, so blocking prose is the trade taken.
  check block B56-heredoc-open-line     $'git -c core.hooksPath=/dev/null commit -F - <<\'EOF\'\nchore: x\nEOF'
  check block B57-heredoc-into-shell    $'bash <<\'EOF\'\ngit commit --no-verify -m x\nEOF'
  check block B58-heredoc-unquoted      $'cat <<EOF > note.md\ngit commit --no-verify\nEOF'
  # …and the same holds for a `<<'X'` that opens no heredoc at all: text that merely mentions the
  # spelling, or a here-string, must not become a lid the rest of the command hides under.
  check block B59-comment-heredoc-text  $'# see <<\'X\' pattern\ngit commit --no-verify -m wip'
  check block B60-quoted-heredoc-text   $'echo "docs use <<\'EOF\' for notes"\ngit -c core.hooksPath=/dev/null commit -m wip'
  check block B61-herestring            $'grep -q x <<<\'OK\'\ngit commit -n -m wip'
  check block B62-heredoc-scan-resumes  $'cat > n.md <<\'EOF\'\ntext\nEOF\ngit commit --no-verify -m wip'

  # --- must ALLOW (no false positives) ---------------------------------------
  check allow A01-plain             'git commit -m "safe change"'
  check allow A02-flag-in-msg       'git commit -m "do not use --no-verify"'
  check allow A03-escaped-quotes    'git commit -m "block \"--no-verify\" bypass"'
  check allow A04-bundled-msg       "git commit -am 'fix: ban --no-verify in docs'"
  check allow A05-no-edit           'git commit --amend --no-edit'
  check allow A06-no-gpg-sign       'git commit --no-gpg-sign -m x'
  check allow A07-log-n             'git log -n 5'
  # …still a `git log` when a glued separator puts it right behind a commit: the message value
  # ends at the separator, so the -n of the NEXT command never lands inside the commit segment
  check allow A07a-glued-log-n      'git commit -m WIP;git log -n 5'
  check allow A07b-glued-ls-n       'git commit -m wip;ls -n'
  check allow A08-cherry-pick-n     'git cherry-pick -n abc123'
  check allow A09-push              'git push origin main'
  check allow A10-legit-c           'git -c user.email=a@b.c commit -m x'
  check allow A11-hooksPath-alone   'git config core.hooksPath .husky'
  check allow A12-hooksPath-in-msg  "git commit -m 'note: core.hooksPath stays .husky'"
  check allow A13-message-eq        'git commit --message="mentions --no-verify"'
  # the message span goes before the escape decode, so a message may spell one out
  check allow A13a-hex-escape-in-msg "git commit -m \"docs: \$'\\x2dn' is banned\""
  check allow A14-file-arg          'git commit -F notes.txt'
  check allow A15-revert-no-commit  'git revert --no-commit HEAD'
  check allow A16-bare-commit       'git commit'
  check allow A17-reuse-msg-C       'git commit --amend -C HEAD'
  check allow A18-cmd-subst-msg     'git commit -m "$(date)"'
  check allow A19-non-git           'npm run commit'
  check allow A20-signed            'git commit -s -S -m x'
  check allow A21-multiline-msg     $'git commit -m "note:\n--no-verify is banned"'
  check allow A22-multiline-hookspath-msg $'git commit -m "docs:\nwhy core.hooksPath stays .husky"'
  # `git push -n` is --dry-run, not --no-verify: the -n bundle rule is commit-only
  check allow A23-push-dry-run      'git push -n origin main'
  check allow A24-push-dry-long     'git push --dry-run origin main'
  check allow A25-push-atomic-n     'git push --atomic -n'
  check allow A26-push-force-lease  'git push --force-with-lease'
  check allow A27-push-no-verify-sigs 'git pull --no-verify-signatures && git push'
  # `git pull -n` is --no-stat, and the flags it shares with fetch/merge are its own business
  check allow A27a-pull-n           'git pull -n origin main'
  check allow A27b-pull-rebase      'git pull --rebase'
  check allow A27c-pull-plain       'git pull'
  # hook files: reads and unrelated paths are not mutations
  check allow A28-husky-one         'HUSKY=1 git commit -m ok'
  check allow A29-chmod-plus-x      'chmod +x scripts/foo.sh && git commit -m x'
  check allow A30-chmod-other       'chmod -x build/artifact.bin && git commit -m x'
  # restoring a hook must never be blocked by the guard that asks for the restore
  check allow A30a-chmod-restore    'chmod +x .husky/pre-commit && git commit -m x'
  check allow A30b-chmod-755        'chmod 755 .husky/pre-commit && git commit -m x'
  check allow A30c-cp-hook-backup   'cp .husky/pre-commit /tmp/bak && git commit -m x'
  check allow A31-cat-husky         'cat .husky/pre-commit && git commit -m x'
  check allow A32-husky-install     'npx husky install && git commit -m x'
  check allow A33-rm-unrelated      'rm -rf node_modules && npm ci && git commit -m x'
  check allow A34-husky-path-in-msg 'git commit -m "chore: keep rm .husky/pre-commit blocked"'
  check allow A34a-husky-env-in-msg 'git commit -m "docs: explain why HUSKY=0 is banned"'
  check allow A35-multiline-rm      $'rm -rf node_modules\nnpm ci\nls .husky\ngit commit -m x'
  check allow A36-hooks-report      'git log > .git/hooks-report.txt && git commit -m x'
  # read-only config forms name the key without changing it
  check allow A37-hooksPath-get     'git commit -m x && git config --get core.hooksPath'
  check allow A38-hooksPath-get-all 'git commit -m x && git config --get-all core.hooksPath'
  check allow A39-hooksPath-get-1st 'git config --get core.hooksPath; git commit -m x'
  check allow A40-hooksPath-list    'git config --list && git commit -m x'
  check allow A41-config-get-email  'git config --get user.email && git commit -m x'
  check allow A42-hooksPath-local-get  'git commit -m x && git config --local --get core.hooksPath'
  check allow A43-hooksPath-global-get 'git commit -m x && git config --global --get core.hooksPath'
  check allow A44-hooksPath-file-get   'git config -f .git/config --get core.hooksPath && git commit -m x'
  # the flagless 2-arg form is the shortest way to READ a key
  check allow A45-hooksPath-bare-read  'git commit -m x && git config core.hooksPath'
  check allow A46-hooksPath-bare-scoped 'git config --local core.hooksPath; git commit -m x'
  # git reads config keys case-insensitively, and so does the matcher — the read exemption must too
  check allow A46a-hooksPath-lower-read  'git commit -m x && git config core.hookspath'
  check allow A46b-hooksPath-mixed-read  'git config --local core.HooksPath && git commit -m x'
  # symbolic chmod modes that KEEP the execute bit are the repair, not the bypass
  check allow A47-chmod-a-plus-x    'chmod a+x .husky/pre-commit && git commit -m x'
  check allow A48-chmod-setuid-755  'chmod 4755 .husky/pre-commit && git commit -m x'
  check allow A49-chmod-assign-rwx  'chmod a=rwx .husky/pre-commit && git commit -m x'
  # reading a hook with a mutating tool's READ form is not a mutation
  check allow A50-sed-read-hook     'sed -n "1,3p" .husky/pre-commit && git commit -m x'
  check allow A51-find-read-hook    'find .git/hooks -name "pre-*" && git commit -m x'
  check allow A52-cd-husky-ls       'cd .husky && ls && git commit -m x'
  # a redirect whose target is a PATH leads out of the directory cd landed in
  check allow A52a-cd-redirect-out  'cd .husky && ls > /tmp/hooklist && git commit -m x'
  check allow A53-npm-install       'npm install && git commit -m x'
  check allow A54-ln-unrelated      'ln -s ../shared src/shared && git commit -m x'
  # merge/am flags that are NOT --no-verify (`-n` is --no-stat on merge, --utf8 off on am)
  check allow A55-merge-n           'git merge -n main'
  check allow A56-merge-no-ff       'git merge --no-ff main'
  check allow A57-am-3              'git am -3 patch.mbox'
  check allow A57a-merge-abort      'git merge --abort && git commit -m x'
  check allow A57b-amend-am-word    'git commit --amend -m "am I done"'
  # modes that keep an execute bit somewhere are not a disable
  check allow A57c-chmod-700        'chmod 700 .husky/pre-commit && git commit -m x'
  check allow A57d-chmod-555        'chmod 555 .git/hooks/pre-commit && git commit -m x'
  check allow A57e-cd-then-sed-read $'cd .husky; sed -n 1p pre-commit\ngit commit -m x'
  check allow A57f-sed-read-two     'sed -n 1p .husky/pre-commit .husky/pre-push && git commit -m x'
  check allow A57g-tail-hook        'tail -5 .git/hooks/pre-commit && git commit -m x'
  check allow A57h-config-worktree-get 'git config --worktree --get core.hooksPath && git commit -m x'
  check allow A57i-config-get-regexp   'git config --get-regexp core.hooks && git commit -m x'
  # ` am` is a stdin trigger word (B53a), which must stay a trigger and not a verdict
  check allow A57j-prose-am            'echo am i clean'
  # the safe spelling of B55's commit: a quoted message span is stripped before the disable matchers
  check allow A58-heredoc-msg-hook  $'git commit -m "$(cat <<\'EOF\'\nchore: drop husky\n\nMigration does rm .husky/pre-commit.\nEOF\n)"'
  # Documented residual FNs — a `|` ends the span the verb and the path have to share, so the pipe
  # spellings of a mutation stay open. Asserted so closing one is a conscious matrix update.
  check allow A59-residual-xargs-fn 'echo .husky/pre-commit | xargs rm && git commit -m x'
  check allow A60-residual-sed-pipe-fn 'sed -i "" -e "1s|.*|exit 0|" .husky/pre-commit && git commit -m x'
  # A plain backslash inside the flag word is a residual FN of its own: the shell drops it, the scan
  # does not (only the ANSI-C escape FORMS are decoded — B30a–B30c).
  check allow A60a-residual-backslash-long  'git commit --no-\verify -m x'
  check allow A60b-residual-backslash-short 'git commit -\n -m x'

  # --- malformed / degraded input --------------------------------------------
  raw allow R01-no-command-field '{"tool_name":"Bash","tool_input":{}}'
  raw allow R02-empty-stdin ''

  raw block J01-nojq-long  '{"tool_name":"Bash","tool_input":{"command":"git commit --no-verify -m \"x\""}}' "$shim"
  raw block J02-nojq-short '{"tool_name":"Bash","tool_input":{"command":"git commit -n"}}' "$shim"
  raw allow J03-nojq-clean '{"tool_name":"Bash","tool_input":{"command":"git commit -m \"safe\""}}' "$shim"
  raw allow J04-nojq-msg   '{"tool_name":"Bash","tool_input":{"command":"git commit -m \"do not use --no-verify\""}}' "$shim"
  raw block J05-nojq-push  '{"tool_name":"Bash","tool_input":{"command":"git push --no-verify"}}' "$shim"
  raw block J06-nojq-husky '{"tool_name":"Bash","tool_input":{"command":"rm .husky/pre-commit && git commit -m x"}}' "$shim"
  # A JSON-escaped keyword only exists after the jq decode, so it must survive the
  # prefilter's raw-stdin reject. The escape is assembled here so this file never
  # holds the decoded form.
  local bs='\'
  raw block J07-unicode-escape "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git ${bs}u0063ommit -n -m x\"}}"

  # --- degraded TOOLING (D) ---------------------------------------------------
  # awk/sed/tr/grep build the text every matcher below reads, so a missing or broken one used to
  # hand back an empty scan — and an empty scan matches nothing, which allowed a plain
  # `--no-verify`. The guard now degrades to the raw command instead: the plain spellings must
  # still block on every one of these PATHs, and an ordinary commit must still go through.
  # tests/hooks-cursor-sim.sh eval's this function with a harness of its own, where these dirs
  # do not exist (and where a PATH without `bash` would test the shim's own no-verdict rail
  # rather than the guard) — so the block runs only where the matrix built them.
  [ -n "${noawk:-}" ] || return 0
  local d t
  for d in "$noawk" "$brokenawk" "$nosed" "$notr" "$nogrep" "$brokengrep" "$nosedgrep"; do
    t="$(basename "$d")"
    raw block "D01-$t-long"      "$(str_ev 'git commit --no-verify -m wip')" "$d"
    raw block "D02-$t-short"     "$(str_ev 'git commit -n -m wip')" "$d"
    raw block "D03-$t-hookspath" "$(str_ev 'git -c core.hooksPath=/dev/null commit -m wip')" "$d"
    raw block "D04-$t-husky"     "$(str_ev 'HUSKY=0 git commit -m wip')" "$d"
    raw allow "D05-$t-plain"     "$(str_ev 'git commit -m "plain message"')" "$d"
    raw allow "D06-$t-status"    "$(str_ev 'git status')" "$d"
    raw allow "D07-$t-echo"      "$(str_ev 'echo hello')" "$d"
  done
  # The message strip is sed's half of that pipeline, and the fallback drops the failed stage
  # rather than the whole pass — so with awk (or tr, or grep) gone the strip still runs and a
  # MESSAGE quoting the flag is still allowed, exactly as J04/A02 pin it with a full toolbox…
  raw allow "D08-noawk-msg"      "$(str_ev 'git commit -m "never use --no-verify"')" "$noawk"
  raw allow "D08-brokenawk-msg"  "$(str_ev 'git commit -m "never use --no-verify"')" "$brokenawk"
  raw allow "D08-notr-msg"       "$(str_ev 'git commit -m "never use --no-verify"')" "$notr"
  raw allow "D08-nogrep-msg"     "$(str_ev 'git commit -m "never use --no-verify"')" "$nogrep"
  raw allow "D08-brokengrep-msg" "$(str_ev 'git commit -m "never use --no-verify"')" "$brokengrep"
  # …and with sed itself gone there is nothing left to strip with: the raw command stands in,
  # the message is read as command text, and the row false-blocks. Accepted — over-blocking a
  # message on a host with no sed is the price of not disarming the guard on one.
  raw block "D09-nosed-msg-fp"     "$(str_ev 'git commit -m "never use --no-verify"')" "$nosed"
  raw block "D09-nosedgrep-msg-fp" "$(str_ev 'git commit -m "never use --no-verify"')" "$nosedgrep"
  # The no-grep rail reads `-n` per commit span, not across the whole command: a `-n` that belongs
  # to a NEIGHBOUR (git log, git push, find -name) is not a commit's --no-verify, and a second
  # commit further along the line still is.
  raw allow "D10-nogrep-log-n"       "$(str_ev 'git commit -m x && git log -n 5')" "$nogrep"
  raw allow "D10-nogrep-sort-n"      "$(str_ev 'sort -n f && git commit -m wip')" "$nogrep"
  raw allow "D10-nogrep-push-n"      "$(str_ev 'git commit -m x && git push -n origin main')" "$nogrep"
  raw allow "D10-nogrep-find-name"   "$(str_ev 'find . -name x.js && git commit -m x')" "$nogrep"
  raw block "D10-nogrep-second-cmt"  "$(str_ev 'git commit -m x && git commit -n -m y')" "$nogrep"
  raw block "D10-nogrep-short"       "$(str_ev 'git commit -n')" "$nogrep"
  raw allow "D10-nosedgrep-log-n"      "$(str_ev 'git commit -m x && git log -n 5')" "$nosedgrep"
  raw allow "D10-nosedgrep-push-n"     "$(str_ev 'git commit -m x && git push -n origin main')" "$nosedgrep"
  raw block "D10-nosedgrep-second-cmt" "$(str_ev 'git commit -m x && git commit -n -m y')" "$nosedgrep"
  # D11 — the EXTRACTION toolbox, not the scan pipeline: with no jq and no sed (or no tr behind
  # it), and with no `cat` to read stdin at all, the hook has to keep a verdict rather than fall
  # off the front of its own pipeline.
  for d in "$nojqsed" "$nojqtr" "$nocat"; do
    t="$(basename "$d")"
    raw block "D11-$t-long"   "$(str_ev 'git commit --no-verify -m wip')" "$d"
    raw block "D11-$t-short"  "$(str_ev 'git commit -n -m wip')" "$d"
    raw allow "D11-$t-plain"  "$(str_ev 'git commit -m ok')" "$d"
    raw allow "D11-$t-status" "$(str_ev 'git status')" "$d"
    raw allow "D11-$t-echo"   "$(str_ev 'echo hello')" "$d"
  done
  # Scanning the raw EVENT means scanning JSON escapes, which the message strip cannot see past —
  # so on that PATH a message naming the flag false-blocks, the same trade as D09. `nocat` keeps
  # jq, so it reads the real command and D08's verdict holds there.
  raw block "D11-nojqsed-msg-fp" "$(str_ev 'git commit -m "never use --no-verify"')" "$nojqsed"
  raw block "D11-nojqtr-msg-fp"  "$(str_ev 'git commit -m "never use --no-verify"')" "$nojqtr"
  raw allow "D11-nocat-msg"      "$(str_ev 'git commit -m "never use --no-verify"')" "$nocat"
}

attribution_cases() {
  # --- must BLOCK (attribution in a commit segment) ---------------------------
  check block N01-trailer-multiline $'git commit -m "feat: x\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"'
  check block N02-anthropic-email   'git commit -m "fix" -m "Co-Authored-By: Bot <noreply@anthropic.com>"'
  check block N03-generated-with    $'git commit -m "x\n\n🤖 Generated with [Claude Code]"'
  check block N04-generated-bare    'git commit -m "Generated with Claude"'
  check block N05-C-option-gate     'git -C . commit -m "x Co-Authored-By: Claude <noreply@anthropic.com>"'
  check block N06-double-space-gate 'git  commit -m "x Co-Authored-By: Claude <noreply@anthropic.com>"'
  check block N07-heredoc-F         $'git commit -F - <<\'EOF\'\nmsg\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF'
  check block N08-sh-wrap           'sh -c "git commit -m \"x Co-Authored-By: Claude <noreply@anthropic.com>\""'
  check block N09-amend-chain       $'git add -A && git commit --amend -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'
  check block N10-semicolon-in-msg  $'git commit -m "fix: a; b\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'
  # Documented residual FPs, asserted so a fix is a conscious matrix update:
  check block N11-residual-mention-fp "git commit -m 'docs: forbid Co-Authored-By: Claude trailers'"
  check block N12-residual-postcmd-fp 'git commit -m "ok"; git log --grep "Co-Authored-By: Claude"'
  # an @anthropic.com address inside <…> — the display name alone says nothing
  check block N13-addr-only         $'git commit -m "feat: x\n\nCo-Authored-By: Fable 5 <fable@anthropic.com>"'
  check block N14-addr-upper        $'git commit -m "feat: x\n\nCo-Authored-By: Fable 5 <BOT@ANTHROPIC.COM>"'
  check block N15-addr-subdomain    $'git commit -m "feat: x\n\nCo-Authored-By: Fable 5 <ai@mail.anthropic.com>"'
  # the matcher reads the message with newlines flattened, so the trailer phrase may be line-wrapped —
  # the fast reject reads the raw event, where it is not (both twins must still block)
  check block N16-genwith-wrapped   $'git commit -m "feat: x\n\n\xf0\x9f\xa4\x96 Generated\nwith [Claude Code](https://claude.com/claude-code)"'
  # `anthropic` is the ONLY trigger word here: without it the fast reject would swallow the row, and no
  # other N case would notice (every other one also carries `co-authored-by` or `generated with`)
  check block N17-anthropic-only    'git commit -m "wip" -m "noreply@anthropic.com"'

  # --- must ALLOW (no false positives) ---------------------------------------
  check allow M01-plain             'git commit -m "safe change"'
  check allow M02-human-coauthor    $'git commit -m "pair work\n\nCo-Authored-By: Jane Doe <jane@corp.example>"'
  check allow M03-grep-before       'grep -r "Co-Authored-By: Claude" plugins ; git commit -m "ok"'
  check allow M04-echo-before       'echo "Co-Authored-By: Claude" > docs/note.md && git commit -m "ok"'
  check allow M05-heredoc-before    $'cat <<EOF > note.md\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\ngit commit -m "ok"'
  check allow M06-log-grep          'git log --grep "Co-Authored-By: Claude"'
  check allow M07-claude-mention    'git commit -m "explain claude workflow"'
  check allow M08-prose-no-commit   'echo Co-Authored-By: Claude is banned in commits'
  check allow M09-postcmd-and-chain 'git commit -m "ok" && git log --grep "Co-Authored-By: Claude"'
  # look-alike domains stay human
  check allow M10-anthropic-sub     $'git commit -m "pair\n\nCo-Authored-By: Jane <jane@anthropic.example.com>"'
  check allow M11-not-anthropic     $'git commit -m "pair\n\nCo-Authored-By: Jane <jane@notanthropic.community>"'

  # --- malformed / degraded input --------------------------------------------
  raw allow MR1-no-command-field '{"tool_name":"Bash","tool_input":{}}'
  raw allow MR2-empty-stdin ''
  raw block NJ1-nojq-trailer '{"tool_name":"Bash","tool_input":{"command":"git commit -m \"x\\n\\nCo-Authored-By: Claude <noreply@anthropic.com>\""}}' "$shim"
  raw allow NJ2-nojq-clean   '{"tool_name":"Bash","tool_input":{"command":"git commit -m \"safe\""}}' "$shim"
  local bs='\'
  raw block NJ3-unicode-escape "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git ${bs}u0063ommit -m ${bs}\"x Co-Authored-By: Claude${bs}\"\"}}"
}

# ── V / AV — the ARGV-ARRAY payload shape ───────────────────────────────────────────────────
# Codex's `shell` / `local_shell` tools carry the command as an argv ARRAY, not a string, and
# `jq -r` on one prints an element PER LINE — `git` and `commit` land on different lines, every
# per-line matcher in both guards finds nothing, and the call is allowed. The guards join the
# array into one line before scanning; these rows are that join's contract, run against BOTH
# extraction paths (jq, and the sed fallback with jq hidden).
# They sit OUTSIDE no_verify_cases / attribution_cases deliberately: tests/hooks-cursor-sim.sh
# re-runs those two functions through hooks/cursor-shim.cjs, whose payload contract is a command
# STRING — an array row there would test the shim's fail-open rail, not the guards' join.
argv_ev() { # element… — a Codex shell event whose tool_input.command is an argv array
  jq -nc '{tool_name:"shell",tool_input:{command:$ARGS.positional}}' --args -- "$@"
}

codex_argv_no_verify_cases() {
  local p t
  for p in "" "$shim"; do
    t=jq; [ -n "$p" ] && t=nojq
    # the bypasses, in the shape Codex sends them
    raw block "V01-$t-argv-long"     "$(argv_ev git commit --no-verify -m x)" "$p"
    raw block "V02-$t-argv-short"    "$(argv_ev git commit -n -m x)" "$p"
    raw block "V03-$t-argv-bundled"  "$(argv_ev git commit -anm wip)" "$p"
    raw block "V04-$t-argv-push"     "$(argv_ev git push --no-verify origin main)" "$p"
    raw block "V05-$t-argv-husky"    "$(argv_ev env HUSKY=0 git commit -m x)" "$p"
    raw block "V06-$t-argv-hookspath" "$(argv_ev git -c core.hooksPath=/dev/null commit -m x)" "$p"
    # the `["bash","-lc","<one string>"]` spelling: the command keeps its own quoting inside one
    # element, so it scans exactly like the Claude-shaped string payload
    raw block "V07-$t-argv-lc-bypass" "$(argv_ev bash -lc 'git commit --no-verify -m x')" "$p"
    raw allow "V08-$t-argv-lc-msg"    "$(argv_ev bash -lc 'git commit -m "do not use --no-verify"')" "$p"
    # …and the clean argv commit must stay clean
    raw allow "V09-$t-argv-clean"     "$(argv_ev git commit -m ok)" "$p"
    raw allow "V10-$t-argv-status"    "$(argv_ev git status --short)" "$p"
    raw allow "V11-$t-argv-push-dry"  "$(argv_ev git push -n origin main)" "$p"
    # Residual FP of the join, asserted so a fix is a conscious matrix update: joining on spaces
    # loses the argv boundary that told a multi-word -m VALUE apart from the flags around it, so
    # the words after the first are read as command text. (Codex's own shell tool sends
    # ["bash","-lc",…] — V08 — which keeps its quoting and is unaffected.)
    raw block "V12-$t-residual-msg-fp" "$(argv_ev git commit -m 'fix: never use --no-verify')" "$p"
  done
  # The ONE class where the two extraction paths diverge, pinned on both sides. An element
  # carrying a bracket has no `[…]` span the sed fallback can delimit, so that path reads
  # nothing at all — and an unreadable argv array naming a git verb FAILS CLOSED rather than
  # waving a shell call through unchecked. jq has no such limit and reads the real command.
  raw allow "V13-jq-bracket-parsed"       "$(argv_ev git commit -m '[wip] tidy')"
  raw block "V13-nojq-bracket-failclosed" "$(argv_ev git commit -m '[wip] tidy')" "$shim"
  # …and the fail-closed branch is gated on the git verbs: an unreadable argv array that is not
  # a git call at all is not this guard's business.
  raw allow "V14-jq-bracket-nongit"       "$(argv_ev ls -la '[a]')"
  raw allow "V14-nojq-bracket-nongit"     "$(argv_ev ls -la '[a]')" "$shim"
}

codex_argv_attribution_cases() {
  local p t
  for p in "" "$shim"; do
    t=jq; [ -n "$p" ] && t=nojq
    raw block "AV01-$t-argv-trailer" \
      "$(argv_ev git commit -m 'feat: x

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>')" "$p"
    raw block "AV02-$t-argv-generated" \
      "$(argv_ev git commit -m 'x

Generated with [Claude Code]')" "$p"
    raw block "AV03-$t-argv-lc-trailer" \
      "$(argv_ev bash -lc 'git commit -m "x

Co-Authored-By: Claude <noreply@anthropic.com>"')" "$p"
    raw allow "AV04-$t-argv-human" \
      "$(argv_ev git commit -m 'pair work

Co-Authored-By: Jane Doe <jane@corp.example>')" "$p"
    raw allow "AV05-$t-argv-clean" "$(argv_ev git commit -m ok)" "$p"
  done
  # Same divergence as V13, on this guard's own trigger set.
  raw block "AV06-nojq-bracket-failclosed" \
    "$(argv_ev git commit -m '[wip] x

Co-Authored-By: Claude <noreply@anthropic.com>')" "$shim"
}

CUR_HOOK="$HOOK";      LBL=""; no_verify_cases; codex_argv_no_verify_cases
CUR_HOOK="$HOOK_ATTR"; LBL=""; attribution_cases; codex_argv_attribution_cases

NV_NOPRE="$TMPD/no-verify-bypass-noprefilter.sh"
AT_NOPRE="$TMPD/no-ai-attribution-noprefilter.sh"
strip_prefilter "$HOOK" "$NV_NOPRE" 2
strip_prefilter "$HOOK_ATTR" "$AT_NOPRE" 2
CUR_HOOK="$NV_NOPRE"; LBL="nopre-"; no_verify_cases; codex_argv_no_verify_cases
CUR_HOOK="$AT_NOPRE"; LBL="nopre-"; attribution_cases; codex_argv_attribution_cases

# A quote-split SUBCOMMAND still runs a commit, and the fast reject reads the raw event — so it stays
# in only because `git` itself is one of the trigger words. Both twins must block: this is the row that
# keeps the `*git*` glob in the prefilter (dropping it reopens the bypass, and nothing else notices).
LBL=""
for xp in 'git com"mit" -n -m x' "git com\$'mit' -n -m x" 'git pu"sh" --no-verify' 'HUSKY=0 git com"mit" -m x'; do
  CUR_HOOK="$HOOK";     check block "XP-split-kw-prefiltered" "$xp"
  CUR_HOOK="$NV_NOPRE"; check block "XP-split-kw-matcher"     "$xp"
done

# XQ — the ONE class where the fast reject changes a verdict, pinned on both sides. With `git` AND the
# subcommand both quote-split, no trigger word survives in the raw event; the matchers see the command
# once they dequote. Dequoting in the reject is not affordable (bash 3.2 pattern substitution: 6 s on a
# 64 KB command), so this stays open — deliberate obfuscation, same class as the $FLAG smuggling the
# hook's header concedes. Both rows exist so a change of mind is conscious.
for xq in 'g"it" com"mit" -n -m x' "g\$'it' com\$'mit' --no-verify -m x"; do
  CUR_HOOK="$HOOK";     check allow "XQ-split-git-prefiltered" "$xq"
  CUR_HOOK="$NV_NOPRE"; check block "XQ-split-git-matcher"     "$xq"
done

echo "commit-guard hooks matrix: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  printf '%s' "$failures"
  exit 1
fi
