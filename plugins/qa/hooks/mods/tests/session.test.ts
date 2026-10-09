import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { BASE_MISSING } from '../session.ts'
import { NOW, PEEK, compose, eventsOf, peek, start, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)

describe('start line and the base check', () => {
  t('one start line per session with the manifest version; a reloaded start writes none', async ($, on) => {
    const { w } = world(on, { manifest: '{ "name": "qa", "version": "1.2.3" }' })
    await start($)
    await start($)
    expect(await eventsOf($, 'start')).toEqual([{ atMs: NOW, kind: 'start', text: 'qa 1.2.3' }])
    expect((await peek($)).started).toBe('s1')
    w.sid = 's2'
    await start($)
    expect((await eventsOf($, 'start')).map(ev => ev.text)).toEqual(['qa 1.2.3', 'qa 1.2.3'])
  })

  t('an unreadable manifest → qa unknown', async ($, on) => {
    world(on, { manifest: 'not json' })
    await start($)
    expect((await eventsOf($, 'start')).map(ev => ev.text)).toEqual(['qa unknown'])
  })

  t('base loaded → nothing said', async ($, on) => {
    const { calls } = world(on)
    await start($)
    expect(calls.toasts).toEqual([])
    expect(await eventsOf($, 'install')).toEqual([])
  })

  t('base absent → one toast and one install line with the pointer, once per session', async ($, on) => {
    const { w, calls } = world(on, { commands: [['slim-log', 'slim'], ['band-log', 'band']] })
    await start($)
    await start($)
    expect(calls.toasts).toEqual(['qa: needs the base plugin — claude plugin install base@domaine'])
    expect(await eventsOf($, 'install')).toEqual([{ atMs: NOW, kind: 'install', text: BASE_MISSING }])
    w.sid = 's2'
    await start($)
    expect(calls.toasts).toHaveLength(2)
  })

  t('a command list that fails says nothing', async ($, on) => {
    const { calls } = world(on, { commands: null })
    await start($)
    expect(calls.toasts).toEqual([])
  })

  t('QA_EVENT_LOG=0 keeps the list empty; the toast still shows', async ($, on) => {
    const { calls } = world(on, { env: { QA_EVENT_LOG: '0' }, commands: [] })
    await start($)
    await compose($)
    expect((await peek($)).events).toEqual([])
    expect(calls.toasts).toEqual([`qa: ${BASE_MISSING}`])
  })

  t('a compose writes no event', async ($, on) => {
    world(on)
    await compose($)
    expect((await peek($)).events).toEqual([])
  })
})
