#!/usr/bin/env bash
# Rules-bundle assertions for plugins/fnd/rules/ (M4 — foundation import).
# The .mdc files are vendored from meetdomaine/foundation; this suite guards the three
# ways a vendored bundle rots: a rule that no longer parses as an .mdc (Cursor drops the
# whole file, silently), a cross-link still pointing at `.cursor/rules/` (resolves against
# the workspace root, which the bundle is not), and provenance without a pinned commit
# (no way to diff against upstream, so drift becomes unfalsifiable).
# Discovery is by glob, so rules added in a later import are covered without editing this file.
# Exit 0 = bundle green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RULES_DIR="$ROOT/plugins/fnd/rules"
SOURCE_MD="$RULES_DIR/SOURCE.md"
MIN_RULES=13

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

if [ ! -d "$RULES_DIR" ]; then
  echo "rules-bundle: 0 passed, 1 failed"
  echo "  [rules-dir] missing: $RULES_DIR"
  exit 1
fi

# ---------------------------------------------------------------------- file count --
count=0
for f in "$RULES_DIR"/*.mdc; do [ -f "$f" ] && count=$((count + 1)); done
if [ "$count" -ge "$MIN_RULES" ]; then ok
else bad "rule-count" "$count .mdc files, expected >= $MIN_RULES"; fi

# ------------------------------------------------------------------- per-rule shape --
# An .mdc is frontmatter (a `---` fence pair starting on line 1) followed by a body.
# Asserted per file: fence pair present, `alwaysApply` declared (Cursor's attach mode
# has no safe default here — an omitted key silently means "manual only"), a non-empty
# `description` (what the model matches on), and a non-empty body.
for f in "$RULES_DIR"/*.mdc; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"

  first="$(head -n 1 "$f")"
  if [ "$first" = "---" ]; then ok
  else bad "frontmatter-open-$name" "line 1 is '$first', expected '---'"; continue; fi

  close_line="$(awk 'NR > 1 && $0 == "---" { print NR; exit }' "$f")"
  if [ -n "$close_line" ]; then ok
  else bad "frontmatter-close-$name" "no closing '---' fence"; continue; fi

  if awk -v end="$close_line" 'NR > 1 && NR < end' "$f" | grep -q '^alwaysApply:[[:space:]]*\(true\|false\)[[:space:]]*$'; then ok
  else bad "frontmatter-alwaysapply-$name" "no 'alwaysApply: true|false' in frontmatter"; fi

  if awk -v end="$close_line" 'NR > 1 && NR < end' "$f" | grep -q '^description:[[:space:]]*[^[:space:]]'; then ok
  else bad "frontmatter-description-$name" "empty or missing 'description'"; fi

  if [ -n "$(awk -v end="$close_line" 'NR > end && $0 ~ /[^[:space:]]/' "$f")" ]; then ok
  else bad "body-$name" "frontmatter only, no rule body"; fi
done

# -------------------------------------------------------------- cross-link rewriting --
# `mdc:.cursor/rules/x.mdc` is workspace-root-relative and dangles once the rules ship
# inside the plugin; the import rewrites those to sibling-relative links.
# Only the rules themselves: SOURCE.md quotes the pre-rewrite form as documentation.
hits="$(grep -n 'mdc:\.cursor/rules/' "$RULES_DIR"/*.mdc 2>/dev/null)"
if [ -z "$hits" ]; then ok
else bad "mdc-workspace-links" "$(printf '%s' "$hits" | tr '\n' ' ')"; fi

# Sibling-relative rule links must resolve — a rewrite that outlives its target is the
# same dangling link in a new costume.
missing_links=""
for f in "$RULES_DIR"/*.mdc; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  for target in $(grep -o '](\([A-Za-z0-9._-]*\.mdc\))' "$f" 2>/dev/null | sed 's/^](//; s/)$//'); do
    [ -f "$RULES_DIR/$target" ] || missing_links="$missing_links $name->$target"
  done
done
if [ -z "$missing_links" ]; then ok
else bad "dangling-rule-links" "unresolved:$missing_links"; fi

# ------------------------------------------------------------------------ provenance --
if [ -f "$SOURCE_MD" ]; then
  ok

  if grep -qi '\bmeetdomaine/foundation\b' "$SOURCE_MD"; then ok
  else bad "source-repo" "SOURCE.md does not name meetdomaine/foundation"; fi

  # A pinned 40-hex commit is what makes drift checkable; a branch name alone is not.
  if grep -qE '\b[0-9a-f]{40}\b' "$SOURCE_MD"; then ok
  else bad "source-sha" "SOURCE.md carries no 40-hex commit SHA"; fi

  if grep -qE '\b20[0-9]{2}-[01][0-9]-[0-3][0-9]\b' "$SOURCE_MD"; then ok
  else bad "source-date" "SOURCE.md carries no ISO fetch date"; fi

  # Refresh instructions: without them the next import is guesswork.
  if grep -q 'gh api' "$SOURCE_MD"; then ok
  else bad "source-refresh" "SOURCE.md documents no gh api refresh command"; fi

  # The manifest is checked in the provable direction: every rule SOURCE.md claims must
  # be on disk. The reverse is not asserted — the bundle also carries fnd-authored rules,
  # which have no foundation provenance and belong in no import table.
  # Read the manifest table only (rows opening with a backticked filename), so prose that
  # mentions a rule in passing is not mistaken for an entry.
  listed="$(grep -oE '^\| `[A-Za-z0-9._-]+\.mdc`' "$SOURCE_MD" | tr -d '|` ' | sort -u)"
  listed_count=0; absent=""
  for name in $listed; do
    listed_count=$((listed_count + 1))
    [ -f "$RULES_DIR/$name" ] || absent="$absent $name"
  done
  if [ -z "$absent" ]; then ok
  else bad "source-file-list" "listed in SOURCE.md but absent from the bundle:$absent"; fi

  if [ "$listed_count" -ge "$MIN_RULES" ]; then ok
  else bad "source-file-count" "SOURCE.md names $listed_count rules, expected >= $MIN_RULES"; fi

  # Byte fidelity. SOURCE.md's Ownership rule is "edit upstream, then re-import"; nothing else in
  # this suite would notice a local hand-edit of a vendored body, and drift vs foundation would
  # stay unfalsifiable until someone re-ran the gh api fetch by hand. The table already records
  # the size each file had at import — compare against it. A legitimate re-import updates the
  # table in the same change, so this only fires on an edit that skipped the import path.
  drifted=""
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    name="$(printf '%s' "$row" | sed 's/^| `\([^`]*\)`.*/\1/')"
    want="$(printf '%s' "$row" | awk -F'|' '{ gsub(/[ \t]/, "", $4); print $4 }')"
    case "$want" in ''|*[!0-9]*) continue ;; esac
    [ -f "$RULES_DIR/$name" ] || continue
    got="$(wc -c < "$RULES_DIR/$name" | tr -d ' ')"
    [ "$got" = "$want" ] || drifted="$drifted $name($got!=$want)"
  done <<EOF
$(grep -E '^\| `[A-Za-z0-9._-]+\.mdc` \| [0-9]+ \| [0-9]+ \|' "$SOURCE_MD")
EOF
  if [ -z "$drifted" ]; then ok
  else bad "source-byte-drift" "vendored rule sizes differ from SOURCE.md — edit upstream and re-import, don't hand-edit the bundle:$drifted"; fi
else
  bad "source-md" "missing: $SOURCE_MD"
fi

echo "rules-bundle: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
