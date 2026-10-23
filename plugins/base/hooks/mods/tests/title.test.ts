import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { NOW, PEEK, eventsOf, reset, start, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const HOME = '/home/dev'
const LOG = `${HOME}/.claude/domaine/log`
const titleFile = (by: string, title?: string, ts = NOW - 5_000) => ({ text: JSON.stringify({ sid: 's1', by, ...(title ? { title } : {}), ts }), mtimeMs: NOW })

describe('the title hooks/title.cjs set', () => {
  t('the tick adopts title.json once as a title event in base.events and base.jsonl', async ($, on) => {
    const { w, clock } = world(on, { env: { HOME } })
    await start($)
    await clock.advance(30_000)
    expect(await eventsOf($, 'title')).toEqual([])
    w.files[`${LOG}/s1/title.json`] = titleFile('base', 'ABC-1591 — Header logo')
    await clock.advance(30_000)
    await clock.advance(30_000)
    expect(await eventsOf($, 'title')).toEqual([{ atMs: NOW - 5_000, kind: 'title', text: 'ABC-1591 — Header logo' }])
    expect(w.files[`${LOG}/s1/base.jsonl`]?.text.split('\n').filter(l => l.includes('"kind":"title"'))).toHaveLength(1)
  })

  t('a title the person set adds no event', async ($, on) => {
    const { w, clock } = world(on, { env: { HOME } })
    w.files[`${LOG}/s1/title.json`] = titleFile('user')
    await start($)
    await clock.advance(30_000)
    expect(await eventsOf($, 'title')).toEqual([])
  })

  t('the spare dir counts without HOME; a new session id reads its own file', async ($, on) => {
    const { w, clock } = world(on)
    w.files['/tmp/domaine-log/s1/title.json'] = titleFile('base', 'ABC-1')
    await start($)
    await clock.advance(30_000)
    w.sid = 's2'
    w.files['/tmp/domaine-log/s2/title.json'] = { text: JSON.stringify({ sid: 's2', by: 'base', title: 'ABC-2', ts: NOW }), mtimeMs: NOW }
    await clock.advance(30_000)
    expect((await eventsOf($, 'title')).map(e => e.text)).toEqual(['ABC-1', 'ABC-2'])
  })

  t('a malformed title.json is read once and adds no event', async ($, on) => {
    const { w, calls, clock } = world(on)
    w.files['/tmp/domaine-log/s1/title.json'] = { text: '{"sid":"s1","by":"ba', mtimeMs: NOW }
    await start($)
    await clock.advance(30_000)
    reset(calls)
    await clock.advance(30_000)
    expect(calls.reads.filter(p => p.endsWith('/title.json'))).toEqual([])
    expect(await eventsOf($, 'title')).toEqual([])
  })

  t('BASE_EVENT_LOG=0 adopts nothing', async ($, on) => {
    const { w, clock } = world(on, { env: { HOME, BASE_EVENT_LOG: '0' } })
    w.files[`${LOG}/s1/title.json`] = titleFile('base', 'ABC-1')
    await start($)
    await clock.advance(30_000)
    expect(await eventsOf($, 'title')).toEqual([])
    expect(w.files[`${LOG}/s1/base.jsonl`]).toBeUndefined()
  })
})
