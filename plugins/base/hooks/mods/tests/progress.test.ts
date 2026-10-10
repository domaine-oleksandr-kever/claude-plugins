import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HOUR, MD, NOTES, NOW, PEEK, ROOT, TASKS, addWorkspace, eventsOf, peek, progressMd, reset, run, start, submit, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)

describe('resolver', () => {
  t('git plus fs → the published progress', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ABC-1591')
    w.files[`${TASKS}/ABC-1591/notes.md`] = { text: NOTES, mtimeMs: NOW - HOUR }
    await start($)
    expect((await peek($)).progress).toEqual({
      workId: 'ABC-1591',
      branch: 'feature/ABC-1591-x',
      hasWorkspace: true,
      done: 3,
      total: 5,
      current: 'Preview themes',
      rows: [
        { mark: 'done', text: 'Read the ticket' },
        { mark: 'done', text: 'Plan approved' },
        { mark: 'done', text: 'Branch' },
        { mark: 'current', text: 'Preview themes' },
        { mark: 'todo', text: 'QA' },
      ],
      notesTail: ['- two', '- three', '- four'],
      mtimeMs: NOW - 60_000,
      lastSavableMs: 0,
      agentsSince: 0,
      editsSince: 0,
      stale: false,
    })
  })

  t('pin beats the branch key', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ABC-1591')
    addWorkspace(w, 'OTHER-1')
    await start($)
    await run($, 'OTHER-1')
    expect((await peek($)).progress.workId).toBe('OTHER-1')
  })

  t('the conversation key beats the branch key', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ABC-1591')
    addWorkspace(w, 'ABC-77')
    await start($)
    expect((await peek($)).progress.workId).toBe('ABC-1591')
    await submit($, 'see ABC-77')
    const s = await peek($)
    expect(s.lastKey).toBe('ABC-77')
    expect(s.progress.workId).toBe('ABC-77')
    expect(s.progress.hasWorkspace).toBe(true)
  })

  t('conversation key on main', async ($, on) => {
    const { w } = world(on, { branch: 'main' })
    addWorkspace(w, 'ABC-77')
    addWorkspace(w, 'main', MD, NOW - 13 * HOUR)
    await start($)
    expect((await peek($)).progress.workId).toBe('main')
    await submit($, 'see ABC-77')
    expect((await peek($)).progress.workId).toBe('ABC-77')
  })

  t('a conversation key without a workspace still names the task: the bare id, over the branch key', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    await submit($, 'see ABC-77')
    const s = await peek($)
    expect(s.lastKey).toBe('ABC-77')
    expect(s.progress).toMatchObject({ workId: 'ABC-77', branch: 'feature/ABC-1591-x', hasWorkspace: false, total: 0, rows: [], notesTail: [] })
    addWorkspace(w, 'ABC-77', MD, NOW + 1)
    await $.tool.call({ tool: 'Write', file_path: progressMd('ABC-77'), content: MD })
    expect((await peek($)).progress).toMatchObject({ workId: 'ABC-77', hasWorkspace: true, total: 5 })
  })

  t('a bare key of an unknown project is not a ticket; a /browse/ URL makes it one', async ($, on) => {
    world(on, { branch: 'main' })
    await start($)
    await submit($, 'see ABC-77')
    let s = await peek($)
    expect(s.lastKey).toBeNull()
    expect(s.progress).toEqual({ workId: null, branch: 'main' })
    await submit($, 'https://example.atlassian.net/browse/ABC-77 look at the comment')
    s = await peek($)
    expect(s.lastKey).toBe('ABC-77')
    expect(s.progress).toMatchObject({ workId: 'ABC-77', hasWorkspace: false })
  })

  t('conversation key beats the branch slug', async ($, on) => {
    const { w } = world(on, { branch: 'feature/header-refactor' })
    addWorkspace(w, 'header-refactor')
    addWorkspace(w, 'ABC-77', MD, NOW - 20 * HOUR)
    await start($)
    expect((await peek($)).progress.workId).toBe('header-refactor')
    await submit($, 'ABC-77 please')
    expect((await peek($)).progress.workId).toBe('ABC-77')
  })

  t('a non-ticket token keeps the conversation key', async ($, on) => {
    const { w } = world(on, { branch: 'main' })
    addWorkspace(w, 'ABC-77', MD, NOW - 20 * HOUR)
    addWorkspace(w, 'base-mods', MD, NOW - HOUR)
    await start($)
    await submit($, 'work on ABC-77')
    expect((await peek($)).progress.workId).toBe('ABC-77')
    await submit($, 'format the dates as ISO-8601 and save as UTF-8')
    const s = await peek($)
    expect(s.lastKey).toBe('ABC-77')
    expect(s.progress.workId).toBe('ABC-77')
  })

  t('a key in a notification or a peer message is not the conversation key', async ($, on) => {
    const { w } = world(on, { branch: 'main' })
    addWorkspace(w, 'ABC-77', MD, NOW - 20 * HOUR)
    addWorkspace(w, 'ABC-88', MD, NOW - 20 * HOUR)
    await start($)
    await submit($, 'work on ABC-77')
    for (const kind of ['task-notification', 'peer', 'scheduled-trigger']) {
      await submit($, 'ABC-88 finished', kind)
      const s = await peek($)
      expect(s.lastKey).toBe('ABC-77')
      expect(s.progress.workId).toBe('ABC-77')
    }
  })

  t('a rejected git run falls through to the newest workspace', async ($, on) => {
    const { w, calls } = world(on, { gitRejects: true })
    addWorkspace(w, 'ABC-1591', MD, NOW - 2 * HOUR)
    addWorkspace(w, 'base-mods', MD, NOW - HOUR)
    await start($)
    expect(calls.git).toBe(1)
    const { progress } = await peek($)
    expect(progress.workId).toBe('base-mods')
    expect(progress.branch).toBeNull()
  })

  t('newest progress.md only within 12 h', async ($, on) => {
    const { w } = world(on, { branch: 'main' })
    addWorkspace(w, 'base-mods', MD, NOW - 11 * HOUR)
    addWorkspace(w, 'older', MD, NOW - 11.5 * HOUR)
    await start($)
    expect((await peek($)).progress.workId).toBe('base-mods')
  })

  t('nothing within 12 h → { workId: null, branch }', async ($, on) => {
    const { w } = world(on, { branch: 'main' })
    addWorkspace(w, 'base-mods', MD, NOW - 13 * HOUR)
    await start($)
    expect((await peek($)).progress).toEqual({ workId: null, branch: 'main' })
  })

  t('a ticket dir without progress.md → the bare id, no rows, the notes tail', async ($, on) => {
    const { w } = world(on, { branch: 'bugfix/ABC-1588' })
    w.files[`${TASKS}/ABC-1588/notes.md`] = { text: NOTES, mtimeMs: NOW - HOUR }
    w.files[`${TASKS}/ABC-1588/ticket.md`] = { text: '# ABC-1588', mtimeMs: NOW - HOUR }
    addWorkspace(w, 'base-mods', MD, NOW - HOUR)
    await start($)
    const { progress } = await peek($)
    expect(progress).toMatchObject({ workId: 'ABC-1588', total: 0, rows: [], current: null, notesTail: ['- two', '- three', '- four'] })
    w.files[progressMd('ABC-1588')] = { text: MD, mtimeMs: NOW + 1 }
    await $.tool.call({ tool: 'Write', file_path: progressMd('ABC-1588'), content: MD })
    expect((await peek($)).progress).toMatchObject({ workId: 'ABC-1588', done: 3, total: 5, current: 'Preview themes' })
  })

  t('a stray file named like a key is not a workspace', async ($, on) => {
    const { w } = world(on)
    w.files[`${TASKS}/ABC-1591`] = { text: 'x', mtimeMs: NOW }
    await start($)
    expect((await peek($)).progress).toEqual({ workId: null, branch: 'feature/ABC-1591-x' })
  })
})

describe('refresh', () => {
  t('session.end clear → progress null, no process or fs call', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    await submit($, 'ABC-1591')
    reset(calls)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    expect(calls.git).toBe(0)
    expect(calls.fs).toEqual([])
    const s = await peek($)
    expect(s.progress).toBeNull()
    expect(s.lastKey).toBeNull()
  })

  t('the next tick after a clear resolves again', async ($, on) => {
    const { w, clock } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(30_000)
    expect((await peek($)).progress.workId).toBe('ABC-1591')
  })

  t('session.start registers the command before a slow git run', async ($, on) => {
    const { w, calls, clock } = world(on, { gitDelayMs: 4_000 })
    addWorkspace(w, 'ABC-1591')
    const started = start($)
    await clock.settle()
    expect(calls.git).toBe(1)
    expect(calls.registers).toBe(1)
    await clock.advance(4_000)
    await started
    expect((await peek($)).progress.workId).toBe('ABC-1591')
  })

  t('a new session id → the command again and a fresh resolve', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    expect(calls.registers).toBe(1)
    reset(calls)
    await submit($, 'hello')
    expect(calls.registers).toBe(1)
    expect(calls.git).toBe(0)
    w.sid = 's2'
    await submit($, 'hello again')
    expect(calls.registers).toBe(2)
    expect(calls.git).toBe(1)
    const s = await peek($)
    expect(s.sessionId).toBe('s2')
    expect(s.progress.workId).toBe('ABC-1591')
  })

  t('a deleted progress.md falls through on the next tick', async ($, on) => {
    const { w, clock } = world(on, { branch: 'main' })
    addWorkspace(w, 'base-mods', MD, NOW - HOUR)
    addWorkspace(w, 'older', MD, NOW - 2 * HOUR)
    await start($)
    expect((await peek($)).progress.workId).toBe('base-mods')
    delete w.files[progressMd('base-mods')]
    await clock.advance(30_000)
    expect((await peek($)).progress.workId).toBe('older')
  })

  t('a resolve tick in flight does not overwrite a newer pin', async ($, on) => {
    const { w, clock } = world(on)
    addWorkspace(w, 'ABC-1591')
    addWorkspace(w, 'ABC-2')
    await start($)
    w.gitDelayMs = 60_000
    await clock.advance(120_000)
    expect(await run($, 'ABC-2')).toEqual({ text: 'Pinned ABC-2. /band-progress shows it.' })
    await clock.advance(60_000)
    expect((await peek($)).progress.workId).toBe('ABC-2')
  })

  t('a resolve tick in flight does not bring back the cleared conversation', async ($, on) => {
    const { w, clock } = world(on, { branch: 'main' })
    addWorkspace(w, 'ABC-77', MD, NOW - 20 * HOUR)
    await start($)
    await submit($, 'work on ABC-77')
    w.gitDelayMs = 60_000
    await clock.advance(120_000)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(60_000)
    expect((await peek($)).progress).toEqual({ workId: null, branch: 'main' })
  })

  t('a tick re-parses only when the mtime changed', async ($, on) => {
    const { w, calls, clock } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    reset(calls)
    await clock.advance(30_000)
    expect(calls.reads).toEqual([])
    w.files[progressMd('ABC-1591')] = { text: MD.replace('- [ ] Preview', '- [x] Preview'), mtimeMs: NOW + 10_000 }
    await clock.advance(30_000)
    expect(calls.reads.filter(p => p === progressMd('ABC-1591'))).toHaveLength(1)
    expect(calls.git).toBe(0)
    expect((await peek($)).progress).toMatchObject({ done: 4, total: 5, current: 'QA' })
  })

  t('every fourth tick resolves the branch again', async ($, on) => {
    const { w, calls, clock } = world(on)
    addWorkspace(w, 'ABC-1591')
    addWorkspace(w, 'ABC-77')
    await start($)
    reset(calls)
    w.branch = 'feature/ABC-77-y'
    await clock.advance(90_000)
    expect(calls.git).toBe(0)
    await clock.advance(30_000)
    expect(calls.git).toBe(1)
    expect((await peek($)).progress.workId).toBe('ABC-77')
  })

  for (const tool of ['Write', 'Edit'] as const) {
    t(`${tool} on the workspace → exactly one re-read`, async ($, on) => {
      const { w, calls } = world(on)
      addWorkspace(w, 'ABC-1591')
      await start($)
      reset(calls)
      const path = progressMd('ABC-1591')
      const input =
        tool === 'Write' ? { tool, file_path: path, content: '- [x] a\n- [ ] b\n' } : { tool, file_path: path, old_string: 'x', new_string: 'y' }
      await $.tool.call(input)
      expect(calls.reads.filter(p => p === path)).toHaveLength(1)
      expect(calls.git).toBe(0)
    })
  }

  t('a Write elsewhere → zero reads', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    reset(calls)
    await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/a.ts`, content: 'x' })
    expect(calls.fs).toEqual([])
    expect(calls.git).toBe(0)
  })

  t('a Write into another workspace resolves again', async ($, on) => {
    const { calls } = world(on, { branch: 'main' })
    await start($)
    expect((await peek($)).progress.workId).toBeNull()
    reset(calls)
    await $.tool.call({ tool: 'Write', file_path: progressMd('base-mods'), content: '- [ ] first\n' })
    expect(calls.git).toBe(1)
    expect((await peek($)).progress.workId).toBe('base-mods')
  })

  t('git checkout in Bash resolves again; other commands do not', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ABC-1591')
    addWorkspace(w, 'ABC-77')
    await start($)
    reset(calls)
    await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    expect(calls.git).toBe(0)
    await $.tool.call({ tool: 'Bash', command: 'git checkout feature/ABC-77-y' })
    expect(calls.git).toBe(1)
    expect((await peek($)).progress.workId).toBe('ABC-77')
  })

  t('CwdChanged resolves again', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    reset(calls)
    await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: `${ROOT}/sub` })
    expect(calls.git).toBe(1)
  })
})

describe('workspace event', () => {
  t('the first resolve logs the work id; a re-read of the same workspace logs nothing', async ($, on) => {
    const { w, clock } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    expect(await eventsOf($, 'workspace')).toEqual([{ atMs: NOW, kind: 'workspace', text: 'ABC-1591' }])
    await $.tool.call({ tool: 'Write', file_path: progressMd('ABC-1591'), content: MD })
    await clock.advance(4 * 30_000)
    expect(await eventsOf($, 'workspace')).toHaveLength(1)
  })

  t('a branch switch to another workspace logs it; leaving every workspace logs none', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ABC-1591')
    addWorkspace(w, 'ABC-77')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git checkout feature/ABC-77-y' })
    w.files = {}
    await $.tool.call({ tool: 'Bash', command: 'git checkout main' })
    expect((await eventsOf($, 'workspace')).map(ev => ev.text)).toEqual(['ABC-1591', 'ABC-77', 'none'])
  })

  t('/clear and the re-resolve on the next prompt log no second line for the same workspace', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ABC-1591')
    addWorkspace(w, 'ABC-77')
    await start($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    w.sid = 's2'
    await submit($, 'hi')
    expect((await eventsOf($, 'workspace')).map(ev => ev.text)).toEqual(['ABC-1591'])
    await $.tool.call({ tool: 'Bash', command: 'git checkout feature/ABC-77-y' })
    expect((await eventsOf($, 'workspace')).map(ev => ev.text)).toEqual(['ABC-1591', 'ABC-77'])
  })

  t('no workspace at start → no workspace event', async ($, on) => {
    world(on)
    await start($)
    expect(await eventsOf($, 'workspace')).toEqual([])
  })

  t('BASE_EVENT_LOG=0 keeps the list empty while progress still publishes', async ($, on) => {
    const { w } = world(on, { env: { BASE_EVENT_LOG: '0' } })
    addWorkspace(w, 'ABC-1591')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git checkout main' })
    const s = await peek($)
    expect(s.events).toEqual([])
    expect(s.progress.workId).toBe('ABC-1591')
  })
})

describe('staleness', () => {
  const agent = ($: any) => $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'general-purpose' })
  const edit = ($: any, file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })

  t('an agent return and an edit outside .claude/ count; 20 min without a write turns the workspace stale', async ($, on) => {
    const { w, clock } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    await agent($)
    await edit($, `${ROOT}/sections/header.liquid`)
    expect((await peek($)).progress).toMatchObject({ lastSavableMs: NOW, agentsSince: 1, editsSince: 1, stale: false })
    await clock.advance(20 * 60_000)
    expect((await peek($)).progress).toMatchObject({ mtimeMs: NOW - 60_000, stale: true })
    await $.tool.call({ tool: 'Write', file_path: `${TASKS}/ABC-1591/notes.md`, content: NOTES })
    expect((await peek($)).progress).toMatchObject({ mtimeMs: NOW + 1, lastSavableMs: NOW, agentsSince: 0, editsSince: 0, stale: false })
  })

  t('an edit under .claude/ and a denied agent are not savable; time alone is not stale', async ($, on) => {
    const { w, clock } = world(on, { tools: ['Bash', 'Read'] })
    addWorkspace(w, 'ABC-1591')
    await start($)
    await edit($, `${ROOT}/.claude/settings.json`)
    await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'base:jira-reader' })
    await clock.advance(25 * 60_000)
    expect((await peek($)).progress).toMatchObject({ lastSavableMs: 0, agentsSince: 0, editsSince: 0, stale: false })
  })

  t('an MCP result over slim\'s gate, or carrying its handle, counts; a small one does not', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    const mcp = (reply: string) => $.tool.call({ tool: 'mcp__atlassian__getJiraIssue', reply })
    await mcp('x'.repeat(4096))
    expect((await peek($)).progress).toMatchObject({ lastSavableMs: 0 })
    await mcp('x'.repeat(4097))
    await mcp('<<slim stub>> getJiraIssue returned 90000 B')
    expect((await peek($)).progress).toMatchObject({ lastSavableMs: NOW, agentsSince: 0, editsSince: 0 })
  })

  t('no workspace is never stale', async ($, on) => {
    const { w, clock } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    await submit($, 'see ABC-77')
    await agent($)
    await clock.advance(25 * 60_000)
    expect((await peek($)).progress).toMatchObject({ workId: 'ABC-77', hasWorkspace: false, agentsSince: 1, stale: false })
  })
})

describe('/base-progress', () => {
  t('a work id pins, - unpins; each answer points at the checklist', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ABC-1591')
    addWorkspace(w, 'ABC-9')
    await start($)
    expect(calls.registers).toBe(1)
    expect(await run($, 'ABC-9')).toEqual({ text: 'Pinned ABC-9. /band-progress shows it.' })
    let s = await peek($)
    expect(s.pin).toBe('ABC-9')
    expect(s.progress.workId).toBe('ABC-9')
    expect(await run($, '-')).toEqual({ text: 'Unpinned. /band-progress shows the checklist.' })
    s = await peek($)
    expect(s.pin).toBeNull()
    expect(s.progress.workId).toBe('ABC-1591')
  })

  t('no argument names the pin and the checklist command', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ABC-9')
    await start($)
    expect(await run($, '')).toEqual({ text: "Pinned: none. The checklist is band's: /band-progress" })
    await run($, 'ABC-9')
    expect(await run($, '  ')).toEqual({ text: "Pinned: ABC-9. The checklist is band's: /band-progress" })
  })

  t('refuses a path; says when the pin has no workspace', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ABC-1591')
    await start($)
    expect(await run($, '../../etc')).toEqual({ text: 'Not a work id: ../../etc' })
    expect((await peek($)).pin).toBeNull()
    expect(await run($, 'ABC-9')).toEqual({ text: 'Pinned ABC-9. /band-progress shows it. ABC-9 has no task workspace.' })
    expect((await peek($)).progress.workId).toBe('ABC-1591')
  })
})
