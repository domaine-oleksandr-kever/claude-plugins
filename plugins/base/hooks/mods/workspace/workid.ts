// Pure work-id extraction for the progress resolver and the session title: a ticket key or a kebab slug.

export const KEY = /\b[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}\b/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** First ticket key in a branch name, else null. */
export function keyFromBranch(branch: string | null | undefined): string | null {
  const m = KEY.exec(branch ?? '')
  return m ? m[0] : null
}

/** Last `/` segment of a branch when it is a kebab slug; `HEAD`, empty, `--x` → null. */
export function slugFromBranch(branch: string | null | undefined): string | null {
  const b = (branch ?? '').trim()
  if (!b || b === 'HEAD') return null
  const last = b.slice(b.lastIndexOf('/') + 1)
  return SLUG.test(last) ? last : null
}

/**
 * The tickets a prompt names, the most recent first. A key counts when a Jira `/browse/<KEY>` URL or a
 * project this checkout has worked (`known` = the projects of its `.claude/tasks/<KEY>` dirs) corroborates
 * it: key shape alone is not evidence, as UTF-8, SHA-256 and ISO-8601 match it.
 */
export function ticketKeys(text: string | null | undefined, known: ReadonlySet<string>): string[] {
  const s = text ?? ''
  const out: string[] = []
  const re = new RegExp(KEY.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    const key = m[0]
    const browse = /browse\/$/i.test(s.slice(Math.max(0, m.index - 7), m.index))
    if (browse || known.has(key.slice(0, key.indexOf('-')))) out.push(key)
  }
  return out.reverse()
}

const KEY_WHOLE = new RegExp(`^${KEY.source.replace(/\\b/g, '')}$`)

/** `ABC-1591` → `ABC`; a slug → null. */
export function projectOf(id: string): string | null {
  return KEY_WHOLE.test(id) ? id.slice(0, id.indexOf('-')) : null
}

/** The projects of a checkout's `.claude/tasks/<KEY>` dir names: what corroborates a bare key. */
export function projectsOf(dirs: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const d of dirs) {
    const project = projectOf(d)
    if (project) out.add(project)
  }
  return out
}

/** A ticket key or a kebab slug: the only names the resolver turns into a workspace path. */
export function isWorkId(id: string): boolean {
  return KEY_WHOLE.test(id) || SLUG.test(id)
}
