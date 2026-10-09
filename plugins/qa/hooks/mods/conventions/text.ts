// qa's conventions, the text the main session's system prompt and the subagents read. Pure: `<base root>`
// stays literal, as the session's `base plugin root:` line names it.

export const rootLine = (root: string) => `qa plugin root: ${root}`

export const STORE_ACCESS = `## qa convention — store access while a QA preflight runs

While \`/qa:preflight\` runs, or when the person says this is a hands-on QA session, the run works on
the storefront only: no Admin API write, no theme or theme-settings write, no publish, duplicate or
preview-theme creation. Storefront-session actions — add to cart, change a quantity, apply a discount
code the ticket names, advance checkout to the payment step — are in scope; any other write is
reported, not performed. A team plugin's own QA flow follows its own store-access section.

A storefront password comes only from \`node <base root>/scripts/qa-stores.cjs get <store>\`
(\`<base root>\` is the path on base's \`base plugin root:\` line) and is used only as the browser fill
value: never written to a file, a workspace note, a Jira comment or a screenshot, never on another
Bash line than the \`qa-stores.cjs set\` that registers a store, and never restated in chat. The
registry file itself is never read directly.`

/** base's readers and writer, and Claude Code's own helpers: no qa context at all. */
export const NO_QA_AGENT = /(^|:)(jira-reader|jira-writer|figma-reader|doc-reader)$|^(claude-code-guide|statusline-setup)$/

/** base's own agents (the reviewers): the root line, not the store-access posture. */
export const BASE_AGENT = /^base:/
