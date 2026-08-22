#!/usr/bin/env bash
# Simulation harness for plugins/fnd/scripts/doctor.cjs (multi-harness port, M2 — Verification
# story layer 1). Every case runs the doctor against a sandbox plugin root (--root) and a sandbox
# home (--home): no host, no network, nothing written outside $TMPDIR. Exit 0 = all green.
set -u

# --home is the whole override, but only because the doctor ignores XDG_CONFIG_HOME when it is
# given; an ambient export would otherwise re-target the OpenCode cases on a developer machine.
unset XDG_CONFIG_HOME

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCTOR="$ROOT/plugins/fnd/scripts/doctor.cjs"
INSTALLER="$ROOT/scripts/install.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Re-checked at the end (D46): nothing in this suite may run against the real checkout.
HEAD_BEFORE="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)"
O="$TMP/out"; E="$TMP/err"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

rc=0
run() { rc=0; node "$DOCTOR" "$@" >"$O" 2>"$E" || rc=$?; }

# expect <label> <want-rc> [pattern ...] — every pattern must appear in stdout as a literal;
# a pattern prefixed with ! must NOT appear.
expect() {
  local label="$1" want="$2" p; shift 2
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

# mkroot <dir> [rel:version ...] — a minimal plugin root: hooks/ plus the named manifests.
mkroot() {
  local d="$1" spec rel ver; shift
  mkdir -p "$d/hooks"
  printf '#!/bin/sh\nexit 0\n' > "$d/hooks/no-verify-bypass.sh"; chmod 755 "$d/hooks/no-verify-bypass.sh"
  printf "'use strict';\n" > "$d/hooks/mcp-slim.cjs"; chmod 644 "$d/hooks/mcp-slim.cjs"
  printf 'static text\n' > "$d/hooks/task-workspace.md"; chmod 644 "$d/hooks/task-workspace.md"
  for spec in "$@"; do
    rel="${spec%%:*}"; ver="${spec##*:}"
    mkdir -p "$d/$(dirname "$rel")"
    printf '{"name":"fnd","version":"%s"}\n' "$ver" > "$d/$rel"
  done
}

ALL3=(".claude-plugin/plugin.json:0.59.0" ".cursor-plugin/plugin.json:0.59.0" ".codex-plugin/plugin.json:0.59.0")

# ptrmanifest <file> <version> [key:value ...] — a host manifest carrying path pointers
ptrmanifest() {
  local f="$1" v="$2" body="" pair
  shift 2
  for pair in "$@"; do body="$body,\"${pair%%:*}\":\"${pair#*:}\""; done
  mkdir -p "$(dirname "$f")"
  printf '{"name":"fnd","version":"%s"%s}\n' "$v" "$body" > "$f"
}

# ------------------------------------------------------------------ manifests + version sync --
# D1: the all-green bundle — three manifests at one version, hooks healthy, nothing generated yet.
G="$TMP/green"; mkroot "$G" "${ALL3[@]}"
run --root "$G"
expect D1-all-green 0 "PASS  manifest:claude" "PASS  manifest:cursor" "PASS  manifest:codex" \
  "PASS  version-sync" "3 manifests all at 0.59.0" "PASS  hooks" "!FAIL"

# D2 (the Shopify cautionary tale): one stale stamp is the whole point of the check — FAIL, and
# the line has to name both versions so the fix is obvious.
D="$TMP/drift"; mkroot "$D" ".claude-plugin/plugin.json:0.59.0" ".cursor-plugin/plugin.json:0.58.0" ".codex-plugin/plugin.json:0.59.0"
run --root "$D"
expect D2-version-drift 1 "FAIL  version-sync" "version drift" ".cursor-plugin/plugin.json=0.58.0" "bump-version.cjs"

# D3: optional manifests absent is the pre-M2 state, not a failure.
O1="$TMP/claudeonly"; mkroot "$O1" ".claude-plugin/plugin.json:0.59.0"
run --root "$O1"
expect D3-optional-skip 0 "SKIP  manifest:cursor" "SKIP  manifest:codex" "SKIP  version-sync" "!FAIL"

# D4: an unparseable manifest is a FAIL, not a crash.
B="$TMP/badjson"; mkroot "$B" ".claude-plugin/plugin.json:0.59.0" ".codex-plugin/plugin.json:0.59.0"
mkdir -p "$B/.cursor-plugin"; printf '{"name":"fnd",\n' > "$B/.cursor-plugin/plugin.json"
run --root "$B"
expect D4-invalid-json 1 "FAIL  manifest:cursor" "invalid JSON"

# D5: no canonical manifest = this is not a plugin root at all.
N="$TMP/nomanifest"; mkroot "$N" ".cursor-plugin/plugin.json:0.59.0"
run --root "$N"
expect D5-missing-canonical 1 "FAIL  manifest:claude" "not an fnd plugin root"

# D6: a manifest without a version stamp cannot be compared — FAIL rather than silently pass.
V="$TMP/noversion"; mkroot "$V" ".claude-plugin/plugin.json:0.59.0"
mkdir -p "$V/.codex-plugin"; printf '{"name":"fnd"}\n' > "$V/.codex-plugin/plugin.json"
run --root "$V"
expect D6-no-version 1 "FAIL  manifest:codex" 'no "version" string'

# D7: a JSON array parses but is not a manifest.
A="$TMP/arraymanifest"; mkroot "$A" ".claude-plugin/plugin.json:0.59.0"
mkdir -p "$A/.cursor-plugin"; printf '[]\n' > "$A/.cursor-plugin/plugin.json"
run --root "$A"
expect D7-array-manifest 1 "FAIL  manifest:cursor" "not a JSON object"

# D8: a non-existent --root fails loudly instead of reporting an empty green run.
run --root "$TMP/does-not-exist"
expect D8-missing-root 1 "FAIL  manifest:claude" "FAIL  hooks"

# ------------------------------------------------------------------------ manifest pointers --
# A manifest pointer is a path the host resolves against the plugin root; one that does not
# resolve is the "clone succeeded but the host loads nothing" break this script exists to catch.

# D7b: everything a pointer names is on disk.
PR="$TMP/pointers"; mkroot "$PR" ".claude-plugin/plugin.json:0.59.0"
mkdir -p "$PR/skills" "$PR/agents-cursor"
printf '%s\n' '---' > "$PR/agents-cursor/bug-hunter.md"
printf '{}\n' > "$PR/hooks/hooks-cursor.json"
ptrmanifest "$PR/.cursor-plugin/plugin.json" 0.59.0 "skills:skills/" "agents:agents-cursor/" "hooks:hooks/hooks-cursor.json"
run --root "$PR"
expect D7b-pointers-resolve 0 "PASS  pointers:cursor" "3 pointer(s) resolve" "!FAIL"

# D7c: a pointer at a dir M4/M5/M6 has not produced yet is SKIP — the milestone is not a defect,
# but the line has to name what is still missing.
PP="$TMP/pointers-pending"; mkroot "$PP" ".claude-plugin/plugin.json:0.59.0"
mkdir -p "$PP/skills"
ptrmanifest "$PP/.cursor-plugin/plugin.json" 0.59.0 "skills:skills/" "agents:agents-cursor/"
run --root "$PP"
expect D7c-pointers-pending 0 "SKIP  pointers:cursor" "1/2 resolve" "agents -> agents-cursor/" "!FAIL"

# D7d: skills/ is canonical, not generated — a pointer at a missing skills dir is a real break.
PM="$TMP/pointers-missing"; mkroot "$PM" ".claude-plugin/plugin.json:0.59.0"
ptrmanifest "$PM/.codex-plugin/plugin.json" 0.59.0 "skills:./skills/"
run --root "$PM"
expect D7d-pointer-skills-missing 1 "FAIL  pointers:codex" 'does not exist'

# D7e: host loaders refuse to escape the plugin root, so an absolute or `..` pointer never loads.
PE="$TMP/pointers-escape"; mkroot "$PE" ".claude-plugin/plugin.json:0.59.0"
mkdir -p "$PE/skills"
ptrmanifest "$PE/.cursor-plugin/plugin.json" 0.59.0 "skills:../elsewhere/skills"
run --root "$PE"
expect D7e-pointer-escapes 1 "FAIL  pointers:cursor" 'free of ".."'

# D7f: a manifest that declares no pointers leans entirely on host auto-discovery — nothing to
# verify, and never a false PASS that reads as "3 pointers checked".
run --root "$G"
expect D7f-pointers-none 0 "SKIP  pointers:cursor" "SKIP  pointers:codex" "auto-discovery only" "!FAIL"

# ------------------------------------------------------------------------------------ hooks --
# D9: a shell hook without the exec bit is the classic "cloned but the host cannot run it" break.
H="$TMP/hooksbad"; mkroot "$H" "${ALL3[@]}"
chmod 644 "$H/hooks/no-verify-bypass.sh"
run --root "$H"
expect D9-hook-not-executable 1 "FAIL  hooks" "no-verify-bypass.sh (not executable)" "chmod +x"

# D10 (bug): .cjs hooks ship mode 644 in this repo and every wiring invokes them through `node` —
# demanding an exec bit there would fail a healthy install (D1 already asserts the PASS; this
# pins the reason).
run --root "$G"
expect D10-cjs-mode-irrelevant 0 "1 executable + 1 node-invoked script(s)"

# D10b (bug): the per-host hook WIRING files (hooks/hooks-cursor.json, hooks/hooks-codex.json)
# land in this same dir in M5 — they are config a host reads, not something it executes, so an
# exec-bit demand there would fail every healthy install once M5 ships.
HJ="$TMP/hookjson"; mkroot "$HJ" "${ALL3[@]}"
printf '{"hooks":{}}\n' > "$HJ/hooks/hooks-cursor.json"
run --root "$HJ"
expect D10b-wiring-json-not-a-script 0 "PASS  hooks" "1 executable + 1 node-invoked script(s)" "!FAIL"

# D10c (M5): hooks/no-verify.rules is Codex execpolicy Starlark — a declarative rule set the host
# READS. Same class as the wiring JSON: never chmod +x, and never a reason to fail an install.
HR="$TMP/hookrules"; mkroot "$HR" "${ALL3[@]}"
printf 'prefix_rule(pattern = ["git", "commit", "-n"], decision = "forbidden")\n' > "$HR/hooks/no-verify.rules"
run --root "$HR"
expect D10c-rules-not-a-script 0 "PASS  hooks" "1 executable + 1 node-invoked script(s)" "!FAIL"

# D11: hooks/ missing entirely.
NH="$TMP/nohooks"; mkroot "$NH" "${ALL3[@]}"; rm -rf "$NH/hooks"
run --root "$NH"
expect D11-hooks-missing 1 "FAIL  hooks" "hooks/ unreadable"

# D12: hooks/ present but holding only static .md files — no hook script would ever run.
EH="$TMP/emptyhooks"; mkroot "$EH" "${ALL3[@]}"; rm -f "$EH/hooks/no-verify-bypass.sh" "$EH/hooks/mcp-slim.cjs"
run --root "$EH"
expect D12-hooks-no-scripts 1 "FAIL  hooks" "no hook scripts"

# ------------------------------------------------------------------------- generated dirs ----
# D13: before M4 nothing is generated — four SKIPs and a skipped sync check, exit 0.
run --root "$G"
expect D13-generated-skip 0 "SKIP  gen:agents-cursor" "SKIP  gen:agents-codex" \
  "SKIP  gen:agents-opencode" "SKIP  gen:commands-opencode" "not generated yet (M4)" \
  "SKIP  generator-sync" "gen-host-adapters.cjs absent (M4)"

# D14: a populated generated dir passes; the others still SKIP; with no generator there is
# nothing to compare against.
GD="$TMP/gendirs"; mkroot "$GD" "${ALL3[@]}"
mkdir -p "$GD/agents-cursor"; printf '%s\n' '---' > "$GD/agents-cursor/bug-hunter.md"
run --root "$GD"
expect D14-generated-present 0 "PASS  gen:agents-cursor" "1 file(s)" "SKIP  gen:agents-codex" \
  "SKIP  generator-sync" "!FAIL"

# D15: an empty generated dir is drift, not absence — the generator ran and produced nothing.
ED="$TMP/emptygen"; mkroot "$ED" "${ALL3[@]}"; mkdir -p "$ED/agents-codex"
run --root "$ED"
expect D15-generated-empty 1 "FAIL  gen:agents-codex" "is empty"

# D16: generator with a --check flag, dirs in sync.
SY="$TMP/gensync"; mkroot "$SY" "${ALL3[@]}"
mkdir -p "$SY/agents-cursor" "$SY/scripts"; printf '%s\n' '---' > "$SY/agents-cursor/bug-hunter.md"
cat > "$SY/scripts/gen-host-adapters.cjs" <<'GEN'
#!/usr/bin/env node
if (process.argv.includes('--check')) process.exit(0);
process.exit(0);
GEN
run --root "$SY"
expect D16-generator-in-sync 0 "PASS  generator-sync" "generated dirs match" "!FAIL"

# D17: the generator reports drift — the doctor relays its first line, not just an exit code.
DR="$TMP/gendrift"; mkroot "$DR" "${ALL3[@]}"
mkdir -p "$DR/agents-cursor" "$DR/scripts"; printf '%s\n' '---' > "$DR/agents-cursor/bug-hunter.md"
cat > "$DR/scripts/gen-host-adapters.cjs" <<'GEN'
#!/usr/bin/env node
if (process.argv.includes('--check')) {
  process.stderr.write('agents-cursor/bug-hunter.md differs from the generator output\n');
  process.exit(1);
}
GEN
run --root "$DR"
expect D17-generator-drift 1 "FAIL  generator-sync" "agents-cursor/bug-hunter.md differs"

# D18: a generator without a --check flag cannot be asked about drift — SKIP, never a false PASS.
NC="$TMP/gennocheck"; mkroot "$NC" "${ALL3[@]}"
mkdir -p "$NC/agents-cursor" "$NC/scripts"; printf '%s\n' '---' > "$NC/agents-cursor/bug-hunter.md"
printf '#!/usr/bin/env node\nprocess.exit(0);\n' > "$NC/scripts/gen-host-adapters.cjs"
run --root "$NC"
expect D18-generator-no-check 0 "SKIP  generator-sync" "has no --check flag" "!FAIL"

# D19: generator present, nothing generated yet — running it would say nothing useful.
GN="$TMP/gennodirs"; mkroot "$GN" "${ALL3[@]}"; mkdir -p "$GN/scripts"
printf '#!/usr/bin/env node\nif (process.argv.includes("--check")) process.exit(0);\n' > "$GN/scripts/gen-host-adapters.cjs"
run --root "$GN"
expect D19-generator-nothing-generated 0 "SKIP  generator-sync" "nothing generated yet (M4)" "!FAIL"

# ------------------------------------------------------------------------- host installs -----
# record <home> <root-rel> <mode> <repo> <version> [entry ...] — the file scripts/install.sh writes.
record() {
  local home="$1" rootrel="$2" mode="$3" repo="$4" ver="$5"; shift 5
  local dir="$home/$rootrel" e
  mkdir -p "$dir"
  { echo "mode=$mode"; echo "repo=$repo"; echo "version=$ver"
    for e in "$@"; do echo "entry=$e"; done; } > "$dir/.fnd-install-mode"
}

CUR_REL=".cursor/plugins/local"
OC_REL=".config/opencode"
CX_REL=".codex"

# D20: no --target — host checks are not the doctor's business unless asked.
run --root "$G"
expect D20-no-target 0 "SKIP  install" "no --target given" "!FAIL"

# D21: --target with nothing installed names the missing record AND the command that creates it.
H1="$TMP/home1"; mkdir -p "$H1"
run --root "$G" --home "$H1" --target cursor
expect D21-cursor-not-installed 1 "FAIL  install:cursor" "not installed" ".fnd-install-mode" \
  "install.sh --target cursor"

# D22: the installer's record + a live symlink into the checkout = installed.
H2="$TMP/home2"; mkdir -p "$H2/$CUR_REL"
ln -s "$G" "$H2/$CUR_REL/fnd"
record "$H2" "$CUR_REL" symlink "$G" 0.59.0 "$H2/$CUR_REL/fnd"
run --root "$G" --home "$H2" --target cursor
expect D22-cursor-symlink 0 "PASS  install:cursor" "symlink install, 1 entry(ies) live" "!FAIL"

# D23 (bug): a symlink that resolves OUTSIDE the checkout is a different install answering for
# this one — the host would load someone else's files while the doctor blessed this repo.
H3="$TMP/home3"; mkdir -p "$H3/$CUR_REL" "$TMP/other-clone/plugins/fnd"
ln -s "$TMP/other-clone/plugins/fnd" "$H3/$CUR_REL/fnd"
record "$H3" "$CUR_REL" symlink "$G" 0.59.0 "$H3/$CUR_REL/fnd"
run --root "$G" --home "$H3" --target cursor
expect D23-symlink-outside 1 "FAIL  install:cursor" "points outside this checkout"

# D24: a dangling symlink (the checkout moved) reads as broken, not as missing.
H4="$TMP/home4"; mkdir -p "$H4/$CUR_REL"
ln -s "$TMP/moved-away" "$H4/$CUR_REL/fnd"
record "$H4" "$CUR_REL" symlink "$G" 0.59.0 "$H4/$CUR_REL/fnd"
run --root "$G" --home "$H4" --target cursor
expect D24-symlink-broken 1 "FAIL  install:cursor" "broken symlink"

# D25: a recorded entry that no longer exists (someone deleted it by hand).
H5="$TMP/home5"
record "$H5" "$CUR_REL" symlink "$G" 0.59.0 "$H5/$CUR_REL/fnd"
run --root "$G" --home "$H5" --target cursor
expect D25-entry-missing 1 "FAIL  install:cursor" "1/1 entries broken" "(missing)"

# D26: a --copy install at the same version is healthy — the marker is what proves it is ours.
H6="$TMP/home6"; mkdir -p "$H6/$CUR_REL"
cp -R "$G" "$H6/$CUR_REL/fnd"
record "$H6" "$CUR_REL" copy "$G" 0.59.0 "$H6/$CUR_REL/fnd"
run --root "$G" --home "$H6" --target cursor
expect D26-copy-install 0 "PASS  install:cursor" "copy install, 1 entry(ies) live" "!FAIL"

# D27 (bug): a --copy install does NOT follow `git pull`, so a repo bump leaves the host running
# old files with no other symptom — the recorded version is the only place that shows it.
H7="$TMP/home7"; mkdir -p "$H7/$CUR_REL"
cp -R "$G" "$H7/$CUR_REL/fnd"
record "$H7" "$CUR_REL" copy "$G" 0.58.0 "$H7/$CUR_REL/fnd"
run --root "$G" --home "$H7" --target cursor
expect D27-copy-stale 1 "FAIL  install:cursor" "copy install is stale: 0.58.0 vs 0.59.0" "re-run install.sh"

# D28: a symlink where the record says copy — the install was rebuilt in another mode behind the
# record's back, so the mode-specific checks (staleness) no longer mean anything.
H8="$TMP/home8"; mkdir -p "$H8/$CUR_REL"
ln -s "$G" "$H8/$CUR_REL/fnd"
record "$H8" "$CUR_REL" copy "$G" 0.59.0 "$H8/$CUR_REL/fnd"
run --root "$G" --home "$H8" --target cursor
expect D28-copy-record-symlink 1 "FAIL  install:cursor" "symlink in a copy install"

# D29 (bug): a record left by a DIFFERENT clone must not certify this one — the developer would
# edit here and the host would keep loading the other checkout.
H9="$TMP/home9"; mkdir -p "$H9/$CUR_REL"
ln -s "$TMP/other-clone/plugins/fnd" "$H9/$CUR_REL/fnd"
record "$H9" "$CUR_REL" symlink "$TMP/other-clone" 0.59.0 "$H9/$CUR_REL/fnd"
run --root "$G" --home "$H9" --target cursor
expect D29-record-other-checkout 1 "FAIL  install:cursor" "records a different checkout"

# D29b (live smoke 2026-08-22): a Cursor MARKETPLACE install runs the doctor from inside
# ~/.cursor/plugins/cache — that cache IS the install, so no local record or symlink is expected
# and the row must pass, not send the user to install.sh.
HC="$TMP/home-cache"; CACHE_PLUG="$HC/.cursor/plugins/cache/domaine/fnd/742b0c1"
mkroot "$CACHE_PLUG" "${ALL3[@]}"
run --root "$CACHE_PLUG" --home "$HC" --target cursor
expect D29b-cursor-marketplace-cache 0 "PASS  install:cursor" "marketplace cache install" "!FAIL"

# D29c: the cache pass is keyed to the plugin root actually being IN the cache — a doctor run
# from a normal checkout on a machine that also has a cache dir still checks the local install.
mkdir -p "$HC/.cursor/plugins/cache"
run --root "$G" --home "$HC" --target cursor
expect D29c-checkout-beside-cache 1 "FAIL  install:cursor" "not installed" "!marketplace cache"

# D30: a record with no entries at all (interrupted install).
H10="$TMP/home10"
record "$H10" "$CUR_REL" symlink "$G" 0.59.0
run --root "$G" --home "$H10" --target cursor
expect D30-record-no-entries 1 "FAIL  install:cursor" "records no entries"

# D30b (bug): the record is a flat key=value file a future installer may grow keys in — an
# unknown line (or one whose key merely resembles `entries`) must not clobber the parsed entry
# list and turn a broken install green.
H10B="$TMP/home10b"; mkdir -p "$H10B/$CUR_REL"
ln -s "$G" "$H10B/$CUR_REL/fnd"
record "$H10B" "$CUR_REL" symlink "$G" 0.59.0 "$H10B/$CUR_REL/fnd"
printf 'entries=bogus\n# a comment\nhost=cursor\n' >> "$H10B/$CUR_REL/.fnd-install-mode"
run --root "$G" --home "$H10B" --target cursor
expect D30b-record-unknown-keys 0 "PASS  install:cursor" "1 entry(ies) live" "!FAIL"

# D30c (bug): a checkout with no .git (tarball download, vendored copy, sparse export — a case
# install.sh supports and reports on) still records `repo=<checkout root>`. Resolving the root as
# the plugin dir instead made that comparison unsatisfiable, so every non-git install FAILed with
# "records a different checkout" right after the installer created it.
NG="$TMP/nongit"; mkroot "$NG/plugins/fnd" "${ALL3[@]}"
H10C="$TMP/home10c"; mkdir -p "$H10C/$CUR_REL"
ln -s "$NG/plugins/fnd" "$H10C/$CUR_REL/fnd"
record "$H10C" "$CUR_REL" symlink "$NG" 0.59.0 "$H10C/$CUR_REL/fnd"
run --root "$NG/plugins/fnd" --home "$H10C" --target cursor
expect D30c-nongit-checkout-root 0 "PASS  install:cursor" "!FAIL"

# D30d: ...and the tolerance is exactly one path — a record naming a genuinely different
# checkout still FAILs in the same non-git layout.
H10D="$TMP/home10d"; mkdir -p "$H10D/$CUR_REL"
ln -s "$NG/plugins/fnd" "$H10D/$CUR_REL/fnd"
record "$H10D" "$CUR_REL" symlink "$TMP/other-root" 0.59.0 "$H10D/$CUR_REL/fnd"
run --root "$NG/plugins/fnd" --home "$H10D" --target cursor
expect D30d-nongit-other-checkout 1 "FAIL  install:cursor" "records a different checkout"

# D31: a hand-made symlink at the documented Cursor path counts as installed even with no record.
H11="$TMP/home11"; mkdir -p "$H11/$CUR_REL"
ln -s "$G" "$H11/$CUR_REL/fnd"
run --root "$G" --home "$H11" --target cursor
expect D31-handmade-symlink 0 "PASS  install:cursor" "(no installer record)" "!FAIL"

# D32: a plain directory at that path is somebody else's fnd, not this checkout.
H12="$TMP/home12"; mkdir -p "$H12/$CUR_REL/fnd"
run --root "$G" --home "$H12" --target cursor
expect D32-handmade-plain-dir 1 "FAIL  install:cursor" "not a symlink"

# D33: OpenCode installs per entry under ~/.config/opencode — the record is the only single point
# that proves the set is live.
H13="$TMP/home13"; mkdir -p "$H13/$OC_REL/skills" "$H13/$OC_REL/plugins"
ln -s "$G/skills/ship" "$H13/$OC_REL/skills/ship"
mkdir -p "$G/skills/ship"; printf '%s\n' '---' > "$G/skills/ship/SKILL.md"
ln -s "$G/opencode/fnd-plugin.js" "$H13/$OC_REL/plugins/fnd-plugin.js"
mkdir -p "$G/opencode"; printf '// adapter\n' > "$G/opencode/fnd-plugin.js"
record "$H13" "$OC_REL" symlink "$G" 0.59.0 "$H13/$OC_REL/skills/ship" "$H13/$OC_REL/plugins/fnd-plugin.js"
run --root "$G" --home "$H13" --target opencode
expect D33-opencode-installed 0 "PASS  install:opencode" "symlink install, 2 entry(ies) live" "!FAIL"

# D34: one broken entry out of many is reported with its count, not swallowed by the healthy ones.
rm "$H13/$OC_REL/skills/ship"
run --root "$G" --home "$H13" --target opencode
expect D34-opencode-partial 1 "FAIL  install:opencode" "1/2 entries broken"

# D35: OpenCode with nothing installed points at its own root, not Cursor's.
H14="$TMP/home14"; mkdir -p "$H14"
run --root "$G" --home "$H14" --target opencode
expect D35-opencode-not-installed 1 "FAIL  install:opencode" ".config/opencode/.fnd-install-mode" \
  "install.sh --target opencode"

# D36 (bug): --home must win over an ambient XDG_CONFIG_HOME, or a developer who exports it sees
# every sandboxed OpenCode case answer about their real config dir.
H15="$TMP/home15"; mkdir -p "$H15/$OC_REL/skills"
ln -s "$G/skills/ship" "$H15/$OC_REL/skills/ship"
record "$H15" "$OC_REL" symlink "$G" 0.59.0 "$H15/$OC_REL/skills/ship"
rc=0; XDG_CONFIG_HOME="$TMP/elsewhere" node "$DOCTOR" --root "$G" --home "$H15" --target opencode >"$O" 2>"$E" || rc=$?
expect D36-home-beats-xdg 0 "PASS  install:opencode" "!FAIL"

# D37: Claude Code has no local install to inspect — SKIP with where it does live.
run --root "$G" --home "$H1" --target claude
expect D37-claude-cache 0 "SKIP  install:claude" ".claude/plugins/cache" "!FAIL"

# D37b: Codex is the half-cache host. Its skills/hooks/MCP come from the marketplace cache, but the
# TOML subagents are linked locally, so "nothing linked" is a real broken install — a SKIP here
# would bless a plugin whose whole agent layer can never load, with doctor green.
run --root "$G" --home "$H1" --target codex
expect D37b-codex-not-linked 1 "FAIL  install:codex" ".codex/.fnd-install-mode" \
  "install.sh --target codex" "subagents only"

# D37c: linked subagents pass, and the row still names what it does NOT cover.
H16="$TMP/home16"; mkdir -p "$H16/$CX_REL/agents"
mkdir -p "$G/agents-codex"; printf 'name = "jira-reader"\n' > "$G/agents-codex/jira-reader.toml"
ln -s "$G/agents-codex/jira-reader.toml" "$H16/$CX_REL/agents/jira-reader.toml"
record "$H16" "$CX_REL" symlink "$G" 0.59.0 "$H16/$CX_REL/agents/jira-reader.toml"
run --root "$G" --home "$H16" --target codex
expect D37d-codex-linked 0 "PASS  install:codex" "1 entry(ies) live" "skills/hooks/MCP" "!FAIL"

# D37e: a hand-made link at the documented path counts, same as the Cursor probe.
H17="$TMP/home17"; mkdir -p "$H17/$CX_REL/agents"
ln -s "$G/agents-codex/jira-reader.toml" "$H17/$CX_REL/agents/jira-reader.toml"
run --root "$G" --home "$H17" --target codex
expect D37f-codex-handmade 0 "PASS  install:codex" "(no installer record)" "!FAIL"

# D37g–D37k: Codex arms hooks behind two user actions the installer cannot take. Linked subagents
# are what "installed" means on this host, so without these rows a doctor run goes green while
# every guard — the commit guards included — is dormant.
run --root "$G" --home "$H16" --target codex
expect D37g-hooks-gate-absent 0 "SKIP  codex:hooks-gate" "config.toml absent" "[features] hooks = true" "!FAIL"
expect D37h-hooks-trust-row 0 "SKIP  codex:hooks-trust" "/hooks" "git commit --no-verify -m probe"

printf '[features]\nhooks = true\n' > "$H16/$CX_REL/config.toml"
run --root "$G" --home "$H16" --target codex
expect D37i-hooks-gate-on 0 "PASS  codex:hooks-gate" "[features] hooks = true" "!FAIL"
# an explicit off is the silent-degradation case, and a commented-out line is not an entry
printf '[features]\nhooks = false\n' > "$H16/$CX_REL/config.toml"
run --root "$G" --home "$H16" --target codex
expect D37j-hooks-gate-off 0 "SKIP  codex:hooks-gate" "every fnd hook is off" "!FAIL"
# a `hooks` key under ANOTHER table says nothing about the feature gate
printf '[features]\n# hooks = true\n\n[mcp_servers.x]\nhooks = true\n' > "$H16/$CX_REL/config.toml"
run --root "$G" --home "$H16" --target codex
expect D37k-hooks-gate-other-table 0 "SKIP  codex:hooks-gate" "no [features] hooks entry" "!FAIL"
rm -f "$H16/$CX_REL/config.toml"

# the rows are Codex-only: another target must not print them (this home has no Cursor install,
# hence the FAILing install row and exit 1 — the point here is the two absent codex rows)
run --root "$G" --home "$H1" --target cursor
expect D37l-hooks-gate-codex-only 1 "!codex:hooks-gate" "!codex:hooks-trust"

# ------------------------------------------------------------------------------ CLI surface --
# D38: usage errors exit 2 — distinct from a FAILing check (1), so install.sh can tell them apart.
rc=0; node "$DOCTOR" --target nosuchhost >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 2 ] && grep -q "unknown target" "$E"; then ok; else bad D38-unknown-target "rc=$rc err=$(head -c 200 "$E")"; fi

rc=0; node "$DOCTOR" --nope >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 2 ] && grep -q "unknown argument" "$E"; then ok; else bad D39-unknown-arg "rc=$rc err=$(head -c 200 "$E")"; fi

rc=0; node "$DOCTOR" --root >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 2 ] && grep -q "needs a value" "$E"; then ok; else bad D40-missing-value "rc=$rc err=$(head -c 200 "$E")"; fi

rc=0; node "$DOCTOR" --help >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q "usage: doctor.cjs" "$O"; then ok; else bad D41-help "rc=$rc out=$(head -c 200 "$O")"; fi

# D42: the node-version row is always reported, and this suite proves it on a supported runtime.
run --root "$G"
expect D42-node-row 0 "PASS  node" ">= 18 required"

# D43: the summary line counts every row and the header names the root that was checked.
run --root "$G"
if grep -qE '^doctor: [0-9]+ passed, 0 failed, [0-9]+ skipped$' "$O" \
   && grep -qF "fnd doctor — plugin root: $G" "$O"; then ok
else bad D43-summary "out=$(tr '\n' ';' <"$O" | head -c 300)"; fi

# D44: the real bundle in this repo passes with no arguments (the state install.sh ships).
run
expect D44-real-repo 0 "PASS  manifest:claude" "PASS  hooks" "!FAIL"

# D45 (integration): the doctor reads the record format scripts/install.sh actually writes — the
# two files are only useful together, and the installer runs the doctor as its last step.
# Both are COPIED into a $TMP fixture: running the repo's own installer would `git pull --ff-only`
# the developer's working tree mid-suite (silently skipped only while that tree happens to be
# dirty), which is a network call and a mutation of the files the other suites are reading.
if [ -f "$INSTALLER" ]; then
  FIX="$TMP/fixrepo"
  mkdir -p "$FIX/scripts" "$FIX/plugins/fnd/scripts" "$FIX/plugins/fnd/skills/alpha"
  cp "$INSTALLER" "$FIX/scripts/install.sh"
  cp "$DOCTOR" "$FIX/plugins/fnd/scripts/doctor.cjs"
  mkroot "$FIX/plugins/fnd" "${ALL3[@]}"
  printf '%s\n' '---' > "$FIX/plugins/fnd/skills/alpha/SKILL.md"
  H16="$TMP/home16"; mkdir -p "$H16"
  ilog="$TMP/install.log"
  if HOME="$H16" bash "$FIX/scripts/install.sh" --target cursor >"$ilog" 2>&1; then
    run --root "$FIX/plugins/fnd" --home "$H16" --target cursor
    expect D45-installer-roundtrip 0 "PASS  install:cursor" "!FAIL"
    # the doctor the INSTALLER ran (its own last step) has to agree — this is the copy of the
    # verification a user actually sees
    if grep -q "0 failed" "$ilog" && ! grep -q "doctor reported problems" "$ilog"; then ok
    else bad D45b-installer-doctor-clean "$(tr '\n' ';' <"$ilog" | head -c 300)"; fi
    HOME="$H16" bash "$FIX/scripts/install.sh" --target cursor --uninstall >>"$ilog" 2>&1
    run --root "$FIX/plugins/fnd" --home "$H16" --target cursor
    expect D45c-uninstall-roundtrip 1 "FAIL  install:cursor" "not installed"
  else
    bad D45-installer-roundtrip "installer exited non-zero :: $(tail -c 200 "$ilog")"
  fi
fi

# D46: the suite never advanced the checkout it is testing. Running the repo's own installer
# would have fast-forwarded this tree from the network mid-run — invisible on an offline runner,
# and a mutation of files the other suites in the same CI job are reading.
HEAD_AFTER="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)"
if [ "$HEAD_AFTER" = "$HEAD_BEFORE" ]; then ok
else bad D46-checkout-not-pulled "repo HEAD moved during the suite: $HEAD_BEFORE -> $HEAD_AFTER"; fi

echo "doctor-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
