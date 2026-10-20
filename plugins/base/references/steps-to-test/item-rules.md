# Steps to Test — Item-by-item rules

One section of the Steps to Test format; the index is `../steps-to-test-format.md`.

**1. Theme.** Store + theme, label + id (order: `theme-resolution.md`), and the route that opens it, since
every later path resolves against it: confirmed id, no editor work → the preview link
`https://<store>.myshopify.com/?preview_theme_id=<id>`; else `Online Store > Themes > *<theme>* >
**Preview**`; either way, "stay in that preview session". Never the PR's own preview theme. Market / viewport
/ locale / customer state only when the behaviour depends on them, with how to set each — a viewport-dependent
change names both ranges with the breakpoint in px ("check both a mobile viewport (under 1024px) and desktop
(1024px and up)"), never "mobile" alone. No storefront
passwords, no deploy or CI mechanics (workflows, pushes, tags, PR links); naming the branch a theme receives
("the theme the TL deploys `develop` to") is allowed.

**2. Where + setup.** Pages by path; the section or block **by the name the admin sees**, read from the
`{% schema %}` with `t:` keys resolved through `locales/en.default.schema.json`, never a code name. A label
you cannot read is **unverified**: write it plus `(name as the code spells it — confirm the admin label)`
and raise it in the presentation — marked, never dropped. Sub-bullets, one action each:

- **Where** — the store by its alias, then the editor route as the admin shows it (`Online Store > Themes >
  <theme> > Customize > <page / template>`) or one deep link,
  `https://admin.shopify.com/store/<handle>/themes/<theme id>/editor?previewPath=<url-encoded path>`.
- **Setup from scratch** — for everything the change adds and every setting whose default, options or wiring
  it changes: **Add section** / **Add block** by their editor names, the placement, every setting that must
  leave its default by its **label** with its value by its **option label**, the content, then **Save**. QA
  builds it; an empty section on the QA theme is expected. The recipe may sit in item 2 or be the walk-through
  steps themselves when building the section **is** the test.
- **Already there** — from the repo, never from the QA theme's state, which you cannot see: in the template
  JSON → "ships on the `<template>` template — find it in the sidebar, don't **Add section**"; else "if it is
  missing, set it up as: …".
- **Data you need** — in dependency order: store / market settings (toggle by verbatim label with its value) →
  metafield definitions (owner · **Name** · `namespace.key` · type · `Settings > Custom data > … > Add
  definition`) → metaobject definitions → entries (`Content > Metaobjects > <type> > Add entry`) → values →
  fixtures. Tag **(store-wide)** or **(per-theme)** where it matters; store-wide data is shared with the live
  theme — use QA fixtures.
- **Restore** — a store-wide mutation ends with its restore in the same bullet (`(restore: Activate)`);
  per-theme settings need none.
- **Fixtures** — handle plus the property that makes it right: `e.g. /products/studio-fix-fluid (40+ shades,
  in stock)`; the handle is the example, the properties the requirement. Once, after the first handle, as its
  own sentence: `Handles are examples — if one is missing on your store, use any product with the same
  properties and say which one you used.` Never folded into a parenthesis behind one product, where it reads
  as a remark on that product instead of a rule for all of them. Both templates: on Bug item 4 the trigger
  product and the boundary product are each an `e.g.` handle carrying the counts that make them trigger.
  Every `e.g.` handle is a real product **on item 1's store when you write the steps**, confirmed there with
  its properties — a `/base:shopify` lookup of the handle (`status: ACTIVE`) or the storefront's
  `/products/<handle>.js` answering 200; a handle from `notes.md` or the developer counts only once confirmed
  on that store (a dev-store repro handle is often missing on the QA store, and QA then reports "this product
  does not exist"). Not there → use a confirmed product with the same properties instead; none found or no
  access to that store → keep the handle, mark it **unconfirmed** and raise it at the ✋ checkpoint.
- **Created in setup** — an entity that exists only once QA makes it (an issued gift card, a discount) is
  named by its role, with where its value appears and whether it shows once. A state only time reaches is
  a dated instruction (`**Expiration date** = today, check it the next calendar day`); the steps needing it
  name their day.

**3…n. Steps to replicate.** One pass through the feature **as built**: imperative, location before action,
labels bold and verbatim, one action per step — or one chain along a single path. Every AC's functionality is
exercised by a step, or discharged in n+2 when this ticket delivers it outside the theme. Not one scenario per
AC, no regression sweep, no negative path unless the implementation has a deliberate one. Never restate setup;
name a fixture by its item-2 role.

**Expectations sit inside the step that produces them** — "You should see …" — never a separate Expected
block: one clause, concrete wherever a value is observable (copy verbatim, prices, counts), never "works
correctly" or "or similar". A setup step's expectation may be what the setting accepts and what happens at its
limits ("any size works, 1000x1000 preferred").

**n+1. Edge cases.** One per new or changed setting where blank, overflow or a boundary matters, plus the
cases the named data already reaches (an entity without the value, a deactivated fixture, another market),
each with its expected behaviour. A platform limitation is stated as not a bug (the colour picker cannot
exclude `#ffffff`). Soft cap ≈ 4 — coverage outranks it.

**n+2. Context / out of scope.** The developer's choices that affect testing: new settings with their defaults
and where a value comes from, what was intentionally left unchanged, known limits, copy from **Theme content**
that should stay default, and what is **not** in this ticket — including an AC item delivered outside the
theme, named as the AC names it. Up to five bullets, a clause each; omit the item only when the change made
no choice worth stating.

**Bug item 4 — What to expect.** A lead line plus one nested bullet per case, never one paragraph: a QA
engineer reading one block of prose cannot tell which page, viewport or product each expectation belongs
to. The **lead line** names the trigger fixture by role with its `e.g.` handle, the counts / values that
made it trigger and the admin route, then the substitution sentence; a fix whose rendering does not depend
on viewport says `any viewport` here once. Each **bullet** is one case, opened by a bold label naming what
sets it apart — the viewport with its breakpoint (`**Mobile (under 1024px):**`), the page or surface
(`**Search card:**`), the data state (`**Bundle without a campaign:**`) — then the action, location first,
and its expectation with exact values, as a walk-through step would carry it. Cases, in order: the state
that used to break; every further surface or viewport the fix reaches, one bullet each; the boundary — the
second `e.g.` handle with its properties, or a setting blank / past its limit — with its restore; last,
`**Regression:**` — what a failure looks like, one clause per sign. Two cases never share a bullet, and
no bullet repeats the lead line's fixture.

**Visual aids.** Where a location or setup step is not obvious from text, ask the developer **in the
presentation**, never as a line in the field, to attach a screenshot or short video by hand; the plugin
uploads nothing.
