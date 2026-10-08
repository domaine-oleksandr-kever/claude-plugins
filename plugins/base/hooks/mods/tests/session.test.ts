import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { WITH_FND, SLIM_MISSING } from '../session.ts'
import { NOW, PEEK, SLIM_VIEW, eventsOf, peek, start, submit, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const NO_SLIM = ['Bash', 'Read', 'mcp__other__view']
const spawnArgs = (subagent_type: string) => ({ tool: 'Agent', description: 'read the ticket', prompt: 'ABC-1', subagent_type })

describe('start line', () => {
  t('one start line per session, with the manifest version; a reloaded start writes none', async ($, on) => {
    const { w } = world(on, { manifest: '{ "name": "base", "version": "1.2.3" }' })
    await start($)
    await start($)
    expect(await eventsOf($, 'start')).toEqual([{ atMs: NOW, kind: 'start', text: 'base 1.2.3' }])
    expect((await peek($)).started).toBe('s1')
    w.sid = 's2'
    await start($)
    expect((await eventsOf($, 'start')).map(ev => ev.text)).toEqual(['base 1.2.3', 'base 1.2.3'])
  })

  t('an unreadable manifest → base unknown', async ($, on) => {
    world(on, { manifest: 'not json' })
    await start($)
    expect((await eventsOf($, 'start')).map(ev => ev.text)).toEqual(['base unknown'])
  })

  t('BASE_EVENT_LOG=0 keeps the list empty', async ($, on) => {
    const { calls } = world(on, { env: { BASE_EVENT_LOG: '0' }, tools: NO_SLIM, enabledPlugins: { 'fnd@domaine': true } })
    await start($)
    await submit($, 'hello')
    await $.tool.call(spawnArgs('base:jira-reader'))
    expect((await peek($)).events).toEqual([])
    expect(calls.toasts).toEqual([`base: ${SLIM_MISSING}`, `base: ${WITH_FND}`])
  })
})

describe('install checks at the first prompt', () => {
  t('slim and no fnd → nothing said', async ($, on) => {
    const { calls } = world(on)
    await start($)
    await submit($, 'hello')
    expect(calls.toasts).toEqual([])
    expect(await eventsOf($, 'install')).toEqual([])
    expect((await peek($)).checked).toBe('s1')
  })

  t('slim missing → one line and one toast with the install pointer, once per session', async ($, on) => {
    const { w, calls } = world(on, { tools: NO_SLIM })
    await start($)
    await submit($, 'hello')
    await submit($, 'again')
    expect(calls.toasts).toEqual(['base: slim is not loaded — claude plugin install slim@domaine'])
    expect(await eventsOf($, 'install')).toEqual([{ atMs: NOW, kind: 'install', text: SLIM_MISSING }])
    w.sid = 's2'
    await submit($, 'after a clear')
    expect(calls.toasts).toHaveLength(2)
  })

  t('slim registered after session.start is seen at the first prompt', async ($, on) => {
    const { w, calls } = world(on, { tools: NO_SLIM })
    await start($)
    w.tools = [...NO_SLIM, SLIM_VIEW]
    await submit($, 'hello')
    expect(calls.toasts).toEqual([])
  })

  t('fnd enabled in settings → the uninstall line', async ($, on) => {
    const { calls } = world(on, { enabledPlugins: { 'base@domaine': true, 'fnd@domaine': true } })
    await start($)
    await submit($, 'hello')
    expect(calls.toasts).toEqual([`base: ${WITH_FND}`])
    expect((await eventsOf($, 'install')).map(ev => ev.text)).toEqual([WITH_FND])
    expect(WITH_FND).toContain('fnd and base must not run together — uninstall fnd')
  })

  t('fnd disabled in settings and no fnd command → nothing', async ($, on) => {
    const { calls } = world(on, { enabledPlugins: { 'fnd@domaine': false }, commands: [['band-log', 'band']] })
    await start($)
    await submit($, 'hello')
    expect(calls.toasts).toEqual([])
  })

  t('fnd loaded without a settings key (a plugin-dir load) → its commands give it away', async ($, on) => {
    const { calls } = world(on, { enabledPlugins: {}, commands: [['fnd-progress', 'fnd']] })
    await start($)
    await submit($, 'hello')
    expect(calls.toasts).toEqual([`base: ${WITH_FND}`])
  })

  t('slim missing and fnd present → both lines', async ($, on) => {
    const { calls } = world(on, { tools: NO_SLIM, enabledPlugins: { 'fnd@domaine': true } })
    await start($)
    await submit($, 'hello')
    expect(calls.toasts).toEqual([`base: ${SLIM_MISSING}`, `base: ${WITH_FND}`])
  })
})

describe('reader refusal without slim', () => {
  for (const reader of ['jira-reader', 'figma-reader', 'doc-reader']) {
    t(`base:${reader} through the Agent tool → denied, one refuse line`, async ($, on) => {
      const { calls } = world(on, { tools: NO_SLIM })
      await start($)
      const r = await $.tool.call(spawnArgs(`base:${reader}`))
      expect(r).toEqual({ deny: `base: ${reader} needs the slim plugin — claude plugin install slim@domaine` })
      expect(calls.below).toEqual([])
      expect(await eventsOf($, 'refuse')).toEqual([{ atMs: NOW, kind: 'refuse', text: `${reader}: slim is not loaded` }])
    })
  }

  for (const agent of ['base:jira-writer', 'base:bug-hunter', 'base:change-reviewer', 'general-purpose']) {
    t(`${agent} runs without slim`, async ($, on) => {
      const { calls } = world(on, { tools: NO_SLIM })
      await start($)
      await $.tool.call(spawnArgs(agent))
      expect(calls.below).toHaveLength(1)
      expect(await eventsOf($, 'refuse')).toEqual([])
    })
  }

  t('a reader runs while slim is loaded', async ($, on) => {
    const { calls } = world(on)
    await start($)
    await $.tool.call(spawnArgs('base:jira-reader'))
    expect(calls.below).toHaveLength(1)
  })

  // The harness hands a hook-made spawn to agent.spawn hooks in the Agent tool's shape, so the bare-name chain
  // is pinned in its two halves: the Agent hook lets the bare name through, the resolved type is denied.
  t('a bare reader name passes the Agent hook: the refusal is agent.spawn\'s', async ($, on) => {
    const { calls } = world(on, { tools: NO_SLIM })
    await start($)
    for (const reader of ['jira-reader', 'figma-reader', 'doc-reader']) await $.tool.call(spawnArgs(reader))
    expect(calls.below).toHaveLength(3)
    expect(await eventsOf($, 'refuse')).toEqual([])
  })

  for (const reader of ['jira-reader', 'figma-reader', 'doc-reader']) {
    t(`a spawn resolved to base:${reader} (a bare name, another plugin) → denied at agent.spawn, one refuse line`, async ($, on) => {
      const { calls } = world(on, { tools: NO_SLIM })
      await start($)
      expect(await $.agent.spawn({ subagentType: `base:${reader}`, prompt: 'read it' })).toEqual({
        deny: `base: ${reader} needs the slim plugin — claude plugin install slim@domaine`,
      })
      expect(calls.spawned).toEqual([])
      expect(await eventsOf($, 'refuse')).toEqual([{ atMs: NOW, kind: 'refuse', text: `${reader}: slim is not loaded` }])
    })
  }

  t('a writer spawned without slim runs', async ($, on) => {
    const { calls } = world(on, { tools: NO_SLIM })
    await start($)
    await $.agent.spawn({ subagentType: 'base:jira-writer', prompt: 'write' })
    expect(calls.spawned).toEqual(['base:jira-writer'])
    expect(await eventsOf($, 'refuse')).toEqual([])
  })
})
