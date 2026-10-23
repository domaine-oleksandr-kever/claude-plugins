import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { NOTES, NOW, PEEK, TASKS, addWorkspace, peek, progressMd, start, submit, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const agent = ($: any) => $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'general-purpose' })
/** A Read under the branch's workspace: the session's own from then on. */
const touch = ($: any) => $.tool.call({ tool: 'Read', file_path: progressMd('ABC-1591') })
const background = ($: any, agentId: string) =>
  $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'general-purpose', reply: { status: 'async_launched', agentId, description: 'd', prompt: 'p', outputFile: '/tmp/o' } })
const agentDone = ($: any, agentId: string) => $.turn.complete({ agentId, turnId: 't', answer: '', durationMs: 0, isAborted: false, reason: 'answer' })
const NOTES_MD = `${TASKS}/ABC-1591/notes.md`
const MIN = 60_000
const NUDGE = 'workspace stale 21 min: save findings to .claude/tasks/ABC-1591/notes.md before answering'
const LOG = '/log'
const STATE = `${LOG}/s1/autosave-state.json`
const MARKER = `${LOG}/s1/compact-marker.json`
const state = (w: any) => JSON.parse(w.files[STATE]?.text ?? 'null')
/** The mirror's half of the Stop hook's test: stale, unwritten since the turn began, savable work in it (the rest is tests/hooks-sim.sh). */
const blocks = (w: any) => {
  const s = state(w)
  return !!s && s.stale && s.mtimeMs < s.startMs && s.lastSavableMs >= s.startMs
}

/** A workspace written a minute before the start and read, an agent returned, then 20 min without a write. */
async function staleWorld($: any, on: On, env: Record<string, string> = {}) {
  const ctx = world(on, { env: { DOMAINE_LOG_DIR: LOG, ...env } })
  addWorkspace(ctx.w, 'ABC-1591')
  await start($)
  await touch($)
  await agent($)
  await ctx.clock.advance(20 * MIN)
  return ctx
}

const lastContext = (calls: any) => calls.prompts[calls.prompts.length - 1]?.context ?? []

describe('nudge', () => {
  t('a stale workspace adds one context line to the prompt, once per stale period', async ($, on) => {
    const { w, calls, clock } = await staleWorld($, on)
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([NUDGE])
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([])
    w.files[NOTES_MD] = { text: NOTES, mtimeMs: clock.now() }
    await clock.advance(30_000)
    await agent($)
    await clock.advance(21 * MIN)
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([NUDGE])
  })

  t('a notification or a peer message gets no line; the person\'s next prompt does', async ($, on) => {
    const { calls } = await staleWorld($, on)
    for (const kind of ['task-notification', 'peer', 'scheduled-trigger']) {
      await submit($, 'done', kind)
      expect(lastContext(calls)).toEqual([])
    }
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([NUDGE])
  })

  t('a fresh workspace adds none', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    await agent($)
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([])
  })

  t('no workspace adds none', async ($, on) => {
    const { calls, clock } = world(on, { branch: 'main' })
    await start($)
    await agent($)
    await clock.advance(25 * MIN)
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([])
  })

  t('a workspace guessed from the newest progress.md gets no line and no block until this session writes into it', async ($, on) => {
    const { w, calls, clock } = world(on, { branch: 'main', env: { DOMAINE_LOG_DIR: LOG } })
    addWorkspace(w, 'ABC-1591')
    await start($)
    expect((await peek($)).progress).toMatchObject({ workId: 'ABC-1591', guessed: true })
    await agent($)
    await clock.advance(25 * MIN)
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([])
    expect(blocks(w)).toBe(false)
    await $.tool.call({ tool: 'Write', file_path: NOTES_MD, content: NOTES })
    expect((await peek($)).progress).toMatchObject({ guessed: false })
    await agent($)
    await clock.advance(25 * MIN)
    await submit($, 'go on')
    // the stub stamps a Write at NOW + 1, 50 min before this prompt
    expect(lastContext(calls)).toEqual([NUDGE.replace('21 min', '49 min')])
  })

  t('a workspace matched by the branch gets no line and no block until this session reads under it', async ($, on) => {
    const { w, calls, clock } = world(on, { env: { DOMAINE_LOG_DIR: LOG } })
    addWorkspace(w, 'ABC-1591')
    await start($)
    expect((await peek($)).progress).toMatchObject({ workId: 'ABC-1591', guessed: true })
    await agent($)
    await clock.advance(25 * MIN)
    await submit($, 'run /base-doctor, change nothing')
    expect(lastContext(calls)).toEqual([])
    await agent($)
    expect(blocks(w)).toBe(false)
    await $.tool.call({ tool: 'Read', file_path: `${TASKS}/ABC-1592/progress.md` })
    expect((await peek($)).progress).toMatchObject({ guessed: true })
    await touch($)
    expect((await peek($)).progress).toMatchObject({ guessed: false })
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([NUDGE.replace('21 min', '26 min')])
    await agent($)
    expect(blocks(w)).toBe(true)
  })

  t('a Bash command naming the workspace dir adopts it; one naming the tasks dir alone does not', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls .claude/tasks/' })
    expect((await peek($)).progress).toMatchObject({ guessed: true })
    await $.tool.call({ tool: 'Bash', command: 'cat .claude/tasks/ABC-1591/notes.md' })
    expect((await peek($)).progress).toMatchObject({ guessed: false })
  })

  t('BASE_AUTOSAVE=0 adds none', async ($, on) => {
    const { calls } = await staleWorld($, on, { BASE_AUTOSAVE: '0' })
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([])
  })

  t('a context window 85 % full shortens the stale window to 5 min', async ($, on) => {
    const { w, calls, clock } = world(on, { ctxPct: 84 })
    addWorkspace(w, 'ABC-1591')
    await start($)
    await touch($)
    await agent($)
    await clock.advance(6 * MIN)
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([])
    w.ctxPct = 85
    await clock.advance(30_000)
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([NUDGE.replace('21 min', '7 min')])
  })
})

describe('autosave-state.json', () => {
  t('the mirror carries the workspace, its staleness and the turn; a turn with savable work and no write is blockable', async ($, on) => {
    const { w, clock } = await staleWorld($, on)
    await submit($, 'go on')
    await agent($)
    await clock.advance(MIN)
    expect(state(w)).toEqual({
      sid: 's1', workId: 'ABC-1591', wsDir: `${TASKS}/ABC-1591`, stale: true, mtimeMs: NOW - MIN,
      lastSavableMs: NOW + 20 * MIN, agentsSince: 2, editsSince: 0, turn: 1, startMs: NOW + 20 * MIN,
    })
    expect(blocks(w)).toBe(true)
  })

  t('a prompt delivered into the running turn keeps that turn: the turn and its start stay', async ($, on) => {
    const { w, clock } = await staleWorld($, on)
    await submit($, 'go on')
    await agent($)
    await clock.advance(MIN)
    await $.prompt.submit({ text: 'also this', wait: false, origin: { kind: 'composer' }, turnId: 't1' })
    expect(state(w)).toMatchObject({ turn: 1, startMs: NOW + 20 * MIN })
    expect(blocks(w)).toBe(true)
  })

  t('a turn with no savable work of its own is never blockable, however long the workspace stayed stale', async ($, on) => {
    const { w, clock } = await staleWorld($, on)
    for (let i = 0; i < 4; i++) {
      await submit($, 'run /base-doctor, change nothing')
      expect(blocks(w)).toBe(false)
      await clock.advance(15 * MIN)
    }
  })

  t('a background agent: its launch is no savable work; its turn.complete is, in the turn it lands in', async ($, on) => {
    const { w, clock } = await staleWorld($, on)
    await submit($, 'go on')
    await background($, 'bg1')
    expect(blocks(w)).toBe(false)
    await clock.advance(MIN)
    await submit($, 'go on')
    await agentDone($, 'bg1')
    expect(blocks(w)).toBe(true)
  })

  t('a write to the workspace in the turn clears it', async ($, on) => {
    const { w } = await staleWorld($, on)
    await submit($, 'go on')
    await agent($)
    await $.tool.call({ tool: 'Write', file_path: NOTES_MD, content: NOTES })
    expect(state(w)).toMatchObject({ stale: false })
    expect(blocks(w)).toBe(false)
  })

  t('a context window 85 % full turns the mirror stale after 5 min', async ($, on) => {
    const { w, clock } = world(on, { ctxPct: 90, env: { DOMAINE_LOG_DIR: LOG } })
    addWorkspace(w, 'ABC-1591')
    await start($)
    await touch($)
    await submit($, 'go on')
    await agent($)
    await clock.advance(6 * MIN)
    expect(blocks(w)).toBe(true)
  })

  t('no workspace: workId null, never blockable', async ($, on) => {
    const { w, clock } = world(on, { branch: 'main', env: { DOMAINE_LOG_DIR: LOG } })
    await start($)
    await clock.advance(25 * MIN)
    await submit($, 'go on')
    await agent($)
    expect(state(w)).toMatchObject({ workId: null, wsDir: null, stale: false })
  })

  t('written only when it changed', async ($, on) => {
    const { calls, clock } = await staleWorld($, on)
    await submit($, 'go on')
    const n = calls.writes.filter(x => x.path === STATE).length
    await clock.advance(5 * MIN)
    expect(calls.writes.filter(x => x.path === STATE)).toHaveLength(n)
  })

  t('BASE_AUTOSAVE=0 writes no mirror', async ($, on) => {
    const { w, calls } = await staleWorld($, on, { BASE_AUTOSAVE: '0' })
    await submit($, 'go on')
    await agent($)
    expect(calls.writes.filter(x => x.path === STATE)).toEqual([])
    expect(w.files[STATE]).toBeUndefined()
  })
})

describe('compact-marker.json', () => {
  /** What the PreCompact command hook leaves: one line on notes.md, and the marker naming its write and the time before it. */
  const compact = (w: any, at: number, priorMs = NOW - MIN) => {
    w.files[NOTES_MD] = { text: '- compact: workspace stale\n', mtimeMs: at }
    w.files[MARKER] = { text: JSON.stringify({ workId: 'ABC-1591', notesMs: at, priorMs }), mtimeMs: at }
  }

  t('the marker line is no save: the workspace stays stale and the next prompt gets the line again, once', async ($, on) => {
    const { w, calls, clock } = await staleWorld($, on)
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([NUDGE])
    compact(w, clock.now())
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([NUDGE])
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([])
    await clock.advance(30_000)
    expect((await peek($)).progress).toMatchObject({ mtimeMs: NOW - MIN, stale: true })
    expect((await peek($)).compactMarker).toEqual({ workId: 'ABC-1591', notesMs: NOW + 20 * MIN, priorMs: NOW - MIN })
  })

  t('the tick adopts it too: the progress mtime stays the one before the marker', async ($, on) => {
    const { w, clock } = await staleWorld($, on)
    compact(w, clock.now())
    await clock.advance(30_000)
    expect((await peek($)).progress).toMatchObject({ mtimeMs: NOW - MIN, stale: true })
    expect(state(w)).toMatchObject({ stale: true, mtimeMs: NOW - MIN })
  })

  t('a notes.md written after the marker is a save', async ($, on) => {
    const { w, clock } = await staleWorld($, on)
    compact(w, clock.now())
    await clock.advance(30_000)
    w.files[NOTES_MD] = { text: NOTES, mtimeMs: clock.now() }
    await clock.advance(30_000)
    expect((await peek($)).progress).toMatchObject({ mtimeMs: NOW + 20 * MIN + 30_000, stale: false })
  })

  t('a marker that is no JSON, or lacks a field, is ignored', async ($, on) => {
    const { w, clock } = await staleWorld($, on)
    w.files[NOTES_MD] = { text: NOTES, mtimeMs: clock.now() }
    w.files[MARKER] = { text: '{"workId":"ABC-1591","notesMs":"x"}', mtimeMs: clock.now() }
    await clock.advance(30_000)
    expect((await peek($)).compactMarker).toBeNull()
    expect((await peek($)).progress).toMatchObject({ stale: false })
  })
})
