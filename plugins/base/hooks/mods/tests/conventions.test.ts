import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { PEEK, TEXT, peek, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const HOME = '/home/dev'
const MARKER = `${HOME}/.claude/domaine/log/s1/conventions.base.json`
const INPUT = { model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], tools: ['Bash'], outputStyle: null, traits: [] }
const context = ($: any) => $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'rules' }] })
const block = async ($: any): Promise<string | undefined> => (await context($)).blocks.find((b: any) => b.name === 'baseConventions')?.text
const injected = async ($: any) => (await peek($)).injected
const CORE = ['comment-discipline', 'task-workspace', 'untrusted-content', 'shopify']

describe('the cloud fallback', () => {
  t('nothing draws and no marker: every section in order as one block after the engine\'s, the root filled in', async ($, on) => {
    world(on, { surfaces: [], env: { HOME } })
    const r = await context($)
    expect(r.blocks.map((b: any) => b.name)).toEqual(['claudeMd', 'baseConventions'])
    const text = r.blocks[1].text as string
    const root = text.split('\n')[0]!.replace(/^base plugin root: /, '')
    expect(root).toStartWith('/')
    const at = [...CORE, 'lean-code', 'writing-style'].map(n => text.indexOf(TEXT[n]!.split('\n')[0]!))
    expect(at.every(i => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(text).toContain(`see ${root}/references/task-workspace.md`)
    expect(text).not.toContain('<base root>')
    expect(text).not.toContain('dogfood mode')
    expect(await injected($)).toBe('s1')
  })

  t('the SessionStart command hook\'s marker for this session id: no block', async ($, on) => {
    const { w } = world(on, { surfaces: [], env: { HOME } })
    w.files[MARKER] = { text: '{"via":"hook"}', mtimeMs: 0 }
    expect(await block($)).toBeUndefined()
    expect(await injected($)).toBeNull()
    w.sid = 's2'
    expect(await block($)).toContain(TEXT['comment-discipline'])
  })

  t('DOMAINE_LOG_DIR moves the marker it looks for', async ($, on) => {
    const { w } = world(on, { surfaces: [], env: { HOME, DOMAINE_LOG_DIR: '/var/log/domaine' } })
    w.files[MARKER] = { text: '{}', mtimeMs: 0 }
    expect(await block($)).toContain(TEXT.shopify)
    w.files['/var/log/domaine/s1/conventions.base.json'] = { text: '{}', mtimeMs: 0 }
    expect(await block($)).toBeUndefined()
  })

  t('no HOME (a cloud sandbox): delivered unless the marker sits under the spare root (TMPDIR, else /tmp)', async ($, on) => {
    const { w } = world(on, { surfaces: [] })
    expect(await block($)).toContain(TEXT['untrusted-content'])
    w.sid = 's2'
    w.files['/tmp/domaine-log/s2/conventions.base.json'] = { text: '{}', mtimeMs: 0 }
    expect(await block($)).toBeUndefined()
  })

  t('a marker under the spare root counts with HOME too (the log dir was not writable)', async ($, on) => {
    const { w } = world(on, { surfaces: [], env: { HOME, TMPDIR: '/var/tmp/' } })
    w.files['/var/tmp/domaine-log/s1/conventions.base.json'] = { text: '{}', mtimeMs: 0 }
    expect(await block($)).toBeUndefined()
  })

  t('a session a surface draws: no block, whatever the marker', async ($, on) => {
    world(on, { env: { HOME } })
    expect((await context($)).blocks.map((b: any) => b.name)).toEqual(['claudeMd'])
    expect(await injected($)).toBeNull()
  })

  t('BASE_LEAN=0 drops lean code; BASE_STE=0 drops the writing style', async ($, on) => {
    world(on, { surfaces: [], env: { HOME, BASE_LEAN: '0', BASE_STE: '0' } })
    const text = (await block($))!
    expect(text).toContain(TEXT.shopify)
    expect(text).not.toContain(TEXT['lean-code'])
    expect(text).not.toContain(TEXT['writing-style'])
  })

  t('dogfood on: the section with the versions and the surfaceless rule', async ($, on) => {
    world(on, { surfaces: [], env: { HOME, BASE_DOGFOOD: '1' } })
    const text = (await block($))!
    expect(text).toContain('## base convention — dogfood mode\nbuilds: slim (version unknown), band (version unknown), base 0.1.0.\nRULE-SURFACELESS paste the whole report')
    expect(text).not.toContain('RULE-DRAWN')
  })

  t('an unreadable text file: no block, the prompt goes on', async ($, on) => {
    const { w } = world(on, { surfaces: [], env: { HOME } })
    const root = (await block($))!.split('\n')[0]!.replace(/^base plugin root: /, '')
    w.sid = 's2'
    w.files[`${root}/hooks/conventions-text.json`] = { text: 'not json', mtimeMs: 0 }
    expect((await context($)).blocks.map((b: any) => b.name)).toEqual(['claudeMd'])
  })
})

describe('no other text delivery', () => {
  t('prompt.compose adds no section and SubagentStart no context', async ($, on) => {
    world(on, { env: { HOME, BASE_DOGFOOD: '1' } })
    expect((await $.prompt.compose(INPUT)).sections.map((s: any) => s.id)).toEqual(['intro'])
    expect((await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' })).additionalContext ?? []).toEqual([])
    expect((await peek($)).checked).toBeNull()
  })
})
