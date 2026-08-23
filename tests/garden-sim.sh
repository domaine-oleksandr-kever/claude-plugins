#!/usr/bin/env bash
# Simulation harness for plugins/fnd/scripts/garden-check.cjs (multi-harness port, M8).
# The garden check only earns its place in CI if each rule actually fires, so every case here
# breaks ONE thing in a sandbox copy of the checkout (--root) and asserts the matching row goes
# red — plus the two cases that must stay green: the real tree, and a warning-only run.
# Nothing is written outside $TMPDIR. Exit 0 = all green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GARDEN="$ROOT/plugins/fnd/scripts/garden-check.cjs"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Re-checked at the end: no case may mutate the real checkout.
HEAD_BEFORE="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)"
O="$TMP/out"; E="$TMP/err"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

rc=0
run() { rc=0; node "$GARDEN" "$@" >"$O" 2>"$E" || rc=$?; }

# expect <label> <want-rc> [pattern ...] — every pattern must appear in stdout as a literal;
# a pattern prefixed with ! must NOT appear.
expect() {
  label="$1"; want="$2"; shift 2
  if [ "$rc" -ne "$want" ]; then
    bad "$label" "exit $rc, want $want :: $(tr '\n' ';' <"$O" | head -c 300) err=$(head -c 120 "$E")"; return
  fi
  for p in "$@"; do
    if [ "${p#!}" != "$p" ]; then
      if grep -qF -- "${p#!}" "$O"; then bad "$label" "stdout has forbidden '${p#!}' :: $(tr '\n' ';' <"$O" | head -c 300)"; return; fi
    elif ! grep -qF -- "$p" "$O"; then
      bad "$label" "stdout missing '$p' :: $(tr '\n' ';' <"$O" | head -c 300)"; return
    fi
  done
  ok
}

# A pristine sandbox checkout: everything garden-check.cjs resolves paths into, nothing else (no
# .git — the script never shells out to git, and CI must not need one either). tests/ and LICENSE
# are in the list because bundled prose points at them from outside the plugin dir
# (`<plugin root>/../../tests/fixtures/…`, README's `[LICENSE](./LICENSE)`).
BASE="$TMP/base"
mkdir -p "$BASE"
for entry in plugins scripts tests docs README.md CLAUDE.md LICENSE; do
  [ -e "$ROOT/$entry" ] && cp -R "$ROOT/$entry" "$BASE/"
done

# sandbox <name> — a fresh copy of BASE, printed so a case can mutate it
sandbox() {
  d="$TMP/$1"
  rm -rf "$d"
  cp -R "$BASE" "$d"
  printf '%s' "$d"
}

PLUGIN="plugins/fnd"

# ------------------------------------------------------------------------------ green runs --
# G1: the real checkout is the bar this suite defends — every rule green, exit 0.
run
expect G1-real-tree 0 "PASS  links" "PASS  generated" "PASS  version:manifests" "PASS  version:stamps" \
  "PASS  rules-bundle" "PASS  hook-wiring:json" "PASS  hook-wiring:targets" "!FAIL"

# G2: the same tree copied into a sandbox — proves --root, and that no check depends on git,
# on the absolute path, or on anything outside the copied files.
S="$(sandbox green)"
run --root "$S"
expect G2-sandbox-green 0 "fnd garden — repo root: $S" "PASS  links" "PASS  generated" "!FAIL"

# ----------------------------------------------------------------------------- dead links --
# G3: a markdown link to a file that was renamed away — the silent rot this rule exists for.
S="$(sandbox deadlink)"
printf '# probe\n\nSee [the format](gone-away.md) for details.\n' > "$S/$PLUGIN/references/garden-probe.md"
run --root "$S"
expect G3-dead-md-link 1 "FAIL  links:$PLUGIN/references/garden-probe.md" "line 3: gone-away.md" "renamed or deleted"

# G4: the `<plugin root>/…` mention form skills use for bundled paths.
S="$(sandbox deadmention)"
printf '# probe\n\nRun `<plugin root>/scripts/no-such-script.sh` first.\n' > "$S/$PLUGIN/references/garden-probe.md"
run --root "$S"
expect G4-dead-path-mention 1 "FAIL  links:$PLUGIN/references/garden-probe.md" "<plugin root>/scripts/no-such-script.sh"

# G5: an absolute path resolves on the author's machine and nowhere else — still a dead link.
S="$(sandbox abslink)"
printf '# probe\n\nSee [notes](/Users/someone/notes.md).\n' > "$S/$PLUGIN/skills/commit/GARDEN-PROBE.md"
run --root "$S"
expect G5-absolute-link 1 "FAIL  links:$PLUGIN/skills/commit/GARDEN-PROBE.md" "absolute path"

# G6: documentation ABOUT a link is not a link — inline code and fenced blocks stay exempt, which
# is what keeps rules/SOURCE.md (it quotes the pre-import `mdc:` form) and the PR-body templates
# green. A live link on the same page still has to resolve.
S="$(sandbox codelink)"
{
  printf '# probe\n\nThe old form was `[x](mdc:.cursor/rules/x.mdc)`, rewritten at import.\n\n'
  printf '```md\n[template](THEME_URL)\n[example](also-not-real.md)\n```\n\n'
  printf 'Live: [session theme](session-theme.md).\n'
} > "$S/$PLUGIN/references/garden-probe.md"
run --root "$S"
expect G6-code-spans-exempt 0 "PASS  links" "!FAIL"

# G7: a rule cross-link inside the vendored bundle is checked like any other relative link.
S="$(sandbox rulelink)"
printf '\n\nSee [gone.mdc](gone.mdc).\n' >> "$S/$PLUGIN/rules/liquid.mdc"
run --root "$S"
expect G7-rule-cross-link 1 "FAIL  links:$PLUGIN/rules/liquid.mdc" "gone.mdc"

# --------------------------------------------------------------------- skill size watchlist --
# G8: the Codex cap is unconfirmed (M1b), so an oversized skill WARNs and the run still exits 0 —
# a size watchlist that blocked CI would be a guess enforced as a rule.
S="$(sandbox oversize)"
head -c 9000 /dev/zero | tr '\0' 'x' >> "$S/$PLUGIN/skills/commit/SKILL.md"
run --root "$S"
expect G8-skill-size-warn 0 "WARN  skill-size:commit" "over the 8000 B Codex watchlist" "!FAIL"

# G9: the watchlist row reports the real skill count, so a skills/ that stopped being discovered
# cannot masquerade as "nothing oversized".
run --root "$BASE"
expect G9-skill-size-count 0 "PASS  skill-size" "18 skill(s)"

# -------------------------------------------------------------------------- generated drift --
# G10: a hand-edited generated adapter — the one failure mode "never hand-edit generated dirs"
# depends on being caught before a push, since the host reads the committed file, not the generator.
S="$(sandbox gendrift)"
printf '\nhand-edited\n' >> "$S/$PLUGIN/agents-cursor/jira-reader.md"
run --root "$S"
expect G10-generated-drift 1 "FAIL  generated" "agents-cursor/jira-reader.md" "never hand-edit generated dirs"

# G11: a file nobody's canonical source produces is stale output, not new content.
S="$(sandbox genstale)"
printf 'orphan\n' > "$S/$PLUGIN/agents-codex/ghost.toml"
run --root "$S"
expect G11-generated-stale 1 "FAIL  generated" "ghost.toml"

# G12: without the generator there is no way to verify the committed adapters at all — say so
# rather than passing a check that did not run.
S="$(sandbox nogen)"
rm -f "$S/$PLUGIN/scripts/gen-host-adapters.cjs"
run --root "$S"
expect G12-generator-missing 1 "FAIL  generated" "is missing"

# --------------------------------------------------------------------------- version drift --
# G13: the Shopify-AI-Toolkit failure in one row — one manifest stamped by hand, two not.
S="$(sandbox verdrift)"
sed 's/"version": "[^"]*"/"version": "0.1.2"/' "$S/$PLUGIN/.cursor-plugin/plugin.json" > "$S/tmp.json"
mv "$S/tmp.json" "$S/$PLUGIN/.cursor-plugin/plugin.json"
run --root "$S"
# The remediation is asserted as the full runnable path: `scripts/bump-version.cjs` does not exist
# from the repo root, and a fix line that MODULE_NOT_FOUNDs leaves a red garden with no way out.
expect G13-manifest-drift 1 "FAIL  version:manifests" "drift:" ".cursor-plugin/plugin.json=0.1.2" \
  "node plugins/fnd/scripts/bump-version.cjs"

# G14: the documented text stamps are part of the same all-or-nothing bump — a README left behind
# tells every reader the wrong version.
S="$(sandbox stampdrift)"
sed 's/fnd v0\./fnd v9./' "$S/README.md" > "$S/tmp.md"
mv "$S/tmp.md" "$S/README.md"
run --root "$S"
expect G14-stamp-drift 1 "FAIL  version:stamps" "README.md:" "node plugins/fnd/scripts/bump-version.cjs"

# G15: the installer carries the same marker and drifts the same way.
S="$(sandbox installstamp)"
sed 's/^FND_VERSION="[^"]*"/FND_VERSION="0.0.1"/' "$S/scripts/install.sh" > "$S/tmp.sh"
mv "$S/tmp.sh" "$S/scripts/install.sh"
run --root "$S"
expect G15-installer-stamp-drift 1 "FAIL  version:stamps" "scripts/install.sh:" "0.0.1"

# G15b: …but only on the marker bump-version.cjs actually stamps there. That script's TARGETS row
# for install.sh carries FND_VERSION= alone, so an `fnd v<semver>` line in the installer's prose is
# text no bump can reach — flagging it would be a FAIL whose own remediation cannot clear it.
S="$(sandbox installprose)"
printf '# Installs fnd v0.0.1 into the chosen host.\n' >> "$S/scripts/install.sh"
run --root "$S"
expect G15b-installer-prose-not-a-stamp 0 "PASS  version:stamps" "!scripts/install.sh:"

# G16: no canonical manifest means this is not an fnd checkout — a wrong --root must not report
# a tidy garden.
S="$(sandbox nomanifest)"
rm -f "$S/$PLUGIN/.claude-plugin/plugin.json"
run --root "$S"
# …and the stamps row is skipped, not answered from a per-host manifest: those are copies of the
# canonical stamp, so a version read out of one would report drift against a substitute.
expect G16-no-canonical-manifest 1 "FAIL  version:manifests" "not an fnd checkout" "!version:stamps"

# G16b: same rule when the canonical manifest is present but unparseable — a surviving sibling
# manifest is still not a stand-in for the stamp every documented marker is bumped from.
S="$(sandbox brokenmanifest)"
printf '{ not json\n' > "$S/$PLUGIN/.claude-plugin/plugin.json"
run --root "$S"
expect G16b-broken-canonical-manifest 1 "FAIL  version:manifests" "!version:stamps"

# --------------------------------------------------------------------------- rules bundle --
# G17: a vendored foundation rule edited in place instead of upstream — the recorded byte size is
# the only trace such an edit leaves.
S="$(sandbox ruleedit)"
printf '\n' >> "$S/$PLUGIN/rules/core.mdc"
run --root "$S"
expect G17-vendored-rule-edited 1 "FAIL  rules-bundle" "core.mdc is" "SOURCE.md records" "re-import"

# G18: a rule listed in the provenance table but no longer on disk.
S="$(sandbox ruledeleted)"
rm -f "$S/$PLUGIN/rules/locales.mdc"
run --root "$S"
expect G18-vendored-rule-absent 1 "FAIL  rules-bundle" "locales.mdc listed in SOURCE.md but absent"

# G19: an imported rule that arrived without a provenance row — WARN, because fnd-authored rules
# legitimately have none and the fix is a table edit, not a revert.
S="$(sandbox ruleorphan)"
cp "$S/$PLUGIN/rules/locales.mdc" "$S/$PLUGIN/rules/imported-by-hand.mdc"
run --root "$S"
expect G19-rule-provenance-warn 0 "WARN  rules-bundle:provenance" "imported-by-hand.mdc" "!FAIL"

# G20: an fnd-authored rule is not an import and must not be warned about.
S="$(sandbox rulefnd)"
cp "$S/$PLUGIN/rules/locales.mdc" "$S/$PLUGIN/rules/fnd-garden-probe.mdc"
run --root "$S"
expect G20-fnd-rule-exempt 0 "PASS  rules-bundle" "!WARN  rules-bundle:provenance"

# G21: no provenance file at all — drift vs foundation becomes unfalsifiable.
S="$(sandbox nosource)"
rm -f "$S/$PLUGIN/rules/SOURCE.md"
run --root "$S"
expect G21-source-md-missing 1 "FAIL  rules-bundle" "SOURCE.md is missing"

# --------------------------------------------------------------------------- hook wirings --
# G22: a wiring file that stopped parsing disables the whole guard layer on that host, silently.
S="$(sandbox badwiring)"
printf '{"sessionStart": [\n' > "$S/$PLUGIN/hooks/hooks-cursor.json"
run --root "$S"
expect G22-wiring-unparseable 1 "FAIL  hook-wiring:json" "hooks/hooks-cursor.json"

# G23: a wiring that still spawns a hook script someone renamed.
S="$(sandbox missingtarget)"
rm -f "$S/$PLUGIN/hooks/cursor-shim.cjs"
run --root "$S"
expect G23-wiring-target-gone 1 "FAIL  hook-wiring:targets" "hooks/cursor-shim.cjs" "spawns a script that is gone"

# G24: the OpenCode adapter is JS, so "does it parse" means a syntax check, not JSON.parse.
S="$(sandbox badjs)"
printf '\nfunction ( {\n' >> "$S/$PLUGIN/opencode/fnd-plugin.js"
run --root "$S"
expect G24-adapter-syntax 1 "FAIL  hook-wiring:js" "opencode/fnd-plugin.js"

# G25: runtime-built paths (`$r/hooks/$f.md`) are not resolvable from here and must not be guessed
# at — the Codex wiring builds its static-context paths that way and stays green.
run --root "$BASE"
expect G25-runtime-paths-skipped 0 "PASS  hook-wiring:targets" "!FAIL"

# ------------------------------------------------------------------------------- CLI shape --
# G26: an unknown flag is a usage error (2), not a garden failure (1) — CI can tell them apart.
run --nope
expect G26-unknown-flag 2
if grep -qF 'usage: garden-check.cjs' "$E"; then ok; else bad G26-usage-stderr "no usage line on stderr"; fi

# G27: --root without a value is the same class of mistake.
run --root
expect G27-root-needs-value 2

# G28: --help prints usage and exits clean.
run --help
expect G28-help 0 "usage: garden-check.cjs"

# G29: a --root that is not a checkout fails loudly rather than reporting an empty green garden.
run --root "$TMP/does-not-exist"
expect G29-bogus-root 1 "FAIL  links" "FAIL  version:manifests"

# ----------------------------------------------------------------------------- CI workflow --
# The workflow is the other half of M8: the garden check only guards a push if something runs it.
# There is no YAML parser in a dependency-free repo, so these are content assertions — enough to
# catch the three ways this file rots: a runner dropped from the matrix, a suite class no longer
# executed, and a dependency sneaking in through an action or an install command.
WF="$ROOT/.github/workflows/tests.yml"
if [ -f "$WF" ]; then ok; else bad ci-workflow "missing: $WF"; fi

# `permissions: contents: read` is in the list because the suites build and drive real git repos:
# an undeclared token inherits the repo/org default, so a suite bug that reaches `git push` would
# write to this repository instead of failing.
# `fail-fast: false` is pinned too: without it one red runner cancels the other, and "green on
# macOS, red on Linux" is the finding this matrix exists to produce.
for want in "macos-latest" "ubuntu-latest" "actions/checkout" "actions/setup-node" \
            "for f in tests/*.sh" "bash \"\$f\"" "for f in tests/*.mjs" "node \"\$f\"" \
            "garden-check.cjs" "gen-host-adapters.cjs --check" "permissions:" "contents: read" \
            "fail-fast: false"; do
  if grep -qF -- "$want" "$WF" 2>/dev/null; then ok
  else bad "ci-workflow-content" "tests.yml does not mention: $want"; fi
done

# Suites are discovered by glob, never listed — a hard-coded suite name would silently stop
# covering whatever is added next.
if grep -qE 'tests/[A-Za-z0-9_-]+\.(sh|mjs)' "$WF"; then
  bad "ci-workflow-glob" "tests.yml names an individual suite instead of globbing tests/*"
else ok; fi

# Repo policy: dependency-free. An `npm install` in CI would make the suites pass against a
# toolchain no developer machine has.
if grep -qE '(npm|yarn|pnpm|bun|brew|apt-get)[[:space:]]+(install|add|ci)' "$WF"; then
  bad "ci-workflow-deps" "tests.yml installs packages — the plugin must run on bare node + bash"
else ok; fi

# Third-party actions are a supply-chain surface and the plan allows exactly two.
extra="$(grep -oE 'uses:[[:space:]]*[^[:space:]]+' "$WF" | sed 's/uses:[[:space:]]*//' \
         | grep -vE '^actions/(checkout|setup-node)@' || true)"
if [ -z "$extra" ]; then ok
else bad "ci-workflow-actions" "unexpected action(s): $(printf '%s' "$extra" | tr '\n' ' ')"; fi

# ------------------------------------------------------------------------------ isolation --
HEAD_AFTER="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)"
if [ "$HEAD_AFTER" = "$HEAD_BEFORE" ]; then ok; else bad isolation "HEAD moved: $HEAD_BEFORE -> $HEAD_AFTER"; fi
# The G1 run above was against the real checkout, so "reports only, never repairs" is not a claim
# this suite can take on trust: a garden check that writes would repair the very drift it is meant
# to report, and CI would go green on a tree nobody fixed.
if grep -qE '\b(writeFileSync|appendFileSync|rmSync|mkdirSync|renameSync|unlinkSync|createWriteStream)\b' "$GARDEN"
then bad isolation "garden-check.cjs contains a filesystem write call — it must only report"
else ok; fi

echo "garden-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
