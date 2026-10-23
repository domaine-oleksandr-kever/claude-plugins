// /base-doctor and the sweeps of base-tmp and of old event-log directories (once per session id; a /clear starts
// a new one). The doctor runs scripts/doctor.cjs for what a node process sees and adds what only a session answers:
// slim's view tool, each MCP server of base's manifest connected, the connectors serving the same tools; then the
// tail of base.events.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { BaseEvent, BaseMainEdits } from '../../types'
import { LOG_TTL_MS, defaultLogRoot, logDir, logLine, pushEvent, spareRoot } from './events.ts'
import type { Disk } from './events.ts'
import { SLIM_MISSING, SLIM_VIEW } from './session.ts'
import { WINDOW_DAYS, dogfoodMode, enabledNames, loginAccount, loginFile, recent, seen } from './dogfood/text.ts'
import { SIGNATURE, twinServers } from './guards/mcp.ts'

export const COMMAND = {
  name: 'base-doctor',
  description: 'Check the base install: node, manifest, slim, MCP servers, base-tmp, event log',
  immediate: true,
} as const
export const MCP_TIMEOUT_MS = 15_000
const TAIL = 10
/** The Figma desktop app serves it locally; base:figma-reader falls back to the REST API without it. */
const LOCAL_SERVER = 'figma-dev-mode'

type Status = 'PASS' | 'FAIL' | 'SKIP' | 'WARN'
export type Row = { status: Status; name: string; detail: string }

const swept = atom({ plugin: 'base', key: 'swept' } as const, null)
const events = atom({ plugin: 'base', key: 'events' } as const, [] as BaseEvent[])
// Written in session.ts (the first prompt's slim check).
const checked = atom({ plugin: 'base', key: 'checked' } as const, null)
// Written in guards/edit.ts: this session's main-loop project-file changes.
const mainEdits = atom({ plugin: 'base', key: 'mainEdits' } as const, null as BaseMainEdits | null)
/** The Domaine plugins whose SessionStart command hook writes a conventions marker. */
const MARKED = ['base', 'fe', 'qa', 'be', 'pm'] as const

type $ = EngineInterface

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

/** Claude Code's session ids: the sweep touches nothing else, so no dotfile or other directory ever goes. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Removes the session directories under `$HOME/.claude/domaine/log` whose newest file is older than 7 days:
 * never this session's, only a session-id name holding nothing but `*.jsonl` and `*.json` files, and never when the root
 * or the directory resolves anywhere but its own spelling (a linked root could point at `~`). `$.fs` has no
 * delete, hence `rm -rf`. A DOMAINE_LOG_DIR is the person's to clean.
 */
async function sweepLogs($: $, sid: string): Promise<void> {
  const root = defaultLogRoot(await $.env.get('HOME'))
  if (!root) return
  if ((await $.fs.stat(root, { resolve: true })).realPath !== root) return
  const now = await $.clock.now()
  for (const d of await $.fs.list(root)) {
    if (d.kind !== 'dir' || d.name === sid || !SESSION_ID.test(d.name)) continue
    const dir = `${root}/${d.name}`
    try {
      const entries = await $.fs.list(dir)
      if (entries.some(f => f.kind !== 'file' || !/\.jsonl?$/.test(f.name))) continue
      const newest = entries.length ? Math.max(...entries.map(f => f.mtimeMs)) : (await $.fs.stat(dir)).mtimeMs
      if (now - newest <= LOG_TTL_MS) continue
      if ((await $.fs.stat(dir, { resolve: true })).realPath === dir) await $.process.run(['rm', '-rf', dir], { timeoutMs: 10_000 })
    } catch {}
  }
}

/**
 * The command on every session start (a reload or a re-enable drops it) and at the first prompt of a new
 * session id; the sweeps of `.claude/base-tmp` past BASE_TMP_TTL hours and of the old event-log session
 * directories once per session id, unawaited.
 */
async function arm($: $, start: boolean): Promise<void> {
  try {
    const sid = String(await $.session.id())
    const fresh = (await read($, swept)) !== sid
    if (start || fresh) await $.command.register(COMMAND).catch(() => undefined)
    if (!fresh) return
    await update($, swept, () => sid)
    const argv = ['node', `${$.plugin.root}/scripts/scratch-hygiene.cjs`, '--sweep', await $.session.root()]
    const ttl = await $.env.get('BASE_TMP_TTL')
    if (ttl) argv.push('--ttl-hours', ttl)
    void $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)
    void sweepLogs($, sid).catch(() => undefined)
  } catch {}
}

const STATUSES = new Set(['PASS', 'FAIL', 'SKIP', 'WARN'])

/** doctor.cjs --json rows, or null when its stdout is not that shape. */
export function parseStatic(stdout: string): Row[] | null {
  try {
    const rows = (JSON.parse(stdout) as { rows?: unknown }).rows
    if (!Array.isArray(rows)) return null
    return rows.filter(
      (r): r is Row => !!r && STATUSES.has(r.status) && typeof r.name === 'string' && typeof r.detail === 'string',
    )
  } catch {
    return null
  }
}

async function staticRows($: $): Promise<Row[]> {
  const root = $.plugin.root
  let r
  try {
    const argv = ['node', `${root}/scripts/doctor.cjs`, '--json', '--root', root, '--project', await $.session.root()]
    const dir = logDir(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), await $.session.id())
    if (dir) argv.push('--log-dir', dir)
    r = await $.process.run(argv, { timeoutMs: 30_000 })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return [{ status: 'SKIP', name: 'static', detail: `scripts/doctor.cjs did not run (${why}): the static checks need node and the Claude Code CLI` }]
  }
  const rows = parseStatic(r.stdout)
  if (rows?.length) return rows
  const why = (r.stderr.trim().split('\n')[0] ?? '') || 'no rows on stdout'
  return [{ status: 'FAIL', name: 'static', detail: `scripts/doctor.cjs exited ${r.exitCode}: ${why}` }]
}

type Marker = { source?: unknown; login?: { label?: unknown; file?: unknown } }

/** The conventions markers the SessionStart command hooks wrote for this session in the log dir or the spare dir, by file stem (`base`, `base.rules`, `fe`, …). */
async function markers($: $, dirs: string[]): Promise<Map<string, Marker>> {
  const out = new Map<string, Marker>()
  for (const stem of [...MARKED, 'base.rules']) {
    for (const dir of dirs) {
      try {
        out.set(stem, JSON.parse(await $.fs.read(`${dir}/conventions.${stem}.json`)) as Marker)
        break
      } catch {}
    }
  }
  return out
}

async function conventionsRow($: $, dirs: string[], found: Map<string, Marker>, prompted: boolean): Promise<Row> {
  if (!dirs.length) return { status: 'SKIP', name: 'conventions', detail: 'no log directory for this session id: the SessionStart command hook markers cannot be read' }
  if (!found.size) {
    return prompted
      ? { status: 'FAIL', name: 'conventions', detail: `not delivered: no SessionStart command hook marker in ${dirs.join(' or ')} (hooks/hooks.json → hooks/conventions.cjs)` }
      : { status: 'SKIP', name: 'conventions', detail: 'no prompt sent yet: send one, then run the doctor again' }
  }
  const enabled = new Set(['base', ...enabledNames(await $.settings.read().catch(() => null))])
  const has = (p: string) => found.has(p) || (p === 'base' && found.has('base.rules'))
  // A claude.ai sandbox's synced plugins have no enabledPlugins entry: a plugin's event log shows it loaded.
  const loaded = new Set<string>()
  for (const p of MARKED) {
    if (enabled.has(p) || has(p)) continue
    if ((await Promise.all(dirs.map(d => $.fs.exists(`${d}/${p}.jsonl`).catch(() => false)))).some(Boolean)) loaded.add(p)
  }
  const want = MARKED.filter(p => enabled.has(p) || loaded.has(p) || has(p))
  const label = (p: string) => (p === 'base' ? `base ${[found.has('base') && 'core', found.has('base.rules') && 'rules'].filter(Boolean).join('+')}` : p)
  const source = (found.get('base') ?? [...found.values()][0])?.source
  const login = found.get('base')?.login
  const who = typeof login?.label === 'string' ? ` (login: ${login.label}, ${typeof login.file === 'string' ? login.file : '?'})` : ''
  const head = `SessionStart command hook (${typeof source === 'string' ? source : '?'}): ${want.filter(has).map(label).join(', ')}${who}`
  const missing = want.filter(p => !has(p))
  return missing.length
    ? { status: 'WARN', name: 'conventions', detail: `${head}; no marker from ${missing.map(p => `${p} (${enabled.has(p) ? 'enabled' : 'loaded'})`).join(', ')}` }
    : { status: 'PASS', name: 'conventions', detail: head }
}

async function liveRows($: $): Promise<Row[]> {
  const rows: Row[] = []
  try {
    rows.push((await $.tool.list()).some(t => t.name === SLIM_VIEW)
      ? { status: 'PASS', name: 'slim-live', detail: `${SLIM_VIEW} registered` }
      : { status: 'FAIL', name: 'slim-live', detail: `${SLIM_MISSING}; base refuses its readers until it is` })
  } catch {
    rows.push({ status: 'SKIP', name: 'slim-live', detail: 'the tool list did not answer' })
  }
  try {
    const sid = String(await $.session.id())
    const prompted = (await read($, checked)) === sid
    const dirs = [logDir(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), sid), logDir(undefined, spareRoot(await $.env.get('TMPDIR')), sid)]
      .filter((d): d is string => d !== null)
    rows.push(await conventionsRow($, dirs, await markers($, dirs), prompted))
  } catch {
    rows.push({ status: 'SKIP', name: 'conventions', detail: 'the state did not answer' })
  }
  return rows
}

const dogfoodOn = async ($: $) => {
  const sw = (await $.env.get('BASE_DOGFOOD')) ?? ''
  if (sw === '1' || sw === '0') return sw === '1'
  const file = loginFile(await $.env.get('HOME'), await $.env.get('CLAUDE_CONFIG_DIR'))
  const account = (await $.env.get('CLAUDE_CODE_ACCOUNT_UUID'))?.trim() || loginAccount(file && (await $.fs.read(file).catch(() => null)))
  return dogfoodMode(sw, account, await $.fs.read(`${$.plugin.root}/dogfood.json`).catch(() => null))
}

/** Dogfood mode's reports of the last 7 days, the home index and this project's folder together; no row when it is off. */
async function defectRows($: $): Promise<Row[]> {
  if (!(await dogfoodOn($))) return []
  try {
    const home = (await $.env.get('HOME'))?.trim() ?? ''
    const index = home.startsWith('/') ? await $.fs.read(`${home.replace(/\/+$/, '')}/.claude/plugin-defects/index.md`).catch(() => '') : ''
    const dir = `${await $.session.root()}/.claude/plugin-defects`
    const names = (await $.fs.list(dir).catch(() => [])).filter(f => f.kind === 'file').map(f => f.name)
    const week = recent(seen(index as string, dir, names), await $.clock.now())
    return [week.length
      ? { status: 'WARN', name: 'defects', detail: `${week.length} in ${WINDOW_DAYS} days, newest ${week[0]!.title} (/base-defects lists them)` }
      : { status: 'PASS', name: 'defects', detail: `none in ${WINDOW_DAYS} days` }]
  } catch {
    return [{ status: 'SKIP', name: 'defects', detail: 'the reports did not answer' }]
  }
}

/** The connection row, naming the servers that are no plugin's and serve the same tools: they take precedence. */
async function connectRow($: $, server: string, names: readonly string[]): Promise<Row> {
  const row = await connect($, server)
  const twins = twinServers(names, server).join(', ')
  if (!twins) return row
  return row.status === 'PASS'
    ? { ...row, detail: `${row.detail} — ${twins} takes precedence` }
    : { status: 'WARN', name: row.name, detail: `${row.detail} — ${twins} serves the same tools and takes precedence` }
}

/** The connectors serving what base's own Atlassian, Notion and Figma servers serve. */
function connectorsRow(names: readonly string[] | null): Row {
  if (names === null) return { status: 'SKIP', name: 'connectors', detail: 'the tool list did not answer' }
  const found = Object.entries(SIGNATURE)
    .map(([server, [, vendor]]) => [vendor, twinServers(names, server).join(', ')] as const)
    .filter(([, twins]) => twins)
  return found.length
    ? { status: 'PASS', name: 'connectors', detail: found.map(([vendor, twins]) => `${vendor}: ${twins}`).join('; ') }
    : { status: 'SKIP', name: 'connectors', detail: "none attached — base's own servers serve Jira, Notion and Figma" }
}

async function connect($: $, server: string): Promise<Row> {
  const name = `mcp:${server}`
  const timeout = $.clock.sleep(MCP_TIMEOUT_MS).then(() => null)
  let r
  try {
    r = await Promise.race([$.mcp.connect(server), timeout])
  } catch (err) {
    return { status: 'FAIL', name, detail: err instanceof Error ? err.message : String(err) }
  }
  if (r === null) return { status: 'FAIL', name, detail: `no answer in ${MCP_TIMEOUT_MS / 1000} s` }
  if (r.isConnected) return { status: 'PASS', name, detail: `connected as ${r.server}` }
  if (server === LOCAL_SERVER) {
    return { status: 'WARN', name, detail: `${r.message} — the Figma desktop app serves it (Dev Mode); base:figma-reader falls back to the REST API` }
  }
  if (r.reason === 'disabled') return { status: 'WARN', name, detail: `turned off: ${r.message}` }
  if (r.reason === 'auth') return { status: 'FAIL', name, detail: `needs sign-in — /mcp, then authenticate ${server}: ${r.message}` }
  return { status: 'FAIL', name, detail: `${r.reason}: ${r.message}` }
}

/** One row per server in base's own manifest, connected in parallel, then the `connectors` row. */
async function mcpRows($: $): Promise<Row[]> {
  const names = await $.tool.list().then(l => l.map(t => t.name), () => null)
  const tail = connectorsRow(names)
  let servers: string[]
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { mcpServers?: unknown }
    servers = manifest.mcpServers && typeof manifest.mcpServers === 'object' ? Object.keys(manifest.mcpServers) : []
  } catch {
    return [{ status: 'FAIL', name: 'mcp', detail: "base's manifest is unreadable: no server to check" }, tail]
  }
  if (!servers.length) return [{ status: 'SKIP', name: 'mcp', detail: 'no mcpServers in the manifest' }, tail]
  return [...(await Promise.all(servers.map(s => connectRow($, s, names ?? [])))), tail]
}

/**
 * A static `slim` FAIL for a slim that is loaded anyway (a `--plugin-dir` load has no install record)
 * reads as a warning: the session has what base needs.
 */
export function reconcile(rows: Row[]): Row[] {
  const live = rows.find(r => r.name === 'slim-live')?.status === 'PASS'
  return rows.map(r =>
    live && r.name === 'slim' && r.status === 'FAIL' && r.detail.startsWith('not installed')
      ? { status: 'WARN', name: 'slim', detail: 'not in installed_plugins.json, yet loaded this session (a --plugin-dir load?)' }
      : r,
  )
}

/** The static `delegate` row plus this session's main-loop file changes under the root (guards/edit.ts counts them). */
export function withMainEdits(rows: Row[], m: BaseMainEdits | null, sid: string): Row[] {
  if (!m || m.sid !== sid) return rows
  const parts = [`${m.n} tool edit(s) in ${m.files.length} file(s)`, `${m.shell} shell write(s)`]
  if (m.refused) parts.push(`${m.refused} refused`)
  if (m.direct) parts.push('direct edits allowed (/base-edit-direct)')
  return rows.map(r => (r.name === 'delegate' && r.status === 'PASS' ? { ...r, detail: `${r.detail}; this session: ${parts.join(', ')}` } : r))
}

export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 48 * 3600) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function summary(rows: Row[]): string {
  const n = { PASS: 0, FAIL: 0, SKIP: 0, WARN: 0 }
  for (const r of rows) n[r.status]++
  return `${n.PASS} passed, ${n.FAIL} failed, ${n.SKIP} skipped${n.WARN ? `, ${n.WARN} warned` : ''}`
}

export function render(root: string, rows: Row[], tail: string[]): string {
  const width = rows.reduce((w, r) => Math.max(w, r.name.length), 0)
  return [
    `base doctor — plugin root: ${root}`,
    ...rows.map(r => `${r.status}  ${r.name.padEnd(width)}  ${r.detail}`),
    `doctor: ${summary(rows)}`,
    '',
    ...tail,
  ].join('\n')
}

async function eventTail($: $): Promise<string[]> {
  if ((await $.env.get('BASE_EVENT_LOG')) === '0') return ['base events: off (BASE_EVENT_LOG=0)']
  const list = await read($, events)
  if (!list.length) return ['base events: none yet']
  const now = await $.clock.now()
  const shown = list.slice(-TAIL)
  return [
    `base events (last ${shown.length} of ${list.length}, newest last):`,
    ...shown.map(ev => `  ${age(now - ev.atMs).padStart(4)}  ${ev.kind.padEnd(9)}  ${ev.text}`),
  ]
}

async function logDoctor($: $, text: string): Promise<void> {
  try {
    if ((await $.env.get('BASE_EVENT_LOG')) === '0') return
    const ev: BaseEvent = { atMs: await $.clock.now(), kind: 'doctor', text }
    await update($, events, l => pushEvent(l, ev))
    await logLine(diskOf($), ev)
  } catch {}
}

export function registerDoctor(on: On): void {
  // Matchers apart from base's other start hooks: one unmatched hook per event per plugin.
  on('session.start', { cwd: /$/ }, async ($, e, next) => {
    const r = await next(e)
    await arm($, true)
    return r
  })

  on('prompt.submit', { text: /$/ }, async ($, e, next) => {
    const r = await next(e)
    await arm($, false)
    return r
  })

  on('command.run', { command: COMMAND.name }, async $ => {
    const [fixed, live, defects, mcp] = await Promise.all([staticRows($), liveRows($), defectRows($), mcpRows($)])
    const rows = withMainEdits(reconcile([...fixed, ...live, ...defects, ...mcp]), await read($, mainEdits).catch(() => null), String(await $.session.id()))
    const tail = await eventTail($)
    await logDoctor($, summary(rows))
    return { text: render($.plugin.root, rows, tail) }
  })
}
