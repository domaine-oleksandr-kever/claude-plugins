// The edit-delegation guard: in the main loop (no agentId), a Write / Edit / NotebookEdit of a file under the session
// root but outside `<root>/.claude/` is refused with a pointer to Agent(model: X) while the rules marker names X; a
// main-loop Bash command that recognisably writes such a file is counted, never refused. Escapes: the session already on
// X or cheaper, `/base-edit-direct` for this session id, BASE_GUARD=0. No marker or no `edit.model` = no edit guard, no
// count. Apart from that, whenever base runs: a main-loop read of a drafter's draft (`.claude/tasks/<id>/steps-to-test.md`,
// `pr-body.md`, `jira-comment.md`: Read, Grep, slim view, or a Bash command naming one outside drafter-check /
// gh --body-file / test / ls) is refused on any model; only BASE_GUARD=0 lifts it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { BaseEvent, BaseEventKind, BaseMainEdits } from '../../../types'
import { markerPaths } from '../conventions.ts'
import { bare, logLine, pushEvent } from '../events.ts'
import type { Disk } from '../events.ts'

export const COMMAND = {
  name: 'base-edit-direct',
  description: 'Allow direct project-file edits in this session (base edit delegation)',
  immediate: true,
} as const

const TOOLS = /^(Edit|Write|NotebookEdit)$/
/** Twin of scripts/edit-delegation.cjs FAMILIES: cheapest first. */
export const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable']
const MODELS = ['opus', 'sonnet', 'haiku']
// conservative: a shell command that writes a file in place or by redirection (`=>` and `->` are no redirection)
export const SHELL_WRITE = /\bsed\b[^|;&\n]*\s-[a-zA-Z]*i|\bperl\s+-[a-zA-Z]*i|(?<![=-])>>?\s*[^\s&|>=]|\btee\s|\bgit\s+apply\b|\bpatch\s/
const SHELL_SKIP = /\.claude\/|\/dev\/|\/tmp\/|\$TMPDIR/
/** A drafter's draft in a task workspace: the main session shows its path and never reads it. */
export const DRAFT = /\/\.claude\/tasks\/[^/]+\/(steps-to-test|pr-body|jira-comment)\.md$/
const DRAFT_NAME = /(steps-to-test|pr-body|jira-comment)\.md/
// a draft named in a shell command: a workspace path, or a variable's (`$W/pr-body.md`)
const DRAFT_ARG = /(?:\.claude\/tasks\/[^\s'"/]+|\$\{?\w+\}?)\/(?:steps-to-test|pr-body|jira-comment)\.md\b/
// the sanctioned consumers of a draft path: the checker, gh's --body-file, an existence test, a listing
const DRAFT_OK = /drafter-check\.cjs\b|\bgh\s+pr\s+(?:create|edit)\b[^\n]*--body-file|^\s*(?:test|\[)\s+-[sef]\s|^\s*ls\b/
const CHECKER = /drafter-check\.cjs\b/
// a segment that only assigns variables (`P=<draft>`, `export P="$W/pr-body.md"`); a `$(…)` or backtick value runs a command
const VALUE = String.raw`(?:"(?:[^"\`$]|\$(?!\())*"|'[^']*'|(?:[^\s'"\`$;|&]|\$(?!\())*)`
const ASSIGN_ONLY = new RegExp(String.raw`^\s*(?:(?:export|local|declare|readonly)\s+)?\w+=${VALUE}(?:\s+\w+=${VALUE})*\s*$`)
const ASSIGN = new RegExp(String.raw`(\w+)=(${VALUE})`, 'g')
// a heredoc start (`<<EOF`, `<<-'EOF'`), not a here-string (`<<<`)
const HEREDOC = /(?<!<)<<-?\s*(['"]?)(\w+)\1/
const VIEW_TOOL = 'mcp__slim__view'
const FILES_CAP = 50

export const editRefusal = (model: string) =>
  `base edit delegation: this session hands project-file changes to Agent(model: "${model}") — brief one agent with ` +
  `the files, the exact change and the test, then review its diff. Allowed directly only when this session already runs ` +
  `on ${model} or a cheaper family (haiku < sonnet < opus < fable) — say which model you run on and call again after ` +
  `the developer runs /base-edit-direct — or for files under .claude/. BASE_EDIT_MODEL=0 turns delegation off.`

export const draftRefusal = (rel: string) =>
  `base drafter rule: ${rel} is a drafter agent's draft — never read, quote or paraphrase it. Show its path; a change ` +
  `goes to the same agent via SendMessage, and jira-writer / gh pr create --body-file take the path. Refused on ` +
  `any model and after /base-edit-direct too; only BASE_GUARD=0 lifts it.`

const mainEdits = atom({ plugin: 'base', key: 'mainEdits' } as const, null as BaseMainEdits | null)
const delegation = atom({ plugin: 'base', key: 'delegation' } as const, null as { sid: string; model: string | null } | null)
const events = atom({ plugin: 'base', key: 'events' } as const, [] as BaseEvent[])

type $ = EngineInterface

/** `claude-opus-5-5[1m]` → `opus`; null for no id. */
export function modelFamily(id: string | null | undefined): string | null {
  return typeof id === 'string' && id ? (id.replace(/^claude-/, '').replace(/\[1m\]$/, '').split('-')[0] ?? null) : null
}

/** True when `family` is a known family no dearer than `model`. */
export const atOrBelow = (family: string | null, model: string): boolean =>
  family !== null && FAMILIES.includes(family) && FAMILIES.indexOf(family) <= FAMILIES.indexOf(model)

/** An absolute path under `root`, outside `<root>/.claude/`; a relative one resolves against root. */
export function inScope(path: string, root: string): boolean {
  const p = path.startsWith('/') ? path : `${root}/${path}`
  return p.startsWith(`${root}/`) && !p.startsWith(`${root}/.claude/`)
}

/** The rules marker's `edit.model` (opus, sonnet or haiku), else null. */
export function markerModel(text: string): string | null {
  try {
    const m = (JSON.parse(text) as { edit?: { model?: unknown } }).edit?.model
    return typeof m === 'string' && MODELS.includes(m) ? m : null
  } catch {
    return null
  }
}

const empty = (sid: string): BaseMainEdits => ({ sid, n: 0, files: [], shell: 0, refused: 0, direct: false })
const mine = (v: BaseMainEdits | null, sid: string): BaseMainEdits => (v && v.sid === sid ? v : empty(sid))

/** events.ts's file writer reaches `$` through this: the validator follows `$` only within one file. */
function diskOf($: $): Disk {
  return {
    session: () => $.session.id(),
    home: () => $.env.get('HOME'),
    override: () => $.env.get('DOMAINE_LOG_DIR'),
    manifest: () => $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    toast: text => $.ui.toast(text),
  }
}

async function logEvent($: $, kind: BaseEventKind, text: string): Promise<void> {
  try {
    if ((await $.env.get('BASE_EVENT_LOG')) === '0') return
    const ev: BaseEvent = { atMs: await $.clock.now(), kind, text }
    await update($, events, l => pushEvent(l, ev))
    await logLine(diskOf($), ev)
  } catch {}
}

/** The delegate model of session `sid`, read once from its rules marker; no marker caches null. */
async function modelFor($: $, sid: string): Promise<string | null> {
  const known = await read($, delegation)
  if (known && known.sid === sid) return known.model
  let model: string | null = null
  for (const file of markerPaths(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), await $.env.get('TMPDIR'), sid, 'base.rules')) {
    const text = await $.fs.read(file).catch(() => null)
    if (text === null) continue
    model = markerModel(text)
    break
  }
  await update($, delegation, () => ({ sid, model }))
  return model
}

/** True when a shell command reads a draft: some segment names one and is not a sanctioned consumer. */
export function shellReadsDraft(command: string): boolean {
  const vars = new Map<string, string>()
  const expand = (s: string) => s.replace(/\$\{?(\w+)\}?/g, (m, v: string) => vars.get(v) ?? m)
  return withoutHeredocs(command).split(/&&|\|\||[;\n]/).some(raw => {
    // a draft path parked in a variable is no read; its later use is matched with the value substituted
    if (ASSIGN_ONLY.test(raw)) {
      for (const [, name, value] of raw.matchAll(ASSIGN)) vars.set(name, expand(value.replace(/^(['"])(.*)\1$/, '$2')))
      return false
    }
    const cmd = expand(raw)
    const stages = cmd.split('|')
    // a pipeline into the checker: it prints counts only (a drafter's receipt piped in)
    if (CHECKER.test(stages[stages.length - 1])) return false
    return stages.some(seg => DRAFT_ARG.test(seg) && !DRAFT_OK.test(seg))
  })
}

/** The command without its heredoc bodies: they are stdin data, not commands. */
function withoutHeredocs(command: string): string {
  const out: string[] = []
  let end: string | null = null
  for (const line of command.split('\n')) {
    if (end !== null) {
      if (line.trim() === end) end = null
      continue
    }
    out.push(line)
    const m = HEREDOC.exec(line)
    if (m) end = m[2]
  }
  return out.join('\n')
}

/** The session's own escapes: /base-edit-direct, BASE_GUARD=0, a model at or below the delegate's. */
async function escaped($: $, cur: BaseMainEdits, model: string): Promise<boolean> {
  if (cur.direct || (await $.env.get('BASE_GUARD')) === '0') return true
  const own = await $.session.model().catch(() => null)
  return atOrBelow(modelFamily(own), model)
}

const rel = (path: string, root: string) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)

/** The draft deny for a main-loop read, on any model and with or without a rules marker; `shown` names the path or command. */
async function draftDeny($: $, tool: string, shown: string): Promise<{ deny: string } | null> {
  if ((await $.env.get('BASE_GUARD')) === '0') return null
  const sid = String(await $.session.id())
  await update($, mainEdits, v => ({ ...mine(v, sid), refused: mine(v, sid).refused + 1 }))
  await logEvent($, 'guard', `${tool}: main session — ${shown} is a drafter's draft`)
  return { deny: draftRefusal(shown) }
}


/** The command on every session start and at the first prompt of a new session id. */
async function arm($: $, start: boolean): Promise<void> {
  try {
    const sid = String(await $.session.id())
    const known = await read($, mainEdits)
    if (start || known?.sid !== sid) await $.command.register(COMMAND).catch(() => undefined)
  } catch {}
}

export function registerEditGuard(on: On): void {
  // Matchers apart from base's other start hooks: one unmatched hook per event per plugin.
  on('session.start', { cwd: /(?:)$/ }, async ($, e, next) => {
    const r = await next(e)
    await arm($, true)
    return r
  })

  on('prompt.submit', { text: /(?:)$/ }, async ($, e, next) => {
    const r = await next(e)
    await arm($, false)
    return r
  })

  // A developer's gesture only: a run another plugin or a delivered message queued grants nothing.
  on('command.run', { command: COMMAND.name }, async ($, e) => {
    const kind = e.origin.kind
    if (kind !== 'composer' && kind !== 'bridge' && kind !== 'sdk') return { text: 'base: /base-edit-direct is the developer\'s to run at the prompt' }
    const sid = String(await $.session.id())
    const model = await modelFor($, sid).catch(() => null)
    await update($, mainEdits, v => ({ ...mine(v, sid), direct: true }))
    return {
      text: model
        ? `base: direct edits allowed for this session (edit delegation: ${model}); /clear starts over.`
        : 'base: direct edits allowed for this session (edit delegation is off here); /clear starts over.',
    }
  })

  on('tool.call', { tool: TOOLS }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (e.tool !== 'Edit' && e.tool !== 'Write' && e.tool !== 'NotebookEdit') return next(e)
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    let root: string, sid: string, model: string | null, cur: BaseMainEdits
    try {
      root = await $.session.root()
      if (typeof path !== 'string' || !inScope(path, root)) return next(e)
      sid = String(await $.session.id())
      model = await modelFor($, sid)
      if (!model) return next(e)
      cur = mine(await read($, mainEdits), sid)
      if (!(await escaped($, cur, model))) {
        const m = model
        await update($, mainEdits, v => ({ ...mine(v, sid), refused: mine(v, sid).refused + 1 }))
        await logEvent($, 'guard', `${e.tool}: main session — delegate to Agent(model: ${m})`)
        return { deny: editRefusal(m) }
      }
    } catch {
      return next(e)
    }
    const r = await next(e)
    if (r.deny !== undefined || r.isError) return r
    try {
      const abs = path.startsWith('/') ? path : `${root}/${path}`
      let fresh = false
      await update($, mainEdits, v => {
        const c = mine(v, sid)
        fresh = !c.files.includes(abs)
        return { ...c, n: c.n + 1, files: fresh ? [...c.files, abs].slice(-FILES_CAP) : c.files }
      })
      if (fresh) await logEvent($, 'delegate', bare(`main-session ${e.tool} of ${rel(abs, root)} (delegation: ${model}${cur.direct ? ', direct' : ''})`))
    } catch {}
    return r
  })

  on('tool.call', { tool: /^(Read|Grep)$/ }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    try {
      const args = e as unknown as Record<string, unknown>
      const raw = e.tool === 'Read' ? args.file_path : args.path
      const root = await $.session.root()
      const path = typeof raw === 'string' ? (raw.startsWith('/') ? raw : `${root}/${raw}`) : ''
      const glob = e.tool === 'Grep' && typeof args.glob === 'string' ? args.glob : ''
      if (!DRAFT.test(path) && !(path.includes('/.claude/tasks/') && DRAFT_NAME.test(glob))) return next(e)
      const r = await draftDeny($, e.tool, rel(path, root))
      return r ?? next(e)
    } catch {
      return next(e)
    }
  })

  on('tool.call', { tool: VIEW_TOOL }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    try {
      const args = e as unknown as Record<string, unknown>
      const root = await $.session.root()
      const raw = typeof args.path === 'string' ? args.path : ''
      const path = raw.startsWith('/') ? raw : `${root}/${raw}`
      if (!DRAFT.test(path)) return next(e)
      return (await draftDeny($, 'view', rel(path, root))) ?? next(e)
    } catch {
      return next(e)
    }
  })

  // Apart from the shell-write counter below: a narrower `command` matcher of its own.
  on('tool.call', { tool: 'Bash', command: DRAFT_NAME }, async ($, e, next) => {
    if (e.agentId !== undefined || e.tool !== 'Bash') return next(e)
    try {
      if (!shellReadsDraft(e.command)) return next(e)
      const m = DRAFT_ARG.exec(e.command)
      const root = await $.session.root()
      return (await draftDeny($, 'Bash', m ? rel(m[0], root) : 'a draft')) ?? next(e)
    } catch {
      return next(e)
    }
  })

  // Matched apart from progress.ts's Bash hook: the `command` field narrows this one.
  on('tool.call', { tool: 'Bash', command: SHELL_WRITE }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || e.tool !== 'Bash' || r.deny !== undefined || r.isError) return r
    try {
      if (SHELL_SKIP.test(e.command)) return r
      const sid = String(await $.session.id())
      if (!(await modelFor($, sid))) return r
      await update($, mainEdits, v => ({ ...mine(v, sid), shell: mine(v, sid).shell + 1 }))
    } catch {}
    return r
  })
}
