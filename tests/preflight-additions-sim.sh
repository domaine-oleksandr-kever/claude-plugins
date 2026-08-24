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
#      order and their instructions, and the new rows are appended after them.
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

if [ -n "$UPDATE" ]; then ok; else bad update-section "no '## Plugin update check' section in the checklist"; fi
if [ -n "$PINS" ]; then ok; else bad pins-section "no '## Model pins' section in the checklist"; fi

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

# Every plugin path the two rows point at exists in this checkout.
for rel in agents-cursor agents-codex references/host-model-map.md scripts/gen-host-adapters.cjs \
           scripts/doctor.cjs .claude-plugin/plugin.json; do
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

# ------------------------------------------------------------ wiring into the report --
# A row that never reaches the report format is dead prose.
REPORT="$(section "$CHECKLIST" 'Report format')"
sec_has report-update "$REPORT" 'plugin update'
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
has skill-order "$PREFLIGHT" 'local dev server → plugin update → model pins'
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

echo "preflight-additions: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
