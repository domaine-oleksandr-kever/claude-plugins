// qa's conventions, the text the main session's system prompt reads. Pure: `<base root>` stays literal, as the
// session's `base plugin root:` line names it.

export const rootLine = (root: string) => `qa plugin root: ${root}`

export const PASSWORDS = `## qa convention — storefront passwords

A storefront password comes only from \`node <base root>/scripts/qa-stores.cjs get <store>\` (\`<base root>\` is
the path on base's \`base plugin root:\` line) and is used only as the browser fill value: never in a file, a
workspace note, a Jira comment, a screenshot or chat, never on a Bash line other than a \`qa-stores.cjs set\`
that registers or updates a store, and the registry file is never read directly.`
