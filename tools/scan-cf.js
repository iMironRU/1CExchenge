#!/usr/bin/env node
// Разбор CF поставок: планы обмена, встроенные правила КД2, корреспонденты, версии EnterpriseData.
// Конвейер на поставку (кешируется в work/, повторный запуск пропускает готовые шаги):
//   1) ibcmd infobase create + config load <1cv8.cf>        -> work/ib/<id>       (~5 мин)
//   2) ibcmd infobase config export info                    -> work/cf/<id>/ConfigDumpInfo.xml
//   3) ibcmd infobase config export objects (обмены)        -> work/cf/<id>/xml
//   4) анализ                                               -> data/cf/<id>.json
// Лицензия не нужна (ibcmd). Использование:
//   node tools/scan-cf.js [--root C:\.temp\tmplts] [--only trade/11_6] [--ibcmd <path>]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { decodeText, parseRules, unescapeXml } = require('./lib/rules');
const { rulesContent } = require('./lib/rules-content');
const { edRules, handEdRules } = require('./lib/ed-rules');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));
const ROOT = args.root || 'C:\\.temp\\tmplts';
const PROJECT = path.join(__dirname, '..');
const WORK = path.join(PROJECT, 'work');
const OUT = path.join(PROJECT, 'data', 'cf');
// Не прикладные конфигурации — обменов с ними не ищем
const SKIP_NAMES = new Set(['БиблиотекаСтандартныхПодсистем', 'КонвертацияДанныхРедакция21', 'БиблиотекаПодключаемогоОборудования']);

function findIbcmd() {
  if (args.ibcmd) return args.ibcmd;
  const base = 'C:\\Program Files\\1cv8';
  const vers = fs.readdirSync(base).filter(d => /^\d+\.\d+\.\d+\.\d+$/.test(d))
    .filter(d => fs.existsSync(path.join(base, d, 'bin', 'ibcmd.exe')))
    .sort((a, b) => a.split('.').map(Number).reduce((r, x, i) => r || x - b.split('.').map(Number)[i], 0));
  if (!vers.length) throw new Error('ibcmd.exe не найден в C:\\Program Files\\1cv8');
  return path.join(base, vers[vers.length - 1], 'bin', 'ibcmd.exe');
}
const IBCMD = findIbcmd();

function ibcmd(argv, log, timeoutMin = 60) {
  const t0 = Date.now();
  const r = spawnSync(IBCMD, argv, { encoding: 'utf8', timeout: timeoutMin * 60000, maxBuffer: 64 << 20 });
  const text = `> ibcmd ${argv.join(' ')}\n${r.stdout || ''}${r.stderr || ''}\n[exit ${r.status} ${(Date.now() - t0) / 1000}s]\n`;
  fs.appendFileSync(log, text);
  if (r.status !== 0) throw new Error(`ibcmd ${argv[0]} ${argv[1]} ${argv[2] || ''}: exit ${r.status}\n${(r.stdout || '') + (r.stderr || '')}`.trim());
  return r;
}

function readText(file) {
  return decodeText(fs.readFileSync(file));
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function findTemplates(root) {
  const res = [];
  (function rec(dir, depth) {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    const cf = items.find(d => d.isFile() && d.name.toLowerCase() === '1cv8.cf');
    const mft = items.find(d => d.isFile() && d.name.toLowerCase() === '1cv8.mft');
    if (mft) {
      if (cf) res.push({ dir, cf: path.join(dir, cf.name), mft: path.join(dir, mft.name) });
      return;
    }
    if (depth < 4) for (const d of items) if (d.isDirectory()) rec(path.join(dir, d.name), depth + 1);
  })(root, 0);
  return res;
}

function mftName(file) {
  const m = readText(file).match(/^Name=(.*)$/m);
  return m ? m[1].trim() : null;
}

// ---------- выбор объектов для выгрузки
const RE_MODULE = /Обмен|Синхрониз|EnterpriseData|Переход|Перенос/i;
const RE_PROCESSOR = /Переход|Перенос|ЗагрузкаДанныхИз|ЗагрузкаИз|Конвертац|Миграц|EnterpriseData|Обмен/i;

function topObjects(dumpInfo) {
  const names = new Set();
  for (const m of dumpInfo.matchAll(/name="([A-Za-z]+)\.([^".]+)"/g)) names.add(`${m[1]}.${m[2]}`);
  return [...names];
}

// ---------- анализ выгрузки
function synonym(xml) {
  const m = xml.match(/<Synonym>\s*<v8:item>\s*<v8:lang>ru<\/v8:lang>\s*<v8:content>([^<]*)<\/v8:content>/);
  return m ? unescapeXml(m[1]) : null;
}
function comment(xml) {
  const m = xml.match(/<Comment>([^<]*)<\/Comment>/);
  return m ? unescapeXml(m[1]) : null;
}

// ---------- корреспонденты плана обмена (БСП)
// Модуль менеджера общий для УТ/КА/ERP: в ПриПолученииОписанияВариантаНастройки описаны все
// варианты, а реально предлагаются только добавленные в ПриПолученииВариантовНастроекОбмена.

function methodBody(bsl, name) {
  const m = bsl.match(new RegExp(`^\\s*(?:Процедура|Функция)\\s+${name}\\s*\\([^)]*\\)[^\\n]*\\n([\\s\\S]*?)^\\s*Конец(?:Процедуры|Функции)`, 'm'));
  return m ? m[1] : null;
}

const ID = '[A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]*';
// вызов без параметров: [Квалификатор.]Функция() — квалификатор = общий модуль или ПланыОбмена.<План>
const CALL = `((?:${ID}\\.)*)(${ID})\\(\\s*\\)`;

// Контекст разрешения функций: текущий модуль + выгруженные общие модули и модули менеджеров
function makeCtx(bsl, xmlDir) {
  const cache = new Map();
  const load = rel => {
    if (!cache.has(rel)) {
      const p = path.join(xmlDir, rel);
      cache.set(rel, fs.existsSync(p) ? readText(p) : null);
    }
    return cache.get(rel);
  };
  return {
    cur: { id: '', text: bsl },
    module(qual, cur) {
      if (!qual) return cur;
      const parts = qual.replace(/\.$/, '').split('.');
      let rel = null;
      if (parts[0] === 'ПланыОбмена' && parts.length === 2) rel = path.join('ExchangePlans', parts[1], 'Ext', 'ManagerModule.bsl');
      else if (parts.length === 1) rel = path.join('CommonModules', parts[0], 'Ext', 'Module.bsl');
      const text = rel ? load(rel) : null;
      return text ? { id: qual, text } : null;
    },
  };
}

// Литералы-идентификаторы из тела функции (функция-константа или предикат «ЭтоОбмен_X»);
// вложенные вызовы без параметров разворачиваются рекурсивно, в т.ч. в других модулях
function literalsOf(qual, fn, ctx, cur = ctx.cur, seen = new Set()) {
  const mod = ctx.module(qual, cur);
  const key = `${mod ? mod.id : '?'}:${fn}`;
  if (!mod || seen.has(key)) return [];
  seen.add(key);
  const body = methodBody(mod.text, fn);
  if (!body) return [];
  const res = [...body.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  for (const m of body.matchAll(new RegExp(CALL, 'g'))) res.push(...literalsOf(m[1] || null, m[2], ctx, mod, seen));
  return res;
}

// Значение идентификатора варианта: литерал или вызов функции
function resolveIds(expr, ctx) {
  const lit = expr.match(/^"([^"]*)"$/);
  if (lit) return [lit[1]];
  const call = expr.match(new RegExp(`^${CALL}$`));
  return call ? literalsOf(call[1] || null, call[2], ctx) : [];
}

// Идентификаторы из условия ветки: «ИдентификаторНастройки = X» и «Предикат(ИдентификаторНастройки)»
function condIds(cond, ctx) {
  if (!/ИдентификаторНастройки/.test(cond)) return null;
  const ids = [];
  for (const m of cond.matchAll(new RegExp(`ИдентификаторНастройки\\s*=\\s*("[^"]*"|(?:${ID}\\.)*${ID}\\(\\s*\\))`, 'g'))) ids.push(...resolveIds(m[1], ctx));
  for (const m of cond.matchAll(new RegExp(`((?:${ID}\\.)*)(${ID})\\(\\s*ИдентификаторНастройки\\s*\\)`, 'g'))) ids.push(...literalsOf(m[1] || null, m[2], ctx));
  return ids;
}

// Имена и наименования корреспондентов в ветке; порядок присваивания в разных
// конфигурациях разный, поэтому пары составляем по порядковому номеру.
// Формы: .Вставить("ИмяКонфигурацииКорреспондента", "X") / ….ИмяКонфигурацииКорреспондента = "X" /
// локальная переменная ИмяКонфигурацииКорреспондента = НСтр("ru = 'X'") (ЗУП)
function corrInText(text) {
  const names = [], titles = [];
  const re = /(ИмяКонфигурацииКорреспондента|НаименованиеКонфигурацииКорреспондента)"?\s*[,=]\s*(?:НСтр\("ru\s*=\s*'([^']*)'[^)]*\)|"([^"]*)")/g;
  for (const m of text.matchAll(re)) {
    const val = m[2] != null ? m[2] : m[3];
    (m[1] === 'ИмяКонфигурацииКорреспондента' ? names : titles).push(val);
  }
  return names.filter(Boolean).map((name, i) => ({ name, title: titles[i] || null }));
}

function correspondents(bsl, xmlDir) {
  const ctx = makeCtx(bsl, xmlDir);
  const offeredBody = methodBody(bsl, 'ПриПолученииВариантовНастроекОбмена');
  const offered = offeredBody === null ? null : new Set(
    [...offeredBody.matchAll(/ИдентификаторНастройки\s*=\s*([^;\n]+);/g)].flatMap(m => resolveIds(m[1].trim(), ctx)));
  const descr = methodBody(bsl, 'ПриПолученииОписанияВариантаНастройки') || bsl;

  // ветки Если/ИначеЕсли по ИдентификаторНастройки
  const res = [];
  const parts = descr.split(/^\s*(?=(?:ИначеЕсли|Если|Иначе)\s)/m);
  for (const part of parts) {
    const cond = part.match(/^(?:ИначеЕсли|Если)\s+([\s\S]*?)\s+Тогда/);
    let text = part;
    // ветка может вызывать процедуру модуля с описанием варианта
    for (const c of part.matchAll(/^\s*([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\(ОписаниеВарианта\);/gm)) {
      text += '\n' + (methodBody(bsl, c[1]) || '');
    }
    const corr = corrInText(text);
    if (!corr.length) continue;
    const ids = cond ? condIds(cond[1], ctx) : null;
    for (const c of corr) {
      const isOffered = offered === null || ids === null ? null : ids.some(id => offered.has(id));
      res.push({ ...c, variants: ids, offered: isOffered });
    }
  }
  return res;
}

function formatVersions(bsl) {
  const vers = new Set();
  for (const m of bsl.matchAll(/ВерсииФормата\w*\.Вставить\(\s*"(\d+\.\d+(?:\.\d+)*)"/g)) vers.add(m[1]);
  // рукописный EnterpriseData (1С:Мобильная касса): Функция ПоддерживаемыеВерсииФорматаОбмена() с Массив.Добавить("1.x")
  const fn = bsl.match(/Функция\s+ПоддерживаемыеВерсииФорматаОбмена\s*\([\s\S]*?КонецФункции/);
  if (fn) for (const m of fn[0].matchAll(/\.Добавить\(\s*"(\d+\.\d+(?:\.\d+)*)"\s*\)/g)) vers.add(m[1]);
  return [...vers];
}

const verCmp = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

// Макеты объекта, содержащие правила КД2 (Template.txt / Template.xml)
function rulesTemplates(objDir) {
  const res = [];
  const tdir = path.join(objDir, 'Templates');
  if (!fs.existsSync(tdir)) return res;
  for (const d of fs.readdirSync(tdir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const ext = path.join(tdir, d.name, 'Ext');
    for (const f of ['Template.txt', 'Template.xml']) {
      const p = path.join(ext, f);
      if (!fs.existsSync(p)) continue;
      const text = readText(p);
      const rules = parseRules(text);
      if (rules) res.push({ template: d.name, ...rules, content: rulesContent(text) });
    }
  }
  return res;
}

// Модули правил EnterpriseData (по одному на версию формата у ДО и Розницы)
function edModules(xmlDir) {
  const dir = path.join(xmlDir, 'CommonModules');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    // бывают с префиксом подсистемы: «нсиМенеджерОбмена…» (MDM), «Питание_МенеджерОбмена…» (Комбинат питания)
    .filter(n => /^[А-Яа-яЁёA-Za-z]*_?МенеджерОбменаЧерезУниверсальныйФормат(_?[\d_]+|[А-ЯЁ]{1,3})?$/.test(n) && fs.existsSync(path.join(dir, n, 'Ext', 'Module.bsl')))
    .map(n => ({ name: n, text: readText(path.join(dir, n, 'Ext', 'Module.bsl')) }));
}

// Правила EnterpriseData: модули БСП (ПКО), иначе — рукописный обмен (1С:Мобильная касса):
// общий модуль с диспетчерами ПолучитьОбъектXDTO (выгрузка) и ЗагрузитьОбъект (загрузка)
function edRulesOf(xmlDir) {
  const mods = edModules(xmlDir);
  if (mods.length) return edRules(mods);
  const dir = path.join(xmlDir, 'CommonModules');
  if (!fs.existsSync(dir)) return edRules([]);
  const hand = fs.readdirSync(dir)
    .map(n => ({ name: n, file: path.join(dir, n, 'Ext', 'Module.bsl') }))
    .filter(m => fs.existsSync(m.file))
    .map(m => ({ name: m.name, text: readText(m.file) }))
    .filter(m => /^\s*Функция\s+ПолучитьОбъектXDTO\s*\(/m.test(m.text) && /^\s*Процедура\s+ЗагрузитьОбъект\s*\(/m.test(m.text));
  return hand.length ? handEdRules(hand) : edRules([]);
}

// Обмены в собственном формате (не EnterpriseData), но с правилами в модуле того же вида (ДобавитьПКО_*):
// план обмена -> общий модуль менеджера обмена
const PLAN_FORMAT_MODULES = { 'ФИБОбменБГУ': 'ФИББГУМенеджерОбмена' };
function planRules(xmlDir) {
  const out = {};
  for (const [plan, mod] of Object.entries(PLAN_FORMAT_MODULES)) {
    const file = path.join(xmlDir, 'CommonModules', mod, 'Ext', 'Module.bsl');
    if (fs.existsSync(path.join(xmlDir, 'ExchangePlans', `${plan}.xml`)) && fs.existsSync(file)) {
      out[plan] = edRules([{ name: mod, text: readText(file) }]);
    }
  }
  return out;
}

function analyze(id, cfDir, meta) {
  const xmlDir = path.join(cfDir, 'xml');
  const dumpInfo = fs.readFileSync(path.join(cfDir, 'ConfigDumpInfo.xml'), 'utf8');
  const all = topObjects(dumpInfo);
  const edPackages = all.filter(n => /^XDTOPackage\.EnterpriseData_\d/.test(n)).map(n => n.replace('XDTOPackage.EnterpriseData_', '').replace(/_/g, '.'));

  const plans = [];
  const epDir = path.join(xmlDir, 'ExchangePlans');
  for (const f of fs.existsSync(epDir) ? fs.readdirSync(epDir).filter(f => f.endsWith('.xml')) : []) {
    const name = f.slice(0, -4);
    const xml = readText(path.join(epDir, f));
    const mm = path.join(epDir, name, 'Ext', 'ManagerModule.bsl');
    const bsl = fs.existsSync(mm) ? readText(mm) : '';
    plans.push({
      name,
      synonym: synonym(xml),
      comment: comment(xml),
      distributed: /<DistributedInfoBase>true<\/DistributedInfoBase>/.test(xml),
      xdto: /ЭтоПланОбменаXDTO\s*=\s*Истина/.test(bsl) || /ВерсииФорматаОбмена/.test(bsl),
      correspondents: correspondents(bsl, xmlDir),
      sourceConfigName: ((bsl.match(/ИмяКонфигурацииИсточника\s*=\s*"([^"]+)"/) || [])[1]) || null,
      rules: rulesTemplates(path.join(epDir, name)),
    });
  }

  const processors = [];
  const dpDir = path.join(xmlDir, 'DataProcessors');
  for (const f of fs.existsSync(dpDir) ? fs.readdirSync(dpDir).filter(f => f.endsWith('.xml')) : []) {
    const name = f.slice(0, -4);
    const xml = readText(path.join(dpDir, f));
    processors.push({ name, synonym: synonym(xml), comment: comment(xml), rules: rulesTemplates(path.join(dpDir, name)) });
  }

  // версии EnterpriseData, которые конфигурация реально объявляет для обмена
  const fv = new Set();
  for (const file of walk(xmlDir).filter(p => p.endsWith('.bsl'))) for (const v of formatVersions(readText(file))) fv.add(v);

  return {
    id, ...meta,
    scanned: new Date().toISOString(),
    enterpriseData: { declared: [...fv].sort(verCmp), xdtoPackages: edPackages.sort(verCmp), rules: edRulesOf(xmlDir) },
    planRules: planRules(xmlDir),
    exchangePlans: plans,
    processors,
  };
}

// ---------- конвейер
function processTemplate(t) {
  const rel = path.relative(ROOT, t.dir).replace(/\\/g, '/');
  const id = rel.replace(/\//g, '__');
  const name = mftName(t.mft);
  if (SKIP_NAMES.has(name)) { console.log(`${rel}: пропуск (${name})`); return; }
  const version = (readText(t.mft).match(/^Version=(.*)$/m) || [])[1];
  const ibDir = path.join(WORK, 'ib', id);
  const cfDir = path.join(WORK, 'cf', id);
  const log = path.join(cfDir, 'ibcmd.log');
  fs.mkdirSync(cfDir, { recursive: true });
  const step = s => console.log(`${rel}: ${s}`);

  if (!fs.existsSync(path.join(ibDir, '.loaded'))) {
    fs.rmSync(ibDir, { recursive: true, force: true });
    step('создание базы и загрузка CF...');
    ibcmd(['infobase', 'create', `--data=${ibDir}`], log, 10);
    ibcmd(['infobase', 'config', 'load', `--data=${ibDir}`, t.cf], log, 60);
    fs.writeFileSync(path.join(ibDir, '.loaded'), t.cf);
  }
  const infoFile = path.join(cfDir, 'ConfigDumpInfo.xml');
  if (!fs.existsSync(infoFile)) {
    step('список объектов (ConfigDumpInfo)...');
    ibcmd(['infobase', 'config', 'export', 'info', `--data=${ibDir}`, `--out=${cfDir}`], log, 20);
  }
  const xmlDir = path.join(cfDir, 'xml');
  if (!fs.existsSync(path.join(xmlDir, '.done'))) {
    const all = topObjects(fs.readFileSync(infoFile, 'utf8'));
    const pick = all.filter(n => n.startsWith('ExchangePlan.') ||
      (n.startsWith('CommonModule.') && RE_MODULE.test(n)) ||
      (n.startsWith('DataProcessor.') && RE_PROCESSOR.test(n)));
    step(`выгрузка ${pick.length} объектов...`);
    fs.rmSync(xmlDir, { recursive: true, force: true });
    // Список объектов — пачками (лимит командной строки Windows ~32К символов). ibcmd пишет
    // только в пустой каталог, поэтому каждая пачка — в свой, затем сливаем.
    const batches = [[]];
    let len = 0;
    for (const n of pick) {
      if (len + n.length > 20000) { batches.push([]); len = 0; }
      batches[batches.length - 1].push(n);
      len += n.length + 3;
    }
    batches.forEach((b, i) => {
      const part = `${xmlDir}.part${i}`;
      fs.rmSync(part, { recursive: true, force: true });
      ibcmd(['infobase', 'config', 'export', 'objects', `--data=${ibDir}`, `--out=${part}`, '--recursive', ...b], log, 60);
      fs.cpSync(part, xmlDir, { recursive: true });
      fs.rmSync(part, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(xmlDir, '.done'), String(pick.length));
  }
  step('анализ...');
  const res = analyze(id, cfDir, { path: rel, name, version });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(res, null, 1));
  const corr = res.exchangePlans.reduce((n, p) => n + p.correspondents.length, 0);
  const rules = res.exchangePlans.reduce((n, p) => n + p.rules.length, 0) + res.processors.reduce((n, p) => n + p.rules.length, 0);
  step(`готово: планов обмена ${res.exchangePlans.length}, корреспондентов ${corr}, правил КД2 ${rules}, ` +
    `EnterpriseData ${res.enterpriseData.declared.join(', ') || '—'}`);
}

let templates = findTemplates(ROOT);
if (args.only) templates = templates.filter(t => path.relative(ROOT, t.dir).replace(/\\/g, '/').includes(args.only));
for (const t of templates) {
  try { processTemplate(t); } catch (e) { console.error(`${t.dir}: ОШИБКА ${e.message}`); process.exitCode = 1; }
}
