// pm's conventions, the text the main session's system prompt and the subagents read. Pure.

export const rootLine = (root: string) => `pm plugin root: ${root}`

/** base's readers and writer, and Claude Code's own helpers: no pm context at all. */
export const NO_PM_AGENT = /(^|:)(jira-reader|jira-writer|figma-reader|doc-reader)$|^(claude-code-guide|statusline-setup)$/
