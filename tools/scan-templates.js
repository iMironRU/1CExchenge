#!/usr/bin/env node
// Сканер каталога шаблонов 1С (tmplts): находит в поставках правила обмена КД2,
// обработки переходов/обменов и сопроводительные документы.
// Использование: node tools/scan-templates.js [--root C:\.temp\tmplts] [--out data/templates.json]
'use strict';
const fs = require('fs');
const path = require('path');
const { listEntries, readEntry } = require('./lib/zip');
const { decodeText, rootElement, parseRules } = require('./lib/rules');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
  return a;
}, []));
const ROOT = args.root || 'C:\\.temp\\tmplts';
const OUT = args.out || path.join(__dirname, '..', 'data', 'templates.json');

const SKIP_EXT = new Set(['.cf', '.cfu', '.dt', '.mft', '.ttf', '.jpg', '.jpeg', '.png', '.gif', '.bmp',
  '.pdf', '.ppt', '.pptx', '.doc', '.docx', '.des', '.css', '.js', '.feature']);
const PROC_EXT = new Set(['.epf', '.erf', '.ert']);
const DOC_EXT = new Set(['.htm', '.html', '.txt']);

function walk(dir, out = []) {
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
    const mft = items.find(d => d.isFile() && d.name.toLowerCase() === '1cv8.mft');
    if (mft) { res.push({ dir, mft: path.join(dir, mft.name) }); return; }
    if (depth < 4) for (const d of items) if (d.isDirectory()) rec(path.join(dir, d.name), depth + 1);
  })(root, 0);
  return res;
}

function parseMft(file) {
  const text = decodeText(fs.readFileSync(file));
  const kv = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([^=\[]+)=(.*)$/);
    if (m && !(m[1].trim() in kv)) kv[m[1].trim()] = m[2].trim();
  }
  const catalog = (kv.Catalog || '').split('/')[0].trim();
  return { vendor: kv.Vendor || null, name: kv.Name || null, version: kv.Version || null, synonym: catalog || null };
}

// Контекст артефакта по пути внутри поставки
function context(rel) {
  const segs = rel.split(/[\\/]/);
  for (let i = 0; i < segs.length; i++) {
    const m = segs[i].match(/^Обмен с (?:конфигурацией|приложением)\s+(.+)$/i);
    if (m) return { section: 'exchange', partner: m[1].trim() };
    if (/^Переходы с других конфигураций$/i.test(segs[i])) {
      const rest = segs.slice(i + 1, -1);
      if (rest[0] && /^Синхронизация данных$/i.test(rest[0])) return { section: 'exchange', partner: rest[1] || null };
      return { section: 'transition', partner: rest[0] || null };
    }
    if (/^Conv/i.test(segs[i]) && i < segs.length - 1) return { section: 'transition', partner: segs[i] };
    if (/^(Exchange|Обмены данными)$/i.test(segs[i]) && i === segs.length - 2) return { section: 'exchange', partner: null };
  }
  return { section: null, partner: null };
}

function xmlArtifact(buf, where) {
  const text = decodeText(buf);
  const rules = parseRules(text);
  if (rules) return { type: 'rules', ...where, ...rules };
  return { type: 'xml', ...where, root: rootElement(text) };
}

// zip бывает вложенным (ДО 2.0: «Правила обмена.zip» внутри «Правила обмена.zip»)
function scanZip(buf, where, prefix, artifacts) {
  for (const e of listEntries(buf)) {
    if (e.dir) continue;
    const eext = path.extname(e.name).toLowerCase();
    const w = { ...where, entry: prefix + e.name };
    if (eext === '.xml') artifacts.push(xmlArtifact(readEntry(buf, e), w));
    else if (eext === '.zip') scanZip(readEntry(buf, e), where, `${prefix}${e.name}::`, artifacts);
    else if (PROC_EXT.has(eext)) artifacts.push({ type: 'processing', ...w });
  }
}

function scanTemplate(t) {
  const meta = parseMft(t.mft);
  const artifacts = [];
  for (const file of walk(t.dir)) {
    const rel = path.relative(t.dir, file);
    const ext = path.extname(file).toLowerCase();
    if (SKIP_EXT.has(ext) || path.basename(file).toLowerCase() === 'thumbs.db') continue;
    const ctx = context(rel);
    const where = { file: rel, ...ctx };
    try {
      if (ext === '.xml') {
        artifacts.push(xmlArtifact(fs.readFileSync(file), where));
      } else if (ext === '.zip') {
        scanZip(fs.readFileSync(file), where, '', artifacts);
      } else if (PROC_EXT.has(ext)) {
        artifacts.push({ type: 'processing', ...where });
      } else if (DOC_EXT.has(ext) && ctx.section) {
        artifacts.push({ type: 'doc', ...where });
      }
    } catch (err) {
      artifacts.push({ type: 'error', ...where, error: String(err.message || err) });
    }
  }
  return { path: path.relative(ROOT, t.dir).replace(/\\/g, '/'), ...meta, artifacts };
}

const templates = findTemplates(ROOT).map(scanTemplate);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ root: ROOT, scanned: new Date().toISOString(), templates }, null, 1));
for (const t of templates) {
  const c = t.artifacts.reduce((a, x) => (a[x.type] = (a[x.type] || 0) + 1, a), {});
  console.log(`${t.path.padEnd(28)} ${String(t.name).padEnd(40)} ${t.version}  ${JSON.stringify(c)}`);
}
console.log(`-> ${OUT}`);
