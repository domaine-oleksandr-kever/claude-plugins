import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { SHELL_WRITE, atOrBelow, draftRefusal, editRefusal, inScope, markerModel, modelFamily, shellReadsDraft } from '../guards/edit.ts'
import { PEEK, ROOT, TASKS, eventsOf, peek, run, start, submit, world } from './world.ts'

const HOME = '/home/dev'
const marker = (w: any, edit: unknown, sid = 's1') =>
  (w.files[`${HOME}/.claude/domaine/log/${sid}/conventions.base.rules.json`] = { text: JSON.stringify({ part: 'rules', ...(edit ? { edit } : {}) }), mtimeMs: 0 })
const SONNET = { model: 'sonnet', kind: 'work', source: 'login record' }

/** A world on HOME with the session model `model` (a throw when it is an Error). */
function setup(on: On, model: string | Error = 'claude-opus-5-5', env: Record<string, string> = {}) {
  // registered before the world's catch-all, so it answers first: a failing Edit
  on('tool.call', { tool: 'Edit', file_path: '/repo/bad.ts' } as any, async () => ({ result: 'no match', isError: true }) as any)
  const r = world(on, { env: { HOME, ...env } })
  const m = { model }
  on('session.model', async () => {
    if (m.model instanceof Error) throw m.model
    return { value: m.model }
  })
  return { ...r, m }
}
const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const edit = ($: any, file_path: string, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', ...extra })
const write = ($: any, file_path: string, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'Write', file_path, content: 'x', ...extra })
const bash = ($: any, command: string, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'Bash', command, ...extra })
const readFile = ($: any, file_path: string, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'Read', file_path, ...extra })
const direct = ($: any) => run($, '', 'base-edit-direct')
const edits = async ($: any) => (await peek($)).mainEdits

describe('edit guard (pure)', () => {
  test('modelFamily / atOrBelow / inScope / markerModel', async () => {
    expect(modelFamily('claude-opus-5-5[1m]')).toBe('opus')
    expect(modelFamily('claude-haiku-5-5')).toBe('haiku')
    expect(modelFamily(null)).toBe(null)
    expect(atOrBelow('sonnet', 'sonnet')).toBe(true)
    expect(atOrBelow('haiku', 'sonnet')).toBe(true)
    expect(atOrBelow('opus', 'sonnet')).toBe(false)
    expect(atOrBelow(null, 'opus')).toBe(false)
    expect(atOrBelow('x', 'opus')).toBe(false)
    expect(inScope('/repo/src/a.ts', ROOT)).toBe(true)
    expect(inScope('src/a.ts', ROOT)).toBe(true)
    expect(inScope('/repo/.claude/tasks/X/notes.md', ROOT)).toBe(false)
    expect(inScope('/tmp/x.html', ROOT)).toBe(false)
    expect(inScope('/repository/a.ts', ROOT)).toBe(false)
    expect(markerModel('{"edit":{"model":"sonnet"}}')).toBe('sonnet')
    expect(markerModel('{"edit":{"model":"fable"}}')).toBe(null)
    expect(markerModel('{}')).toBe(null)
    expect(markerModel('not json')).toBe(null)
  })

  test('the shell-write pattern', async () => {
    for (const c of ["sed -i '' 's/a/b/' src/a.ts", 'sed -E -i s/a/b/ x', 'perl -pi -e s/a/b/ x', 'echo x > src/a.ts', 'cat >> a.ts', 'tee src/a.ts', 'git apply p.diff', 'patch -p1 < p'])
      expect(SHELL_WRITE.test(c)).toBe(true)
    for (const c of ['grep foo src', 'sed -n 1,20p a.ts', 'npm test 2>&1', "node -e 'x=>x'", 'ls -> y', 'git status'])
      expect(SHELL_WRITE.test(c)).toBe(false)
  })
})

describe('edit guard', () => {
  t('a main-loop Edit under the root is refused while the marker names the delegate, every time', async ($, on) => {
    const { w } = setup(on)
    marker(w, SONNET)
    await start($)
    const r1 = await edit($, '/repo/src/a.ts')
    expect(r1.deny).toBe(editRefusal('sonnet'))
    expect((await eventsOf($, 'guard')).map(e => e.text)).toEqual(['Edit: main session — delegate to Agent(model: sonnet)'])
    expect(await edits($)).toEqual({ sid: 's1', n: 0, files: [], shell: 0, refused: 1, direct: false })
    const r2 = await edit($, '/repo/src/a.ts')
    expect(r2.deny).toBe(editRefusal('sonnet'))
    expect((await edits($)).refused).toBe(2)
  })

  t('/base-edit-direct allows and counts, one delegate event per new file', async ($, on) => {
    const { w } = setup(on)
    marker(w, SONNET)
    await start($)
    expect((await direct($)).text).toBe('base: direct edits allowed for this session (edit delegation: sonnet); /clear starts over.')
    expect((await edit($, '/repo/src/a.ts')).deny).toBeUndefined()
    expect((await edits($)).n).toBe(1)
    expect((await eventsOf($, 'delegate')).map(e => e.text)).toEqual(['main-session Edit of src/a.ts (delegation: sonnet, direct)'])
    await edit($, '/repo/src/a.ts')
    expect((await edits($)).n).toBe(2)
    expect(await eventsOf($, 'delegate')).toHaveLength(1)
    await write($, '/repo/src/b.ts')
    expect((await eventsOf($, 'delegate')).map(e => e.text)).toEqual([
      'main-session Edit of src/a.ts (delegation: sonnet, direct)',
      'main-session Write of src/b.ts (delegation: sonnet, direct)',
    ])
    expect((await edits($)).files).toEqual(['/repo/src/a.ts', '/repo/src/b.ts'])
  })

  t('a run another plugin queues grants nothing', async ($, on) => {
    const { w } = setup(on)
    marker(w, SONNET)
    await start($)
    const r = await $.command.run({ command: 'base-edit-direct', args: '', origin: { kind: 'plugin', name: 'x' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(r.text).toContain("is the developer's to run at the prompt")
    expect((await edit($, '/repo/src/a.ts')).deny).toBe(editRefusal('sonnet'))
  })

  t('a session on the delegate family or a cheaper one edits without the command, counted', async ($, on) => {
    const { w, m } = setup(on, 'claude-sonnet-5-5')
    marker(w, SONNET)
    await start($)
    expect((await edit($, '/repo/src/a.ts')).deny).toBeUndefined()
    expect((await eventsOf($, 'delegate')).map(e => e.text)).toEqual(['main-session Edit of src/a.ts (delegation: sonnet)'])
    m.model = 'claude-haiku-5-5'
    expect((await edit($, '/repo/src/c.ts')).deny).toBeUndefined()
    expect((await edits($)).n).toBe(2)
  })

  t("a subagent's Edit is neither refused nor counted", async ($, on) => {
    const { w } = setup(on)
    marker(w, SONNET)
    await start($)
    expect((await edit($, '/repo/src/a.ts', { agentId: 'a1' })).deny).toBeUndefined()
    expect(await eventsOf($, 'delegate')).toEqual([])
    expect(await edits($)).toBe(null)
  })

  t('files under .claude/, outside the root, the scratchpad and memory are allowed and not counted', async ($, on) => {
    const { w } = setup(on)
    marker(w, SONNET)
    await start($)
    for (const p of [`${TASKS}/ABC-1/notes.md`, '/tmp/x.html', '/private/tmp/claude-501/x/scratchpad/p.html', '/home/u/.claude/projects/x/memory/m.md'])
      expect((await write($, p)).deny).toBeUndefined()
    expect(await edits($)).toBe(null)
    expect(await eventsOf($, 'guard')).toEqual([])
  })

  t('no marker, or a marker without edit: no guard, no count', async ($, on) => {
    const { w } = setup(on)
    await start($)
    expect((await edit($, '/repo/src/a.ts')).deny).toBeUndefined()
    expect(await edits($)).toBe(null)
    w.sid = 's2'
    marker(w, null, 's2')
    expect((await edit($, '/repo/src/a.ts')).deny).toBeUndefined()
    expect(await edits($)).toBe(null)
  })

  t('the marker is read once per session id: a late marker does not turn the guard on', async ($, on) => {
    const { w } = setup(on)
    await start($)
    await edit($, '/repo/src/a.ts')
    marker(w, SONNET)
    expect((await edit($, '/repo/src/a.ts')).deny).toBeUndefined()
    expect((await peek($)).delegation).toEqual({ sid: 's1', model: null })
  })

  t('BASE_GUARD=0 never refuses and still counts', async ($, on) => {
    const { w } = setup(on, 'claude-opus-5-5', { BASE_GUARD: '0' })
    marker(w, SONNET)
    await start($)
    expect((await edit($, '/repo/src/a.ts')).deny).toBeUndefined()
    expect((await edits($)).n).toBe(1)
  })

  t('BASE_EVENT_LOG=0 writes no events; the atom still counts', async ($, on) => {
    const { w } = setup(on, 'claude-opus-5-5', { BASE_EVENT_LOG: '0' })
    marker(w, SONNET)
    await start($)
    await edit($, '/repo/src/a.ts')
    await direct($)
    await edit($, '/repo/src/a.ts')
    expect((await peek($)).events).toEqual([])
    expect(await edits($)).toEqual({ sid: 's1', n: 1, files: ['/repo/src/a.ts'], shell: 0, refused: 1, direct: true })
  })

  t('a new session id (a /clear) refuses again: direct is reset', async ($, on) => {
    const { w } = setup(on)
    marker(w, SONNET)
    await start($)
    await direct($)
    expect((await edit($, '/repo/src/a.ts')).deny).toBeUndefined()
    w.sid = 's2'
    marker(w, SONNET, 's2')
    await submit($, 'after a clear')
    expect((await edit($, '/repo/src/a.ts')).deny).toBe(editRefusal('sonnet'))
    expect(await edits($)).toEqual({ sid: 's2', n: 0, files: [], shell: 0, refused: 1, direct: false })
  })

  t('an error result is not counted', async ($, on) => {
    const { w } = setup(on, 'claude-sonnet-5-5')
    marker(w, SONNET)
    await start($)
    await edit($, '/repo/bad.ts')
    expect(await edits($)).toBe(null)
  })

  t('NotebookEdit is refused like Edit', async ($, on) => {
    const { w } = setup(on)
    marker(w, SONNET)
    await start($)
    const r = await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/repo/n.ipynb', new_source: 'x' })
    expect(r.deny).toBe(editRefusal('sonnet'))
  })

  t('a session model that does not answer counts as not cheaper', async ($, on) => {
    const { w } = setup(on, new Error('no model yet'))
    marker(w, { model: 'haiku', kind: 'override', source: 'BASE_EDIT_MODEL' })
    await start($)
    expect((await edit($, '/repo/src/a.ts')).deny).toBe(editRefusal('haiku'))
  })

  t('the command is registered at session start', async ($, on) => {
    const { calls } = setup(on)
    await start($)
    expect(calls.commands).toContain('base-edit-direct')
  })
})

describe('shell writes', () => {
  t('a main-loop shell write under the root is counted, never refused', async ($, on) => {
    const { w } = setup(on)
    marker(w, SONNET)
    await start($)
    const r = await bash($, "sed -i '' 's/a/b/' src/a.ts")
    expect(r.deny).toBeUndefined()
    expect((await edits($)).shell).toBe(1)
    await bash($, "cat > .claude/tasks/X/notes.md <<'EOF'\nx\nEOF")
    await bash($, 'grep foo src')
    await bash($, 'echo x > /dev/null')
    await bash($, "sed -i '' 's/a/b/' src/a.ts", { agentId: 'a1' })
    expect((await edits($)).shell).toBe(1)
  })

  t('no delegation: no shell count', async ($, on) => {
    setup(on)
    await start($)
    await bash($, 'echo x > src/a.ts')
    expect(await edits($)).toBe(null)
  })
})

describe('draft read guard', () => {
  const DRAFT = `${TASKS}/ABC-1/steps-to-test.md`
  t("a main-loop Read of a drafter's draft is refused on any model and after /base-edit-direct; a subagent's and another workspace file are not", async ($, on) => {
    const { w, m } = setup(on)
    marker(w, SONNET)
    w.files[DRAFT] = { text: 'draft', mtimeMs: 0 }
    await start($)
    const r = await readFile($, DRAFT)
    expect(r.deny).toBe(draftRefusal('.claude/tasks/ABC-1/steps-to-test.md'))
    expect((await readFile($, `${TASKS}/ABC-1/pr-body.md`)).deny).toBeDefined()
    expect((await readFile($, `${TASKS}/ABC-1/jira-comment.md`)).deny).toBe(draftRefusal('.claude/tasks/ABC-1/jira-comment.md'))
    expect((await eventsOf($, 'guard')).map(e => e.text)).toEqual([
      "Read: main session — .claude/tasks/ABC-1/steps-to-test.md is a drafter's draft",
      "Read: main session — .claude/tasks/ABC-1/pr-body.md is a drafter's draft",
      "Read: main session — .claude/tasks/ABC-1/jira-comment.md is a drafter's draft",
    ])
    expect((await edits($)).refused).toBe(3)
    expect((await readFile($, DRAFT, { agentId: 'a1' })).deny).toBeUndefined()
    expect((await readFile($, `${TASKS}/ABC-1/notes.md`)).deny).toBeUndefined()
    expect((await readFile($, '/elsewhere/.claude/tasks/ABC-1/pr-body.md')).deny).toBeDefined()
    m.model = 'claude-haiku-5-5'
    expect((await readFile($, DRAFT)).deny).toBeDefined()
    expect((await edit($, '/repo/src/a.ts')).deny).toBeUndefined()
    m.model = 'claude-opus-5-5'
    await direct($)
    expect((await readFile($, DRAFT)).deny).toBeDefined()
    expect((await edit($, '/repo/src/b.ts')).deny).toBeUndefined()
  })

  test('the shell draft-read pattern', async () => {
    const W = '/repo/.claude/tasks/ABC-1'
    for (const c of [`cat ${W}/steps-to-test.md`, `sed -n 1,20p ${W}/pr-body.md`, `grep -n Theme ${W}/steps-to-test.md`, `head .claude/tasks/ABC-1/pr-body.md`,
      'cat "$W/steps-to-test.md"', `cat ${W}/jira-comment.md`, `node drafter-check.cjs file stt ${W}/steps-to-test.md && cat ${W}/steps-to-test.md`])
      expect(shellReadsDraft(c)).toBe(true)
    for (const c of [`node /fe/scripts/drafter-check.cjs file stt ${W}/steps-to-test.md`, `gh pr create --title t --body-file ${W}/pr-body.md`,
      `test -s ${W}/pr-body.md`, `test -s ${W}/jira-comment.md`, `ls ${W}/steps-to-test.md`, 'grep -rn steps-to-test.md plugins/fe', `cat ${W}/notes.md`,
      `node /fe/scripts/drafter-check.cjs receipt jira <<'TXT'\nwritten: ${W}/jira-comment.md\nunconfirmed: []\nreport: PR line\nTXT`,
      `printf 'written: ${W}/pr-body.md\\n' | node /fe/scripts/drafter-check.cjs receipt pr`])
      expect(shellReadsDraft(c)).toBe(false)
  })

  test('a draft path in a shell variable: the assignment is no read, a later use is matched with the value', async () => {
    const P = 'P=.claude/tasks/ELC-1217/pr-body.md'
    for (const c of [`${P}; node /fe/scripts/drafter-check.cjs file pr "$P" | head -2 && gh pr create --title t --body-file "$P"`,
      `${P}; node /fe/scripts/drafter-check.cjs file pr "$P" && gh pr create --title t --body-file "$P"`,
      P, `export ${P}`, `local W=/repo/.claude/tasks/ABC-1; test -s "$W/steps-to-test.md"`, `W=/repo/.claude/tasks/ABC-1 P="$W/pr-body.md"; ls $P`])
      expect(shellReadsDraft(c)).toBe(false)
    for (const c of [`${P}; cat "$P"`, `${P}; sed -n 1,5p $P`, `export ${P}; head \${P}`, `W=/repo/.claude/tasks/ABC-1; P="$W/pr-body.md"; cat "$P"`,
      `${P}; node /fe/scripts/drafter-check.cjs file pr "$P" && cat "$P"`, 'P="$(cat .claude/tasks/ABC-1/pr-body.md)"', 'P=`cat .claude/tasks/ABC-1/pr-body.md`'])
      expect(shellReadsDraft(c)).toBe(true)
  })

  t('a main-loop cat, sed -n or grep of a draft is refused; the checker, gh --body-file and a subagent are not', async ($, on) => {
    const { w } = setup(on)
    marker(w, SONNET)
    await start($)
    const D = `${TASKS}/ABC-1/steps-to-test.md`
    expect((await bash($, `cat ${D}`)).deny).toBe(draftRefusal('.claude/tasks/ABC-1/steps-to-test.md'))
    expect((await bash($, `sed -n 1,40p ${TASKS}/ABC-1/pr-body.md`)).deny).toBeDefined()
    expect((await bash($, `grep -n Theme ${D}`)).deny).toBeDefined()
    expect((await eventsOf($, 'guard')).map(e => e.text)[0]).toBe("Bash: main session — .claude/tasks/ABC-1/steps-to-test.md is a drafter's draft")
    expect((await edits($)).refused).toBe(3)
    expect((await bash($, `node /fe/scripts/drafter-check.cjs file stt ${D}`)).deny).toBeUndefined()
    expect((await bash($, `gh pr create --title t --body-file ${TASKS}/ABC-1/pr-body.md`)).deny).toBeUndefined()
    expect((await bash($, `cat ${D}`, { agentId: 'a1' })).deny).toBeUndefined()
    expect((await edits($)).refused).toBe(3)
  })

  t('a main-loop Grep or slim view of a draft is refused; a subagent\'s is not', async ($, on) => {
    const { w } = setup(on)
    marker(w, SONNET)
    await start($)
    const D = `${TASKS}/ABC-1/pr-body.md`
    expect((await $.tool.call({ tool: 'Grep', pattern: 'x', path: D })).deny).toBe(draftRefusal('.claude/tasks/ABC-1/pr-body.md'))
    expect((await $.tool.call({ tool: 'Grep', pattern: 'x', path: `${TASKS}/ABC-1`, glob: 'steps-to-test.md' })).deny).toBeDefined()
    expect((await $.tool.call({ tool: 'Grep', pattern: 'x', path: `${TASKS}/ABC-1`, glob: '*.json' })).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'mcp__slim__view', path: D })).deny).toBeDefined()
    expect((await $.tool.call({ tool: 'Grep', pattern: 'x', path: D, agentId: 'a1' })).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'mcp__slim__view', path: D, agentId: 'a1' })).deny).toBeUndefined()
    expect((await edits($)).refused).toBe(3)
  })

  t('BASE_GUARD=0 reads the draft', async ($, on) => {
    const { w } = setup(on, 'claude-opus-5-5', { BASE_GUARD: '0' })
    marker(w, SONNET)
    await start($)
    expect((await readFile($, `${TASKS}/ABC-1/pr-body.md`)).deny).toBeUndefined()
  })

  t('no marker, or a marker with delegation off: the draft is still refused, the edit is not', async ($, on) => {
    setup(on)
    await start($)
    expect((await readFile($, `${TASKS}/ABC-1/pr-body.md`)).deny).toBe(draftRefusal('.claude/tasks/ABC-1/pr-body.md'))
    expect((await edit($, '/repo/src/a.ts')).deny).toBeUndefined()
  })

  t('a marker without edit.model (BASE_EDIT_MODEL=0): the draft is still refused', async ($, on) => {
    const { w } = setup(on, 'claude-haiku-5-5')
    marker(w, null)
    await start($)
    expect((await bash($, `cat ${TASKS}/ABC-1/jira-comment.md`)).deny).toBe(draftRefusal('.claude/tasks/ABC-1/jira-comment.md'))
    expect((await $.tool.call({ tool: 'mcp__slim__view', path: `${TASKS}/ABC-1/steps-to-test.md` })).deny).toBeDefined()
  })

  t("no marker: a drafter's receipt piped or heredoc'd into drafter-check.cjs is not refused; a read after the heredoc is", async ($, on) => {
    setup(on)
    await start($)
    const R = `written: ${TASKS}/ABC-1/jira-comment.md\nunconfirmed: []\nreport: PR line`
    expect((await bash($, `node /fe/scripts/drafter-check.cjs receipt jira <<'TXT'\n${R}\nTXT`)).deny).toBeUndefined()
    expect((await bash($, `printf 'written: ${TASKS}/ABC-1/jira-comment.md\\nunconfirmed: []\\n' | node /fe/scripts/drafter-check.cjs receipt jira`)).deny).toBeUndefined()
    expect((await bash($, `node /fe/scripts/drafter-check.cjs receipt jira <<TXT\n${R}\nTXT\ncat ${TASKS}/ABC-1/jira-comment.md`)).deny).toBeDefined()
    expect((await edits($)).refused).toBe(1)
  })
})
