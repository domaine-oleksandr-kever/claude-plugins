// slim's switches, read straight from the environment. A SLIM_* value wins; the FND_MCP_SLIM_* twin
// is the fallback, so slim and fnd share one spill dir and one report log during the live period.
// The domaine env files (env-file.cjs) fill gaps in process.env before anything here is read.
'use strict';

const os = require('os');

try { require('../env-file.cjs').load(); } catch (_) {}

const ENV = process.env;
const set = (v) => v !== undefined && v !== '';
const own = (name, twin) => (set(ENV[name]) ? ENV[name] : (twin ? ENV[twin] : undefined));

const spillRoot = () => own('SLIM_DIR', 'FND_MCP_SLIM_DIR') || os.tmpdir();
// fnd's own spill dir: fnd beneath slim spills there, and a handle into it is trusted.
const fndDir = () => ENV.FND_MCP_SLIM_DIR || '';
// Both TTLs: the spill names slim writes are fnd's names too, so neither plugin's setting may cut the other's short.
const ttlRaws = () => [ENV.SLIM_TTL, ENV.FND_MCP_SLIM_TTL];

// `1|true|yes|on` = key events, an integer ≥ 2 = everything, anything else = off.
function debugLevel() {
  const raw = own('SLIM_DEBUG', 'FND_MCP_SLIM_DEBUG');
  if (!raw) return 0;
  const v = String(raw).trim();
  if (/^\d+$/.test(v) && Number(v) >= 2) return 2;
  return /^(1|true|yes|on)$/i.test(v) ? 1 : 0;
}

const BUDGET_MS_DEFAULT = 5000;
function budgetMs() {
  const raw = String(ENV.SLIM_BUDGET_MS ?? '').trim();
  if (raw === '0') return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n < 0) return -1;
  return Number.isFinite(n) && n > 0 ? n : BUDGET_MS_DEFAULT;
}

const STUB_CAP = 1200;
const STUB_BYTES_DEFAULT = 32768;
const stubEnabled = () => !(ENV.SLIM_STUB !== undefined && String(ENV.SLIM_STUB).trim() === '0');
// Whole-string Number, so `32k` falls back to the default instead of 32 bytes; floored at the stub's own cap.
function stubBytesOf(raw) {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.max(n, STUB_CAP) : STUB_BYTES_DEFAULT;
}
const stubBytes = () => stubBytesOf(ENV.SLIM_STUB_BYTES);
// The largest stub either plugin emits, plus the stub's own cap: the already-slim rule's bound.
const alreadySlimBound = () => Math.max(stubBytes(), stubBytesOf(ENV.FND_MCP_SLIM_STUB_BYTES)) + STUB_CAP;

const PLAIN_BYTES_DEFAULT = 65536;
const PLAIN_BYTES_FLOOR = 8192;
function plainBytes() {
  const raw = String(ENV.SLIM_PLAIN_BYTES ?? '').trim();
  if (!/^\d+$/.test(raw)) return PLAIN_BYTES_DEFAULT;
  return Math.max(Number(raw), PLAIN_BYTES_FLOOR);
}

const hintOn = () => ENV.SLIM_HINT !== '0' && ENV.SLIM_LOOKUP !== '0';

module.exports = {
  spillRoot, fndDir, ttlRaws, debugLevel, budgetMs, stubEnabled, stubBytes, alreadySlimBound, plainBytes, hintOn,
  STUB_CAP, PLAIN_BYTES_DEFAULT,
};
