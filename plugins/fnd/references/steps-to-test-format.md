# Steps to Test — Domaine format

The output standard shared by `/fnd:write-steps-to-test` and the pipeline steps-to-test
phase. The reader is a QA tester who deploys the branch code to **their own unpublished
theme** and configures everything **from scratch**. They know the Shopify admin but not
this implementation. Bar: **zero clarifying questions** — every fact a step needs lives in
this document, and two different testers following it get identical results.

## Environment rules (hard bans)

- **No preview themes that aren't the tester's own.** The PR's preview theme is for
  reviewers — QA deploys the branch to their own unpublished theme. Never cite someone
  else's environment: no `?preview_theme_id=…` ids, theme names, or links from the
  ticket/PR, no "preview theme linked in the ticket comment", no storefront passwords, no
  release tags, no PR references. The tester opens their own theme via
  **Online Store > Themes > … > Preview** (or the theme editor) and stays in that preview
  session — relative paths resolve against it; Setup line 1 states this.
- **No absolute hosts** (`https://<store>.myshopify.com/…`) — relative paths only
  (`/products/group-lipglass`). If the store matters (fixtures live on one catalog), name
  it **once** in Setup. Never fork steps per store — `dev: X; UAT: Y` per step is banned;
  write for the one store whose fixtures you name.
- **No document meta.** No title (the Jira field is already labeled), no summary paragraph
  restating the ticket, no revision history, no theory/rationale essays, no
  known-limitations walls. A needed operational fact ("validate with validator.schema.org,
  not Google Rich Results Test") is one Setup line, without the why.

## Setup — always the first section

On a fresh theme the section under test is **not placed anywhere** and no data is
configured. Setup is a numbered, imperative, do-once block in dependency order, covering
**every** item class the scenarios touch — section placement, blocks, app embeds, theme
settings, metafield definitions + values, metaobject types + entries, templates, fixtures
(this list is authoritative; source: the setup inventory from the ticket + diff). Emit only the subsections the
feature needs; tag every data/config subsection **(store-wide)** or **(per-theme)**
(Context needs no tag); end with a checkpoint.

Order and content:

1. **Theme (per-theme).** `Deploy the branch to your own unpublished theme, then open it
   in the theme editor (Online Store > Themes > Customize).` If a dev re-push can wipe
   editor config (`templates/*.json`, `settings_data.json`), say "redo the per-theme steps
   after any re-deploy".
2. **Store-wide data** — shared with the live theme, so point at dedicated QA fixtures,
   never live merchandising. In order: metafield definitions → metaobject definitions →
   metaobject entries → metafield values. For each definition give owner resource,
   **Name**, `namespace.key`, type, and the exact path
   (`Settings > Custom data > Products > Add definition`); for entries:
   `Content > Metaobjects > <type> > Add entry`, the fields to fill with **example
   values**, and "leave status **Active** (Draft entries never render)". Metafields on a
   product: `Products > <Product> > Product metafields > <Name> → <value> → Save` (note if
   the definition must be pinned to show). List definitions as compact bullets
   (`owner · namespace.key · type · value`).
3. **Fixtures (store-wide).** Name every entity by **handle/exact value** and the property
   that makes it right: `Product with shades: /products/studio-fix-fluid (40+ shades, in
   stock)`, `Empty-state product: /products/lip-pencil (no metafield value)`, customer
   email + tag/state. "Any product that…" is banned — if a fixture doesn't exist, Setup
   says how to create it.
4. **Theme settings (per-theme).** Exact path with labels verbatim:
   `Theme settings > Cart > Cart type → Drawer → Save`. Note the default so the tester can
   restore it.
5. **Template / section / block config (per-theme).** The exact editor route: template
   dropdown (top bar) → template; sidebar **Add section** → section name → placement
   ("drag below Main product"); **Add block** → block name; wiring a metafield into a
   setting via the **connect dynamic source** icon. If the section ships pre-placed in the
   template JSON (no preset), say "already on the template — find it in the sidebar, don't
   Add section". Alternate templates: create in the editor; the admin **Theme template**
   dropdown only lists the **published** theme's templates, so assign/preview one that
   exists only on this branch from the theme editor's template dropdown (select the
   template, then pick the resource in its preview) — not from the resource page.
6. **Context.** Only if it matters: market/locale (switch via the editor's market selector
   or the preview bar "View as", not the storefront country selector), customer state
   (log in as the named fixture), incognito window, viewport.

Close with: `✅ Checkpoint: <what the tester sees now, e.g. "the PDP for
/products/studio-fix-fluid shows a Comparison table with 7 rows">. If not, stop — recheck
step <n> / re-deploy the branch.`

## Scenario rules

- **One scenario per AC** (plus at most one extra for a cross-cutting flow). 3–6
  scenarios; heading ≤ 8 words in plain business language.
- **≤ 8 steps per scenario** (hard cap 10) — above that, split: the first scenario's end
  state becomes the next one's starting point, stated in one line (a split may take the
  document past 6 scenarios — that's fine).
- **One action per step**, imperative, location before action: `On the PDP, click
  **Add to Bag**.` Bold UI labels verbatim. No chained "then … then …".
- **Expected per step where state must be confirmed, and always at scenario end** — exact,
  observable values: copy verbatim, prices, counts, element states. `**Expected:** the
  line shows $18.00 with $30.00 struck through, labelled "MAC Pro price".` Never "works
  correctly", never "(or similar)" — if copy isn't final, one Setup line says which label
  to treat as a copy question, not a bug.
- **No conditionals or hedges in steps** — no "if present", "if available", "roughly",
  "approximately", "skip if". A condition either moves to Setup (make the state exist) or
  the scenario is dropped. Never restate setup inside scenarios — reference it
  ("as the member customer from Setup").
- **Edge cases:** ≤ 4, only ones the named fixtures can actually reach.
- **A11y / responsive / performance:** only what the AC or the diff actually changed, as
  1–2 concrete steps inside a scenario (`Tab to the CTA. **Expected:** visible focus ring;
  accessible name "Customize, Silky Matte Lip Set".`) — never a generic bolted-on section.
- Steps that mutate **store-wide** data end with a restore line
  (`Restore: toggle back ON`); per-theme settings changed in Setup only note their
  default there — no per-step restore.

## Size budget

Target **300–500 words** total (setup-heavy features up to 650). Coverage outranks the
budget: it caps prose — explanations, repeats, meta — never Setup completeness or
scenario count. Structure as headings + numbered steps, no tables — metafield/fixture
data goes in a compact bullet list (`owner · namespace.key · type · value`); the Jira
ADF write path flattens tables anyway.

## Templates

**General (feature / improvement):**

```markdown
**Setup** — do all of this once, before the scenarios.
1. Deploy the branch to your own unpublished theme; open it in the theme editor.
2. (store-wide) <data / fixtures — named handles, metafield defs + example values>
3. (per-theme) <theme settings → template > Add section > … > Save>
✅ Checkpoint: <observable result>. If not, stop and recheck step <n>.

### <Scenario heading — one per AC>
1. <One action, location first>. **Expected:** <exact outcome>.

### Edge cases
1. <Reachable boundary / empty / error state>. **Expected:** <behaviour>.
```

**Bug (defect fix):** same Setup + scenario rules. The tester's theme already carries the
fix, so **never instruct reproducing on an unfixed theme** — annotate instead:

```markdown
**Setup** — <as above; include the exact data/viewport that used to trigger the defect>.
✅ Checkpoint: <the state that used to trigger the defect is in place>.

### Verify the fix
1. <The action that used to fail>. **Expected:** <correct behaviour>.
   *Before the fix:* <what used to happen — so the tester recognizes a regression>.

### Regression sweep
1. <Adjacent flow the fix could disturb — scoped to the change's blast radius, not a
   standing checklist>. **Expected:** unchanged behaviour.
```

## Self-check before presenting

- Every AC has a scenario; every entity a scenario touches appears in Setup with a handle
  or exact value.
- Setup ends with a ✅ Checkpoint that its own steps actually produce.
- Within the size budget and step caps — prose trimmed, coverage intact.
- No banned content: preview themes, absolute hosts, passwords, per-store forks, titles,
  summaries, essays, "or similar", conditional steps, generic a11y/responsive sections.
- A tester with only this document and admin access can finish without asking anything.
