#!/usr/bin/env bash
# Assertions for the M9 preflight/report additions: the plugin-update nudge and the model-pin
# validation rows, plus the host fields in the plugin-issue bundle.
# These land as checklist prose, not as a script, so what CAN break is what this suite checks:
#   1. the rows exist and stay wired into the report format (a row nobody prints is a no-op);
#   2. every command the rows instruct is either pre-approved in the skill's `allowed-tools` or
#      explicitly marked as needing the developer's go-ahead — the "skill instructs a command its
#      allowed-tools blocks" defect class;
#   3. the read-only contract holds: no `git fetch` / `git pull` anywhere in the checklist, and the
#      remote is named by URL, since in the developer's workspace `origin` is the client repo;
#   4. every plugin path the rows point at actually exists in this checkout;
#   5. the additions are additive — the four original checklist sections keep their headings, their
#      order and their instructions, and the new rows are appended after them;
#   6. Foundation-only wording across the skills/references is gated on the session's
#      `fnd project profile:` line and keeps its Foundation text verbatim (a `foundation` checkout
#      must read exactly as it did before the gate), with a runnable plain-theme branch beside it.
# Usage: preflight-additions-sim.sh [plugin-dir]   (default: plugins/fnd)
# Exit 0 = the additions are wired, honest, and runnable as written.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="${1:-$ROOT/plugins/fnd}"

CHECKLIST="$PLUGIN_DIR/references/preflight-checklist.md"
PREFLIGHT="$PLUGIN_DIR/skills/preflight-checks/SKILL.md"
REPORTER="$PLUGIN_DIR/skills/report-plugin-issue/SKILL.md"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

# has <label> <file> <fixed-string> — the file contains the string verbatim
has() {
  if grep -qF -- "$3" "$2"; then ok; else bad "$1" "missing from $(basename "$2"): $3"; fi
}

# hasre <label> <file> <regex>
hasre() {
  if grep -qE -- "$3" "$2"; then ok; else bad "$1" "no line matching /$3/ in $(basename "$2")"; fi
}

# short_id <path> — a per-file suffix for assertion ids inside loops, so two failures never land
# under the same id; every skill file is named SKILL.md, so those take their directory's name.
short_id() {
  case "$(basename "$1")" in
    SKILL.md) basename "$(dirname "$1")" ;;
    *) basename "$1" ;;
  esac
}

# hasjoin <label> <file> <regex> — like hasre, but the file is matched with newlines and
# indentation collapsed to single spaces: prose wraps wherever the sentence happens to fill a
# line, so a clause split across two lines still has to be pinned as one clause.
hasjoin() {
  if tr '\n' ' ' < "$2" | tr -s ' ' | grep -qE -- "$3"; then ok
  else bad "$1" "no wrap-joined match for /$3/ in $(basename "$2")"; fi
}

# section <file> <heading> — the lines from a `## heading` up to the next `## `, empty when absent
section() {
  awk -v h="$2" '
    $0 == "## " h { in_s = 1; next }
    in_s && /^## / { exit }
    in_s { print }
  ' "$1"
}

# sec_has <label> <section-text> <fixed-string>
sec_has() {
  case "$2" in
    *"$3"*) ok ;;
    *) bad "$1" "section text does not mention: $3" ;;
  esac
}

for f in "$CHECKLIST" "$PREFLIGHT" "$REPORTER"; do
  if [ -f "$f" ]; then ok; else bad files "not a file: $f"; fi
done
[ -f "$CHECKLIST" ] && [ -f "$PREFLIGHT" ] && [ -f "$REPORTER" ] || {
  echo "preflight-additions: $pass passed, $fail failed"
  printf '%s' "$failures"; exit 1
}

UPDATE="$(section "$CHECKLIST" 'Plugin update check')"
PINS="$(section "$CHECKLIST" 'Model pins')"
JIRA="$(section "$CHECKLIST" 'Jira attachments')"

if [ -n "$UPDATE" ]; then ok; else bad update-section "no '## Plugin update check' section in the checklist"; fi
if [ -n "$PINS" ]; then ok; else bad pins-section "no '## Model pins' section in the checklist"; fi
if [ -n "$JIRA" ]; then ok; else bad jira-section "no '## Jira attachments' section in the checklist"; fi

# ------------------------------------------------------------------- the update row --
# One update command per host, quoted verbatim so the report can hand it over as-is.
sec_has update-cmd-claude "$UPDATE" '/plugin marketplace update'
sec_has update-cmd-codex "$UPDATE" 'codex plugin marketplace upgrade'
sec_has update-cmd-cursor "$UPDATE" 'install.sh --target cursor'
sec_has update-cmd-opencode "$UPDATE" 'install.sh --target opencode'

# The remote is named by URL: `origin` in the developer's workspace is the client theme repo.
sec_has update-lsremote "$UPDATE" 'git ls-remote https://github.com/'
case "$UPDATE" in
  *'git ls-remote origin'*) bad update-remote 'ls-remote against bare `origin` — that is the client repo, not the plugin' ;;
  *) ok ;;
esac

# Fail-silent + advisory: an update check that cannot run is a 🟡 with a reason, never a blocker.
sec_has update-skip "$UPDATE" 'update check skipped'
# A `--copy` install has no clone to compare, and the installer's record is how that is known.
sec_has update-copy-mode "$UPDATE" 'mode=copy'
sec_has update-install-record "$UPDATE" '.fnd-install-mode'
sec_has update-advisory "$UPDATE" 'never a blocker'
sec_has update-installed-version "$UPDATE" '.claude-plugin/plugin.json'

# Codex: the answer comes from the clone the installer recorded, never from the version-keyed
# plugin cache. Only installs write into that cache, so its highest directory cannot exceed the
# installed version — reading it can only ever fabricate a green "up to date".
sec_has update-codex-clone "$UPDATE" '~/.codex/.fnd-install-mode'
sec_has update-cache-ban "$UPDATE" 'Never the plugin cache'
sec_has update-cache-why "$UPDATE" 'record of what was installed'
sec_has update-cache-fabricated "$UPDATE" 'fabricated green'
case "$UPDATE" in
  *'highest version directory is what an upgrade would activate'*)
    bad update-cache-source 'the cache is named as the available-version source — installs are all that write it' ;;
  *) ok ;;
esac

# The one network call is bounded where the machine can bound it, and a stall is the fail-silent
# case rather than a retry: git has no connect-timeout knob, so the bare form waits on the OS.
sec_has update-bounded "$UPDATE" 'timeout 8 git ls-remote'
sec_has update-unbounded-note "$UPDATE" '75 seconds'
sec_has update-single-call "$UPDATE" 'never run it twice'

# Read-only contract — the whole file, since a sanctioned fetch/pull anywhere turns the check into
# a mutation of the developer's clone. Prose ABOUT the ban is fine, an instruction is not: flag a
# fenced command, a "run `git pull`" imperative, and a line that opens with the command itself.
for verb in fetch pull; do
  fenced_hit="$(awk -v v="git $verb" '
    /^```/ { fence = !fence; next }
    fence && index($0, v) { print NR ": " $0; exit }
  ' "$CHECKLIST")"
  prose_hit="$(grep -nEi -- "([Rr]un|then|first) \`?git $verb|^[[:space:]]*[-*0-9.]*[[:space:]]*\`?git $verb" "$CHECKLIST" | head -1 || true)"
  if [ -z "$fenced_hit$prose_hit" ]; then ok
  else bad "read-only-git-$verb" "checklist instructs \`git $verb\`: ${fenced_hit:-$prose_hit}"; fi
done

# ---------------------------------------------------------------------- the pins row --
sec_has pins-cursor-dir "$PINS" 'agents-cursor'
sec_has pins-codex-dir "$PINS" 'agents-codex'
sec_has pins-map "$PINS" 'references/host-model-map.md'
sec_has pins-generator "$PINS" 'scripts/gen-host-adapters.cjs'
# The honest half: no listing mechanism → SKIP, never a fabricated "resolves".
sec_has pins-skip "$PINS" 'SKIP'
sec_has pins-no-invention "$PINS" 'never invent a'
# Hosts that pin nothing say so instead of inventing a check.
sec_has pins-na "$PINS" 'n/a'
# Escalation: stale pin on a latest plugin is a plugin defect, offered to the reporter skill.
sec_has pins-offer "$PINS" 'report-plugin-issue'
for field in 'host version' 'pinned id' 'error text'; do
  sec_has "pins-field-${field% *}" "$PINS" "$field"
done
# Generated output is never hand-patched as a workaround.
sec_has pins-no-handedit "$PINS" 'Do not hand-edit'

# ----------------------------------------------------------- the Jira attachments row --
# One read-only probe, and the credentials it needs are named — never Read out of the .env.
sec_has jira-check-cmd "$JIRA" 'scripts/jira-attachments.sh --check'
sec_has jira-email "$JIRA" 'JIRA_EMAIL'
sec_has jira-token "$JIRA" 'JIRA_API_TOKEN'
sec_has jira-no-read-env "$JIRA" 'never `Read` the `.env`'
# Every outcome the probe can print carries a severity, and the setup walk-through has one home.
sec_has jira-ok-line "$JIRA" 'ok=1 jira_user='
sec_has jira-ffmpeg-warn "$JIRA" 'ffmpeg=no'
sec_has jira-ffmpeg-fix "$JIRA" 'brew install ffmpeg'
sec_has jira-exit3 "$JIRA" 'error=no_jira_credentials'
sec_has jira-exit4 "$JIRA" 'error=jira_auth_rejected'
sec_has jira-reference "$JIRA" 'references/jira-attachments.md'
# A missing token never blocks a ticket read (the MCP still returns the fields), so no outcome
# in this row is a 🔴 — the prose saying so is not enough, the outcome list has to hold to it.
if printf '%s\n' "$JIRA" | grep -q '→ 🔴'; then
  bad jira-severity 'the Jira attachments row hands out a 🔴 — a missing token degrades the read, it does not fail it'
else ok; fi
sec_has jira-never-red "$JIRA" 'Never 🔴'

# Every plugin path the three rows point at exists in this checkout.
for rel in agents-cursor agents-codex references/host-model-map.md scripts/gen-host-adapters.cjs \
           scripts/doctor.cjs .claude-plugin/plugin.json scripts/jira-attachments.sh \
           references/jira-attachments.md; do
  if [ -e "$PLUGIN_DIR/$rel" ]; then ok; else bad path-missing "referenced path absent: plugins/fnd/$rel"; fi
done

# ------------------------------------------------------- instructions vs allow-list --
# Every shell command fenced in the two new sections has to be pre-approved in the skill's
# frontmatter; the model-listing commands are deliberately NOT, and the prose says to ask first.
fenced="$(printf '%s\n%s\n' "$UPDATE" "$PINS" | awk '
  /^```/ { fence = !fence; next }
  fence && $0 ~ /[^ \t]/ { print }
')"
allowed="$(awk '/^allowed-tools:/ { print; exit }' "$PREFLIGHT")"
if [ -n "$fenced" ]; then ok; else bad fenced-none "the new sections fence no command at all"; fi
while IFS= read -r cmd; do
  [ -n "$cmd" ] || continue
  prefix="$(printf '%s' "$cmd" | awk '{ print $1 " " $2 }')"
  case "$allowed" in
    *"Bash($prefix"*) ok ;;
    *) bad allow-list "checklist fences \`$prefix …\` but preflight's allowed-tools does not carry it" ;;
  esac
done <<EOF
$fenced
EOF
sec_has pins-ask-first "$PINS" 'ask before running one'
# The Jira row fences a bundled runner, so its allow-list entry spells the plugin root the way
# frontmatter may (`${CLAUDE_PLUGIN_ROOT}`) while the prose keeps the host-neutral `<plugin root>`.
case "$allowed" in
  *'Bash(${CLAUDE_PLUGIN_ROOT}/scripts/jira-attachments.sh --check'*) ok ;;
  *) bad allow-list "checklist fences \`jira-attachments.sh --check\` but preflight's allowed-tools does not carry it" ;;
esac

# ------------------------------------------------------------ wiring into the report --
# A row that never reaches the report format is dead prose.
REPORT="$(section "$CHECKLIST" 'Report format')"
sec_has report-update "$REPORT" 'plugin update'
sec_has report-jira "$REPORT" 'Jira attachments'
sec_has report-pins "$REPORT" 'model pins'
# …and the four original groups still read as before — the additions are additive.
for group in 'IDE/workspace' 'MCP servers' 'CLI tools' 'project skills & rules' 'local
dev server'; do
  sec_has "report-kept" "$REPORT" "$group"
done

# ------------------------------------------------------------- the additions are ADDITIVE --
# The rule on this change is that an environment with nothing to report reads exactly as it did
# before, so the four original sections are guarded here rather than trusted: they keep their
# headings, they keep their order, they come FIRST (the new rows are appended, never interleaved),
# and each still carries the instructions that make it that check. Naming the new sections in the
# report format is not evidence about any of that.
ORIGINAL_HEADINGS='## Required CLI tools
## MCP servers
## Project skills & rules
## Local dev server'
if [ "$(grep -E '^## ' "$CHECKLIST" | head -4)" = "$ORIGINAL_HEADINGS" ]; then ok
else
  bad additive-order "the checklist no longer opens with the four original sections in order: $(
    grep -E '^## ' "$CHECKLIST" | head -4 | tr '\n' ' ')"
fi

# One anchor per original instruction that a rewrite would have to destroy: the severity split the
# CLI row exists for, the five MCP servers named one by one, where project skills live, and how the
# dev server is detected.
check_original() {
  local heading="$1" label="$2" body
  shift 2
  body="$(section "$CHECKLIST" "$heading")"
  if [ -z "$body" ]; then bad "additive-$label" "original section '## $heading' is gone"; return; fi
  ok
  for anchor in "$@"; do sec_has "additive-$label" "$body" "$anchor"; done
}
check_original 'Required CLI tools' cli \
  'shopify version' 'gh --version' 'jq missing is a 🔴' 'perl
missing is a 🟡' 'error=strip_needs_perl' 'shopify store execute'
check_original 'MCP servers' mcp \
  'Figma MCP' 'Chrome DevTools MCP' 'Atlassian MCP' 'Notion MCP' 'Shopify Dev MCP' \
  'never
fabricate a green check' 'learn_shopify_api'
check_original 'Project skills & rules' rules '.claude/skills/' 'Foundation conventions'
check_original 'Local dev server' devserver \
  'npm run dev' 'npm run theme:shopify' 'in-browser validation'

# The skill body names the new groups in its run order and pre-approves the one new command.
has skill-order "$PREFLIGHT" 'local dev server → Jira attachments → plugin update → model pins'
has skill-lsremote "$PREFLIGHT" 'Bash(git ls-remote*)'
has skill-lsremote-bounded "$PREFLIGHT" 'Bash(timeout 8 git ls-remote*)'
hasre skill-advisory "$PREFLIGHT" 'advisory'
hasre skill-offers-reporter "$PREFLIGHT" 'report-plugin-issue'

# ------------------------------------------------------ the plugin-issue debug bundle --
has reporter-host-field "$REPORTER" '**Host + host version**'
for host_cmd in 'claude --version' 'cursor-agent --version' 'codex --version' 'opencode --version'; do
  # instructed in the body AND pre-approved in the frontmatter
  has "reporter-cmd-body" "$REPORTER" "$host_cmd"
  if grep -qF "Bash($host_cmd)" "$REPORTER"; then ok
  else bad reporter-allow-list "report-plugin-issue instructs \`$host_cmd\` without an allowed-tools entry"; fi
done
# Claude Code keeps reporting what it reports today: host name + version on the Environment line.
has reporter-env-line "$REPORTER" 'plugin fnd <version> · host <host name> <host version>'
has reporter-unknown "$REPORTER" 'never guess'
# The stale-pin class is fileable, so preflight's offer lands on a documented path.
hasre reporter-stale-pin "$REPORTER" 'pinned in a generated per-host agent no longer resolves'

# ------------------------------------------- project-profile gating of Foundation wording --
# Foundation-only guidance (the `npm run dev` wrapper, Tailwind/token usage, `use_section_vars`,
# the eslint rail, `src/entry/core/*`) misleads a Dawn/Horizon/custom checkout, so every skill or
# reference that carries it names the gate — the session line `fnd project profile:` — and offers
# the plain-theme branch. Two halves per file, and the second is the one that catches a rewrite:
# the Foundation text itself must survive VERBATIM, since a `foundation` checkout has to behave
# exactly as it did before the gate was added.
gated() {
  local label="$1" file="$2" n=0
  shift 2
  if [ ! -f "$file" ]; then bad "gate-$label-file" "missing file: ${file#$ROOT/}"; return; fi
  if grep -qF -- 'fnd project profile' "$file"; then ok
  else bad "gate-$label-gate" "Foundation-only wording with no \`fnd project profile\` gate in $(basename "$file")"; fi
  for anchor in "$@"; do
    n=$((n + 1))
    has "gate-$label-verbatim-$n" "$file" "$anchor"
  done
}

SKILLS="$PLUGIN_DIR/skills"
REFS="$PLUGIN_DIR/references"
gated ship        "$SKILLS/ship/SKILL.md" \
  'npm run dev -- --theme <id> [--port <N>]' 'shopify theme dev -e dev' 'npm run theme:shopify'
gated preview     "$SKILLS/preview-theme/SKILL.md"        'npm run dev -- --theme <id> --port <N>'
gated worktree    "$SKILLS/worktree/SKILL.md"             'npm run dev -- --theme <id> --port <N>'
gated develop     "$SKILLS/develop-feature-or-fix/SKILL.md" \
  'use_section_vars' 'references/section-css-variables-pattern.md' \
  'references/eslint-no-restricted-syntax.md' 'src/entry/core/*'
gated a11y        "$SKILLS/fix-accessibility-issue/SKILL.md" \
  'Tailwind `data-[]:` selectors' '../../references/eslint-no-restricted-syntax.md'
gated ta          "$SKILLS/write-technical-approach/SKILL.md" 'src/entry/core/*'
gated sessiontheme "$REFS/session-theme.md"    'npm run dev -- --theme <id> [--port <N>]'
gated checklist   "$REFS/preflight-checklist.md" \
  'npm run dev' 'npm run theme:shopify' 'Foundation conventions'
gated taformat    "$REFS/technical-approach-format.md" 'src/entry/core/*'
# The two Foundation pattern docs are reached from the implement-phase brief directly, and that
# subagent never sees a `fnd project profile:` line — so the gate has to live in the doc itself.
gated cssvars     "$REFS/section-css-variables-pattern.md" 'use_section_vars'
gated eslintrail  "$REFS/eslint-no-restricted-syntax.md"   'no-restricted-syntax'
for f in "$REFS/section-css-variables-pattern.md" "$REFS/eslint-no-restricted-syntax.md"; do
  # Not the session line alone: the brief's own `profile:` word has to count, or the doc is
  # ungated exactly where pipeline-phases hands it over.
  if grep -qF -- 'profile:' "$f"; then ok
  else bad "gate-patterndoc-brief-$(short_id "$f")" "$(basename "$f") gates only on a session line the implement subagent never receives"; fi
done
if grep -qF -- 'foundation` profile only' "$REFS/pipeline-phases.md"; then ok
else bad gate-implement-brief "pipeline-phases.md hands the Foundation pattern docs to the implement agent ungated"; fi
if grep -qF -- 'foundation|theme|none' "$REFS/pipeline-phases.md"; then ok
else bad gate-implement-profile "pipeline-phases.md's implement brief does not carry the run's profile"; fi

# A per-file presence grep is satisfied by any unrelated mention of the profile, so each gate is
# also pinned to its own SPOT: the gate word and the guidance it governs in one clause. This is the
# half that fails when a future edit drops the conditional from the flagship skills.
# The per-profile START command has ONE home: session-theme.md step 5 carries both branches, and
# every other file names the gate word, keeps its Foundation form verbatim, and points back there.
# These clauses wrap mid-sentence, so they are matched with the file's newlines joined.
hasjoin gate-sessiontheme-spot   "$REFS/session-theme.md" \
  '.foundation. checkout \(session line .fnd project profile: foundation.\) . .npm run dev -- --theme <id> \[--port <N>\].'
hasjoin gate-sessiontheme-plain  "$REFS/session-theme.md" \
  'any other checkout . .shopify theme dev --theme <id> \[--port <N>\].'
has     gate-sessiontheme-home   "$REFS/session-theme.md" 'single home of that mapping'
hasjoin gate-sessiontheme-noline "$REFS/session-theme.md" \
  'No profile line in the session[^|]{0,60}the .foundation. form'
hasjoin gate-ship-devserver      "$SKILLS/ship/SKILL.md" \
  'session-theme\.md step 5[^|]{0,80}.foundation.: .npm run dev -- --theme <id> \[--port <N>\].'
hasjoin gate-preview-devserver   "$SKILLS/preview-theme/SKILL.md" \
  'session-theme\.md. step 5[^|]{0,120}.foundation.[^|]{0,90}npm run dev -- --theme <id> --port <N>.'
hasjoin gate-worktree-devserver  "$SKILLS/worktree/SKILL.md" \
  'session-theme\.md. step 5[^|]{0,120}.foundation.[^|]{0,90}npm run dev -- --theme <id> --port <N>.'
hasjoin gate-checklist-defers    "$REFS/preflight-checklist.md" \
  'only DETECTS a server[^|]{0,90}session-theme\.md. step 5'
hasjoin gate-errors-devserver    "$REFS/preview-theme-errors.md" \
  'session-theme\.md. step 5[^|]{0,80}.foundation.[^|]{0,40}npm run dev -- --theme <id>.'
hasre gate-develop-core       "$SKILLS/develop-feature-or-fix/SKILL.md" \
  'In a .foundation. checkout .session line .fnd project profile: foundation..[^|]*src/entry/core'
hasre gate-develop-patterns   "$SKILLS/develop-feature-or-fix/SKILL.md" \
  'foundation. checkout only, skip both elsewhere.*use_section_vars'
hasre gate-a11y-spot          "$SKILLS/fix-accessibility-issue/SKILL.md" \
  'In a .foundation. checkout .session line .fnd project profile: foundation..[^|]*Tailwind'
hasre gate-ta-spot            "$SKILLS/write-technical-approach/SKILL.md" \
  'In a .foundation. checkout .session line .fnd project profile: foundation..[^|]*src/entry/core'
hasre gate-checklist-spot     "$REFS/preflight-checklist.md" \
  'in a .foundation. checkout ..npm run dev'
# When the session carries no profile line at all (every hook here fails open), the spots that gate
# a PROTECTION or a lint rail rather than a command must still say which branch to take — and a
# skill that instructs the probe has to pre-approve it, or the fallback stops at a prompt.
for f in "$SKILLS/develop-feature-or-fix/SKILL.md" "$SKILLS/write-technical-approach/SKILL.md" \
         "$SKILLS/fix-accessibility-issue/SKILL.md"; do
  if grep -qF -- 'scripts/project-profile.sh' "$f"; then ok
  else bad "gate-no-line-fallback-$(short_id "$f")" "$(basename "$f") gates core protection on a line that can be absent, with no probe fallback"; fi
  case "$(sed -n 's/^allowed-tools: //p' "$f")" in
    '') ok ;;  # no allowed-tools line at all: nothing is restricted, so nothing needs approving
    *'project-profile.sh'*) ok ;;
    *) bad "gate-fallback-allowed-$(short_id "$f")" "$(basename "$f") instructs the profile probe its allowed-tools blocks" ;;
  esac
done

# The non-Foundation branch is what the gate exists to provide: the single home hands over a START
# command, so it names the runnable CLI form, flag and all — a bare `shopify theme dev` mention
# elsewhere in the file must not be able to satisfy this.
for f in "$REFS/session-theme.md"; do
  if grep -qF -- 'shopify theme dev --theme' "$f"; then ok
  else bad "gate-plain-branch-$(short_id "$f")" "no runnable \`shopify theme dev --theme\` fallback in $(basename "$f")"; fi
done
# Every file that used to spell its own copy of the mapping now defers to that home instead.
for f in "$SKILLS/ship/SKILL.md" "$SKILLS/preview-theme/SKILL.md" "$SKILLS/worktree/SKILL.md" \
         "$REFS/preflight-checklist.md" "$REFS/preview-theme-errors.md"; do
  if grep -qF -- 'session-theme' "$f"; then ok
  else bad "gate-defers-$(short_id "$f")" "$(basename "$f") gives a dev-server command without pointing at session-theme.md"; fi
done
# preflight-checklist only DETECTS a server, so the bare form is the right one there.
if grep -qF -- 'else `shopify theme dev`' "$REFS/preflight-checklist.md"; then ok
else bad gate-plain-branch-checklist "preflight-checklist.md has no plain-theme dev-server branch"; fi
# The worktree hand-off the developer pastes is printed by the script, not the skill, so the
# script has to ask the probe too — a README sentence promising the split is not enough.
if grep -qF -- 'project-profile.sh' "$ROOT/plugins/fnd/scripts/worktree-setup.sh"; then ok
else bad gate-worktree-script "worktree-setup.sh prints the npm hand-off unconditionally"; fi
# README documents the same split for the session-theme hand-off.
README_MD="$ROOT/README.md"
has gate-readme-plain      "$README_MD" 'shopify theme dev --theme <id> [--port <N>]'
has gate-readme-foundation "$README_MD" 'npm run dev -- --theme <id> [--port <N>]'

echo "preflight-additions: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
