// fe's conventions, the text the main session's system prompt and the code-writing subagents read. Pure:
// `<fe root>` stands for the plugin root until `withRoot` fills it in.
import type { FeProfile } from '../../../types'

export const rootLine = (root: string) => `fe plugin root: ${root}`

export const profileLine = (word: FeProfile) => `fe project profile: ${word}`

/** `<fe root>` → the plugin's own directory. */
export const withRoot = (text: string, root: string) => text.split('<fe root>').join(root)

export const FOUNDATION = `## fe convention — LiquidDoc and core

This checkout is detected as a Foundation theme (profile \`foundation\`). Every snippet ships a
LiquidDoc \`{% doc %}\` block with a default on each param. The JS/TS core, \`src/entry/core/*\`, is
protected: extend or compose it, never edit it in place. The Liquid core — \`snippets/@*\`,
\`sections/core-*\`, \`blocks/core-*\` — may be edited, but every edit has to be hand-synced from the
foundation repo, so prefer a copy under a new name.`

export const STORE_ACCESS = `## fe capability — live store access, any time

Two runners under \`<fe root>/scripts/\` — use them whenever real store state would answer a
question; don't guess store state.

- \`<fe root>/scripts/shopify-admin-gql.sh --query <file.graphql> [--operation <Name>] [--variables <json>
  | --variables-file <file>] [--store <domain>] [--out <file>]\` (\`--help\` prints the full call
  shape) — Admin GraphQL. Read-only queries are always fair game (big reads: \`--out\` + \`jq\`);
  mutations follow \`<fe root>/references/metafield-metaobject-setup.md\`. Both paths: every query or
  mutation you wrote clears a \`validate_graphql_codeblocks\` pass first (base's Shopify Dev MCP
  server; needs a \`learn_shopify_api\` conversationId).
- \`<fe root>/scripts/theme-json.sh themes|get|set\` — customizer state. \`themes\`/\`get\` freely, any
  theme incl. live; \`set\` only per the snapshot → mutate → verify → restore protocol in
  \`<fe root>/references/theme-customizer-state.md\` (live theme refused). Works without Admin
  credentials via the Theme Access token.

Auth is handled inside; on failure they print the setup fix to relay. Never \`Read\` \`.env\` or
\`shopify.theme.toml\` — the runners consume secrets without exposing them.`

/** The one line base's /base:worktree reads its copy list from, and the step that follows it. */
export const WORKTREE = `worktree copy list: shopify.theme.toml
After \`/base:worktree\` makes a new worktree, run \`/fe:preview-theme\` inside it: the copied \`shopify.theme.toml\` is unpinned there and the worktree gets a theme of its own.`

export const PROGRESS_SERIES = `## fe convention — the progress series

A ticket's \`progress.md\` lists fe's series, one row per step, in this order. The row text is the
step name; the skill after it ticks the row:

1. \`write-technical-approach\` — \`/fe:write-technical-approach\`
2. \`develop-feature-or-fix\` — \`/fe:develop-feature-or-fix\`
3. \`qa-feature-or-fix\` — \`/fe:qa-feature-or-fix\`
4. \`pre-commit-review\` — \`/base:pre-commit-review\` (pass it the profile word above)
5. \`commit\` — \`/base:commit\`
6. \`write-steps-to-test\` — \`/fe:write-steps-to-test\`
7. \`create-pull-request\` — \`/fe:create-pull-request\`

A batch (\`<work-id>\` = branch slug) lists one row per ticket, each ticked as its bug is fixed with
its root cause, then the same tail from \`pre-commit-review\` to \`create-pull-request\`.
\`/fe:ship\` runs the whole series and ticks the same rows.`

/** base's readers and writer, and Claude Code's own helpers: no fe context at all. */
export const NO_FE_AGENT = /(^|:)(jira-reader|jira-writer|figma-reader|doc-reader)$|^(claude-code-guide|statusline-setup)$/

/** Agents that read the theme without writing it: the root, the profile and the Foundation rules, no store access. */
export const READ_ONLY_AGENT = /(^|:)(theme-explorer|change-reviewer|bug-hunter)$|^(Explore|Plan)$/
