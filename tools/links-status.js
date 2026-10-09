#!/usr/bin/env node
// Сохраняет результат проверки ссылок (tools/page/check-links.browser.js, выполняется во вкладке releases.1c.ru
// с сессией ИТС пользователя) в data/links-status.json.
// Вход: строка вида «0:ok/3 1:pin 2:notfound …» (индексы — по work/links.json).
// Использование: node tools/links-status.js "<результат>"
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const links = JSON.parse(fs.readFileSync(path.join(ROOT, 'work', 'links.json'), 'utf8'));
const raw = process.argv.slice(2).join(' ');
const OUT = path.join(ROOT, 'data', 'links-status.json');
const db = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { statuses: {} };
const LABEL = { ok: 'доступно', pin: 'нужен PIN (второй фактор)', notfound: 'файл не найден', login: 'нужен вход', file: 'отдаёт файл сразу', error: 'ошибка запроса', other: 'не распознано' };
const count = {};
for (const m of raw.matchAll(/(\d+):(\w+)(?:\/(\d+))?/g)) {
  const l = links[+m[1]];
  if (!l) continue;
  db.statuses[l.url] = { status: m[2], mirrors: m[3] ? +m[3] : 0, kind: l.kind, title: l.title, version: l.version, checked: new Date().toISOString() };
  count[m[2]] = (count[m[2]] || 0) + 1;
}
db.labels = LABEL;
db.statuses = Object.fromEntries(Object.entries(db.statuses).sort());
fs.writeFileSync(OUT, JSON.stringify(db, null, 1));
console.log(Object.entries(count).map(([k, n]) => `${LABEL[k] || k}: ${n}`).join(', '), '-> data/links-status.json');
