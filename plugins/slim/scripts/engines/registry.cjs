/*
 * engines/registry.cjs — the one table of engines. index.cjs builds its dispatch and spill names from
 * it, slim's delivery reads the per-engine flags through index.cjs (REGISTRY), and
 * tests/slim-engines.mjs pins every literal id list outside this layer (the hooks module, the types)
 * to it. Adding an engine is one row here, its `<id>.cjs`, a rule in sniff.cjs and its tests.
 */
'use strict';

const json = require('./json.cjs');
const log = require('./log.cjs');
const html = require('./html.cjs');
const figma = require('./figma.cjs');
const figmaNodes = require('./figma-nodes.cjs');
const adf = require('./adf.cjs');
const text = require('./text-window.cjs');
const xml = require('./xml.cjs');

/**
 * @typedef {object} EngineRow
 * @property {string} id                   the engine id: Result.engine, Options.engine / engines
 * @property {{run: Function}} module      exports `run(text, opts, ctx)`; ids may share one (jsonl runs json.cjs)
 * @property {'.json'|'.txt'} ext          suffix of the original's spill name — the kind of the INPUT, not of the output
 * @property {boolean} fit                 honours Options.targetBytes: a caller with a size cap passes it so the engine fits first
 * @property {boolean} stub                a compressed text still over the caller's size cap is replaced by a stub naming the
 *                                         original's spill; false → the caller passes the original through
 * @property {boolean} mcp                 an MCP text sniffed as this id runs this engine; false → slim's json route, which
 *                                         unwraps fences, JSONL, block envelopes, Figma JSX and logs itself
 */

/** @type {EngineRow[]} */
const ROWS = [
  { id: 'json', module: json, ext: '.json', fit: true, stub: true, mcp: false },
  { id: 'jsonl', module: json, ext: '.json', fit: true, stub: true, mcp: false },
  { id: 'log', module: log, ext: '.txt', fit: false, stub: true, mcp: false },
  { id: 'html', module: html, ext: '.txt', fit: false, stub: true, mcp: false },
  { id: 'figma', module: figma, ext: '.txt', fit: false, stub: true, mcp: false },
  { id: 'figma-nodes', module: figmaNodes, ext: '.json', fit: true, stub: true, mcp: false },
  { id: 'adf', module: adf, ext: '.json', fit: false, stub: true, mcp: false },
  { id: 'text', module: text, ext: '.txt', fit: false, stub: true, mcp: false },
  { id: 'xml', module: xml, ext: '.txt', fit: true, stub: true, mcp: true },
];

module.exports = { ROWS };
