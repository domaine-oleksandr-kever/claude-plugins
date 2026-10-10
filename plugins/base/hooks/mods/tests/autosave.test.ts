import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { NOTES, NOW, PEEK, TASKS, addWorkspace, start, submit, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const agent = ($: any) => $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'general-purpose' })
const stop = ($: any, stop_hook_active = false) => $.classic.Stop({ stop_hook_active } as any)
const NOTES_MD = `${TASKS}/ABC-1591/notes.md`
const MIN = 60_000
const NUDGE = 'workspace stale: last write 21 min ago — save decisions and interim findings to .claude/tasks/ABC-1591/notes.md before you answer'
const BLOCK = 'save interim findings to the workspace (.claude/tasks/ABC-1591/notes.md), then stop'

/** A workspace written a minute before the start, an agent returned, then 20 min without a write. */
async function staleWorld($: any, on: On, env: Record<string, string> = {}) {
  const ctx = world(on, { env })
  addWorkspace(ctx.w, 'ABC-1591')
  await start($)
  await agent($)
  await ctx.clock.advance(20 * MIN)
  return ctx
}

const lastContext = (calls: any) => calls.prompts[calls.prompts.length - 1]?.context ?? []

describe('nudge', () => {
  t('a stale workspace adds one context line to the prompt', async ($, on) => {
    const { calls } = await staleWorld($, on)
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

  t('BASE_AUTOSAVE=0 adds none', async ($, on) => {
    const { calls } = await staleWorld($, on, { BASE_AUTOSAVE: '0' })
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([])
  })

  t('a context window 85 % full shortens the stale window to 5 min', async ($, on) => {
    const { w, calls, clock } = world(on, { ctxPct: 84 })
    addWorkspace(w, 'ABC-1591')
    await start($)
    await agent($)
    await clock.advance(6 * MIN)
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([])
    w.ctxPct = 85
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([NUDGE.replace('21 min', '7 min')])
    w.ctxPct = null
    await submit($, 'go on')
    expect(lastContext(calls)).toEqual([])
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

  t('3 turns without a workspace write count savable work from an earlier turn', async ($, on) => {
    const ctx = world(on)
    addWorkspace(ctx.w, 'ABC-1591')
    await start($)
    await agent($)
    const turn = async () => {
      await submit($, 'just a question')
      const r = (await stop($)).block ?? null
      await ctx.clock.advance(15 * MIN)
      return r
    }
    expect(await turn()).toBeNull()
    expect(await turn()).toBeNull()
    expect(await turn()).toBe(BLOCK)
  })

  t('chat turns with no savable work never block', async ($, on) => {
    const ctx = world(on)
    addWorkspace(ctx.w, 'ABC-1591')
    await start($)
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
    await agent($)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/sections/header.liquid', old_string: 'a', new_string: 'b' })
    await ctx.clock.advance(20 * MIN)
    await $.classic.PreCompact({ trigger: 'auto', custom_instructions: null } as any)
    expect(ctx.w.files[NOTES_MD]?.text).toBe(
      `## log\n- one\n- ${day(NOW)} compact: workspace stale 21 min; since then 1 reader agents, 1 edits\n`,
    )
  })

  t('a notes.md that exists but cannot be read is left alone', async ($, on) => {
    const ctx = world(on)
    addWorkspace(ctx.w, 'ABC-1591')
    ctx.w.files[NOTES_MD] = { text: 'x'.repeat(100), mtimeMs: NOW - 2 * MIN }
    ctx.w.readFails = [NOTES_MD]
    await start($)
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
