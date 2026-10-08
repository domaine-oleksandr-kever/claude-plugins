// The no-AI-attribution rule for a Bash command, pure. The engine asks every agent to end a commit
// message with an AI trailer; references/commit-message-format.md forbids it, and in that fight the
// system prompt sometimes wins, so the commit call is denied instead.
//
// Best-effort by design; the N/M rows in hooks/mods/tests/guards.test.ts are the FP/FN contract. Known
// residual FPs: a commit message that merely MENTIONS the trailer text, and a `;`-chained command that
// greps for the trailer AFTER the commit. Known residual FNs: a message staged to a file and committed
// with `git commit -F file`, and a `|`/`&` inside the quoted message, which ends the scanned segment early.

export const ATTRIBUTION_DENY =
  'Domaine convention (references/commit-message-format.md): commit messages carry no AI attribution. ' +
  'Re-run the same git commit without the Co-Authored-By / Generated-with-Claude trailer.'

// A deny needs a `commit` and one of the trailer words; `generated…with` stays loose because a wrapped
// message puts a newline between the two words.
const HAS_COMMIT = RegExp('commit', 'i')
const HAS_WORD = /co-authored-by|anthropic|generated[\s\S]*with/i

const S = '[ \\t\\n\\v\\f\\r]'
const NS = '[^ \\t\\n\\v\\f\\r]'
// A `git … commit …` segment: global options may sit between git and commit (-C <path>, -c <k>=<v>,
// --git-dir=…); the leading boundary keeps `legit commit` out. Trailers live at the message END, so a `;`
// does not end a segment (a `;` inside the quoted message must not hide the trailer behind it).
const SEGMENT = new RegExp(`(^|[^A-Za-z0-9_.-])git(${S}+-${NS}+(${S}+[^- \\t\\n\\v\\f\\r]${NS}*)?)*${S}+commit[^|&]*`, 'g')
// Claude/Anthropic attributions only — a human Co-Authored-By trailer passes. The display name stops at
// `<`, so an @anthropic.com address (any subdomain) needs its own branch; a look-alike host passes.
const ATTRIBUTION =
  /co-authored-by:[^<>]*(claude|anthropic|<[^<>]*@([A-Za-z0-9-]+\.)*anthropic\.com)|noreply@anthropic\.com|generated with \[?claude/i

/** True when a `git … commit` segment of `command` carries a Claude/Anthropic attribution. */
export function carriesAttribution(command: string): boolean {
  if (!HAS_COMMIT.test(command) || !HAS_WORD.test(command)) return false
  const flat = command.replace(/\n/g, ' ')
  for (const m of flat.matchAll(SEGMENT)) if (ATTRIBUTION.test(m[0])) return true
  return false
}
