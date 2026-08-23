#!/usr/bin/env bash
# Docs assertions for the multi-harness port (M9): README.md + docs/README.<host>.md.
# Docs are the install contract on three of the four hosts — a command that drifted from the
# installer, a path that was renamed, or a version literal in an unstamped file all read as a
# broken install to whoever follows them. Four families:
#   1. install commands — the literal per-host command lines, each host's smoke-test invocation
#      form, and the per-host doc that owns the walkthrough;
#   2. referenced paths — every repo-relative path the docs name in backticks must exist,
#      resolved against the repo root OR the plugin root (docs address both);
#   3. version markers — README carries the bump-version marker forms and they agree with the
#      canonical manifest; docs/ carries NO version literal, since bump-version does not stamp
#      those files and a stamp it cannot reach is a stamp that drifts;
#   4. links — every relative markdown link resolves to a file, every in-page anchor to a
#      heading in that same file.
# Discovery is by glob over docs/, so a host doc added later is covered without editing this
# file. Exit 0 = docs green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT/plugins/fnd"
CANON="$PLUGIN_DIR/.claude-plugin/plugin.json"
README="$ROOT/README.md"
NODE_BIN="$(command -v node)"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

# has <file> <literal> — fixed-string presence, the only form that proves a command is documented
# verbatim rather than paraphrased
has() {
  if grep -qF -- "$2" "$1"; then ok; else bad "$3" "not found in ${1#$ROOT/}: '$2'"; fi
}

DOCS=""
for f in "$ROOT"/docs/README.*.md; do
  [ -f "$f" ] || continue
  DOCS="${DOCS}${f}
"
done

# --------------------------------------------------------------- 0. the files exist --
for f in "$README" "$ROOT/docs/README.cursor.md" "$ROOT/docs/README.codex.md" \
         "$ROOT/docs/README.opencode.md"; do
  if [ -f "$f" ]; then ok; else bad "exists-${f#$ROOT/}" "missing"; fi
done

# ------------------------------------------------------- 1. install + verify commands --
# The four Install stories, verbatim. Each host's row must carry the install command AND the
# smoke-test invocation form that host actually accepts (`/fnd:`, `/`, `$`) — the verification
# step is half the story, and its spelling is host-specific.
has "$README" '/plugin marketplace add' install-claude
has "$README" '/plugin install fnd@domaine' install-claude-plugin
has "$README" '/fnd:smoke-test' verify-claude
has "$README" './scripts/install.sh --target cursor' install-cursor
has "$README" './scripts/install.sh --target opencode' install-opencode
has "$README" './scripts/install.sh --target codex' install-codex
has "$README" 'codex plugin marketplace add' install-codex-marketplace
has "$README" '$smoke-test' verify-codex
has "$README" '/smoke-test' verify-cursor-opencode
has "$README" 'node plugins/fnd/scripts/doctor.cjs --target' verify-doctor

# The repo slug the marketplace commands name must be this repo's own remote-facing name; a
# placeholder slug here sends a user to a marketplace that does not exist.
SLUG="domaine-oleksandr-kever/claude-plugins"
if grep -qF "codex plugin marketplace add $SLUG" "$README"; then ok
else bad install-codex-slug "README's codex marketplace command does not name $SLUG"; fi

# Per-host docs: the same command, plus the walkthrough steps that only exist there.
has "$ROOT/docs/README.cursor.md" './scripts/install.sh --target cursor' cursor-doc-install
has "$ROOT/docs/README.cursor.md" '/smoke-test' cursor-doc-verify
# 2026-08-23 research: CLI marketplace route + the hybrid model policy (cheap pin / inherit)
has "$ROOT/docs/README.cursor.md" 'agent plugin marketplace add' cursor-doc-cli-route
has "$ROOT/docs/README.cursor.md" 'agent login' cursor-doc-cli-login
has "$ROOT/plugins/fnd/references/host-model-map.md" 'composer-2.5[fast=false]' cursor-hybrid-pin
has "$ROOT/docs/README.opencode.md" './scripts/install.sh --target opencode' opencode-doc-install
has "$ROOT/docs/README.opencode.md" '/smoke-test' opencode-doc-verify
# The statics paste is the step a fresh install cannot infer (live-smoke 2026-08-22 found the
# walkthrough without it → smoke row 6 red); the reference must send an OpenCode red to that
# paste, not to an issue filing.
has "$ROOT/docs/README.opencode.md" 'plugins/fnd/hooks/comment-discipline.md' opencode-doc-statics-paste
has "$ROOT/plugins/fnd/references/smoke-test-checks.md" 'docs/README.opencode.md' smoke-row6-opencode-remediation
has "$ROOT/docs/README.codex.md" "codex plugin marketplace add $SLUG" codex-doc-marketplace
has "$ROOT/docs/README.codex.md" '--ref harness-port' codex-doc-branch-ref
has "$ROOT/docs/README.codex.md" '/plugins' codex-doc-plugins-browser
has "$ROOT/docs/README.codex.md" 'hooks = true' codex-doc-features-gate
has "$ROOT/docs/README.codex.md" '/hooks' codex-doc-trust-review
has "$ROOT/docs/README.codex.md" './scripts/install.sh --target codex' codex-doc-agents-link
has "$ROOT/docs/README.codex.md" '$smoke-test' codex-doc-verify

# Update stories: the exact update command per host, and the caveats a user cannot infer.
has "$README" 'codex plugin marketplace upgrade' update-codex
has "$README" '/plugin marketplace update domaine' update-claude
has "$README" 'Unpushed commits are invisible' update-unpushed-warning
has "$README" '`--copy` installs do not follow `git pull`' update-copy-caveat

# Every target the installer accepts must be documented, and vice versa — the two lists drifting
# is how a host loses its install path. The accepted set is READ from the installer (the accept arm
# of the `case "$TARGET"` validator), never hard-coded here: hard-coding passes a target added there
# without a doc, and fails a reordering of the same three.
INSTALLER_TARGETS="$(awk '
  /^case "\$TARGET" in/ { in_case = 1; next }
  in_case && /^esac/ { exit }
  in_case && $0 ~ /^[[:space:]]*[a-z][a-z|]*\)[[:space:]]*;;/ {
    sub(/^[[:space:]]*/, ""); sub(/\).*/, ""); print; exit
  }
' "$ROOT/scripts/install.sh")"
if [ -n "$INSTALLER_TARGETS" ]; then ok
else bad installer-target-list "scripts/install.sh no longer validates a --target set this suite can read"; fi
INSTALLER_SET=" $(printf '%s' "$INSTALLER_TARGETS" | tr '|' ' ') "
for t in $INSTALLER_SET; do
  if grep -qF -- "--target $t" "$README"; then ok
  else bad "readme-target-$t" "scripts/install.sh accepts --target $t; README does not document it"; fi
done
# The other direction, restricted to installer invocations so doctor's own target list stays free
# to differ: a documented target the installer rejects is an install command that exits 2.
for t in $(grep -oE -- 'install\.sh --target [a-z]+' "$README" | awk '{ print $3 }' | sort -u); do
  case "$INSTALLER_SET" in
    *" $t "*) ok ;;
    *) bad "installer-target-$t" "README documents --target $t but scripts/install.sh does not accept it" ;;
  esac
done

# ----------------------------------------------------------- 2. referenced paths exist --
# Backticked repo-relative paths only: globs, host paths (~/…), placeholders (<…>) and URLs are
# addressed to the reader's machine, not to this checkout.
check_paths() {
  local file="$1" label="$2" p
  for p in $(grep -ohE '`(plugins/fnd|scripts|tests|docs)/[A-Za-z0-9._/-]+`' "$file" |
               tr -d '`' | sort -u); do
    case "$p" in *'*'*|*'<'*) continue ;; esac
    # `scripts/json-slim.cjs` addresses the plugin root, `scripts/install.sh` the repo root;
    # both spellings are correct in their own context, so either resolution counts.
    if [ -e "$ROOT/$p" ] || [ -e "$PLUGIN_DIR/$p" ]; then ok
    else bad "$label" "${file#$ROOT/} names a path that does not exist: $p"; fi
  done
}
check_paths "$README" path-readme
while IFS= read -r d; do
  [ -n "$d" ] || continue
  check_paths "$d" "path-${d##*/}"
done <<EOF
$DOCS
EOF

# Test suites named in the docs must exist — a renamed suite that still reads as runnable in the
# README is a command that fails on a fresh clone.
for s in $(grep -ohE '`?tests/[A-Za-z0-9._-]+\.(sh|mjs)`?' "$README" $ROOT/docs/README.*.md 2>/dev/null |
             tr -d '`' | sort -u); do
  if [ -f "$ROOT/$s" ]; then ok; else bad suite-missing "docs name a suite that does not exist: $s"; fi
done

# ------------------------------------------------------------- 3. version marker sync --
CANON_VERSION="$("$NODE_BIN" -e '
  const fs = require("fs");
  try {
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(typeof m.version === "string" ? m.version : "");
  } catch (e) { process.exit(1); }
' "$CANON" 2>/dev/null)"

if [ -n "$CANON_VERSION" ]; then ok
else bad canon-version "cannot read version from ${CANON#$ROOT/}"; fi

# `fnd v<semver>` — the marker bump-version.cjs stamps in README.md
FND_V="$(grep -oE '\bfnd v[0-9]+\.[0-9]+\.[0-9]+' "$README" | sed 's/^fnd v//' | sort -u)"
if [ -z "$FND_V" ]; then
  bad readme-fnd-v-marker "README carries no 'fnd v<semver>' marker — bump-version would skip it"
elif [ "$(printf '%s\n' "$FND_V" | wc -l | tr -d ' ')" != "1" ]; then
  bad readme-fnd-v-drift "README carries several versions: $(printf '%s' "$FND_V" | tr '\n' ' ')"
elif [ "$FND_V" = "$CANON_VERSION" ]; then ok
else bad readme-fnd-v-sync "README says fnd v$FND_V, manifest says $CANON_VERSION"; fi

# `FND_VERSION="<semver>"` — the other stamped form; README documents it, install.sh assigns it
INSTALL_V="$(grep -oE 'FND_VERSION="[0-9]+\.[0-9]+\.[0-9]+"' "$ROOT/scripts/install.sh" |
             sed 's/.*"\(.*\)"/\1/' | sort -u)"
if [ -z "$INSTALL_V" ]; then
  bad install-version-marker "scripts/install.sh carries no quoted FND_VERSION= assignment"
elif [ "$INSTALL_V" = "$CANON_VERSION" ]; then ok
else bad install-version-sync "install.sh says $INSTALL_V, manifest says $CANON_VERSION"; fi

# docs/ is NOT a bump-version target, so a version literal there can only drift. Placeholders
# (<version>) are how the per-host docs show doctor output without pinning a number.
while IFS= read -r d; do
  [ -n "$d" ] || continue
  hits="$(grep -oE '\bfnd v[0-9]+\.[0-9]+\.[0-9]+|FND_VERSION="[0-9]+\.[0-9]+\.[0-9]+"|version [0-9]+\.[0-9]+\.[0-9]+' "$d" | sort -u)"
  if [ -z "$hits" ]; then ok
  else bad "docs-version-literal-${d##*/}" "unstamped file carries a version literal: $(printf '%s' "$hits" | tr '\n' ' ')"; fi
done <<EOF
$DOCS
EOF

# ---------------------------------------------------------------------- 4. dead links --
# Relative link targets must exist; in-page anchors must match a heading in the same file.
# GitHub's slug rule, reduced to what these files use: lowercase, drop everything that is not
# alphanumeric/space/hyphen, spaces -> hyphens.
link_check() {
  local file="$1"
  "$NODE_BIN" -e '
    const fs = require("fs");
    const path = require("path");
    const file = process.argv[1];
    const text = fs.readFileSync(file, "utf8");
    // one hyphen PER space, not per run: GitHub does not collapse the gap an em dash leaves
    // behind, so "Install — four hosts" is #install--four-hosts
    const slug = (h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");
    const anchors = new Set();
    for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) anchors.add(slug(m[1]));
    const problems = [];
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [rel, frag] = target.split("#");
      if (!rel) {
        if (!anchors.has(frag)) problems.push("no heading for anchor #" + frag);
        continue;
      }
      const abs = path.resolve(path.dirname(file), rel);
      if (!fs.existsSync(abs)) { problems.push("missing target " + rel); continue; }
      if (!frag) continue;
      const other = fs.readFileSync(abs, "utf8");
      const otherAnchors = new Set();
      for (const h of other.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) otherAnchors.add(slug(h[1]));
      if (!otherAnchors.has(frag)) problems.push("no heading for " + rel + "#" + frag);
    }
    if (problems.length) { process.stdout.write(problems.join("; ")); process.exit(1); }
  ' "$file" 2>&1
}

for f in "$README" $ROOT/docs/README.*.md; do
  [ -f "$f" ] || continue
  if out="$(link_check "$f")"; then ok
  else bad "links-${f##*/}" "$out"; fi
done

# Domaine env files (2026-08-23): the mechanism is documented where the switches live, and the
# CLI's KNOWN registry (names only by design) can never drift from the README table — every
# switch it lists must appear here.
has "$README" 'domaine-env.cjs list' env-cli-documented
has "$README" '.claude/domaine.env' env-project-file-documented
has "$README" 'ask the agent in a session' env-ask-agent-documented
for k in $(grep -oE "'(FND_[A-Z0-9_]+|SHOPIFY_ADMIN_GQL_QUIET)'" "$ROOT/plugins/fnd/scripts/domaine-env.cjs" | tr -d "'" | sort -u); do
  has "$README" "$k" "env-known-$k"
done

echo "readme-checks: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
