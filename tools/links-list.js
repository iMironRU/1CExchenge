#!/usr/bin/env node
// Список ссылок releases.1c.ru для проверки доступности (PIN / не найден / доступно):
// полные поставки и пакеты перехода из data/catalog-files.json -> work/links.json
// Проверка выполняется в браузере пользователя (сессия ИТС): см. tools/page/check-links.browser.js,
// результат — data/links-status.json.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog-files.json'), 'utf8')).files;
const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog-ru.json'), 'utf8')).configs;
const out = [];
for (const c of cat) {
  const f = files[c.id];
  if (!f || !f.links) continue;
  if (f.links.full) out.push({ id: c.id, kind: 'full', title: c.title, version: f.version, url: f.links.full });
  for (const x of f.files || []) {
    if (/_(updsetup|updstp)[^\\]*\.zip$/i.test(x.path) && !/_updsetup\.zip$/i.test(x.path)) {
      out.push({ id: c.id, kind: 'package', title: x.title.replace(/^.*Версия [\d.]+\.\s*/, ''), version: f.version, url: x.url });
    }
  }
}
fs.mkdirSync(path.join(ROOT, 'work'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'work', 'links.json'), JSON.stringify(out, null, 1));
console.log(`ссылок: ${out.length} (полных ${out.filter(x => x.kind === 'full').length}, пакетов ${out.filter(x => x.kind === 'package').length}) -> work/links.json`);
