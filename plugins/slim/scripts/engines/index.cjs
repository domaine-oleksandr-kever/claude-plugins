/*
 * engines/index.cjs — slim's compression library: compress(), sniff(), peek().
 *
 * Embeddable anywhere Node runs (a microservice, a CLI, a hook on another harness): no plugin
 * context, no environment, no filesystem, no network, no timers. The contract is CONTRACT.md beside
 * this file; the typedefs below mirror it. A new engine is one file exporting { id, run(text, opts,
 * ctx) } plus one ENGINES row here and one sniff rule in sniff.cjs.
 */
'use strict';

const { sha16, utf8, pct } = require('./util.cjs');
const { sniff } = require('./sniff.cjs');
const json = require('./json.cjs');
const log = require('./log.cjs');
const html = require('./html.cjs');
const figma = require('./figma.cjs');
const adf = require('./adf.cjs');
const text = require('./text-window.cjs');

/**
 * @typedef {'json'|'jsonl'|'log'|'html'|'figma'|'adf'|'text'} EngineId
 * @typedef {EngineId|'binary'|'none'} SniffEngine
 *
 * @typedef {object} Input
 * @property {string|Buffer|object} data      the payload; an object is serialized with JSON.stringify
 * @property {{mime?: string, filename?: string, source?: string}} [hint]  carried for the caller; detection is content-based
 *
 * @typedef {object} Options
 * @property {number|null} [budgetBytes=null]  text window budget (null → 12288); clips html output when set
 * @property {number} [maxMs=5000]             wall-clock budget; 0 = none, negative = already expired
 * @property {EngineId[]} [engines]            allow-list; a sniffed engine outside it → passthrough 'engine-not-allowed'
 * @property {EngineId} [engine]               run this engine and skip detection
 * @property {'default'} [profile='default']   anything else → refused 'bad-option'
 * @property {number} [plainBytes=65536]       text at or under this size is never windowed
 * @property {string} [spillDir='']            prefix of the paths the text cites for parts
 * @property {{original?: string, rows?: string, ids?: string}} [spillNames]  name prefixes per kind
 * @property {boolean} [trace=false]           fill stats.stages with the stages that changed bytes
 * @property {number|null} [targetBytes=null]  json/jsonl: a crushed body still above it is trimmed, then row-fitted
 * @property {number} [maxInputBytes=67108864] larger input → refused 'too-large'
 * @property {'handle'|'ccr'} [marker='handle'] 'ccr' reproduces Headroom's crush hash (parity tests only)
 *
 * @typedef {object} Spill
 * @property {'original'|'rows'|'ids'} kind
 * @property {string} payload
 * @property {string} suggestedName            prefix + sha256(payload)[0,16] + '.json'|'.txt'
 *
 * @typedef {object} Result
 * @property {1} v
 * @property {SniffEngine} engine
 * @property {'compressed'|'passthrough'|'refused'} decision
 * @property {string} [reason]
 * @property {string} [format]                 a diagnostic tag on a non-json passthrough
 * @property {string} text                     the compressed text, or the input as a string
 * @property {{bytesIn: number, bytesOut: number, pct: number, ms: number, stages: string[]}} stats
 * @property {Spill} [spill]                   the original, for the caller to store (compressed only)
 * @property {Spill[]} [parts]                 payloads the text cites by path (crush rows, Figma id map)
 * @property {{lines_total: number, lines_hidden: number, bytes_hidden: number}} [window]
 * @property {string[]} warnings
 */

const VERSION = 1;
const ENGINES = {
  json,
  jsonl: json,
  log,
  html,
  figma,
  adf,
  text,
};
const IDS = Object.keys(ENGINES);
const NAMES = { original: 'slim-original-', rows: 'slim-rows-', ids: 'slim-ids-' };
const DEFAULTS = {
  budgetBytes: null,
  maxMs: 5000,
  engines: null,
  engine: null,
  profile: 'default',
  plainBytes: 65536,
  spillDir: '',
  spillNames: NAMES,
  trace: false,
  targetBytes: null,
  maxInputBytes: 67108864,
  marker: 'handle',
};

const isPos = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

// The validated option set, or a string naming the first bad field.
function optionsOf(o) {
  if (o === undefined || o === null) return { ...DEFAULTS };
  if (typeof o !== 'object' || Array.isArray(o)) return 'options';
  const v = { ...DEFAULTS, ...o, spillNames: { ...NAMES, ...(o.spillNames || {}) } };
  if (v.budgetBytes !== null && !isPos(v.budgetBytes)) return 'budgetBytes';
  if (typeof v.maxMs !== 'number' || Number.isNaN(v.maxMs)) return 'maxMs';
  if (v.engines !== null && (!Array.isArray(v.engines) || !v.engines.every((e) => IDS.includes(e)))) return 'engines';
  if (v.engine !== null && !IDS.includes(v.engine)) return 'engine';
  if (v.profile !== 'default') return 'profile';
  if (!isPos(v.plainBytes)) return 'plainBytes';
  if (typeof v.spillDir !== 'string') return 'spillDir';
  if (!Object.values(v.spillNames).every((s) => typeof s === 'string')) return 'spillNames';
  if (typeof v.trace !== 'boolean') return 'trace';
  if (v.targetBytes !== null && !isPos(v.targetBytes)) return 'targetBytes';
  if (!isPos(v.maxInputBytes)) return 'maxInputBytes';
  if (v.marker !== 'handle' && v.marker !== 'ccr') return 'marker';
  return v;
}

// The input as text, or a refusal reason.
function textOf(input) {
  if (!input || typeof input !== 'object' || !('data' in input)) return { reason: 'bad-input' };
  const d = input.data;
  if (typeof d === 'string') return { text: d };
  if (Buffer.isBuffer(d)) return { text: d.toString('utf8'), buffer: d };
  if (d && typeof d === 'object') {
    try {
      const s = JSON.stringify(d);
      return typeof s === 'string' ? { text: s } : { reason: 'bad-input' };
    } catch (_) {
      return { reason: 'bad-input' };
    }
  }
  return { reason: 'bad-input' };
}

const extOf = (engine) => (engine === 'json' || engine === 'jsonl' || engine === 'adf' ? '.json' : '.txt');

/**
 * Compress one payload. Never throws; never writes anything.
 * @param {Input} input
 * @param {Options} [options]
 * @returns {Result}
 */
function compress(input, options) {
  const t0 = Date.now();
  const result = (engine, decision, body, x = {}) => {
    const bytesIn = x.bytesIn ?? utf8(body);
    const bytesOut = utf8(x.text ?? body);
    return {
      v: VERSION, engine, decision, ...(x.reason ? { reason: x.reason } : {}), ...(x.format ? { format: x.format } : {}),
      text: x.text ?? body,
      stats: { bytesIn, bytesOut, pct: pct(bytesIn, bytesOut), ms: Date.now() - t0, stages: x.stages || [] },
      ...(x.spill ? { spill: x.spill } : {}), ...(x.parts && x.parts.length ? { parts: x.parts } : {}),
      ...(x.window ? { window: x.window } : {}),
      warnings: x.warnings || [],
    };
  };
  const refused = (reason, warning) => result('none', 'refused', '', { reason, bytesIn: 0, warnings: warning ? [warning] : [] });
  try {
    const opts = optionsOf(options);
    if (typeof opts === 'string') return refused('bad-option', `invalid option: ${opts}`);
    const t = textOf(input);
    if (t.reason) return refused(t.reason);
    if ((t.buffer ? t.buffer.length : utf8(t.text)) > opts.maxInputBytes) return refused('too-large');

    const sniffed = opts.engine ? { engine: opts.engine } : sniff({ data: t.buffer || t.text });
    if (sniffed.engine === 'binary') return { ...refused('binary'), engine: 'binary' };
    const body = t.text;
    if (sniffed.engine === 'none') return result('none', 'passthrough', body, { reason: 'empty' });
    if (opts.engines && !opts.engines.includes(sniffed.engine)) return result(sniffed.engine, 'passthrough', body, { reason: 'engine-not-allowed' });

    const parts = new Map();
    const dir = opts.spillDir.replace(/\/+$/, '');
    const ctx = {
      deadline: opts.maxMs === 0 ? null : (opts.maxMs < 0 ? Date.now() - 1 : Date.now() + opts.maxMs),
      part: (kind, payload) => {
        const name = `${opts.spillNames[kind] || `slim-${kind}-`}${sha16(payload)}.json`;
        const cite = dir ? `${dir}/${name}` : name;
        parts.set(name, { kind, payload, suggestedName: name, cite });
        return cite;
      },
    };
    if (ctx.deadline != null && Date.now() > ctx.deadline) return result(sniffed.engine, 'passthrough', body, { reason: 'budget-exceeded', warnings: ['maxMs elapsed'] });
    let r;
    try {
      r = ENGINES[sniffed.engine].run(body, opts, ctx);
    } catch (_) {
      return result(sniffed.engine, 'passthrough', body, { reason: 'transform-error' });
    }
    const engine = r.engine || sniffed.engine;
    if (r.decision !== 'compressed') {
      return result(engine, 'passthrough', body, { reason: r.reason || 'no-gain', format: r.format, warnings: r.reason === 'budget-exceeded' ? ['maxMs elapsed'] : [] });
    }
    const cited = [...parts.values()].filter((p) => r.text.includes(p.cite)).map(({ kind, payload, suggestedName }) => ({ kind, payload, suggestedName }));
    const spill = { kind: 'original', payload: body, suggestedName: `${opts.spillNames.original}${sha16(body)}${extOf(engine)}` };
    return result(engine, 'compressed', body, { text: r.text, stages: opts.trace ? r.stages || [] : [], spill, parts: cited, window: r.window, warnings: r.warnings });
  } catch (e) {
    return refused('bad-input', e && e.name ? e.name : 'Error');
  }
}

/** One-line shape hint of a payload: { format, hint } (JSON keys / array length / head preview). */
function peek(t) {
  return json.shapeHint(typeof t === 'string' ? t : '');
}

module.exports = { compress, sniff, peek, VERSION, ENGINES: IDS };
