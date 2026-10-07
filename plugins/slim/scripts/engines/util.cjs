// Small pure helpers every engine shares. No I/O; `crypto` is the only Node module required.
'use strict';

const crypto = require('crypto');

const sha = (str, n) => crypto.createHash('sha256').update(str, 'utf8').digest('hex').slice(0, n);
const sha16 = (str) => sha(str, 16);
const utf8 = (s) => Buffer.byteLength(s, 'utf8');
// Percent saved, one decimal; negative when the output grew.
const pct = (bytesIn, bytesOut) => (bytesIn ? Math.round((1 - bytesOut / bytesIn) * 1000) / 10 : 0);
// JSON.parse rejects a leading BOM, so every parse of caller text strips one first.
const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);
const GROUP3 = /\B(?=(\d{3})+(?!\d))/g;
const commas = (n) => String(n).replace(GROUP3, ',');

module.exports = { sha, sha16, utf8, pct, stripBom, commas };
