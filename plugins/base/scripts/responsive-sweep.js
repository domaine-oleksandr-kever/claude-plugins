// Browser snippet for references/responsive-sweep.md: measures one width of a responsive sweep (sideways page scroll,
// elements sticking out of the viewport, content spilling out of its box, text cut by its box, short text that wraps)
// and folds the measured widths into one text table. Runs in the page. One function declaration and nothing else, so
// the file is both a classic script (Playwright's addScriptTag) and a function source (chrome-devtools' sourcePath).
// opts: { widths: [breakpoint px…], step } starts a sweep and returns the widths to visit; { root: selector } or an
// Element (a chrome-devtools args uid) measures the current width (async); { table: true, maxRows, maxBytes } → text.
function responsiveSweep(opts) {
  const o = opts && opts.nodeType === 1 ? { root: opts } : opts || {}
  // An <input name="id"> clobbers a form's .id property; the attribute is the real id.
  const id = e => e.getAttribute('id')
  const seg = e => {
    if (id(e)) return '#' + id(e)
    const c = typeof e.className === 'string' ? e.className.trim().split(/\s+/).find(k => /^[A-Za-z_][\w-]*$/.test(k)) : ''
    return e.tagName.toLowerCase() + (c ? '.' + c : '')
  }
  const name = el => {
    const host = el.getRootNode().host
    if (host) return name(host) + ' >> ' + seg(el)
    if (id(el)) return seg(el)
    const p = el.parentElement
    let a = p
    while (a && !id(a)) a = a.parentElement
    return (a && a !== p ? '#' + id(a) + ' ' : '') + (p && p !== document.body ? seg(p) + ' > ' : '') + seg(el)
  }

  if (o.widths) {
    // A media-query em or rem is the initial 16 px font size, whatever the root's font size.
    const px = b => Math.round(parseFloat(b) * (/r?em\s*$/i.test(String(b)) ? 16 : 1))
    const step = o.step || 40, bps = o.widths.map(px).filter(b => b > 1)
    const set = new Set([1920])
    for (let w = 320; w <= 1920; w += step) set.add(w)
    for (const b of bps) { set.add(b); set.add(b - 1) }
    globalThis.__responsiveSweep = { step, bps, seen: {} }
    return [...set].sort((a, b) => a - b)
  }

  if (o.table) {
    const t = globalThis.__responsiveSweep || { seen: {} }
    const widths = Object.keys(t.seen).map(Number).sort((a, b) => a - b)
    if (!widths.length) return 'responsive sweep: no width measured'
    // Repeated cards differ only in a product or variant id: one row for them all, a lone one keeps its real selector.
    const fold = sel => sel.replace(/\d{4,}/g, '…')
    const rows = new Map()
    widths.forEach((w, i) => {
      const here = new Map()
      for (const f of t.seen[w]) {
        const key = fold(f.sel) + '|' + f.kind + '|' + (f.kind === 'lines' ? f.px : f.label)
        const h = here.get(key) || { ...f, n: 0, sels: new Set() }
        h.n++
        h.sels.add(f.sel)
        h.px = Math.max(h.px, f.px)
        here.set(key, h)
      }
      for (const [key, h] of here) {
        const r = rows.get(key) || { ...h, at: [], n: 0, px: 0, sels: new Set() }
        for (const x of h.sels) r.sels.add(x)
        r.at.push(i)
        r.n = Math.max(r.n, h.n)
        r.px = Math.max(r.px, h.px)
        rows.set(key, r)
      }
    })
    const ORDER = ['scroll', 'offscreen', 'spill', 'clip', 'clip-x', 'lines']
    const WHAT = {
      scroll: r => `page scrolls sideways +${r.px}px`,
      offscreen: r => `sticks out of the viewport +${r.px}px`,
      spill: r => `content spills out of its box +${r.px}px`,
      clip: r => `text cut by a fixed height +${r.px}px` + (r.label ? ` (${r.label})` : ''),
      'clip-x': r => `text cut at the side +${r.px}px` + (r.label ? ` (${r.label})` : ''),
      lines: r => `${r.px} lines`,
    }
    const ranges = at => {
      const out = []
      for (const i of at) {
        const last = out[out.length - 1]
        if (last && last[1] === i - 1) last[1] = i
        else out.push([i, i])
      }
      return out.map(([a, b]) => (a === b ? widths[a] : widths[a] + '-' + widths[b])).join(', ')
    }
    const list = [...rows.values()].map(r => (r.sels.size > 1 ? { ...r, sel: fold(r.sel) } : r)).sort((a, b) =>
      ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.sel.localeCompare(b.sel) || a.at[0] - b.at[0])
    const bytes = s => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, 'x').length
    const maxRows = o.maxRows || 30, maxBytes = o.maxBytes || 3000
    const bp = (t.bps || []).length ? `, breakpoints ${t.bps.join(' ')} and 1 px below` : ''
    const head = [
      `responsive sweep: root ${t.root || 'body'}, ${widths.length} widths ${widths[0]}-${widths[widths.length - 1]}` +
        (t.step ? ` (step ${t.step}${bp})` : '') + `, ${list.length} rows; a range runs from the first to the last measured width that shows it`,
      list.length ? 'element | finding | widths' : 'no findings at any measured width',
    ]
    let out = head.join('\n'), shown = 0
    for (const r of list) {
      const line = `${r.sel}${r.n > 1 ? ' ×' + r.n : ''} | ${WHAT[r.kind](r)} | ${ranges(r.at)}`
      if (shown >= maxRows || bytes(out) + 1 + bytes(line) > maxBytes) break
      out += '\n' + line
      shown++
    }
    if (shown < list.length) {
      out += `\n… ${list.length - shown} more rows dropped (cap ${maxRows} rows / ${maxBytes} bytes): ` +
        `responsiveSweep({ table: true, maxRows: ${list.length}, maxBytes: ${maxBytes * 4} }) shows them`
    }
    return out
  }

  return (async () => {
    if (document.fonts) await document.fonts.ready
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    const width = innerWidth
    const root = typeof o.root === 'string' ? document.querySelector(o.root) : o.root || document.body
    if (!root) return { width, error: 'root not found: ' + o.root }
    const t = globalThis.__responsiveSweep || (globalThis.__responsiveSweep = { seen: {} })
    t.root = typeof o.root === 'string' ? o.root : root === document.body ? 'body' : name(root)
    const de = document.documentElement, vw = de.clientWidth
    const found = [], off = [], spill = []
    const add = (el, kind, px, label = '') => found.push({ sel: el ? name(el) : 'page', kind, px: Math.round(px), label })
    if (de.scrollWidth > vw) add(null, 'scroll', de.scrollWidth - vw)
    const SHORT = 'h1,h2,h3,h4,h5,h6,button,a,label,summary,[role=button],[role=tab],[role=menuitem]'
    const short = e => e.matches(SHORT) || (e.tagName === 'LI' && !!e.closest('nav'))
    const ownText = e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
    const clips = v => v === 'hidden' || v === 'clip'
    const all = [], walk = e => { all.push(e); if (e.shadowRoot) for (const d of e.shadowRoot.querySelectorAll('*')) walk(d) }
    for (const e of [root, ...root.querySelectorAll('*')]) walk(e)
    const up = e => e.parentElement || e.getRootNode().host
    for (const el of all) {
      if (el === document.body || !el.getClientRects().length) continue
      const s = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      // A visually-hidden (sr-only) element is 1 px square by design.
      if (s.visibility === 'hidden' || (r.width <= 1 && r.height <= 1)) continue
      if (((r.left < -1 && r.right > 0) || (r.left < vw && r.right > vw + 1)) && !off.some(x => x.contains(el))) {
        let cut = false
        for (let a = up(el); a && a !== document.body && !cut; a = up(a)) cut = getComputedStyle(a).overflowX !== 'visible'
        if (!cut) { off.push(el); add(el, 'offscreen', Math.max(-r.left, r.right - vw)) }
      }
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
        if (s.overflowX === 'visible') spill.push(el)
        else if (clips(s.overflowX) && ownText(el)) add(el, 'clip-x', el.scrollWidth - el.clientWidth, s.textOverflow === 'ellipsis' ? 'ellipsis' : '')
      }
      if (clips(s.overflowY) && el.scrollHeight > el.clientHeight + 1) {
        const straddles = d => { const q = d.getBoundingClientRect(); return q.top < r.bottom - 1 && q.bottom > r.bottom + 1 }
        if (ownText(el) || [...el.querySelectorAll('*')].some(d => ownText(d) && straddles(d))) {
          const clamp = s.webkitLineClamp && s.webkitLineClamp !== 'none'
          add(el, 'clip', el.scrollHeight - el.clientHeight, clamp ? 'line-clamp' : '')
        }
      }
      const text = el.textContent.trim()
      if (text && text.length <= 40 && short(el) && ![...el.querySelectorAll('*')].some(short)) {
        // Text nodes only: a range over the element also returns the boxes of an icon or image above its label.
        const range = document.createRange(), rects = [], walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let n; (n = walk.nextNode());) if (n.textContent.trim()) { range.selectNodeContents(n); rects.push(...range.getClientRects()) }
        let lines = 0, bottom = -Infinity
        for (const q of rects.filter(q => q.width > 0).sort((a, b) => a.top - b.top)) {
          if (q.top >= bottom - 2) { lines++; bottom = q.bottom } else bottom = Math.max(bottom, q.bottom)
        }
        if (lines > 1) add(el, 'lines', lines)
      }
    }
    for (const el of spill) if (!spill.some(x => x !== el && el.contains(x))) add(el, 'spill', el.scrollWidth - el.clientWidth)
    t.seen[width] = found
    return { width, findings: found.length }
  })()
}
