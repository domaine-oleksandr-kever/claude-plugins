// qa's conventions, the text the main session's system prompt reads. Pure: `<base root>` stays literal, as the
// session's `base plugin root:` line names it.

export const rootLine = (root: string) => `qa plugin root: ${root}`

export const PASSWORDS = `## qa convention — storefront passwords

A dev or UAT storefront password is low-sensitivity: the registry (\`node <base root>/scripts/qa-stores.cjs get <store> --field password\`;
\`<base root>\` is the path on base's \`base plugin root:\` line, a bare \`get\` prints JSON, never a fill value) is the
preferred source when it knows the store, and one the developer gave in chat or a memory or workspace note holds is as
good. It may appear in chat, notes, browser fill code and on a Bash line, never in a Jira comment, Steps to Test, a PR
body or anything else the client or QA team reads, a committed theme-repo file or a screenshot attached to a ticket.
The registry file is never read directly, only through the script.`
