#!/usr/bin/env node
// Статус поддержки линеек по всему каталогу Апдейкона (не только «типовые для России»):
// GET /api/configs -> data/catalog-support.json { lines: { "<линейка>": { latest, lastRelease, version, ids } } }
//   latest      — есть редакция с is_latest_edition (последняя редакция продукта);
//   lastRelease — дата последнего релиза линейки (для «поддерживается»: старая редакция, но релизы ещё выходят).
// Использование: node tools/fetch-support.js [--api https://upd.imiron.ru]
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./lib/products');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const API = args.includes('--api') ? args[args.indexOf('--api') + 1] : 'https://upd.imiron.ru';
// другие страны и BAS — не наши линейки
const FOREIGN = /Для(Казахстана|Беларуси|Украины|Узбекистана|Кыргызстана|Молдовы|Армении|Грузии|Азербайджана|Таджикистана)|^BAS/;

(async () => {
  const res = await fetch(`${API}/api/configs`, { headers: { 'User-Agent': '1CExchenge/registry' } });
  if (!res.ok) throw new Error(`${API}/api/configs: HTTP ${res.status}`);
  const j = await res.json();
  const all = Array.isArray(j) ? j : j.configs;
  const lines = {};
  for (const c of all) {
    if (!c.latest_version || (c.region && c.region !== 'ru') || FOREIGN.test(c.name)) continue;
    const t = P.fromTemplate({ name: c.name, version: c.latest_version });
    if (t.product === c.name || /7\.7$/.test(t.product)) continue; // продукт не из нашего списка; 7.7 — всегда устаревшие
    const ln = P.line(t);
    const e = lines[ln] || (lines[ln] = { latest: false, lastRelease: null, version: null, ids: [] });
    e.latest = e.latest || !!c.is_latest_edition;
    if (c.latest_date && (!e.lastRelease || c.latest_date > e.lastRelease)) { e.lastRelease = c.latest_date; e.version = c.latest_version; }
    e.ids.push(String(c.id));
  }
  const sorted = Object.fromEntries(Object.entries(lines).sort((a, b) => a[0].localeCompare(b[0], 'ru')));
  for (const [ln, e] of Object.entries(sorted)) console.log(`${ln.padEnd(32)} ${e.latest ? 'latest' : '      '} ${e.lastRelease || '—'}  ${e.version || ''}`);
  fs.writeFileSync(path.join(ROOT, 'data', 'catalog-support.json'),
    JSON.stringify({ source: `${API}/api/configs`, fetched: new Date().toISOString(), lines: sorted }, null, 1));
  console.log('-> data/catalog-support.json');
})().catch(e => { console.error(e.message); process.exitCode = 1; });
