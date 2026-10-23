import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { PEEK, peek, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const HOME = '/home/dev'
const INPUT = { model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], tools: ['Bash'], outputStyle: null, traits: [] }

describe('the conventions travel only as command hooks', () => {
  t('prompt.context adds no block, prompt.compose no section and SubagentStart no context, even where nothing draws', async ($, on) => {
    world(on, { surfaces: [], env: { HOME, BASE_DOGFOOD: '1' } })
    expect((await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'rules' }] })).blocks.map((b: any) => b.name)).toEqual(['claudeMd'])
    expect((await $.prompt.compose(INPUT)).sections.map((s: any) => s.id)).toEqual(['intro'])
    expect((await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' })).additionalContext ?? []).toEqual([])
    expect((await peek($)).checked).toBeNull()
  })
})
