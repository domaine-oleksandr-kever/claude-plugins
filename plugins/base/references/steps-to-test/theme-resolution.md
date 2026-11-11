# Steps to Test — Theme resolution (item 1)

One section of the Steps to Test format; the index is `../steps-to-test-format.md`.

**Project rules** — with a project rules file (`project-rules.md`), it answers item 1 first:

- **Environment** — the file's `environment`; with several, the one the ticket or the developer's answer
  names.
- **Store** — the listed store (`stores`) of the ticket's brand and market, with its host. A ticket, `notes.md`
  or developer answer that names another environment or an unlisted store (a DEV store) conflicts with the
  project rule: the rule wins, item 1 names the listed store of the same brand, and `unconfirmed: store:` names
  both facts. Never a DEV store in the field when the file allows UAT only. A brand with no listed store →
  `unconfirmed: store:`, no host guessed.
- **Theme** — with `theme: published`: the store's published theme, named as that ("the published theme"; "the
  theme the TL deploys `develop` to" when the file or `notes.md` says so), opened by the plain storefront
  host: no theme question, no id, no preview link. Without `theme`, the order below picks the theme, on a
  listed store only.

Without a project rules file, or with one that has no `theme`, in order, stopping at the first that answers:

1. **The ticket** — a QA theme link or id in the Description, Steps to test, AC or comments, unless it is
   evidently the PR's own preview theme.
2. **A theme this session confirmed on that store**, from the workspace `notes.md` — written as `id <id> as of
   <date> — confirm with the TL`.
3. **Ask the developer once** — "which theme does the TL push to for QA?" (one AskUserQuestion).
4. **Placeholder** — theme **<confirm with the TL>** with the route written as is,
   `Online Store > Themes > <theme> > Preview` (`<theme>` stays a token the TL fills), or a known id whose
   owner is unknown, stated as unconfirmed; never invent a theme.

Never the QA store registry's `defaultTheme`. The workspace's `session-theme:` line is the PR's preview
theme: never take its theme, its host or its store from it.

**Environment and store** — the environment word (DEV / UAT / Prod) and the store come from the developer's
answer; without one, from the workspace `notes.md` facts about the theme id, else from the ticket — never from
`session-theme:`.
An answer that contradicts `notes.md` (the id belongs to another environment, the store name says prod) is
kept as given, and the conflict goes under `unconfirmed: theme:` in one line naming both facts. Item 1 is
never self-contradictory ("UAT — <a prod store>"): it keeps the answer's environment and the theme name + id,
and the disagreeing store name moves from the field into that unconfirmed line.

**Before state** — the field never invents a before for QA to compare with. Prod or another store is never a
"before": other products, another feed, another cache. A theme without the change on the same store goes into
item 1, as the before, only when the ticket or the developer's answer names it — never invented, never the PR's
preview. Otherwise the before record is the PR's screenshots; QA reaches them through the PR-link comment.

**Link or route** — a confirmed id on a DEV or UAT store → the bare preview link; a Prod store or an unconfirmed
id → `Online Store > Themes > <name> > Preview`, never a preview link; the storefront host is named either way.

**Store with the placeholder theme** — named as the developer answered or as the ticket names it, its
storefront host still named, with no preview link (the route form instead). A multi-brand repo with no store in the answer or the
ticket → the store is unconfirmed (`unconfirmed: store:`), not a question.
