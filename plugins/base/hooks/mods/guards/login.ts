// The storefront-login rule for a browser MCP's code tool, pure: code that both targets a storefront's password gate
// and fills or submits it is login code, which references/storefront-login.md replaces with the MCP's own fill.
// Built from the transcripts' real calls; the rows in hooks/mods/tests/login.test.ts are the FP/FN contract. A mere
// `/password` path check, a gate probe that only reads the form, or a click elsewhere passes. Code loaded from a
// `filename` / `sourcePath` is not read.

/** The code tools on any server: Playwright's and chrome-devtools'. */
export const LOGIN_TOOLS = /^(?:browser_run_code_unsafe|browser_evaluate|evaluate_script)$/

/** The gate itself: matched anywhere, one fill or submit anywhere in the code makes it login code. */
const GATE = [
  /storefront_password/,
  /\bform\[action\*?=\s*["']?[^\]]*password/i,
  /\b(?:goto|fetch)\s*\([^)\n]*\/password\b/,
]
/** A password field, which a customer login has too: login code only when the fill or submit acts on it. */
const FIELD = [
  /\[\s*(?:type|name)\s*=\s*["']?password\b/i,
  /#password\b/,
  /getBy(?:Label|Placeholder)\(\s*(?:\/|["'`])password/i,
  /getByRole\(\s*["'`]textbox["'`]\s*,\s*\{\s*name\s*:\s*(?:\/|["'`])password/i,
]
const ACT = [
  /\.(?:fill|type|pressSequentially)\s*\(/,
  /\.value\s*=(?!=)/,
  /\.(?:submit|requestSubmit)\s*\(/,
  /method\s*:\s*["'`]POST/i,
  /\.(?:append|set)\s*\(\s*["'`]password["'`]/,
]
const CUSTOMER = /\/account\/login|customer_login/
/** A snapshot ref (`e12`) or uid (`1_4`): the element a call is handed, unnamed. */
const REF = /^[a-z]?\d+(?:_\d+)*$/i

const any = (rs: RegExp[], s: string) => rs.some(r => r.test(s))

/** True when `code` targets a storefront password gate and fills or submits it. */
export function isStorefrontLogin(code: string): boolean {
  if (!any(ACT, code)) return false
  if (any(GATE, code)) return true
  if (CUSTOMER.test(code)) return false
  const parts = code.split(/[;\n]/)
  const vars = new Set<string>()
  for (const p of parts) {
    if (!any(FIELD, p)) continue
    if (any(ACT, p)) return true
    const m = /\b(?:const|let|var)\s+(\w+)\s*=|^\s*(\w+)\s*=(?!=)/.exec(p)
    if (m) vars.add((m[1] ?? m[2])!)
  }
  return parts.some(p => any(ACT, p) && [...vars].some(v => new RegExp(`\\b${v}\\b`).test(p)))
}

/** True when a code tool's call is storefront login: its code alone, or code acting on the element the call hands it
 * (Playwright's `target` / `element`, chrome-devtools' `args` uids) when that element names the password field, or is
 * an unnamed ref the code fills and submits. */
export function isLoginCall(args: Record<string, unknown>): boolean {
  const code = codeOf(args)
  if (isStorefrontLogin(code)) return true
  const el = [args.target, args.element].filter((v): v is string => typeof v === 'string')
  const uids = Array.isArray(args.args) ? args.args.filter((v): v is string => typeof v === 'string') : []
  if (!el.length && !uids.length) return false
  if (el.some(t => /password/i.test(t))) return any(ACT, code)
  const unnamed = el.every(t => REF.test(t.trim())) && (el.length > 0 || uids.length > 0)
  return unnamed && /\.value\s*=(?!=)/.test(code) && /\.(?:submit|requestSubmit)\s*\(/.test(code)
}

/** The code string of a code tool's call: Playwright's `code` or `function`, chrome-devtools' `function`. */
export function codeOf(args: Record<string, unknown>): string {
  return [args.code, args.function].filter((v): v is string => typeof v === 'string').join('\n')
}

export function loginDenyText(root: string): string {
  return 'base: storefront login code refused — log in with the browser MCP\'s own tools instead: ' +
    `1) \`node ${root}/scripts/qa-stores.cjs get <store> --field password\` prints the password; ` +
    '2) open https://<domain>/password; ' +
    '3) take a snapshot and the ref (Playwright) or uid (chrome-devtools) of `form[action*="/password"] input[name=password]`; ' +
    '4) fill it with browser_type (Playwright) or fill (chrome-devtools); ' +
    '5) submit with Enter and wait for domcontentloaded; ' +
    '6) verify: still on /password → the password is wrong or stale, ask for the current one. ' +
    `The rule: ${root}/references/storefront-login.md. ` +
    'This refusal comes once per session: when the steps above cannot work on this page, the same call runs.'
}
