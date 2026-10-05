#!/usr/bin/env node
// Файлы последних версий конфигураций каталога (data/catalog-ru.json) из API Апдейкона:
// GET /api/files?config_id=<id> -> data/catalog-files.json
// Использование: node tools/fetch-files.js [--api https://upd.imiron.ru]
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const API = args.includes('--api') ? args[args.indexOf('--api') + 1] : 'https://upd.imiron.ru';

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': '1CExchenge/registry' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${url}: HTTP ${res.statusCode} ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog-ru.json'), 'utf8')).configs;
  const out = {};
  for (const c of cat) {
    try {
      out[c.id] = await getJson(`${API}/api/files?config_id=${c.id}`);
      const f = out[c.id];
      console.log(`${c.id.padStart(6)} ${String(f.version).padEnd(12)} read=${f.read} full=${f.links && f.links.full ? 'да' : 'нет'} files=${(f.files || []).length}  ${c.title}`);
    } catch (e) {
      out[c.id] = { error: e.message };
      console.log(`${c.id.padStart(6)} ОШИБКА ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(ROOT, 'data', 'catalog-files.json'),
    JSON.stringify({ source: `${API}/api/files`, fetched: new Date().toISOString(), files: out }, null, 1));
  console.log('-> data/catalog-files.json');
})();
