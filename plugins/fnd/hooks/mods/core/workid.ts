// Pure work-id extraction for the progress resolver. The key shape is
// hooks/session-title.cjs KEY_SRC; the slug rule is scripts/worktree-setup.sh work_id_kind.

export const KEY = /\b[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}\b/
const KEY_ALL = new RegExp(KEY.source, 'g')
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

/** Last ticket key in a text (the most recent mention wins), else null. */
export function keyFromText(text: string | null | undefined): string | null {
  const all = (text ?? '').match(KEY_ALL)
  return all ? all[all.length - 1] ?? null : null
}

/** Every ticket key in a text, the most recent mention first. */
export function keysFromText(text: string | null | undefined): string[] {
  return ((text ?? '').match(KEY_ALL) ?? []).reverse()
}

const KEY_WHOLE = new RegExp(`^${KEY.source.replace(/\\b/g, '')}$`)

/** A ticket key or a kebab slug: the only names the resolver turns into a workspace path. */
export function isWorkId(id: string): boolean {
  return KEY_WHOLE.test(id) || SLUG.test(id)
}
