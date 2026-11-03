# Steps to Test — Item-by-item rules

One section of the Steps to Test format; the index is `../steps-to-test-format.md`.

**Labels.** A section, block or setting is named **by the label the admin shows**, read from the
`{% schema %}` with `t:` keys resolved through `locales/en.default.schema.json`, never a code name. A label
you cannot read is **unverified**: write the best admin-style label the code name gives (`delivery_threshold`
→ **Delivery threshold**), never the code spelling or a note in the field, and list it as unconfirmed in
the presentation — raised, never dropped. A label outside `{% schema %}` and locales (a Fredhopper facet, a
Talon.One campaign field, an app block setting) is copied from the diff's or `notes.md`'s literal storefront /
admin text; without one, the best human label, listed as `unconfirmed: label:` naming the source it came from.

**1. Theme.** The environment (DEV / UAT / Prod), the store, the theme by label and id (order:
`theme-resolution.md`), and the route that opens it: a confirmed id on a DEV or UAT store → the preview link
https://<store>.myshopify.com/?preview_theme_id=<id> as the bare URL, never in a code span or behind a label:
a code span is not clickable in Jira; a Prod store or an unconfirmed id →
`Online Store > Themes > <theme> > Preview`, never a preview link.
Never the PR's own preview theme, never Prod or another store as a "before", and a theme without the change
only when the ticket or the developer's answer names it (`theme-resolution.md` → **Before state**). With the
placeholder theme, the store is named as the developer answered or as the ticket names it, with no host and
no preview link (the route form instead); a multi-brand repo with neither lists the store as unconfirmed.
Market / viewport / locale / customer state / browser or device only when the change depends on them — a
browser or device when the TA, the diff or `notes.md` says so (the timing of a request, a Safari-only API); a
viewport-dependent change names the breakpoint in px ("under 1024px" / "1024px and up"), never "mobile" alone.
When `notes.md`, the ticket or the diff says a nearby environment cannot reach the
change (a facet, app, market or setting absent there), one clause says so ("Not UAT: it has no **Size** filter"). No storefront passwords, no deploy or CI mechanics (workflows, pushes,
tags, PR links); naming the branch a theme receives ("the theme the TL deploys `develop` to") is allowed.

**2. Object.** Where the change lives, nothing about what it does: pages by path (`/products/…`,
`/collections/…`; a path is a page type, never a handle or a page that is already set up — the entity is
item 3's property list), the template by name, the section / block by its admin label, a theme-settings
group by its route (`Theme settings > <group>`; its values are item 3 bullets), every surface the change
reaches (a card in two grids, the cart drawer row); three or more surfaces are grouped by page type
("collection and product pages"), not listed one by one. **Not visible on screen** — a change in a request, response, dataLayer, cookie or console
message: name the tool, the panel and the filter (`DevTools > Network, filter "cart", request
/cart/update.js`); every `DevTools > Network` mention in the field names its filter (`filter Fetch/XHR` for a
feed or API response, `Img` for image downloads, `Doc` for the page), and an item 3 source that sits under
another filter than item 2's names its own; the expected value stays out (it is the AC).

**3. Setup.** What QA has to configure to reach the change, in dependency order: store / market settings →
metafield and metaobject definitions → entries → values → theme settings → content. One bullet per
action or per entity; everything the change adds or re-wires has its route and its non-default settings here.
Item 3 makes reachable every state the Description or AC claims — the fixed state and every state the change
deliberately keeps or limits ("trimming still happens under a size filter"); a kept state gets its setup
bullet like an added one. Admin, store and theme state only: what the shopper does on the storefront while
testing (a filter chosen, a search term typed, a cart below a threshold) is not a setup bullet (a cache in
the way's clear route excepted) — when it
conditions the behaviour it is an item 4 fact; the data it needs (a product the search term returns) stays
item 3 data.

- **Theme editor** — **Add section** / **Add block** by their editor names with the placement, every
  setting that must leave its default **by its label with its value** (an option by its **option label**,
  a typed value with an `e.g.` that shows its shape: "whole and decimal amounts, e.g. 12, 4.50"), the
  content, then **Save**. A section the repo already ships on the template → "already on the `<template>`
  template — find it in the sidebar"; read that from the template JSON, never assume the QA theme's state.
- **Data as properties** — every entity QA needs is a requirement list, never a handle, a title or "the
  page that is already set up": "a product with 3+ sizes, one sold out", "a collection holding it without
  an enforced filter". A count or value in the list is the smallest that makes the changed behaviour
  distinguishable from the unchanged one (one more than the trimming threshold, 3+ sizes when one is trimmed,
  a threshold with pence), never the smallest that merely exists. A property inferred from code and not confirmed is listed as
  `unconfirmed: data:` in the presentation. A definition is named by owner · **Name** ·
  type and its route `Settings > Custom data > <owner> > Add definition`; a value on an entry by
  `<Owner> > <entry> > Metafields` (`Collections > <the collection> > Metafields`), never the definition route.
- **Found, not configured** — an entity whose existence depends on data QA cannot set (a product feed, a
  third-party service, analytics, a CDN, time) gets a recipe to find one: its signature in a source that still
  shows it after the change (the feed response in Network, the DOM, an admin field), quoting the key or value
  the source shows in a code span, never the symptom the change removes; where to look first (the page type or
  collection kind the ticket or `notes.md` names); and that the source decides whether a page holds one. A
  finding recipe is setup, not a walk-through: "an affected card: in the feed response (DevTools > Network, filter
  Fetch/XHR, the request the cards come from), a placeholder image and a first image with the same file name and a different
  `?v=`; try a collection of 20+ fed cards, best-sellers first; the feed decides which collections hold one".
- **Created by QA** — an entity that exists only once QA makes it (a discount, an issued gift card, an
  entry) is named by its role, with where its value appears.
- **Store-wide mutation** — closed in the same bullet by its restore ("clear it afterwards if you set it",
  `(restore: Activate)`); a **(store-wide)** tag is optional. Per-theme settings need none.
- **Hiding state** — a store state that would hide or override the change (an active promotion or
  free-shipping offer, an app override, a feature flag, a cookie / consent state) is named as a requirement
  that it be absent or present ("no active free-delivery offer").
- **Cache in the way** — a cache between QA and the change (card HTML kept in session storage for a minute,
  a CDN, an app cookie) is one bullet that names what it holds, where, and how QA empties it
  (`DevTools > Application > Storage > Clear site data`, or a wait longer than the TTL, in minutes), never a
  bare wait: "card HTML is cached in session storage for a minute: clear site data or wait over a minute before
  each reload" (a shape: the storage and the TTL are read from the theme code — the helper the changed file
  calls — the diff or `notes.md`, and one not read there is `unconfirmed: data:` in the presentation).
- **Optional** — only setup that reaches an item 4 fact outside the Description and AC opens with `optional:`.
- **Bug** — the admin / store / theme state that makes the defect reachable (data shape, viewport, market,
  setting value), as requirements, plus the state the fix keeps or limits; never the root cause or the fix. A
  storefront choice (a filter selected, a search typed) is an item 4 fact, not a bullet.

**4. Edge cases / not obvious.** Facts from the diff and `notes.md` only, and only facts this change creates or changes, platform limits it hits and
what this ticket deliberately leaves out; behaviour nearby code already had is not an item 4 fact unless
QA would file it as a defect of this change. Facts QA would otherwise misread, one clause each: a boundary or blank
value and what the build does with it by design; a platform limit stated as not a bug ("comma decimals are
not supported"); a state only time reaches, as a fact (`**Expiration date** = today: the expired state
appears only the next calendar day`); what is intentionally out of this ticket; a developer decision that looks
like a defect; a visible change in the diff the Description does not mention (a moved element, a restyled
control), stated as a fact with "by design" — the one "what changed" allowed; with no AC, a by-design
difference QA would otherwise file (£40 in one place, £40.00 in another); for an off-screen change, the
field that changes — never its value; with a found fixture in item 3, "a page with none of these today is not
a failed test". Never a scenario
("open X, click Y"), never an expected result the AC already states. Either one line of clauses separated
by semicolons on the item's own line, or nested bullets, one fact each.

**Screenshots.** Setup only — a route or setting not obvious from text — never a result (result
screenshots stay in the PR; QA finds them through the PR-link comment). They are asked for **in the
presentation**, as `screenshot:` lines for the developer, never as a line in the field. The developer
attaches each by hand **after item 4**, with a one-line caption (`Item 3 — Delivery Banner settings`), so
the list is never broken by an image; the plugin uploads nothing.
