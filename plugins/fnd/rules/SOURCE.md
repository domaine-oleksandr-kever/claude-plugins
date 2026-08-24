# Rules bundle provenance — foundation import

The `.mdc` files in this directory are imported from the Domaine foundation theme's
Cursor rules. They are **vendored, not authored here**: edit them upstream, then
re-import, so the two copies never diverge by hand.

| Field | Value |
|---|---|
| Source repo | `meetdomaine/foundation` |
| Source path | `.cursor/rules/` |
| Branch | `main` |
| Commit | `b5bdb6b4a458e8925d96b391241d3bcf7abb0a53` |
| Fetch date | 2026-08-22 |
| Files | 13 `.mdc` |

## Local modifications

Frontmatter (`description`, `globs`, `alwaysApply`) is preserved byte-for-byte —
the auto-attach behavior in this bundle is the same one the foundation repo ships.

The only edit is cross-link rewriting: 7 links of the form
`[name.mdc](mdc:.cursor/rules/name.mdc)` became `[name.mdc](name.mdc)`, because
`mdc:` paths resolve against the *workspace* root and the rules do not live at
`.cursor/rules/` once bundled with the plugin. Sibling-relative links resolve in
both homes. Links pointing at foundation source files (`mdc:src/...`,
`mdc:snippets/...`) and external URLs are left untouched — they address the theme
repo the rules are read in, not this bundle.

Every other byte is upstream's. The size columns below make that checkable: the
files whose local size differs from upstream are exactly the ones that carried a
rewritten link (18 bytes dropped per link).

| File | Upstream bytes | Local bytes | `globs` | `alwaysApply` |
|---|---:|---:|---|---|
| `blocks.mdc` | 1352 | 1298 | `blocks/*.liquid` | false |
| `color-contrast-accessibility.mdc` | 1963 | 1963 | `*.liquid,src/styles/*.css` | false |
| `core.mdc` | 3804 | 3804 | — | true |
| `css-standards.mdc` | 5558 | 5558 | `*.css,*.liquid` | false |
| `html-standards.mdc` | 2315 | 2315 | `*.liquid` | false |
| `liquid.mdc` | 2524 | 2524 | `*.liquid` | false |
| `locales.mdc` | 1425 | 1425 | `locales/*.json,*.liquid` | false |
| `prompts-and-references.mdc` | 2286 | 2286 | — | true |
| `schemas.mdc` | 1830 | 1830 | `blocks/*.liquid,sections/*.liquid,schemas/*` | false |
| `sections.mdc` | 1739 | 1721 | `sections/*.liquid` | false |
| `snippets.mdc` | 2046 | 2028 | `snippets/*.liquid` | false |
| `templates.mdc` | 885 | 867 | `templates/*.json` | false |
| `theme-settings.mdc` | 1096 | 1078 | `config/*.json` | false |

`localization.mdc` is absent on purpose — it was removed upstream in the 2026-08
slimming pass. Import from `main` only; older checkouts still carry the bloated
pre-slim rule set.

## Refresh

Re-import from current `main` (requires `gh` authenticated for
`meetdomaine/foundation`). Run from the repo root:

```sh
SHA="$(gh api repos/meetdomaine/foundation/commits/main --jq .sha)"
DEST=plugins/fnd/rules
gh api "repos/meetdomaine/foundation/contents/.cursor/rules?ref=$SHA" --jq '.[] | select(.name | endswith(".mdc")) | .name' \
| while read -r f; do
    gh api "repos/meetdomaine/foundation/contents/.cursor/rules/$f?ref=$SHA" \
      -H "Accept: application/vnd.github.raw" > "$DEST/$f"
  done
node -e '
  const fs = require("fs"), d = "plugins/fnd/rules";
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".mdc"))) {
    const p = `${d}/${f}`;
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/\(mdc:\.cursor\/rules\/([A-Za-z0-9._-]+\.mdc)\)/g, "($1)"));
  }
'
# then update Commit / Fetch date / the size table above, and run tests/rules-bundle.sh
```

Drift check against upstream without re-importing:

```sh
gh api repos/meetdomaine/foundation/commits/main --jq .sha   # differs from Commit above → upstream moved
```

## Ownership

Open with the foundation team (tracked in `HARNESS-PORT-PLAN.md`, M4): the plugin
should become the single home, with the foundation copy removed or synced *from*
here. Two hand-edited copies is the state this file exists to prevent.
