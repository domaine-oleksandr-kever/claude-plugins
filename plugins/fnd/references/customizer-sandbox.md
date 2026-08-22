# Customizer sandbox — disposable theme for aggressive walks

Read this only when a theme-JSON walk would thrash the shared dev theme
(gated from `theme-customizer-state.md`).

When a test needs many states or risky JSON, take a disposable copy instead: the ticket's
preview theme from `<plugin root>/scripts/create-preview-theme.sh` (**plugin root** = the
plugin's own directory, this file being `<plugin root>/references/customizer-sandbox.md`;
on Claude Code, write plugin root as the literal `${CLAUDE_PLUGIN_ROOT}` in commands, elsewhere
its absolute path) — the script builds the project and
pushes an unpublished theme, the natural sandbox during development — or
`shopify theme duplicate -t <id> -n "fnd-<ticket>-sandbox" -f --json` (needs theme CLI auth).
A fresh duplicate is copied **asynchronously** — for the first seconds its files return
`NOT_FOUND` via Admin GraphQL even though the theme id already exists; poll `theme-json.sh
get` until it succeeds before snapshotting (observed live: ~3 retries).
Don't count on GraphQL `themeCreate(source:)` — it refuses redirecting/chunked zip URLs (GitHub
archive links fail with `Src is empty`). Mutate the copy freely, verify via its preview, then
**delete it** (`shopify theme delete` / `themeDelete`) — stores cap out at 20 themes
(100 on Plus), and stray sandboxes read as clutter to the client.
