import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { titleText } from '../title.ts'
import { MD, NOW, PEEK, TASKS, addWorkspace, eventsOf, peek, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const sessionStart = ($: any, over: Record<string, unknown> = {}) =>
  $.classic.SessionStart({ source: 'startup', session_id: 's1', ...over })
const promptSubmit = ($: any, prompt: string, over: Record<string, unknown> = {}) =>
  $.classic.UserPromptSubmit({ prompt, session_id: 's1', source: 'user', ...over })
const ticket = (key: string, head: string) => [head, '', `Ticket ${key} body`].join('\n')

describe('titleText', () => {
  test('the heading summary after any of its separators', () => {
    for (const head of ['# ABC-12 — Header logo', '# ABC-12: Header logo', '# ABC-12 - Header logo']) {
      expect(titleText('ABC-12', ticket('ABC-12', head))).toBe('ABC-12 — Header logo')
    }
  })

  test('no heading, a bare heading, or a longer key → the key alone', () => {
    expect(titleText('ABC-12', '')).toBe('ABC-12')
    expect(titleText('ABC-12', '# ABC-12\n')).toBe('ABC-12')
    expect(titleText('ABC-12', '# ABC-123 — Other ticket')).toBe('ABC-12')
  })

  test('cut at 100 UTF-8 bytes on a character boundary', () => {
    const ascii = titleText('ABC-12', `# ABC-12 — ${'x'.repeat(200)}`)
    expect(ascii).toBe(`ABC-12 — ${'x'.repeat(100 - 'ABC-12 — '.length - 2)}`)
    const cyr = titleText('ABC-12', `# ABC-12 — ${'ж'.repeat(80)}`)
    expect(cyr).toMatch(/^ABC-12 — ж+$/)
    const bytes = [...cyr].reduce((n, ch) => n + (ch.charCodeAt(0) < 0x80 ? 1 : ch === '—' ? 3 : 2), 0)
    expect(bytes).toBeLessThanOrEqual(100)
    expect(bytes).toBeGreaterThan(97)
  })
})

describe('session title', () => {
  t('the branch key titles the session at start, from ticket.md', async ($, on) => {
    const { w } = world(on)
    w.files[`${TASKS}/ABC-1591/ticket.md`] = { text: ticket('ABC-1591', '# ABC-1591 — Header logo'), mtimeMs: NOW }
    const r = await sessionStart($)
    expect(r.sessionTitle).toBe('ABC-1591 — Header logo')
    expect((await peek($)).titled).toBe('s1')
    expect(await eventsOf($, 'title')).toEqual([{ atMs: NOW, kind: 'title', text: 'ABC-1591 — Header logo' }])
    expect((await promptSubmit($, 'https://example.atlassian.net/browse/XYZ-9')).sessionTitle).toBeUndefined()
  })

  t('a title the person set at start is kept, and spends the shot', async ($, on) => {
    world(on)
    expect((await sessionStart($, { session_title: 'my refactor' })).sessionTitle).toBeUndefined()
    expect((await peek($)).titled).toBe('s1:user')
    expect((await promptSubmit($, 'https://example.atlassian.net/browse/XYZ-9')).sessionTitle).toBeUndefined()
    expect(await eventsOf($, 'title')).toEqual([])
  })

  t('no branch key → the first person prompt naming a corroborated ticket titles it, once', async ($, on) => {
    const { w } = world(on, { branch: 'main' })
    addWorkspace(w, 'ABC-77', MD)
    expect((await sessionStart($)).sessionTitle).toBeUndefined()
    expect((await promptSubmit($, 'save it as UTF-8')).sessionTitle).toBeUndefined()
    expect((await promptSubmit($, 'see XYZ-5')).sessionTitle).toBeUndefined()
    expect((await promptSubmit($, 'ABC-77')).sessionTitle).toBe('ABC-77')
    expect((await promptSubmit($, 'now ABC-78')).sessionTitle).toBeUndefined()
  })

  t('several tickets in one prompt → the most recent, as the workspace resolver picks', async ($, on) => {
    const { w } = world(on, { branch: 'main' })
    addWorkspace(w, 'ABC-77', MD)
    await sessionStart($)
    expect((await promptSubmit($, 'ABC-77 is merged, now start ABC-78')).sessionTitle).toBe('ABC-78')
    expect(await eventsOf($, 'title')).toEqual([{ atMs: NOW, kind: 'title', text: 'ABC-78' }])
  })

  t('a title the person set mid-session (/rename) is kept, and spends the shot', async ($, on) => {
    const { w } = world(on, { branch: 'main' })
    addWorkspace(w, 'ABC-77', MD)
    expect((await sessionStart($)).sessionTitle).toBeUndefined()
    expect((await promptSubmit($, 'look at ABC-77', { session_title: 'my refactor' })).sessionTitle).toBeUndefined()
    expect((await peek($)).titled).toBe('s1:user')
    expect((await promptSubmit($, 'ABC-77 again')).sessionTitle).toBeUndefined()
    expect(await eventsOf($, 'title')).toEqual([])
  })

  t('a prompt no person wrote never titles', async ($, on) => {
    const { w } = world(on, { branch: 'main' })
    addWorkspace(w, 'ABC-77', MD)
    await sessionStart($)
    for (const source of ['system', 'loop_wakeup', 'schedule_wakeup', 'poll_event']) {
      expect((await promptSubmit($, 'ABC-77 finished', { source })).sessionTitle).toBeUndefined()
    }
    expect((await promptSubmit($, 'ABC-77 please', { source: undefined })).sessionTitle).toBe('ABC-77')
  })

  t('a branch key titles only when its workspace or its project is known here', async ($, on) => {
    const { w } = world(on, { branch: 'fix/UTF-8-encoding' })
    addWorkspace(w, 'ABC-77', MD)
    expect((await sessionStart($)).sessionTitle).toBeUndefined()
    expect((await peek($)).titled).toBeNull()
    w.branch = 'feature/ABC-1591-x'
    expect((await sessionStart($, { source: 'clear', session_id: 's2' })).sessionTitle).toBe('ABC-1591')
  })

  t('a new session id gets its own shot', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ABC-1591', MD)
    expect((await sessionStart($)).sessionTitle).toBe('ABC-1591')
    expect((await sessionStart($, { source: 'compact' })).sessionTitle).toBeUndefined()
    expect((await sessionStart($, { source: 'clear', session_id: 's2' })).sessionTitle).toBe('ABC-1591')
  })

  t('BASE_SESSION_TITLE=0 → no title', async ($, on) => {
    const { w } = world(on, { env: { BASE_SESSION_TITLE: '0' } })
    addWorkspace(w, 'ABC-77', MD)
    expect((await sessionStart($)).sessionTitle).toBeUndefined()
    expect((await promptSubmit($, 'ABC-77')).sessionTitle).toBeUndefined()
    expect((await peek($)).titled).toBeNull()
  })

  t('a failing git run leaves the start untitled', async ($, on) => {
    world(on, { gitRejects: true })
    expect((await sessionStart($)).sessionTitle).toBeUndefined()
    expect((await peek($)).titled).toBeNull()
  })
})
