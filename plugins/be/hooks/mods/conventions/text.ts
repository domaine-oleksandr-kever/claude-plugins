// be's session text: the one line the main session's system prompt and the subagents read.

export const rootLine = (root: string) => `be plugin root: ${root}`

/** base's readers and writer, and Claude Code's own helpers: no be context at all. */
export const NO_BE_AGENT = /(^|:)(jira-reader|jira-writer|figma-reader|doc-reader)$|^(claude-code-guide|statusline-setup)$/
