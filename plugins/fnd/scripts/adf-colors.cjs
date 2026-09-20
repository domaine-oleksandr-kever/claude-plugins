/**
 * adf-colors.cjs — the Jira editor's text-colour palette, by name.
 *
 * Shared by md-to-adf.cjs (`{color:green}…{color}` → textColor mark) and adf-to-md.cjs (the
 * reverse). Names are the palette's own labels, lower-cased with hyphens (`dark-green`,
 * `light-red`); hex values are what the editor stores in `textColor.attrs.color`, taken from
 * @atlaskit/adf-schema `colorPaletteNew` (57.5.3) — the 10 × 3 picker Jira shows today.
 * A colour outside the palette travels as `#rrggbb` in both directions.
 */
'use strict';

const PALETTE = [
  ['dark-gray', '#172b4d'], ['dark-blue', '#0747a6'], ['dark-teal', '#008da6'],
  ['dark-green', '#006644'], ['dark-lime', '#4c6b1f'], ['dark-yellow', '#7f5f01'],
  ['dark-orange', '#9e4c00'], ['dark-red', '#bf2600'], ['dark-magenta', '#943d73'],
  ['dark-purple', '#403294'],
  ['light-gray', '#97a0af'], ['blue', '#4c9aff'], ['teal', '#00b8d9'], ['green', '#36b37e'],
  ['lime', '#6a9a23'], ['yellow', '#b38600'], ['orange', '#e06c00'], ['red', '#ff5630'],
  ['magenta', '#cd519d'], ['purple', '#6554c0'],
  ['white', '#ffffff'], ['light-blue', '#b3d4ff'], ['light-teal', '#b3f5ff'],
  ['light-green', '#abf5d1'], ['light-lime', '#d3f1a7'], ['light-yellow', '#fff0b3'],
  ['light-orange', '#fce4a6'], ['light-red', '#ffbdad'], ['light-magenta', '#fdd0ec'],
  ['light-purple', '#eae6ff'],
];

const NAME_TO_HEX = Object.fromEntries(PALETTE);
const HEX_TO_NAME = Object.fromEntries(PALETTE.map(([n, h]) => [h, n]));
const HEX_RE = /^#[0-9a-f]{6}$/i;

// `green` / `dark-red` / `#ff5630` → lower-case hex, or null when it is none of those
const toHex = (s) => {
  const k = String(s).toLowerCase();
  return HEX_RE.test(k) ? k : NAME_TO_HEX[k] || null;
};
// hex → palette name when it has one, else the lower-case hex; null for a malformed value
const toLabel = (hex) => {
  if (!HEX_RE.test(String(hex))) return null;
  const k = String(hex).toLowerCase();
  return HEX_TO_NAME[k] || k;
};

module.exports = { PALETTE, NAME_TO_HEX, HEX_TO_NAME, toHex, toLabel };
