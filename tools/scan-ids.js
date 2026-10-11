#!/usr/bin/env node
// Идентификаторы Интернет-поддержки (БИП/БСП): для каждой разобранной базы (work/ib/<id>) выгружает модули
// ОбновлениеИнформационнойБазы* и читает ПриДобавленииПодсистемы: Описание.Имя / Версия / ИдентификаторИнтернетПоддержки.
// Основная подсистема (Имя = Метаданные.Имя) даёт programName для update-api.1c.ru, библиотеки — свои (SSL, ISL, …).
// Если идентификатор задан функцией — ищет в ней ветки по Метаданные.Имя / литерал Возврат.
// Результат: data/ids.json. Использование: node tools/scan-ids.js [--only <подстрока id>]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { decodeText } = require('./lib/rules');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'work');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const base = 'C:\\Program Files\\1cv8';
const ver = fs.readdirSync(base).filter(d => /^\d+\.\d+\.\d+\.\d+$/.test(d) && fs.existsSync(path.join(base, d, 'bin', 'ibcmd.exe')))
  .sort((a, b) => a.split('.').map(Number).reduce((r, x, i) => r || x - b.split('.').map(Number)[i], 0)).pop();
const IBCMD = path.join(base, ver, 'bin', 'ibcmd.exe');
const ID = '[0-9A-Za-zА-Яа-яЁё_]+';

const walk = d => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
const methodBody = (text, name) => (text.match(new RegExp(`^\\s*Функция\\s+${name}\\s*\\([^)]*\\)[^\\n]*\\n([\\s\\S]*?)^\\s*КонецФункции`, 'm')) || [])[1] || null;

function exportModules(id, names, sub) {
  const out = path.join(WORK, 'cf', id, sub);
  const done = path.join(out, '.done');
  if (fs.existsSync(done) && names.every(n => fs.readFileSync(done, 'utf8').split('\n').includes(n))) return out;
  fs.rmSync(out, { recursive: true, force: true });
  const r = spawnSync(IBCMD, ['infobase', 'config', 'export', 'objects', `--data=${path.join(WORK, 'ib', id)}`, `--out=${out}`, '--recursive', ...names.map(n => `CommonModule.${n}`)], { encoding: 'utf8', timeout: 20 * 60000 });
  if (r.status !== 0) throw new Error((r.stdout || '') + (r.stderr || ''));
  fs.writeFileSync(path.join(out, '.done'), names.join('\n'));
  return out;
}

const db = { scanned: new Date().toISOString(), configs: {} };
for (const id of fs.readdirSync(path.join(WORK, 'ib')).filter(d => fs.existsSync(path.join(WORK, 'ib', d, '.loaded')))) {
  if (only && !id.includes(only)) continue;
  const info = path.join(WORK, 'cf', id, 'ConfigDumpInfo.xml');
  if (!fs.existsSync(info)) continue;
  const dump = fs.readFileSync(info, 'utf8');
  const mods = [...new Set([...dump.matchAll(/name="CommonModule\.(ОбновлениеИнформационнойБазы[^".]*)"/g)].map(m => m[1]))]
    .filter(n => !/(Служебный|Клиент|ВызовСервера|ПовтИсп|Глобальный|Порционное|Переопределяемый)/.test(n));
  try {
    // список модулей подсистем — из ПодсистемыКонфигурацииПереопределяемый.ПриДобавленииПодсистем (там и префиксные: ФИБ…, мии…)
    if (/name="CommonModule\.ПодсистемыКонфигурацииПереопределяемый"/.test(dump)) {
      const pd = exportModules(id, ['ПодсистемыКонфигурацииПереопределяемый'], 'ids-subs');
      const f = walk(pd).find(x => x.endsWith('.bsl'));
      const listed = f ? [...decodeText(fs.readFileSync(f)).matchAll(/МодулиПодсистем\.Добавить\("([^"]+)"\)/g)].map(m => m[1]) : [];
      for (const n of listed) if (!mods.includes(n) && dump.includes(`name="CommonModule.${n}"`)) mods.push(n);
    }
    const dir = exportModules(id, mods, 'ids');
    const texts = Object.fromEntries(walk(dir).filter(f => f.endsWith('.bsl')).map(f => [f.split(/[\\/]/).slice(-3)[0], decodeText(fs.readFileSync(f))]));
    const subs = [];
    for (const [mod, t] of Object.entries(texts)) {
      const body = methodBody(t.replace(/^Процедура/gm, 'Функция').replace(/^КонецПроцедуры/gm, 'КонецФункции'), 'ПриДобавленииПодсистемы');
      if (!body) continue;
      const g = re => ((body.match(re) || [])[1] || '').trim();
      subs.push({ module: mod, name: g(/Описание\.Имя\s*=\s*([^;]+);/), version: g(/Описание\.Версия\s*=\s*([^;]+);/), id: g(/Описание\.ИдентификаторИнтернетПоддержки\s*=\s*([^;]+);/) });
    }
    db.configs[id] = { modules: mods.length, subsystems: subs };
    console.log(`${id}: ${subs.map(s => `${s.name.replace(/"/g, '')}=${s.id.slice(0, 60)}`).join(' | ')}`);
  } catch (e) {
    console.log(`${id}: ОШИБКА ${e.message.slice(0, 200)}`);
  }
}
fs.writeFileSync(path.join(ROOT, 'data', 'ids.json'), JSON.stringify(db, null, 1));
console.log('-> data/ids.json');
