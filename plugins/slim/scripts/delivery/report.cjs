// The one report log both plugins write (`fnd-mcp-slim-debug.log` in the spill root): one metadata
// line per invocation, never payload, and the --report that reads it back by src and by channel.
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./env.cjs');

const DEBUG_LOG = 'fnd-mcp-slim-debug.log';
const DEBUG_LOG_MAX = 5 * 1024 * 1024;
const SPILL_LOG_MAX = 8;
// Lines kept for level 2: the in==out ballast, and every passthrough the hooks module decided itself.
const LEVEL2 = new Set(['size-gate', 'already-slim', 'plain-gate', 'spill-read', 'own-cli', 'windowed-read', 'read-guard', 'not-text', 'no-span']);

// The nearest ancestor of `cwd` holding `.git`, else CLAUDE_PROJECT_DIR, else the cwd — basename only.
const projectMemo = new Map();
function projectName(cwd) {
  try {
    const from = cwd || process.cwd();
    const key = `${process.env.CLAUDE_PROJECT_DIR || ''}|${from}`;
    if (projectMemo.has(key)) return projectMemo.get(key);
    let root = '';
    let d = path.resolve(from);
    for (let i = 0; i < 64; i++) {
      if (fs.existsSync(path.join(d, '.git'))) { root = d; break; }
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
    const name = path.basename(path.resolve(root || String(process.env.CLAUDE_PROJECT_DIR || '').trim() || from)) || null;
    projectMemo.set(key, name);
    return name;
  } catch (_) {
    return null;
  }
}

// Appends one line, rotating past 5 MB. Never through a planted link or into a foreign file: the
// spill root may be a shared tmpdir.
function appendLine(record, cwd) {
  try {
    const root = env.spillRoot();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, DEBUG_LOG);
    try { const st = fs.lstatSync(file); if (st.isFile() && st.size >= DEBUG_LOG_MAX) fs.renameSync(file, `${file}.1`); } catch (_) {}
    let rec = record;
    if (Array.isArray(rec.spills)) {
      const uniq = [...new Set(rec.spills)];
      rec = { ...rec, spills: uniq.slice(0, SPILL_LOG_MAX) };
      if (uniq.length > SPILL_LOG_MAX) rec.spills_n = uniq.length;
      if (!uniq.length) delete rec.spills;
    }
    const project = projectName(cwd);
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...(project ? { project } : {}), lvl: env.debugLevel(), ...rec })}\n`;
    const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
    const fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | (O_NOFOLLOW || 0), 0o600);
    try {
      const st = fs.fstatSync(fd);
      if (st.isFile() && (typeof process.getuid !== 'function' || st.uid === process.getuid())) fs.writeSync(fd, line);
    } finally { fs.closeSync(fd); }
  } catch (_) {}
}

// One invocation's line, by level: errors, lookups and views always; a non-MCP size gate never (below the
// gate a Bash or Read call is not a slim invocation); the LEVEL2 reasons at 2; the rest at 1.
function writeLine(record, cwd) {
  if (record.decision === 'error' || record.channel === 'lookup' || record.channel === 'view') { appendLine(record, cwd); return; }
  if (record.reason === 'no-result') return;
  if (record.reason === 'size-gate' && record.channel && record.channel !== 'mcp') return;
  const level = env.debugLevel();
  if (!level || (level < 2 && LEVEL2.has(record.reason))) return;
  appendLine(record, cwd);
}

const REPORT_TOP_TOOLS = 5;
const REPORT_TOP_PROJECTS = 5;
const REPORT_MISSED = 8;

function fmtCounts(map) {
  return [...map.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(' · ');
}

// With fnd and slim both loaded, fnd's PreToolUse hook and slim's guard each log the same read: a slim
// line with an fnd twin (same tool and spill, within this window) is not counted again.
const ACCESS_TWIN_MS = 10000;
function dropTwins(access) {
  const others = new Map();
  for (const e of access) {
    if (e.src === 'slim') continue;
    const k = `${e.tool}|${e.spill}`;
    if (!others.has(k)) others.set(k, []);
    others.get(k).push(Date.parse(e.ts) || 0);
  }
  if (!others.size) return access;
  return access.filter((e) => {
    const ats = e.src === 'slim' ? others.get(`${e.tool}|${e.spill}`) : null;
    if (!ats) return true;
    const at = Date.parse(e.ts) || 0;
    const i = ats.findIndex((t) => Math.abs(t - at) <= ACCESS_TWIN_MS);
    if (i < 0) return true;
    ats.splice(i, 1);
    return false;
  });
}

function buildReport(lines, opts) {
  const o = opts || {};
  const since = o.since ? Date.parse(o.since) : null;
  const events = [];
  let skipped = 0;
  for (const line of lines) {
    if (!String(line).trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { skipped++; continue; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) { skipped++; continue; }
    if (since != null && !(Date.parse(r.ts) >= since)) continue;
    events.push(r);
  }
  // An `entry:"access"` line (slim's spill-read guard, fnd's hooks/spill-access.sh) is not a compression event: it measures that a
  // tool READ a spill. It carries no bytes, no decision and no stages, so every aggregate below runs
  // over `comp` and the access lines are only counted on their own line and paired as recoveries —
  // a log written before the hook existed therefore reports exactly the numbers it always did.
  const accessLines = events.filter((e) => e.entry === 'access');
  const denied = accessLines.filter((e) => e.denied === true);
  const access = dropTwins(accessLines.filter((e) => e.denied !== true));
  const twins = accessLines.length - denied.length - access.length;
  const comp = events.filter((e) => e.entry !== 'access');
  const out = [`slim: debug-log report — ${o.file || '(stdin)'}`];
  const stamps = events.map((e) => e.ts).filter(Boolean).sort();
  // The header counts the whole window; every aggregate below counts `comp`. Naming the split on the
  // line is what keeps the two populations reconcilable (`140 events` vs `100 events here came from…`).
  out.push(`  log: ${o.bytes != null ? `${o.bytes} B, ` : ''}${events.length} events` +
    `${accessLines.length ? ` (${accessLines.length} spill read${accessLines.length === 1 ? '' : 's'})` : ''}` +
    `${skipped ? ` (+${skipped} unparseable)` : ''}` +
    `${stamps.length ? `, ${stamps[0]} → ${stamps[stamps.length - 1]}` : ''}` +
    `${o.since ? `  [since ${o.since}]` : ''}`);
  if (!events.length) { out.push('  no events in range.'); return out.join('\n'); }

  const decisions = new Map(), reasons = new Map(), stages = new Map(), tools = new Map(), projects = new Map(), deliveries = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  // Access lines are the only population that can survive a window with no compression in it (a session
  // that read spills and made no MCP call), and the body below is all bytes and decisions — rendering it
  // over an empty `comp` printed a bare `decisions:` line and a headerless `projects:` block.
  let spillReads = '';
  if (accessLines.length) {
    const vias = new Map();
    for (const e of access) bump(vias, e.via || 'other');
    spillReads = `  spill reads (access hook): ${access.length}  (via: ${vias.size ? fmtCounts(vias) : 'none'})` +
      `${twins ? ` [+${twins} logged by both fnd and slim]` : ''}` +
      `${denied.length ? ` · denied by the spill-read guard: ${denied.length}` : ''}`;
  }
  if (!comp.length) { out.push('  no compression events in range.', spillReads); return out.join('\n'); }
  // What an event actually saved — only a `compressed`/`stubbed` decision shrank anything, whatever a
  // passthrough happened to log as bytes_out. One `shrunkOf` predicate, shared by the totals and
  // `savedOf`; `savedOf` feeds the per-tool/project/cli aggregates and the recovery pairing below.
  const shrunkOf = (e) => e.decision === 'compressed' || e.decision === 'stubbed';
  // …and what the HOST then DID with it (mcp-slim's `delivery`). A shrunk result is only a saving where
  // the host can replace the original: `discard` (a body the host's adapter could not put in place of
  // the result and dropped — the raw whale still stands) and `additional` (a stub forwarded as extra
  // context beside the raw result) both saved NOTHING, and `additional` also GREW the context. Absent on
  // every line written before the field and on every slim line, so those read as `replace`.
  const deliveryOf = (e) => String(e.delivery || 'replace');
  const savedOf = (e) => (shrunkOf(e) && deliveryOf(e) === 'replace'
    ? Math.max(0, (Number(e.bytes_seen ?? e.bytes_in) || 0) - (Number(e.bytes_out) || 0)) : 0);
  // A whole-file re-dump: the run printed the file back into context with no reduction. The designed
  // low-context recoveries are excluded by the marks their lines carry — a `--jq` narrowing, a JSONL
  // profile (`profile`), a Gate-A capped summary (`spill_out`), the path handbacks and the stream
  // refusals (by `reason`) — none of which put the payload back, whatever bytes_out they logged (a
  // handback line records bytes_out == bytes_in although it printed a ~120 B path line).
  // The two re-run guards answer with ONE line and never print the body, so they are not dumps
  // either — and they are counted on the cli line, because "how often did the guard fire" is the measure
  // of the re-run tax it exists to remove.
  const REFUSED_RERUN = new Set(['already-slim-out', 'no-gain-memo']);
  // `jq-unsupported` and `unknown-flag` join them: neither run read a body at all — one refused an
  // out-of-grammar filter, the other an unrecognized argument — so counting either as a re-dump would
  // report context cost nobody paid.
  const NOT_A_DUMP = new Set(['non-json', 'transform-error', 'error-shape', 'big-nonjsonl', 'stream-jq-refused', 'jq-unsupported', 'unknown-flag', ...REFUSED_RERUN]);
  const flatOf = (e) => !savedOf(e) && !e.narrowed && !e.profile && !e.spill_out && !NOT_A_DUMP.has(e.reason);
  let bytesIn = 0, bytesOut = 0;
  const cli = { n: 0, in: 0, saved: 0, flat: 0, memo: 0 };
  const spills = { paths: new Set(), events: 0, capped: 0 };
  // Collection level, read off the line rather than guessed: 1 = sub-gate events were dropped, so this
  // event's siblings are missing from the totals; ≥2 or absent (an older line, which recorded them even
  // at 1) = the window is complete.
  let lvl1 = 0, lvlFull = 0;
  for (const e of comp) {
    const bi = Number(e.bytes_seen ?? e.bytes_in) || 0;
    const bo = Number(e.bytes_out) || 0;
    // A `stubbed` event shrank the payload as surely as a compressed one — the model got a
    // ~1 KB stub instead of the whale — so it counts toward the savings wherever the host put it in
    // place of the whale (deliveryOf), and its `reason` names the branch it replaced, not a
    // passthrough (it is listed on its own line below).
    const shrunk = shrunkOf(e);
    const delivery = shrunk ? deliveryOf(e) : 'replace';
    bytesIn += bi;
    // A passthrough saved nothing, whatever it logged as bytes_out — and neither did a shrunk result the
    // host could not put in place of the original: `discard` left the raw result standing (bi), while
    // `additional` left it standing AND added something beside it (bi + what was delivered).
    // That addition is `delivered`, the part of the emission an adding host can carry (mcp-slim's own
    // measure of the stub texts), NOT bytes_out: a per-block stub envelope also holds the compressed
    // sibling blocks such a host drops, and charging those read 22,007 added bytes for 1,224 delivered.
    // It is still an approximation of the CONTEXT — the adapter wraps a header (~220 B) around the stubs
    // and truncates the set at its own budget — so it reads one header LOW on a single stub and, past
    // that budget, high on many. bytes_out is the fallback for a line written before the field.
    if (shrunk) bump(deliveries, delivery);
    const added = Number(e.delivered); // NaN on a line older than the field, or on a junk value
    bytesOut += shrunk && delivery === 'replace' ? bo
      : (delivery === 'additional' ? bi + (Number.isFinite(added) && added >= 0 ? added : bo) : bi);
    if (Number(e.lvl) === 1) lvl1++; else lvlFull++;
    bump(decisions, e.decision || 'unknown');
    if (!shrunk) bump(reasons, e.reason || 'unknown');
    for (const s of Array.isArray(e.stages) ? e.stages : []) bump(stages, s);
    const saved = savedOf(e);
    // A CLI event's `tool` is the FILE it ran on, not an MCP tool name — ranking those together
    // would let a handful of whale files crowd every MCP tool out of the top-5 and would double-count
    // the notice and the CLI run of the same whale. CLI work is aggregated on its own line instead.
    // `flat` (flatOf above) — counted so a followed-but-useless recovery is visible instead of reading
    // as savings-neutral work.
    if (e.entry === 'cli') { cli.n++; cli.in += bi; cli.saved += saved; if (flatOf(e)) cli.flat++; if (REFUSED_RERUN.has(e.reason)) cli.memo++; } else {
      const tk = e.tool || '(stdin)';
      const t = tools.get(tk) || { saved: 0, n: 0 };
      t.saved += saved; t.n++; tools.set(tk, t);
    }
    const p = projects.get(e.project || '(unknown)') || { saved: 0, n: 0 };
    p.saved += saved; p.n++; projects.set(e.project || '(unknown)', p);
    // Which files the run left on disk — the anchor for the orphan question, since a
    // stubbed/passed-through event's crush spills are exactly the files nobody will ever read. Paths are
    // DEDUPED across events: names are content-addressed, so repeat traffic names the same file from many
    // events, and summing the per-event lists would report the dedup factor as a file count (the live
    // week that motivated the change: 1030 names for 23 payloads). A capped line contributes the paths it
    // still names plus an upper bound (`spills_n`) for the ones it dropped.
    const listed = Array.isArray(e.spills) ? e.spills.filter((s) => typeof s === 'string' && s) : [];
    if (listed.length) {
      spills.events++;
      for (const s of listed) spills.paths.add(s);
      const total = Number(e.spills_n) || 0;
      if (total > listed.length) spills.capped += total - listed.length;
    }
  }
  const pct = bytesIn ? (100 * (1 - bytesOut / bytesIn)).toFixed(1) : '0.0';
  // The totals % changes MEANING with the collection level — level 1 omits the sub-gate lines, which are
  // the in==out ballast — so the level it came from is stated on the line itself, and a log that straddles
  // the switch is called out rather than averaged into one number nobody can compare.
  const levelTag = lvl1 && lvlFull
    ? `  [MIXED levels: ${lvl1} at =1 (sub-gate omitted) + ${lvlFull} complete — this % is not comparable]`
    : lvl1 ? '  [level 1 — sub-gate results not logged, so this % covers logged events only]' : '';
  // Totals and the per-project subtotals deliberately span BOTH entries — they answer "what did the
  // plugin save", hook and CLI alike. Only the RANKING is hook-only, because a cli `tool` is a path.
  out.push(`  totals: ${bytesIn} → ${bytesOut} B (${pct}% saved)${levelTag}`);
  out.push(`  decisions: ${fmtCounts(decisions)}`);
  // Candidate vs effective, and only where they differ: a log whose every shrunk result was delivered
  // by replacement reads as it always did, while one line says how much of the work above a host threw away or bolted on beside the raw
  // result. `stubbed`/`compressed` above are what the compressor DECIDED; this is what landed.
  if ([...deliveries.keys()].some((k) => k !== 'replace')) {
    out.push(`  delivery: ${fmtCounts(deliveries)}  [only replace saved bytes; discard/additional left the raw result standing]`);
  }
  if (reasons.size) out.push(`  passthrough reasons: ${fmtCounts(reasons)}`);
  if (stages.size) out.push(`  stages: ${fmtCounts(stages)}`);

  const topTools = [...tools.entries()].filter(([, t]) => t.saved > 0).sort((a, b) => b[1].saved - a[1].saved).slice(0, REPORT_TOP_TOOLS);
  out.push('  top tools by bytes saved (hook):');
  if (!topTools.length) out.push('    (no hook compressions)');
  for (const [name, t] of topTools) out.push(`    ${t.saved} B over ${t.n} call${t.n === 1 ? '' : 's'} — ${name}`);
  if (cli.n) out.push(`  cli runs: ${cli.n} · saved ${cli.saved} B (${cli.in ? (100 * cli.saved / cli.in).toFixed(1) : '0.0'}%)` +
    `${cli.flat ? ` · ${cli.flat} gained nothing (the file went into context for no reduction)` : ''}` +
    `${cli.memo ? ` · ${cli.memo} refused by the no-gain/slim-out guard (no body printed)` : ''}`);
  const topProjects = [...projects.entries()].sort((a, b) => b[1].saved - a[1].saved).slice(0, REPORT_TOP_PROJECTS);
  out.push('  projects:');
  for (const [name, p] of topProjects) out.push(`    ${name}: ${p.n} event${p.n === 1 ? '' : 's'}, ${p.saved} B saved`);

  if (spillReads) out.push(spillReads);

  // Missed whales: pair each platform-overflow event with a LATER cli run over the same spill path
  // (the stub's recovery command being followed). Basenames are compared too, so an equivalent path spelling
  // still pairs. Unpaired = the compressor never ran on that whale — the two-lever evidence number.
  // Content addressing does NOT reach this count: a platform-overflow `spill` is the PLATFORM's own
  // tool-results file, not one of our hash names, so no two of these events share a path.
  // Neither a refusal nor a usage error is a recovery: `jq-unsupported` and `unknown-flag` both read
  // no body and printed nothing, so pairing either with a whale would drop that whale out of the
  // count this number exists to give.
  const cliRuns = comp.filter((e) => e.entry === 'cli' && e.tool && (e.reason !== 'jq-unsupported' && e.reason !== 'unknown-flag'))
    .map((e) => ({ at: Date.parse(e.ts) || 0, tool: String(e.tool), via: 'json-slim', flat: flatOf(e) }));
  // …and a spill READ recovers the whale just as well: three targeted `jq` queries over a
  // tool-results file is the right move, and counting it as a miss is what this line was reporting
  // before the access hook existed. `via` names which tool got there, never a byte count.
  // …with one exception: `via:"named"` is the hook's mark for a command that only touched the NAME
  // (`rm`/`mv`/`ls`/`echo` …). Those bytes never entered a context, so pairing one would clear a whale
  // from the very count this line exists to give — a post-session `rm <spill>` would report full recovery.
  const accessRuns = access.filter((e) => e.spill && e.via !== 'named')
    .map((e) => ({ at: Date.parse(e.ts) || 0, tool: String(e.spill), via: String(e.via || 'other'), flat: false }));
  const runs = cliRuns.concat(accessRuns);
  // Indexed by basename once, and memoized per (event ts × path): access lines are the most frequent
  // line the log holds and `recoveries` is called ~3× per overflow/stub, so the linear scan this used to
  // be turned a 5 MB log into a 12 s `--report`. A path equal to `spill` shares its basename, so the
  // bucket subsumes the exact-path test.
  const runsByBase = new Map();
  for (const c of runs) {
    const b = path.basename(c.tool);
    const bucket = runsByBase.get(b);
    if (bucket) bucket.push(c); else runsByBase.set(b, [c]);
  }
  const recCache = new Map();
  // The runs that could be the recovery for this event: same spill path, not earlier. Empty = nobody
  // read it (an event whose path we could not extract is not provably handled either).
  const recoveries = (e) => {
    const spill = e.spill ? String(e.spill) : null;
    if (!spill) return [];
    const at = Date.parse(e.ts) || 0;
    const key = `${at}|${spill}`;
    const hit = recCache.get(key);
    if (hit) return hit;
    const found = (runsByBase.get(path.basename(spill)) || []).filter((c) => c.at >= at);
    recCache.set(key, found);
    return found;
  };
  const unpaired = (e) => recoveries(e).length === 0;
  // A whale the mod's tool.call hook slimmed out of its host file (mcp-slim `--overflow=expand`) was
  // recovered before the model read the notice — only when it went out compressed: a `mod-expand` stub
  // hands back the same file the notice named. Kept out of `runs`, so such a stub is not its own reader.
  const modExpanded = new Map();
  for (const e of comp) {
    if (e.reason !== 'mod-expand' || !e.spill || e.decision !== 'compressed') continue;
    const b = path.basename(String(e.spill));
    modExpanded.set(b, (modExpanded.get(b) || []).concat(Date.parse(e.ts) || 0));
  }
  const byMod = (e) => !!e.spill && (modExpanded.get(path.basename(String(e.spill))) || []).some((at) => at >= (Date.parse(e.ts) || 0));
  const overflows = comp.filter((e) => e.reason === 'platform-overflow');
  const missed = overflows.filter((e) => unpaired(e) && !byMod(e));
  out.push(`  missed whales (platform-overflow never read by any tool): ${missed.length} of ${overflows.length}`);
  for (const e of missed.slice(0, REPORT_MISSED)) out.push(`    ${e.ts || '(no ts)'}  ${e.tool || '(unknown tool)'}  →  ${e.spill || '(no path)'}`);
  if (missed.length > REPORT_MISSED) out.push(`    …(+${missed.length - REPORT_MISSED} more)`);
  // Stubbed results are NOT missed whales — the hook already replaced the payload with a stub
  // carrying the spill path and the CLI command, so an unused stub is a model choice (shown for
  // curiosity), not a gap in the pipeline. A FOLLOWED stub is not automatically a win either: a stub's
  // `spill` IS one of our content-addressed names, so two identical stubbed payloads name the same file
  // and one CLI run pairs both (that much optimism is real here), and a run that reduced nothing put the
  // payload into context anyway — reported separately, or "0 unfollowed" would read as full compliance.
  const stubbed = comp.filter((e) => e.decision === 'stubbed');
  if (stubbed.length) {
    const stubReasons = new Map();
    for (const e of stubbed) bump(stubReasons, e.reason || 'unknown');
    const flatFollowUp = stubbed.filter((e) => recoveries(e).some((c) => c.flat)).length;
    out.push(`  stubbed (spill-and-stub guard): ${stubbed.length} (${fmtCounts(stubReasons)}), ${stubbed.filter(unpaired).length} never read` +
      `${flatFollowUp ? `, ${flatFollowUp} whose run gained nothing` : ''}`);
  }
  // Which tool actually got to each whale — the follow-up question the missed count raises, and the
  // one the access hook exists to answer. Each whale counts once per DISTINCT via among its
  // recoveries, so two jq reads of one spill are one jq recovery, not two.
  const recoveryVias = new Map();
  for (const e of overflows.concat(stubbed)) {
    for (const v of new Set(recoveries(e).map((c) => c.via))) bump(recoveryVias, v);
  }
  for (const e of overflows) if (byMod(e)) bump(recoveryVias, 'mod');
  if (recoveryVias.size) out.push(`  whale recoveries via: ${fmtCounts(recoveryVias)}`);
  if (spills.events) {
    out.push(`  spill files: ${spills.paths.size} named by ${spills.events} event${spills.events === 1 ? '' : 's'}` +
      `${spills.capped ? ` (+ up to ${spills.capped} more the capped lines did not name)` : ''}`);
  }
  // Honesty, not a fix: at level 1 the sub-gate lines are never recorded, so `totals` and the call
  // counts speak about LOGGED events. Missed whales, stubbed and the per-stage counts are unaffected —
  // those events are logged at every level. Read off `lvl`, so a =2 log gets no caveat and a level-1 log
  // keeps it even when a foreign `size-gate` line from another project shares the file.
  if (lvl1) {
    out.push('  note: sub-gate results (≤4 KB, reason size-gate) are logged only at SLIM_DEBUG=2 — ' +
      `${lvl1} of ${comp.length} events here came from level 1, so totals and call counts cover logged events.`);
  }
  return out.join('\n');
}

const seenBytes = (e) => Number(e.bytes_seen ?? e.bytes_in) || 0;
const shrunk = (e) => e.decision === 'compressed' || e.decision === 'stubbed';
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
// A summary of a persisted output is bigger than the host's preview of it: that is a grown view, not a
// negative saving, so it is worded as one, over the shrunk events only; passthroughs are named apart.
function saving(k, t) {
  if (t.out <= t.in) return `${k} ${t.in} → ${t.out} B (${t.in ? (100 * (1 - t.out / t.in)).toFixed(1) : '0.0'}% saved)`;
  const grew = !t.sIn ? '' : t.sOut / t.sIn >= 1.1 ? `; the view grew ×${(t.sOut / t.sIn).toFixed(1)}` : `; the view grew by ${commas(t.sOut - t.sIn)} B`;
  const rest = t.n - t.sn;
  return `${k}: ${t.sn} result${t.sn === 1 ? '' : 's'}, ${commas(t.whole)} B of output summarised into ${commas(t.sOut)} B ` +
    `(host preview would have shown ${commas(t.sIn)} B${grew})${rest ? ` + ${rest} passed through (${commas(t.out - t.sOut)} B)` : ''}`;
}

// Totals per key: what the model would have seen (bytes_seen when the host had already moved the
// output to a file and shows a preview) and what the model got (the output for a shrunk event, else
// the input); for the shrunk events alone, the same two plus the whole output.
function totalsBy(events, keyOf) {
  const m = new Map();
  for (const e of events) {
    const k = keyOf(e);
    const t = m.get(k) || { n: 0, in: 0, out: 0, sn: 0, sIn: 0, sOut: 0, whole: 0 };
    const bi = seenBytes(e);
    t.n++;
    t.in += bi;
    if (shrunk(e)) {
      const bo = Number(e.bytes_out) || 0;
      t.sn++;
      t.sIn += bi;
      t.sOut += bo;
      t.whole += Number(e.bytes_in) || 0;
      t.out += bo;
    } else {
      t.out += bi;
    }
    m.set(k, t);
  }
  return [...m.keys()].sort().map((k) => saving(k, m.get(k))).join(' · ');
}

// The --report text for the log's raw lines.
function report(text, { file, since } = {}) {
  const lines = text.split('\n');
  const events = [];
  const comp = [];
  const lookups = [];
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    if (since && !(Date.parse(r.ts) >= Date.parse(since))) continue;
    events.push(r);
    if (r.channel === 'lookup') lookups.push(r); else if (r.entry !== 'access') comp.push(r);
  }
  const kept = lines.filter((l) => { try { const r = JSON.parse(l); return !(r && r.channel === 'lookup'); } catch (_) { return true; } });
  const out = [buildReport(kept, { file, bytes: Buffer.byteLength(text, 'utf8'), since })];
  out.push(`  by src: ${comp.length ? totalsBy(comp, (e) => String(e.src || 'fnd')) : '(no events)'}`);
  out.push(`  by channel: ${comp.length ? totalsBy(comp, (e) => String(e.channel || 'mcp')) : '(no events)'}`);
  if (lookups.length) {
    const answered = lookups.filter((e) => e.decision === 'answered').length;
    let tin = 0;
    let tout = 0;
    const models = new Map();
    for (const e of lookups) {
      if (e.tokens && typeof e.tokens === 'object') { tin += Number(e.tokens.input) || 0; tout += Number(e.tokens.output) || 0; }
      const m = String(e.model || 'unknown');
      models.set(m, (models.get(m) || 0) + 1);
    }
    out.push(`  lookup: ${lookups.length} calls (${answered} answered) · ${tin} in / ${tout} out tokens · ${[...models.entries()].map(([m, n]) => `${m}×${n}`).join(' ')}`);
  }
  return out.join('\n');
}

module.exports = { DEBUG_LOG, appendLine, writeLine, report, buildReport };
