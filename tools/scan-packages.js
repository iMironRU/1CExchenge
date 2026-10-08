#!/usr/bin/env node
// Пакеты перехода с releases.1c.ru (скачанные zip): что внутри —
//   cfu        — дистрибутив обновления (1cv8.efd с файлом .cfu): переход режимом «Обновление конфигурации», база целиком;
//   processing — обработка выгрузки на стороне источника (epf/ert) с правилами КД2 (макетом в epf или xml рядом).
// Результат дополняет data/packages.json (ключ — имя zip), чтобы не хранить сами пакеты.
// Использование: node tools/scan-packages.js <пакет.zip|каталог>...
'use strict';
const fs = require('fs');
const path = require('path');
const { listEntries, readEntry } = require('./lib/zip');
const v8 = require('./lib/v8container');
const { decodeText, parseRules } = require('./lib/rules');
const { rulesContent } = require('./lib/rules-content');
const { unpack } = require('./efd');

const OUT = path.join(__dirname, '..', 'data', 'packages.json');
const PKG = /_(updsetup|updstp)[^\\/]*\.zip$/i;

// правила КД2 из buf: xml целиком или макеты внутри epf
function rulesIn(name, buf) {
  const blobs = /\.(epf|erf)$/i.test(name) && v8.isContainer(buf) ? v8.walk(buf) : [{ path: '', data: buf }];
  const names = new Map();
  for (const b of blobs) for (const m of b.data.subarray(0, 600).toString('utf8').matchAll(/\{1,0,([0-9a-f-]{36})\},"([^"]+)"/g)) names.set(m[1], m[2]);
  const out = [];
  for (const b of blobs) {
    const text = decodeText(b.data);
    if (!/^\s*<ПравилаОбмена[\s>]/.test(text.slice(0, 200))) continue;
    const r = parseRules(text);
    if (!r) continue;
    const uuid = (b.path.match(/([0-9a-f-]{36})\.\d+$/) || [])[1];
    out.push({ entry: name, template: names.get(uuid) || null, ...r, content: rulesContent(text) });
  }
  return out;
}

async function scan(file) {
  const buf = fs.readFileSync(file);
  const entries = listEntries(buf).filter(e => !e.dir);
  const efd = entries.find(e => /(^|\/)1cv8\.efd$/i.test(e.name));
  if (efd) {
    const { catalog } = await unpack(file, { list: true });
    const files = catalog.files.map(f => f.path.split('\\').pop());
    return { type: files.some(f => /\.cfu$/i.test(f)) ? 'cfu' : 'efd', files };
  }
  const files = entries.map(e => e.name).filter(n => !/\.(png|jpg|gif|db)$/i.test(n));
  const rules = entries.filter(e => /\.(epf|erf|xml)$/i.test(e.name)).flatMap(e => rulesIn(e.name, readEntry(buf, e)));
  return { type: 'processing', files, rules };
}

(async () => {
  const args = process.argv.slice(2);
  if (!args.length) { console.error('Использование: node tools/scan-packages.js <пакет.zip|каталог>...'); process.exit(2); }
  const zips = args.flatMap(a => (fs.statSync(a).isDirectory() ? fs.readdirSync(a).map(f => path.join(a, f)) : [a])).filter(f => PKG.test(f));
  const db = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { packages: {} };
  for (const z of zips) {
    try {
      const r = await scan(z);
      db.packages[path.basename(z)] = { scanned: new Date().toISOString(), size: fs.statSync(z).size, ...r };
      const rs = (r.rules || []).map(x => `${x.template || x.entry}: ${x.source && x.source.name} -> ${x.target && x.target.name}`).join('; ');
      console.log(`${path.basename(z).padEnd(52)} ${r.type.padEnd(10)} ${r.type === 'cfu' ? r.files.filter(f => /\.cfu$/i.test(f)).join(', ') : rs}`);
    } catch (e) {
      console.log(`${path.basename(z)}: ОШИБКА ${e.message}`);
      process.exitCode = 1;
    }
  }
  db.packages = Object.fromEntries(Object.entries(db.packages).sort());
  fs.writeFileSync(OUT, JSON.stringify(db, null, 1));
  console.log(`-> ${OUT}`);
})();
