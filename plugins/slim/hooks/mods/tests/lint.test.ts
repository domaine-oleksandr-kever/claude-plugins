import { describe, expect, test } from 'claude-code/testing'
import { LINT_CMD, LINT_GATE, candidate, viewOf } from '../channels.ts'

describe('lint admission', () => {
  const bash = (stdout: string, command: string) =>
    viewOf('bash', { result: { stdout, stderr: '', interrupted: false } }, { command })!
  const plain = (n: number) => 'line of plain text\n'.repeat(Math.ceil(n / 19)).slice(0, n)
  const P = 65536

  test('Bash: a linter command over 8 KB is a candidate, plain text from another command is not', () => {
    expect(LINT_GATE).toBe(8192)
    expect(candidate('bash', bash(plain(10_000), 'npx eslint src'), P)).toBe(true)
    expect(candidate('bash', bash(plain(10_000), 'shopify theme check'), P)).toBe(true)
    expect(candidate('bash', bash(plain(7_000), 'npx eslint src'), P)).toBe(false)
    expect(candidate('bash', bash(plain(10_000), 'cat report.txt'), P)).toBe(false)
    expect(candidate('bash', bash(plain(10_000), 'cat build.log'), P)).toBe(false)
  })

  test('LINT_CMD: the command word of a pipeline segment', () => {
    for (const c of ['eslint .', 'cd theme && npx stylelint "**/*.css"', 'npm run lint:css', 'yarn tsc -p .', 'prettier --check .']) expect(LINT_CMD.test(c)).toBe(true)
    for (const c of ['cat eslint.txt', 'grep -rn tsc src', 'npm test', 'echo prettier']) expect(LINT_CMD.test(c)).toBe(false)
  })
})
