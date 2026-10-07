#!/usr/bin/env node
// Prints a deterministic orders export — 240 orders (ORD-0001 …, ~190 KB) or the count given as the
// first argument — for slim's Read fixtures and eval case. Every order carries a note; order 217's is
// SENTINEL-ORDER-0217, an ordinary row a compressed view samples away.
'use strict';

let seed = 99;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const CITIES = ['Leeds', 'Bristol', 'Glasgow', 'Cardiff', 'York', 'Bath', 'Derby', 'Exeter'];
const ITEMS = ['Speckled mug', 'Celadon bowl', 'Oatmeal platter', 'Cobalt vase', 'Matte plate', 'Studio jug'];
const orders = [];
const N = Number(process.argv[2]) || 240;
for (let i = 1; i <= N; i++) {
  const lines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ title: pick(ITEMS), qty: 1 + Math.floor(rnd() * 3), price: '24.00', currency: 'GBP' }));
  orders.push({
    id: `ORD-${String(i).padStart(4, '0')}`,
    createdAt: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T${String(8 + (i % 12)).padStart(2, '0')}:15:00Z`,
    status: i % 17 === 0 ? 'refunded' : 'fulfilled',
    customer: { name: `Customer ${i}`, email: `customer${i}@example.com`, city: pick(CITIES) },
    shipping: { method: 'standard', address1: `${i} High Street`, postcode: `AB${i % 90} 1CD`, country: 'GB' },
    lineItems: lines,
    total: (lines.reduce((s, l) => s + l.qty * 24, 0)).toFixed(2),
    note: i === 217 ? 'SENTINEL-ORDER-0217' : `leave with reception, ref ${(i * 7919) % 100000}`,
    metafields: { gift: i % 9 === 0, source: 'web', channel: 'online-store' },
  });
}
process.stdout.write(`${JSON.stringify({ exportedAt: '2026-10-07T09:00:00Z', total: N, orders }, null, 2)}\n`);
