---
name: update-translations
description: >
  Translate English strings into the theme's other languages — storefront copy
  (`locales/*.json`) and/or schema locale files (`locales/*.schema.json`, admin/customizer
  labels). Use when the user asks to translate / localize storefront (customer-facing)
  copy, schema / settings / theme-editor labels, or add locale translations.
argument-hint: "[storefront|schema|all] (describe the English keys/strings to translate)"
arguments:
  - name: scope
    description: storefront | schema | all. Omitted → detect from the request or the changed files (only `locales/*.schema.json` touched → schema; only storefront locales → storefront; both → all); still ambiguous → ask.
  - name: strings
    description: The English keys/strings to translate (or a pointer to where they live). Used to build sourceStructure.
allowed-tools: Read, Glob, Write, Bash(node scripts/update-translations.js), Bash(node scripts/update-translations.js --schema)
---

# Update Translations (storefront / schema)

Storefront copy lives in `locales/*.json` (customer-facing); admin / theme-editor labels
in `locales/*.schema.json`. Both scopes run through the same project script — the only
differences are the language-code glob, the `--schema` flag, and the schema name-length
rule. Scope `all` = run the storefront pass, then the schema pass (each with its own
data file).

## Step 0 — Scope

Explicit argument wins. Otherwise detect: the request names schema / settings /
theme-editor labels, or the strings live in `locales/*.schema.json` → **schema**;
customer-facing copy / `locales/*.json` → **storefront**; keys of both kinds → **all**.
Still ambiguous → ask.

## Step 1 — Build the translation-data file

Create `scripts/translation-data.json` with two top-level keys:

```json
{
  "sourceStructure": {
    "actions": { "add": "Add", "add_to_cart": "Add to cart" },
    "blocks": { "contact_form": { "name": "Name", "email": "Email" } }
  },
  "wordTranslations": {}
}
```

Get the target language codes with **Glob**, per scope:

- **storefront** — `locales/*.json`: take each basename, drop the `.json` suffix, skip
  `en.default.json` plus every `*.schema.json`.
- **schema** — `locales/*.schema.json`: take each basename, drop the `.schema.json`
  suffix, skip `en.default.schema.json`.

What remains are the language codes (e.g. `fr`, `es`, `de`).

In `wordTranslations`, mirror `sourceStructure` exactly, but make **each leaf value an
object of `{ "<lang>": "<translation>" }`** for every language code:

```json
{ "actions": { "add": { "fr": "Ajouter", "es": "Añadir", "de": "Hinzufügen" } } }
```

**Constraints:** mirror `sourceStructure` in `wordTranslations`; every leaf → an object
with all languages; only translate the keys in `sourceStructure`; never add other keys;
do not read other files.

## Step 2 — Run the script

```bash
node scripts/update-translations.js            # storefront scope
node scripts/update-translations.js --schema   # schema scope
```

It updates every locale file of that scope with the new translations, then
**auto-deletes** `scripts/translation-data.json`.

## Notes

- Schema scope only: section `name` strings in `locales/*.schema.json` must be
  **25 characters or fewer** (`ValidSchemaName` in `shopify theme check`) — shorten
  labels (e.g. "FHR collection grid") if needed.
