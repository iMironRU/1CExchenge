#!/usr/bin/env node
// Раскрывает выражения в data/ids.json (после tools/scan-ids.js) в значения:
//   "Литерал"                       -> Литерал
//   Метаданные.Имя / Метаданные.Версия -> имя/версия конфигурации (data/cf/<id>.json) — основная подсистема (isMain)
//   ЛокальнаяФункция()              -> Возврат "…" в том же модуле
//   Модуль.Функция()                -> выгружает модуль из базы (work/ib/<id>) и берёт Возврат "…" /
//                                      ветку «Если ВРег(Метаданные.Имя) = ВРег("<имя конфигурации>") Тогда X = "…"»
// Результат дописывается в data/ids.json: programName, versionValue, isMain, configName.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { decodeText } = require('./lib/rules');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'work');
const base = 'C:\\Program Files\\1cv8';
const ver = fs.readdirSync(base).filter(d => /^\d+\.\d+\.\d+\.\d+$/.test(d) && fs.existsSync(path.join(base, d, 'bin', 'ibcmd.exe')))
  .sort((a, b) => a.split('.').map(Number).reduce((r, x, i) => r || x - b.split('.').map(Number)[i], 0)).pop();
const IBCMD = path.join(base, ver, 'bin', 'ibcmd.exe');
const walk = d => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
const fnBody = (text, name) => (text.match(new RegExp(`^\\s*Функция\\s+${name}\\s*\\([^)]*\\)[^\\n]*\\n([\\s\\S]*?)^\\s*КонецФункции`, 'm')) || [])[1] || null;

const dbPath = path.join(ROOT, 'data', 'ids.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

// индекс уже выгруженных общих модулей базы: имя -> файл (строится один раз; весь каталог выгрузки не обходим)
const indexCache = new Map();
function moduleIndex(id) {
  if (indexCache.has(id)) return indexCache.get(id);
  const idx = new Map();
  const cf = path.join(WORK, 'cf', id);
  const roots = fs.existsSync(cf) ? fs.readdirSync(cf).map(d => path.join(cf, d)).filter(d => fs.statSync(d).isDirectory()) : [];
  for (const r of roots) {
    for (const dir of [path.join(r, 'CommonModules'), ...(fs.existsSync(r) ? fs.readdirSync(r).map(d => path.join(r, d, 'CommonModules')) : [])]) {
      if (!fs.existsSync(dir)) continue;
      for (const m of fs.readdirSync(dir)) {
        const f = path.join(dir, m, 'Ext', 'Module.bsl');
        if (!idx.has(m) && fs.existsSync(f)) idx.set(m, f);
      }
    }
  }
  indexCache.set(id, idx);
  return idx;
}

function moduleText(id, mod) {
  const local = moduleIndex(id).get(mod);
  if (local) return decodeText(fs.readFileSync(local));
  const out = path.join(WORK, 'cf', id, 'ids-x', mod);
  if (!fs.existsSync(path.join(out, '.done'))) {
    fs.rmSync(out, { recursive: true, force: true });
    const r = spawnSync(IBCMD, ['infobase', 'config', 'export', 'objects', `--data=${path.join(WORK, 'ib', id)}`, `--out=${out}`, '--recursive', `CommonModule.${mod}`], { encoding: 'utf8', timeout: 10 * 60000 });
    if (r.status !== 0) return null;
    fs.writeFileSync(path.join(out, '.done'), mod);
  }
  const f = walk(out).find(x => x.endsWith('Module.bsl'));
  return f ? decodeText(fs.readFileSync(f)) : null;
}

// разбиение по разделителю верхнего уровня (вне скобок и строк)
function splitTop(s, sep) {
  const out = [];
  let depth = 0, inStr = false, cur = '';
  for (const ch of s) {
    if (ch === '"') inStr = !inStr;
    if (!inStr) { if (ch === '(') depth++; else if (ch === ')') depth--; }
    if (!inStr && depth === 0 && ch === sep) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim());
}
const isBase = ctx => /Базовая\d*$/.test(String(ctx.cfg.name));
// значение условия: ЭтоБазоваяВерсияКонфигурации() / сравнение имени конфигурации
function cond(c, ctx) {
  const e = c.trim();
  if (/^НЕ\s+/i.test(e)) { const v = cond(e.replace(/^НЕ\s+/i, ''), ctx); return v === null ? null : !v; }
  if (/ЭтоБазоваяВерсияКонфигурации\(\)/.test(e)) return isBase(ctx);
  const m = e.match(/Метаданные\.Имя\)?\s*=\s*(?:ВРег\()?"([^"]+)"/);
  if (m) return m[1].toUpperCase() === String(ctx.cfg.name).toUpperCase();
  return null;
}

// значение выражения: строка или null
function resolve(expr, ctx, depth = 0) {
  if (!expr || depth > 4) return null;
  const e = expr.trim();
  let m;
  const parts = splitTop(e, '+');
  if (parts.length > 1) {
    const vals = parts.map(p => resolve(p, ctx, depth + 1));
    return vals.every(v => v !== null) ? vals.join('') : null;
  }
  if ((m = e.match(/^\?\((.*)\)$/s))) {
    const [c, a, b] = splitTop(m[1], ',');
    const v = cond(c, ctx);
    return v === null ? null : resolve(v ? a : b, ctx, depth + 1);
  }
  if ((m = e.match(/^"([^"]*)"$/))) return m[1];
  if (/^Метаданные\.Имя$/.test(e)) return ctx.cfg.name;
  if (/^Метаданные\.Версия$/.test(e)) return ctx.cfg.version;
  if ((m = e.match(/^([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\.([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\(\s*\)$/))) {
    const t = moduleText(ctx.id, m[1]);
    return t ? fromFunction(t, m[2], { ...ctx, module: m[1] }, depth) : null;
  }
  if ((m = e.match(/^([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\(\s*\)$/))) return fromFunction(ctx.text, m[1], ctx, depth);
  return null;
}

function fromFunction(text, fn, ctx, depth) {
  const body = fnBody(text, fn);
  if (!body) return null;
  // ветки «Если <условие> Тогда … Возврат X / Переменная = X»: первая истинная
  const branches = [...body.matchAll(/(?:Если|ИначеЕсли)\s+([\s\S]*?)\s+Тогда\s*\n\s*(?:Возврат\s+([^;]+)|[^=\n;]+=\s*([^;\n]+));/g)];
  for (const b of branches) {
    if (cond(b[1], ctx) === true) { const v = resolve(b[2] || b[3], { ...ctx, text }, depth + 1); if (v !== null) return v; }
  }
  // «Иначе» после веток
  const els = body.match(/Иначе\s*\n\s*(?:Возврат\s+([^;]+)|[^=\n;]+=\s*([^;\n]+));/);
  if (branches.length && els && branches.every(b => cond(b[1], ctx) === false)) {
    const v = resolve(els[1] || els[2], { ...ctx, text }, depth + 1);
    if (v !== null) return v;
  }
  for (const r of body.matchAll(/Возврат\s+([^;]+);/g)) {
    const v = resolve(r[1], { ...ctx, text }, depth + 1);
    if (v !== null && v !== '') return v;
  }
  const lit = body.match(/=\s*"(\d+\.\d+\.\d+\.\d+)"/);
  return lit ? lit[1] : null;
}

for (const [id, c] of Object.entries(db.configs)) {
  const cfPath = path.join(ROOT, 'data', 'cf', `${id}.json`);
  if (!fs.existsSync(cfPath)) continue;
  const cf = JSON.parse(fs.readFileSync(cfPath, 'utf8'));
  const cfg = { name: cf.name, version: cf.version };
  c.configName = cfg.name;
  c.configVersion = cfg.version;
  const texts = {};
  for (const s of c.subsystems) {
    if (s.versionExpr === undefined) s.versionExpr = s.version;
    if (!texts[s.module]) texts[s.module] = moduleText(id, s.module) || '';
    const ctx = { id, cfg, text: texts[s.module] };
    const name = resolve(s.name, ctx);
    s.nameValue = name;
    s.versionValue = resolve(s.versionExpr, ctx);
    s.programName = resolve(s.id, ctx);
    s.isMain = false;
  }
  // основная подсистема: имя совпадает с именем конфигурации (литералом/выражением), иначе — Имя = Метаданные.Имя
  const main = c.subsystems.find(s => s.nameValue === cfg.name && !/^Метаданные\.Имя$/.test(s.name.trim()))
    || c.subsystems.find(s => /^Метаданные\.Имя$/.test(s.name.trim()));
  if (main) main.isMain = true;
  if (main && !main.versionValue) main.versionValue = cfg.version;
  for (const s of c.subsystems) s.version = s.versionValue || null;
  console.log(`${id.padEnd(44)} ${String(main && main.programName).padEnd(20)} ${c.subsystems.filter(s => s.programName && !s.isMain).map(s => `${s.programName} ${s.version || '?'}`).join(', ').slice(0, 150)}`);
}
fs.writeFileSync(dbPath, JSON.stringify(db, null, 1));
console.log('-> data/ids.json');
