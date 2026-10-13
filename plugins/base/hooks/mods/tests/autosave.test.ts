import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { NOTES, NOW, PEEK, TASKS, addWorkspace, peek, progressMd, start, submit, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const agent = ($: any) => $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'general-purpose' })
const stop = ($: any, stop_hook_active = false) => $.classic.Stop({ stop_hook_active } as any)
/** A Read under the branch's workspace: the session's own from then on. */
const touch = ($: any) => $.tool.call({ tool: 'Read', file_path: progressMd('ABC-1591') })
const background = ($: any, agentId: string) =>
  $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'general-purpose', reply: { status: 'async_launched', agentId, description: 'd', prompt: 'p', outputFile: '/tmp/o' } })
const subagentStop = ($: any, agent_id: string) => $.classic.SubagentStop({ agent_id, stop_hook_active: false, agent_transcript_path: '', agent_type: 'general-purpose' } as any)
const NOTES_MD = `${TASKS}/ABC-1591/notes.md`
const MIN = 60_000
const NUDGE = 'workspace stale 21 min: save findings to .claude/tasks/ABC-1591/notes.md before answering'
const BLOCK = 'save interim findings to the workspace (.claude/tasks/ABC-1591/notes.md), then stop'

/** A workspace written a minute before the start and read, an agent returned, then 20 min without a write. */
async function staleWorld($: any, on: On, env: Record<string, string> = {}) {
  const ctx = world(on, { env })
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
    const { w, calls, clock } = world(on, { branch: 'main' })
    addWorkspace(w, 'ABC-1591')
    await start($)
    expect((await peek($)).progress).toMatchObject({ workId: 'ABC-1591', guessed: true })
    await agent($)
    await clock.advance(25 * MIN)
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([])
    expect((await stop($)).block).toBeUndefined()
    await $.tool.call({ tool: 'Write', file_path: NOTES_MD, content: NOTES })
    expect((await peek($)).progress).toMatchObject({ guessed: false })
    await agent($)
    await clock.advance(25 * MIN)
    await submit($, 'go on')
    // the stub stamps a Write at NOW + 1, 50 min before this prompt
    expect(lastContext(calls)).toEqual([NUDGE.replace('21 min', '49 min')])
  })

  t('a workspace matched by the branch gets no line and no block until this session reads under it', async ($, on) => {
    const { w, calls, clock } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    expect((await peek($)).progress).toMatchObject({ workId: 'ABC-1591', guessed: true })
    await agent($)
    await clock.advance(25 * MIN)
    await submit($, 'run /base-doctor, change nothing')
    expect(lastContext(calls)).toEqual([])
    await agent($)
    expect((await stop($)).block).toBeUndefined()
    await $.tool.call({ tool: 'Read', file_path: `${TASKS}/ABC-1592/progress.md` })
    expect((await peek($)).progress).toMatchObject({ guessed: true })
    await touch($)
    expect((await peek($)).progress).toMatchObject({ guessed: false })
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([NUDGE.replace('21 min', '26 min')])
    await agent($)
    expect((await stop($)).block).toBe(BLOCK)
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

describe('turn-end save', () => {
  t('a turn with savable work and no workspace write is blocked once; stop_hook_active passes', async ($, on) => {
    const { clock } = await staleWorld($, on)
    await submit($, 'go on')
    await agent($)
    await clock.advance(MIN)
    expect(await stop($)).toEqual({ block: BLOCK })
    expect(await stop($, true)).toEqual({})
  })

  t('a prompt delivered into the running turn keeps that turn\'s savable work', async ($, on) => {
    const { clock } = await staleWorld($, on)
    await submit($, 'go on')
    await agent($)
    await clock.advance(MIN)
    await $.prompt.submit({ text: 'also this', wait: false, origin: { kind: 'composer' }, turnId: 't1' })
    expect(await stop($)).toEqual({ block: BLOCK })
  })

  t('a turn with no savable work of its own is never blocked, however long the workspace stayed stale', async ($, on) => {
    const { clock } = await staleWorld($, on)
    for (let i = 0; i < 6; i++) {
      await submit($, 'run /base-doctor, change nothing')
      expect(await stop($)).toEqual({})
      await clock.advance(15 * MIN)
    }
  })

  t('a turn that only launched background agents is not blocked; their stop is savable work of the turn it lands in', async ($, on) => {
    const { clock } = await staleWorld($, on)
    await submit($, 'go on')
    await background($, 'bg1')
    expect(await stop($)).toEqual({})
    await clock.advance(MIN)
    await submit($, 'go on')
    await subagentStop($, 'bg1')
    expect(await stop($)).toEqual({ block: BLOCK })
  })

  t('chat turns with no savable work never block', async ($, on) => {
    const ctx = world(on)
    addWorkspace(ctx.w, 'ABC-1591')
    await start($)
    await touch($)
    for (let i = 0; i < 8; i++) {
      await ctx.clock.advance(15 * MIN)
      await submit($, 'just a question')
      expect(await stop($)).toEqual({})
    }
  })

  t('at most once per 3 turns', async ($, on) => {
    await staleWorld($, on)
    const turn = async () => {
      await submit($, 'go on')
      await agent($)
      return (await stop($)).block ?? null
    }
    expect(await turn()).toBe(BLOCK)
    expect(await turn()).toBeNull()
    expect(await turn()).toBeNull()
    expect(await turn()).toBe(BLOCK)
  })

  t('no block when the turn wrote the workspace, or did nothing savable, or the workspace is fresh', async ($, on) => {
    const { w, clock } = await staleWorld($, on)
    await submit($, 'go on')
    await agent($)
    w.files[NOTES_MD] = { text: NOTES, mtimeMs: clock.now() }
    expect(await stop($)).toEqual({})
    await clock.advance(25 * MIN)
    await submit($, 'just a question')
    expect(await stop($)).toEqual({})
    await submit($, 'go on')
    await agent($)
    w.files[NOTES_MD] = { text: NOTES, mtimeMs: clock.now() - 5 * MIN }
    expect(await stop($)).toEqual({})
  })

  t('a context window 85 % full blocks a stop after 5 min', async ($, on) => {
    const { w, clock } = world(on, { ctxPct: 90 })
    addWorkspace(w, 'ABC-1591')
    await start($)
    await touch($)
    await submit($, 'go on')
    await agent($)
    await clock.advance(6 * MIN)
    expect((await stop($)).block).toBe(BLOCK)
  })

  t('no workspace: never blocked', async ($, on) => {
    const { clock } = world(on, { branch: 'main' })
    await start($)
    await clock.advance(25 * MIN)
    await submit($, 'go on')
    await agent($)
    expect(await stop($)).toEqual({})
  })

  t('BASE_AUTOSAVE=0 never blocks', async ($, on) => {
    await staleWorld($, on, { BASE_AUTOSAVE: '0' })
    await submit($, 'go on')
    await agent($)
    expect(await stop($)).toEqual({})
  })
})

describe('auto-compact marker', () => {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

  t('a stale workspace gets one pointer line appended to notes.md', async ($, on) => {
    const ctx = world(on)
    addWorkspace(ctx.w, 'ABC-1591')
    ctx.w.files[NOTES_MD] = { text: '## log\n- one', mtimeMs: NOW - 2 * MIN }
    await start($)
    await touch($)
    await agent($)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/sections/header.liquid', old_string: 'a', new_string: 'b' })
    await ctx.clock.advance(20 * MIN)
    await $.classic.PreCompact({ trigger: 'auto', custom_instructions: null } as any)
    expect(ctx.w.files[NOTES_MD]?.text).toBe(
      `## log\n- one\n- ${day(NOW)} compact: workspace stale 21 min; since then 1 reader agents, 1 edits\n`,
    )
  })

  t('the marker is no save: the workspace stays stale and the next prompt gets the line again', async ($, on) => {
    const ctx = world(on)
    addWorkspace(ctx.w, 'ABC-1591')
    await start($)
    await touch($)
    await agent($)
    await ctx.clock.advance(20 * MIN)
    await submit($, 'go on')
    expect(lastContext(ctx.calls)).toEqual([NUDGE])
    await $.classic.PreCompact({ trigger: 'auto', custom_instructions: null } as any)
    expect(ctx.calls.writes.map(x => x.path)).toEqual([NOTES_MD])
    await ctx.clock.advance(30_000)
    expect((await peek($)).progress).toMatchObject({ mtimeMs: NOW - MIN, stale: true })
    await submit($, 'go on')
    expect(lastContext(ctx.calls)).toEqual([NUDGE])
    await submit($, 'go on')
    await agent($)
    expect((await stop($)).block).toBe(BLOCK)
  })

  t('a notes.md that exists but cannot be read is left alone', async ($, on) => {
    const ctx = world(on)
    addWorkspace(ctx.w, 'ABC-1591')
    ctx.w.files[NOTES_MD] = { text: 'x'.repeat(100), mtimeMs: NOW - 2 * MIN }
    ctx.w.readFails = [NOTES_MD]
    await start($)
    await touch($)
    await agent($)
    await ctx.clock.advance(20 * MIN)
    await $.classic.PreCompact({ trigger: 'auto', custom_instructions: null } as any)
    expect(ctx.calls.writes).toEqual([])
  })

  t('BASE_AUTOSAVE=0 writes nothing', async ($, on) => {
    const { calls } = await staleWorld($, on, { BASE_AUTOSAVE: '0' })
    await $.classic.PreCompact({ trigger: 'auto', custom_instructions: null } as any)
    expect(calls.writes).toEqual([])
  })

  t('a manual compact writes nothing', async ($, on) => {
    const { calls } = await staleWorld($, on)
    await $.classic.PreCompact({ trigger: 'manual', custom_instructions: null } as any)
    expect(calls.writes).toEqual([])
  })

  t('a fresh workspace writes nothing', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    await agent($)
    await $.classic.PreCompact({ trigger: 'auto', custom_instructions: null } as any)
    expect(calls.writes).toEqual([])
  })
})
