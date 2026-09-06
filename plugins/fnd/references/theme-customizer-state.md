# Theme customizer state — inspect & drive it through theme JSON

Everything a merchant clicks together in the theme editor is stored as **JSON files on the
theme**: `templates/*.json` (which sections a page has, their order, blocks, per-section
settings), `sections/*.json` (header/footer section groups) and `config/settings_data.json`
(global theme settings). You have no customizer UI — but you don't need it: read and write those
files directly with `<plugin root>/scripts/theme-json.sh`, and any customizer-dependent
AC, bug reproduction, or research question becomes scriptable. **Plugin root** = the plugin's own
directory; this file is `<plugin root>/references/theme-customizer-state.md`, and every
`<plugin root>/…` path below resolves the same way.
On Claude Code the session context opens with `fnd plugin root: <absolute path>` — write that path
into commands; the Bash tool's shell does not set `${CLAUDE_PLUGIN_ROOT}`, so a literal one expands
to empty. On other hosts substitute the same path.

## Always available — not only when finishing a plan

**Read-only inspection is fair game at any moment**: researching a ticket, writing a TA,
debugging, QA. `themes` lists the store's themes; `get` reads any file from **any** theme —
including the live one (reading live is safe). Don't guess what's configured on the store — look
(substitute the plugin root's absolute path for the placeholder below):

```bash
<plugin root>/scripts/theme-json.sh themes                       # id / name / role
<plugin root>/scripts/theme-json.sh get --theme <id> --file templates/product.json \
  --strip-comments --out .claude/tasks/<work-id>/tmp/product.json          # then pull values with jq
```

Inspection reads go through `--out` (target the task workspace `tmp/`, mktemp when no
workspace) — a `settings_data.json` is 30–150 KB of context burn inline. `get` without
`--out` suppresses any body over 8 KB to a **non-TTY** caller (pipes and `>` redirects
alike) with a self-describing `note=large_file` line — never redirect a big `get` to make
a snapshot; `--out` is the snapshot path (byte-exact). A human terminal prints in full.

Writes (`set`) follow the protocol below. General Admin GraphQL (products, metafields,
metaobjects, files) goes through `<plugin root>/scripts/shopify-admin-gql.sh` — see
`<plugin root>/references/metafield-metaobject-setup.md`.

## Why these files never route through the working tree

The whole JSON content layer is in `.shopifyignore` deliberately. Two consequences for you:

- `shopify theme dev` will **neither upload nor hot-reload** local edits to these paths — editing
  JSON inside the project does nothing remotely. Edit the theme directly instead (this script).
- Never write pulled theme JSON into the repo; keep snapshots and working copies in a temp dir.

## The tool

```bash
theme-json.sh themes [--role main|development|unpublished|live|demo]
theme-json.sh get  --theme <id|gid> --file <path/in/theme.json> [--strip-comments] [--out <file>]
theme-json.sh set  --theme <id|gid> --file <path/in/theme.json> --from <file>
# common: --store <domain> · --engine auto|store|token|themecli · --env <path> · --api-version <v>
```

`--file` is a path **inside the theme** — it must start with a theme top-level dir and carry no
absolute, `~` or `..` segment (else `error=bad_file`, exit 2) — and `set` writes the JSON content
layer only: `config/*.json`, `templates/**/*.json`, `sections/*.json`, `locales/*.json` (else
`error=file_not_writable`); a `--from` that names a credential file is refused outright
(`error=from_file_refused`), since an upload publishes those bytes and an asset is public.

Engines (`--engine auto|store|token|themecli`, default `auto`) — Admin GraphQL first, via the gql
runner (store execute → `SHOPIFY_ADMIN_TOKEN`); scopes **`read_themes`** for `themes`/`get`,
**`write_themes`** only for `set`. **Ask the developer which level this store gets** — on
client/production stores read-only is often the right call, and inspection alone is still fully
useful (auth blurb in `metafield-metaobject-setup.md`). When those credentials are missing or
lack the theme scopes, the script **falls back to the theme-CLI engine automatically**:
`shopify theme pull/push --only --nodelete` from a private temp dir, authenticated by the
**Theme Access token** every Foundation project already has for `theme dev`
(`SHOPIFY_CLI_THEME_TOKEN`, else `password=` in `shopify.theme.toml` — read internally, never
printed). So theme JSON works even with **no Admin API access at all**; both engines return
identical bytes and enforce the same live-theme refusal. Exit codes: 0 ok · 2 usage · 4
live-theme write refused · 5 GraphQL/user/CLI errors · 3 no credentials for any engine (the
hints name every remedy) · 6 a `set` reported success but the content did not land (read-back
mismatch, or the read-back itself failed — see the write protocol below).

**Finding the dev theme id** without exposing secrets (never `Read` `shopify.theme.toml` — it can
hold a Theme Access password):

```bash
grep -E '^[[:space:]]*theme[[:space:]]*=' shopify.theme.toml | head -1   # persistent dev theme id
# or: theme-json.sh themes --role development
```

## Write protocol — snapshot → mutate → verify → restore

The script refuses the live theme (role `MAIN`); target the dev theme the dev server runs
against, or a preview/sandbox theme. Then:

1. **Snapshot** the pristine file **raw** to a temp dir: `get --theme <id> --file
   templates/product.json --out "$TMP/product.pristine.json"`. That byte copy is your restore
   source. Re-pull it **right before** writing — a teammate may have edited the shared dev theme
   in the customizer meanwhile; keep the whole window short.
2. **Make a working base and edit it with `jq`** (anatomy below). Theme JSON often opens with
   Shopify's auto-generated `/*…*/` banner, which plain `jq` can't parse — pull the base with
   `--strip-comments` (lossless: Shopify re-stamps the banner on every write anyway):

   ```bash
   theme-json.sh get --theme <id> --file templates/product.json --strip-comments \
     --out "$TMP/product.base.json"
   jq '.sections[(.order[0])].disabled = true' \
     "$TMP/product.base.json" > "$TMP/product.working.json"    # e.g. hide the first section
   ```

   To add a section instead, its `type` must exist as a section file **on the target theme**:
   `themeFilesUpsert` validates every reference server-side and rejects the whole write with
   `FILE_VALIDATION_ERROR` userErrors otherwise — atomically, nothing gets written. (Corollary: a
   skeleton theme missing section files refuses even a rewrite of its own current JSON.)

3. **Write**: `set --theme <id> --file templates/product.json --from "$TMP/product.working.json"`.
   The write is **verified mechanically**: on both engines `set` pulls the file back and compares
   it against the payload (semantically for `*.json` — banner stripped, `jq -S` key order — so the
   re-stamped `/*…*/` header is not a diff), retrying once. Landed ⇒ `verified=true` on the result
   line. Shopify validates theme JSON server-side and, for payloads it rejects, **keeps the
   previous content while the write reports success** — that case is now `error=not_applied` +
   **exit 6**, with the two known triggers on stderr: an attribute the setting's schema does not
   support, and a non-canonical dynamic source (write `{{ ….value }}` — a `.value` after every
   reference hop). Fix the payload and re-run — and treat exit 6 as *the theme diverged*, not as
   *nothing happened*: no pre-image is read before the write, so what it proves is only that the
   theme does not serve your payload. `get` the file, and restore the snapshot (step 5) if what
   comes back is neither the payload nor the content you started from.
   `error=verify_read_failed` (same exit 6) means the read-back itself did not run — throttled,
   5xx, unparsable — so the state is unconfirmed; `get` before assuming either outcome. On a host
   with no working `perl` the comparison degrades to raw bytes, which cannot tell the re-stamped
   banner from a lost write: a difference is then `verified=unverified` on the result line + exit
   0 (`note=verify_raw_compare` / `note=verify_unverified` on stderr), and confirming is yours.
4. **Verify the render**: reload the page (running dev server → `127.0.0.1:9292`; otherwise the
   theme preview URL). Ignored paths render from the **remote** theme, so the upserted JSON is
   what the dev server shows. Step 3 already proved the file on the theme, so a stale UI is
   propagation/caching, not a lost write: hard-reload and retry briefly before calling it a bug —
   same discipline as metafields.
5. **Restore** the snapshot (`set --from "$TMP/product.pristine.json"`), `get` once more to
   confirm — the raw pristine restores **byte-exact** (banner included, not duplicated) — and say
   so in your report. The theme must end exactly as you found it.

Walk **every** enumerated/optional/conditional state the AC names — one default render proves
nothing (same rule as data-driven AC in `metafield-metaobject-setup.md`).

## JSON anatomy — what to edit

`templates/*.json` (and `sections/*.json` groups — same shape):

```json
{
  "sections": {
    "<local-id>": {
      "type": "<section filename without .liquid>",
      "blocks": { "<block-id>": { "type": "<block type>", "settings": { } } },
      "block_order": ["<block-id>"],
      "settings": { "<setting-id>": "<value>" }
    }
  },
  "order": ["<local-id>"]
}
```

- **Add a section**: new entry under `sections` + its id appended to `order` (the `type` must
  exist as a section file on the target theme — server-validated).
- **Add a block**: entry under that section's `blocks` + id in `block_order`.
- **Change a setting**: `settings.<id>`. Setting ids, types and allowed values come from the
  section's `{% schema %}` in the repo — read it first; an id the schema doesn't declare is
  silently ignored at render.
- `config/settings_data.json`: global values live under `"current"` (it can also be a preset
  *name string* on a fresh theme — then the values are the preset's in `settings_schema.json`).
- A `"disabled": true` on a section/block hides it without removing it — handy for
  presence/absence AC states.

## Sandbox for aggressive walks

A walk would thrash the shared dev theme (many states, risky JSON) → take a disposable copy per
`<plugin root>/references/customizer-sandbox.md` (preview theme or `theme duplicate`;
mutate freely, verify, **delete it** after).
