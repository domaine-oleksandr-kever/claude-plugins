## Foundation capability — live store access, any time

Two bundled runners (paths relative to the plugin root above) — use whenever real store
state would answer a question; don't guess store state.

- `scripts/shopify-admin-gql.sh --query <file.graphql> [--operation <Name>] [--variables <json>
  | --variables-file <file>] [--store <domain>] [--out <file>]` — Admin GraphQL. Read-only
  queries always fair game (big reads: `--out` + `jq`); mutations follow
  `references/metafield-metaobject-setup.md`. Both paths: every query or mutation you wrote
  clears a `validate_graphql_codeblocks` pass first (Shopify Dev MCP; needs a
  `learn_shopify_api` conversationId).
- `scripts/theme-json.sh themes|get|set` — customizer state. `themes`/`get` freely, any
  theme incl. live; `set` only per the snapshot → mutate → verify → restore protocol in
  `references/theme-customizer-state.md` (live theme refused). Works without Admin
  credentials via the Theme Access token.

Auth handled inside; on failure they print the setup fix to relay. Never `Read` `.env` or
`shopify.theme.toml` — the runners consume secrets without exposing them.
