# Metafield / metaobject store setup — inspect, create, mock, bind

Shared reference for the `develop-feature-or-fix` skill (and the Data / Config section of
the `write-technical-approach` skill). Plugin root = the plugin's own directory; this file is
`<plugin root>/references/metafield-metaobject-setup.md`, and every `<plugin root>/…` path below
resolves the same way.
On Claude Code use the session context's `fnd plugin root:` path — `${CLAUDE_PLUGIN_ROOT}` is empty
in the Bash tool's shell.

**When the ticket — or a linked doc (e.g. a Notion data-mapping / schema page, see
`<plugin root>/references/reading-linked-docs.md`) — describes a metafield or metaobject**, the
theme code has nothing to render until the store's data model exists. This is how you get it in
place: inspect what's already there, create what's missing in dependency order, mock content, and
bind it to a test product so the feature can be built and QA'd.

Admin GraphQL API (pin the version the repo targets, e.g. `2026-04`). Every mutation must select
`userErrors { field message code }` and the created `id`.

## Planning & QA digest

Planners (ship Step 1 / interview, `write-technical-approach`) read **only this section**
— the rest of the file (step skeleton, Mode-2 living-file protocol, engine internals) is
implement-phase material. QA executors additionally read → Verifying data-driven
Acceptance Criteria.

- **Two modes.** Mode 1 — store API access exists (CLI ≥ 4.x `shopify store auth`, or an
  Admin API token): inspection and mutations run via `scripts/shopify-admin-gql.sh`.
  Mode 2 — no access: a living `.graphql` file the developer runs step-by-step in the
  Shopify GraphiQL App — each step handed as a ready-to-run file in the workspace `tmp/`,
  never a chat snippet; in an autonomous run that exchange must **complete before the ✋
  gate** (the run can't pause for manual steps).
- **Access is classified, never assumed:** `read_*`-only scopes → inspection works fully,
  mutations go to the developer (Mode 2); a confirmed `write_*` scope → Mode 1 mutations.
  Never infer write access from a working read; never request `write_*` scopes the
  developer didn't sign off.
- **STEP 0 — inspect before creating:** query the existing metaobject/metafield
  definitions, diff against the doc's data model, plan create/wire/mock/bind only for
  the gap.
- **Verify contract (data-driven AC):** snapshot → mutate → reload → verify (**DOM, not
  the visual**) → **restore**; walk every enumerated/optional/conditional value an AC
  names; mind **propagation lag** — re-query after mutating, retry briefly before calling
  a bug.
- **TA carries the model:** Data / Config names the definitions (types, keys, field list,
  owner/namespace) and may embed the STEP 0 query.

## Two modes

Pick based on whether you have **store API access** (either kind — see **Store access** below):

- **Mode 1 — store access available** (CLI ≥ 4.x stored `shopify store auth`, **or** an Admin API
  token). Run the inspection query **and** all mutations yourself via the bundled runner
  `<plugin root>/scripts/shopify-admin-gql.sh` — it picks the engine automatically
  (`store execute` first, token fallback). Drive it end to end: inspect → diff → create → mock →
  bind → report the resulting gids and final state. **Never print or `Read` any secret** (`.env`,
  `shopify.theme.toml`); the runner consumes credentials without exposing them.
- **Mode 2 — no store access.** Produce a **single living `.graphql` file** the developer runs by hand in
  the **Shopify GraphiQL App** (Shopify admin → Apps → *Shopify GraphiQL App*). Hand them **one
  step at a time — as a ready-to-run file in the task workspace, never as a chat snippet**
  (→ *Handing a step*); they paste back the JSON result, you read the returned **gid**, fill it
  into the next step, mark the step done, and advance. The file is the source of truth and the run log.

Either way the **step skeleton is identical** — only who-runs-it differs.

## Store access (Mode 1)

The runner supports two engines and picks one automatically (`--engine auto|store|token`):

**Engine 1 — `shopify store execute` (preferred; Shopify CLI ≥ 4.x).** No token in the repo at
all: a one-time `shopify store auth` installs a Shopify-managed OAuth app on the store and caches
an **online** access token. Setup is a **manual developer step** — it opens a browser and requires
the store's **"install apps" permission**, which client stores often deny (then use Engine 2):

```bash
shopify store auth --store <store>.myshopify.com \
  --scopes read_products,write_products,read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects,read_files,write_files,read_themes,write_themes
```

That list is the **full example** (metafields/metaobjects + products + files + themes — the
`read_themes`/`write_themes` pair powers `theme-json.sh`, the customizer-state flow in
`<plugin root>/references/theme-customizer-state.md`). **Don't hardcode it — agree the
scope list with the developer first**: propose what the task actually needs and ask which level
this store allows. On some stores (client/production especially) only the `read_*` scopes are
appropriate — inspection still works fully; you just hand mutations to the developer (Mode 2)
instead of running them. Prefer one auth that covers the whole task over asking twice, but never
request `write_*` the developer didn't sign off on.

The stored token **expires** — it's an online token: max **24 h**, sooner if the developer's
admin session ends — so when the runner falls back reporting `no stored store auth`, ask the
developer to re-run that same command (fast: the app is already installed). **Never run `store auth` from a script or skill** — it
is interactive and hangs a non-TTY run. Mutations are auto-opted-in by the runner
(`--allow-mutations`); the CLI blocks them otherwise.

**Auth fails, expires, or the browser step misbehaves** → read
`<plugin root>/references/store-auth-troubleshooting.md` — the fix per symptom and the
ready-to-relay re-auth blurb (never just say "auth expired"; don't interrupt if the runner
already fell back to the token engine).

**Engine 2 — Admin API access token.** `shpat_…`, with scopes
`read/write_metaobject_definitions`, `read/write_metaobjects`, `read/write_products` (plus
`read/write_themes` when the task touches theme JSON state). **This is
NOT the Theme Access token (`shptka_`) in `shopify.theme.toml`** — that one only has `write_themes`
and can't touch metaobjects. Get it from a **custom app** in the Shopify admin (Settings → Apps and
sales channels → Develop apps → your app → API credentials → Admin API access token). It lives in
the repo's **gitignored `.env`** as **`SHOPIFY_ADMIN_TOKEN=shpat_…`** (alongside the existing
`BRAND` / `FIGMA_TOKEN`). **Never `Read` `.env` yourself** — that pulls the secret into context.

Either way, run everything through the runner — substitute the plugin root's absolute path for
the placeholder below:

```bash
<plugin root>/scripts/shopify-admin-gql.sh --query .claude/tasks/<work-id>/tmp/inspection.graphql \
  [--operation <Name>] --out .claude/tasks/<work-id>/tmp/inspection.json   # then pull fields with jq
```

It tries `store execute` first (CLI ≥ 4.x), falls back to the token, takes the store domain from
`shopify.theme.toml`'s `store=` line, and keeps every credential out of context. **Inspection
reads (STEP 0, whole products) run 20–100 KB — always pass `--out` targeting the task
workspace `tmp/` (mktemp when no workspace exists) and pull what you need with `jq`**; the
runner then prints only `ok=1 bytes=… out=… errors=<none|first-error head>` — check `errors=`
before trusting the file. **Mutations stay inline** (small responses; the flow checks
`userErrors` immediately). Both engines return the **same envelope** — `{"data":…}` on success, `{"errors":…}`
on a GraphQL failure (exit 0, mirroring the Admin API's HTTP 200 + errors) — the runner
wraps/unboxes `store execute`'s native output so responses read identically either way, and a
GraphQL error never triggers the token fallback — and for a **mutation**, no failure after an
actually-attempted execute ever falls back (`error=store_execute_failed_mutation` — do what its
hint says before any re-run). Put each query/mutation in a `.graphql` file **inside the task workspace** — scratch/inspection queries in `.claude/tasks/<work-id>/tmp/`, the Mode 2 living setup file at the workspace root; never the repo's `docs/` (`<plugin root>/references/task-workspace.md`) — and pass it with `--query` (and
`--operation` when the file holds several named operations — for the store engine the runner
extracts the named operation itself). If it exits with `error=no_admin_token`, **neither** engine
is set up — relay the two fixes its hint names to the developer, or fall back to **Mode 2**.

**Validate before you run.** Every query or mutation you wrote goes through
`validate_graphql_codeblocks` (Shopify Dev MCP, `api: "admin"`, `version` = the version the
runner requests — `SHOPIFY_ADMIN_API_VERSION`, default `2026-04`; omit it and the MCP
validates against the latest stable instead) first: pass the raw GraphQL text (not a fenced
block) plus the `conversationId` from `learn_shopify_api` — it checks fields, arguments, and
input shapes against that Admin schema. Fix and re-validate (same `artifactId`, `revision` +
1) until it passes. The schema server is already loaded, so this is one cheap call; a
hallucinated field costs a round-trip, and a bad **mutation** may not be undoable.

## Step skeleton (dependency order)

Worked example — a PDP split-view block → an editorial-content wrapper metaobject → product
metafield → mock instances → product bind:

- **STEP 0 — INSPECT what exists.** A read query covering: the target metaobject definition(s) by
  type (`metaobjectDefinitionByType(type: "…")`), any wrapper/parent they attach to, a broad
  `metaobjectDefinitions(first: 100)` to catch naming variance, and the owner
  `metafieldDefinitions(ownerType: …, namespace: "…")`. **Diff the result against the data-mapping
  doc / TA** to decide which of the steps below are actually needed (some may already exist).
- **STEP 1 — CREATE the child metaobject definition** (`metaobjectDefinitionCreate`). Field set
  comes from the data-mapping doc. Use `validations: [{ name: "choices", value: "[\"…\"]" }]` to
  constrain content-team values to what the Liquid switches on; set `displayNameKey`; enable
  `capabilities` (`translatable` / `publishable`) to match siblings. **Copy the returned gid.**
- **STEP 2 — WIRE it into the wrapper/parent** (`metaobjectDefinitionUpdate` on the wrapper gid):
  append a `metaobject_reference` field validated by
  `{ name: "metaobject_definition_id", value: "<gid from STEP 1>" }`. (Adding a sibling block later
  is this same one-field append.)
- **STEP 3 — CREATE the owner metafield definition** (`metafieldDefinitionCreate`, e.g.
  `ownerType: PRODUCT`), `type: "metaobject_reference"` validated against the wrapper definition
  gid. This is what ties `product.<namespace>.<key>` to the data model. **Copy the returned gid.**
- **STEP 4 — CREATE mock content** for the child (`metaobjectCreate`) using data from the design /
  ticket. **Copy the returned instance gid.** For any image/file field, in priority order:
  1. **Prefer a variant that needs no media** (e.g. `media_type: "video"` with a `video_url`) so
     the step is runnable as-is.
  2. **Reuse existing store media** — query for one (`files(first: 10, query: "media_type:IMAGE")`
     → take a `MediaImage` `id`) and reference that gid. No upload, nobody adds anything.
  3. **Upload a specific new asset** only when the ticket genuinely needs it:
     `stagedUploadsCreate` → PUT the file to the returned target → `fileCreate` → use the resulting
     `MediaImage` gid. In **Mode 1** do this yourself if the asset file is available locally; in
     **Mode 2**, or when you don't have the file, **ask the dev to upload it in the admin (Content →
     Files) and paste the `gid://shopify/MediaImage/<id>` back**. So the dev only ever touches media
     in this last case — not by default.
- **STEP 5 — CREATE the wrapper instance** (`metaobjectCreate` on the wrapper type) binding the
  child reference gid from STEP 4. (If the test product already has a wrapper instance, use
  `metaobjectUpdate` on it instead of creating a new one.) **Copy the returned gid.**
- **STEP 6 — BIND onto a test product** (`metafieldsSet`): set the product `ownerId`
  (`gid://shopify/Product/<id>`, copied from the product's admin URL) and the wrapper instance gid
  from STEP 5 as the metafield value. After this the test product renders the feature.

## The living `.graphql` file (Mode 2)

Write it to the task workspace — `.claude/tasks/<work-id>/metaobject-setup.graphql` (and, if
useful, a companion `tmp/inspection.graphql` for STEP 0) — not the repo's `docs/`, so
ticket-scoped working files never ship with the branch
(`<plugin root>/references/task-workspace.md`). Shape:

- **Header comment block**: API version, the per-step **scopes** required
  (`read/write_metaobject_definitions`, `write_metaobjects`, `read/write_products`), a **diff vs
  the data-mapping doc** (what EXISTS vs MISSING), a **STATUS** list, and a **RUN ORDER** line.
- **One named operation per step** (`query InspectPdpEditorialData`,
  `mutation CreateSplitViewBlockDefinition`, …), each preceded by a comment explaining what it does
  and why.
- **`REPLACE_WITH_*` placeholders** for every gid that comes from an earlier step — and a note that
  each is filled from the prior step's result before running.
- **Update it as you go**: when the developer pastes a result, mark that step `✅ DONE` with the
  returned gid inline, paste the gid into the dependent step(s), and move the RUN ORDER pointer
  forward. Keep it accurate enough that someone could re-run the whole thing from the file alone.

### Handing a step — file, not chat

Never paste a GraphQL operation into the chat for the developer to copy — terminal wrapping
mangles it and copying from chat is awkward. Write the current step as a **standalone
ready-to-run file** in `.claude/tasks/<work-id>/tmp/step-<n>-<short-name>.graphql`: exactly one
operation, every `REPLACE_WITH_*` placeholder already filled from prior results, runnable as-is —
and **`validate_graphql_codeblocks`-clean before you hand it over** (a hand-off you can't run
yourself is exactly where a hallucinated field wastes the developer's round-trip).
In chat give only the **file path**, one line on what the step does, and the scope it needs; the
developer copies it from the file (or the IDE), runs it in GraphiQL, and pastes the JSON result
back. This applies to **every** query or mutation handed to the developer to run manually —
Mode 2 steps, one-off inspection reads, and mutations on a read-scope-only store alike. The
living file stays the source of truth: sync gids and step status into it as usual; the `tmp/`
step files are disposable copies.

## Verifying data-driven Acceptance Criteria (mutate to test)

When you have store access and provisioned the data yourself (Mode 1), many AC are **conditional
on the metafield/metaobject value** — one default render doesn't prove them. Drive each state with
a mutation, verify, then restore:

- **Enumerated options** (e.g. *"media area supports 4:3 / 1:1"*): verify the default, then
  `metaobjectUpdate` / `metafieldsSet` the field to each other value (`1:1`), reload, confirm the UI
  reflects it.
- **Optional / presence-conditional fields** (e.g. *"heading, body, secondary CTA are all optional;
  an unconfigured element shows no empty placeholder"*): clear the field, reload, and **inspect the
  DOM** — confirm the element is genuinely absent, not just visually empty. Repeat per optional
  element.
- Walk **every** enumerated/optional/conditional value an AC names; don't assume a state you didn't
  render.

**Propagation lag:** Shopify can serve a **stale value** for a short window after a mutation. After
mutating, **re-query the value** (a quick read via `shopify-admin-gql.sh`) to confirm it actually
changed, then hard-reload (cache-bust) the storefront. If the UI still shows the old value, wait
briefly and retry **before** concluding the code is wrong — distinguish "not yet propagated" from a
real bug. Leave the data in a known state (restore defaults or note what you left set) so QA starts
clean.

## Plan it in the TA first

In the `write-technical-approach` skill, the **Data / Config** section should already name the
required metafield/metaobject definitions (types, keys, field list, owner/namespace) and can carry
the STEP 0 inspection query, so the `develop-feature-or-fix` skill starts from a known target instead of
rediscovering the schema.
