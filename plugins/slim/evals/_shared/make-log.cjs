#!/usr/bin/env node
// Prints a deterministic ~180 KB, 2000-line application log for slim's log fixtures and eval cases:
// mixed INFO/DEBUG/WARN lines, repeated warnings, five ERROR lines and, near line 1412, a
// java.lang.IllegalStateException ("inventory reservation expired") with an 8-frame trace.
'use strict';

let seed = 4242;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const THREADS = ['http-nio-8080-exec-1', 'http-nio-8080-exec-2', 'http-nio-8080-exec-3', 'scheduler-1', 'kafka-consumer-2'];
const LOGGERS = ['c.n.inventory.ReservationService', 'c.n.orders.OrderController', 'c.n.catalog.SyncJob', 'c.n.payments.WebhookHandler'];
const INFO = [
  (i) => `reserved ${1 + (i % 4)} units for order ORD-${String(1000 + i).padStart(5, '0')}`,
  (i) => `catalogue sync batch ${i} processed in ${20 + (i % 70)} ms`,
  (i) => `GET /api/products/${i % 300} 200 ${5 + (i % 40)} ms`,
  (i) => `webhook orders/paid accepted for ORD-${String(2000 + i).padStart(5, '0')}`,
];
const WARN = [
  'slow query on inventory_levels (812 ms) — consider an index on location_id',
  'retrying payment provider call after 502 (attempt 2 of 3)',
];
const ERRORS = {
  305: 'payment webhook signature mismatch for ORD-01305',
  777: 'catalogue sync batch 777 failed to upsert 3 variants',
  1101: 'order ORD-02101 could not be routed to a fulfilment location',
  1655: 'payment provider returned 500 for refund RF-1655',
  1890: 'inventory snapshot export aborted: disk quota reached',
};
const FRAMES = [
  'com.northwind.inventory.ReservationService.confirm(ReservationService.java:214)',
  'com.northwind.inventory.ReservationService.lambda$commit$3(ReservationService.java:188)',
  'com.northwind.orders.CheckoutFlow.reserveStock(CheckoutFlow.java:97)',
  'com.northwind.orders.CheckoutFlow.complete(CheckoutFlow.java:61)',
  'com.northwind.orders.OrderController.submit(OrderController.java:142)',
  'com.northwind.orders.OrderController.handle(OrderController.java:88)',
  'com.northwind.web.RequestPipeline.dispatch(RequestPipeline.java:51)',
  'com.northwind.web.RequestPipeline.run(RequestPipeline.java:33)',
];

const lines = [];
const ts = (i) => {
  const s = 36000 + i * 3;
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `2026-10-07T${hh}:${mm}:${ss}.${String((i * 37) % 1000).padStart(3, '0')}Z`;
};
for (let i = 1; lines.length < 2000; i++) {
  const n = lines.length + 1;
  const head = `${ts(n)} %s [${pick(THREADS)}] ${pick(LOGGERS)} - `;
  if (n === 1412) {
    lines.push(`${head.replace('%s', 'ERROR')}checkout failed for ORD-01412`);
    lines.push('java.lang.IllegalStateException: inventory reservation expired');
    for (const f of FRAMES) lines.push(`\tat ${f}`);
    continue;
  }
  if (ERRORS[n]) { lines.push(`${head.replace('%s', 'ERROR')}${ERRORS[n]}`); continue; }
  if (n % 23 === 0) { lines.push(`${head.replace('%s', 'WARN ')}${WARN[n % 2]}`); continue; }
  if (n % 5 === 0) { lines.push(`${head.replace('%s', 'DEBUG')}cache hit ratio ${(0.8 + rnd() / 5).toFixed(3)} on region catalogue-${n % 9}`); continue; }
  lines.push(`${head.replace('%s', 'INFO ')}${pick(INFO)(i)}`);
}
process.stdout.write(`${lines.slice(0, 2000).join('\n')}\n`);
