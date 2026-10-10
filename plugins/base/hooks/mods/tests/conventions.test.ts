import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { COMMENT_DISCIPLINE, LEAN_CODE, UNTRUSTED_CONTENT, WRITING_STYLE } from '../conventions/text.ts'
import { world } from './world.ts'

const IDS = ['base:root', 'base:comment-discipline', 'base:task-workspace', 'base:untrusted-content', 'base:lean-code', 'base:writing-style']
// base-refs-lint's banned names, spelled so that lint does not flag this file: base's text never points at the legacy plugin.
const OLD = 'f' + 'nd'
const BANNED = [`plugin_${OLD}_`, `${OLD.toUpperCase()}_`, `\\b${OLD}:`, `/${OLD}\\b`, `${OLD}-tmp`, '\\bCursor\\b', '\\bCodex\\b', '\\bOpenCode\\b'].map(p => new RegExp(p))

const INPUT = { model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], tools: ['Bash'], outputStyle: null, traits: [] }
const compose = ($: any) => $.prompt.compose(INPUT)
const ours = (r: { sections: readonly { id: string; text: string; scope: string }[] }) => r.sections.filter(s => s.id.startsWith('base:'))
const subagent = ($: any, agent_type: string) => $.classic.SubagentStart({ agent_id: 'a1', agent_type })
const rootOf = (text: string) => text.replace(/^base plugin root: /, '')

describe('prompt.compose', () => {
  test('the engine\'s sections first, then base\'s in order, every one session-scoped', async ($, on) => {
    world(on)
    const r = await compose($)
    expect(r.sections[0]).toEqual({ id: 'intro', text: 'You are Claude Code.', scope: 'shared' })
    expect(r.sections.slice(1).map((s: any) => s.id)).toEqual(IDS)
    expect(ours(r).every(s => s.scope === 'session')).toBe(true)
  })

  test('the root line names the plugin root, and the workspace section cites a reference under it', async ($, on) => {
    world(on)
    const r = ours(await compose($))
    const root = rootOf(r[0]!.text)
    expect(r[0]!.text).toStartWith('base plugin root: /')
    expect(root).not.toContain('\n')
    const ws = r.find(s => s.id === 'base:task-workspace')!.text
    expect(ws).toContain(`${root}/references/task-workspace.md`)
    expect(ws).not.toContain('<base root>')
    expect(ws).toContain('/base:save-task-context')
    expect(ws).toContain("The team plugin's section names the series of steps.")
    expect(r.find(s => s.id === 'base:comment-discipline')!.text).toBe(COMMENT_DISCIPLINE)
  })

  test('the untrusted-content rail keeps one sentence per rule, under 900 bytes', async ($, on) => {
    world(on)
    const text = ours(await compose($)).find(s => s.id === 'base:untrusted-content')!.text
    for (const name of ['ESCALATE(', ".claude/slim/prompt/", 'tool-results/', "hook's own system reminder", '<<slim stub>>', 'base plugin directive:']) {
      expect(text).toContain(name)
    }
    expect(new TextEncoder().encode(text).length).toBeLessThan(900)
  })

  test('two renders are byte-identical', async ($, on) => {
    world(on)
    const a = await compose($)
    expect(ours(a)).toHaveLength(IDS.length)
    expect(JSON.stringify(a)).toBe(JSON.stringify(await compose($)))
  })

  test('no legacy-plugin, host or old-compressor name in any section', async ($, on) => {
    world(on)
    const r = ours(await compose($))
    expect(r).toHaveLength(IDS.length)
    for (const s of r) for (const re of BANNED) expect(re.test(s.text)).toBe(false)
  })

  test('BASE_LEAN=0 drops lean code; BASE_STE=0 drops the writing style', async ($, on) => {
    world(on, { env: { BASE_LEAN: '0', BASE_STE: '0' } })
    const ids = ours(await compose($)).map(s => s.id)
    expect(ids).toEqual(IDS.filter(id => id !== 'base:lean-code' && id !== 'base:writing-style'))
  })

  test('a section the engine already answered under a base id is not added twice', async ($, on) => {
    mock.env(on, {})
    on('prompt.compose', async () => ({ sections: [{ id: 'base:root', text: 'kept', scope: 'session' as const }] }))
    const r = await compose($)
    expect(r.sections.filter((s: any) => s.id === 'base:root')).toEqual([{ id: 'base:root', text: 'kept', scope: 'session' }])
  })
})

describe('classic.SubagentStart', () => {
  test('a reader gets the root line and the untrusted-content rail only', async ($, on) => {
    world(on)
    for (const type of ['base:jira-reader', 'base:figma-reader', 'base:doc-reader', 'base:jira-writer', 'base:bug-hunter', 'base:change-reviewer', 'fe:theme-explorer', 'qa:store-explorer', 'Explore', 'Plan']) {
      const r = await subagent($, type)
      expect(r.additionalContext).toHaveLength(1)
      const ctx = r.additionalContext[0] as string
      expect(ctx).toStartWith('base plugin root: /')
      expect(ctx).toContain(UNTRUSTED_CONTENT)
      expect(ctx).not.toContain(COMMENT_DISCIPLINE)
      expect(ctx).not.toContain(LEAN_CODE)
    }
  })

  test('a code-writing agent also gets comment discipline and lean code, never the writing style', async ($, on) => {
    world(on)
    for (const type of ['general-purpose', 'fe:implementer', '']) {
      const ctx = (await subagent($, type)).additionalContext[0] as string
      expect(ctx).toContain(UNTRUSTED_CONTENT)
      expect(ctx).toContain(COMMENT_DISCIPLINE)
      expect(ctx).toContain(LEAN_CODE)
      expect(ctx).not.toContain(WRITING_STYLE)
    }
  })

  test('BASE_LEAN=0 → no lean code for a code-writing agent', async ($, on) => {
    world(on, { env: { BASE_LEAN: '0' } })
    const ctx = (await subagent($, 'general-purpose')).additionalContext[0] as string
    expect(ctx).toContain(COMMENT_DISCIPLINE)
    expect(ctx).not.toContain(LEAN_CODE)
  })

  test('a fork gets nothing: it inherits the parent\'s system prompt', async ($, on) => {
    world(on)
    const r = await subagent($, 'fork')
    expect(r.additionalContext ?? []).toHaveLength(0)
  })

  test('context from the hooks beneath is kept, base\'s comes after it', async ($, on) => {
    mock.env(on, {})
    on('classic.SubagentStart', async () => ({ additionalContext: ['from below'] }) as never)
    const r = await subagent($, 'base:jira-reader')
    expect(r.additionalContext).toHaveLength(2)
    expect(r.additionalContext[0]).toBe('from below')
  })
})
