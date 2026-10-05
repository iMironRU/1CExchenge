#!/usr/bin/env node
// Страница реестра: tools/page/template.html + data/registry.json + data/catalog-ru.json
// -> work/page/registry.html (публикуется как артефакт).
// Использование: node tools/build-page.js [--out <файл>]
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./lib/products');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(ROOT, 'work', 'page', 'registry.html');
const ann = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'annotations.json'), 'utf8'));
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'registry.json'), 'utf8'));
const catPath = path.join(ROOT, 'data', 'catalog-ru.json');
const catalog = fs.existsSync(catPath) ? JSON.parse(fs.readFileSync(catPath, 'utf8')).configs : [];

// Порядок продуктов в матрице: семейства рядом, редакции по возрастанию
const FAMILY = ['БП', 'БП КОРП', 'БНО', 'УТ', 'КА', 'ERP', 'Управление холдингом', 'УПП', 'Розница', 'УНФ', 'ЗУП', 'ЗУП КОРП', 'ДО КОРП',
  'БГУ', 'ЗКГУ', 'ЗБУ', 'Вещевое довольствие', 'Больничная аптека', 'Плановое питание',
  '1С:Касса', '1С:Мобильная касса', 'РМК', 'Отчетность предпринимателя', 'Клиент ЭДО', 'КАМИН Зарплата',
  'ТиС 7.7', 'Аспект 7.7', 'ЗиК 7.7', 'Бухгалтерия 7.7'];
const FAMILY_GROUP = { 'БП КОРП': 'БП', 'БНО': 'БП', 'ЗУП КОРП': 'ЗУП', 'ЗКГУ': 'БГУ', 'ЗБУ': 'БГУ', 'Вещевое довольствие': 'БГУ', 'Больничная аптека': 'БГУ', 'Плановое питание': 'БГУ', 'КА': 'УТ', 'ERP': 'УТ', '1С:Мобильная касса': '1С:Касса', 'РМК': '1С:Касса' };

const mechClass = m => (/^КД2/.test(m) ? 'kd2' : /EnterpriseData/.test(m) ? 'ed' : /встроен в конфигурацию/.test(m) ? 'doc' : 'proc');

const lines = {};
// ASCII-метка линейки для адреса страницы (#ut-11~bp-3.0)
const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const slug = s => s.toLowerCase().split('').map(ch => (ch in TR ? TR[ch] : ch)).join('').replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
const lineOf = c => {
  const line = c.line;
  if (!lines[line]) {
    const fi = FAMILY.indexOf(c.product);
    const ed = parseFloat(c.edition) || 0;
    const meta = (reg.lines || {})[line] || {};
    lines[line] = { order: (fi < 0 ? 900 : fi * 10) + Math.min(ed, 99) / 100, family: FAMILY_GROUP[c.product] || c.product,
      fam: meta.family || 'Прочее', cur: meta.current !== false, slug: slug(line) };
  }
  return line;
};

const content = {};
const links = reg.links.map(l => {
  const o = {
    id: l.id, k: l.kind === 'переход' ? 't' : 's', m: mechClass(l.mechanism), mech: l.mechanism,
    from: { line: lineOf(l.from), ver: l.from.version || null },
    to: { line: lineOf(l.to), ver: l.to.version || null },
    plan: l.exchangePlan || null, src: l.sources || ['files'],
    ev: l.evidence, notes: l.notes, fv: l.formatVersions || null, urls: l.urls || [],
    cs: l.content ? { summary: l.content.summary, ed: !!l.content.ed, formats: l.content.formats || null, pko: l.content.pko || null,
      off: l.content.off || 0, reg: l.content.reg || null, basis: l.content.basis || null, n: l.content.export.length } : null,
    cls: l.class || null,
  };
  if (l.content) content[l.id] = l.content.export;
  const objs = [];
  o.text = [o.from.line, o.to.line, o.from.ver, o.to.ver, o.mech, o.plan, ...o.notes, ...o.ev, ...objs].join(' ').toLowerCase();
  return o;
});

const templates = reg.templates.map(t => ({
  ...t, count: reg.links.filter(l => l.shippedIn.some(s => s.path === t.path)).length,
}));

const filesPath = path.join(ROOT, 'data', 'catalog-files.json');
const files = fs.existsSync(filesPath) ? JSON.parse(fs.readFileSync(filesPath, 'utf8')).files : {};
const RE_TRANS = /перехода? с|обновления с конфигурац/i;
const RE_EDITION_UPD = /с базовой версии|с версии (ПРОФ|КОРП)|^Порядок/i;

// Статус конфигурации каталога: разобрана (та же редакция) / другая редакция / нет
const cat = catalog.map(c => {
  const f = files[c.id] || {};
  const dl = f.links ? {
    version: f.version, full: f.links.full || null, page: f.links.page || null,
    trans: (f.files || []).map(x => ({ title: x.title.replace(/^.*Версия [\d.]+\.\s*/, ''), url: x.url }))
      .filter(x => RE_TRANS.test(x.title) && !RE_EDITION_UPD.test(x.title)),
  } : { error: f.error ? f.error.replace(/^.*HTTP \d+ /, '') : null };
  const same = reg.templates.filter(t => t.name === c.name);
  const ed = P.edition(c.version);
  const hit = same.filter(t => P.edition(t.version) === ed || (parseInt(ed, 10) >= 11 && parseInt(P.edition(t.version), 10) === parseInt(ed, 10)));
  const status = hit.length ? 'ok' : same.length ? 'old' : 'no';
  const releases = c.releases || (c.name === 'УправлениеПредприятием' ? 'https://releases.1c.ru/project/EnterpriseERP20' : null);
  return { id: c.id, name: c.name, title: c.title, version: c.version, date: c.date, releases, note: c.note,
    status, scanned: (hit.length ? hit : same).map(t => t.version).join(', ') || null, dl };
});

const data = {
  generated: reg.generated, root: reg.templatesRoot, links, lines, templates,
  ed: reg.enterpriseData, catalog: cat, pairNotes: ann.pairNotes || [],
};
const contentJson = JSON.stringify(content);
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const tpl = fs.readFileSync(path.join(__dirname, 'page', 'template.html'), 'utf8');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const pairJs = fs.readFileSync(path.join(__dirname, 'page', 'pair.js'), 'utf8');
const page = tpl.replace('/*__DATA__*/null', () => json).replace('/*__PAIR__*/', () => pairJs);
fs.writeFileSync(OUT, page);
fs.writeFileSync(path.join(path.dirname(OUT), 'content.json'), contentJson);
// --pages: самостоятельный документ для GitHub Pages (артефакт добавляет обёртку сам, Pages — нет)
if (args.includes('--pages')) {
  const dir = path.join(ROOT, 'docs');
  fs.mkdirSync(dir, { recursive: true });
  const NL = String.fromCharCode(10);
  const head = ['<!doctype html>', '<html lang="ru">', '<head>', '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="description" content="Реестр обменов и переходов типовых конфигураций 1С: матрица «из → в», какие объекты ездят, классификация.">',
    '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}img{max-width:100%}[hidden]{display:none!important}</style>', ''].join(NL);
  const i = page.indexOf('<div class="wrap">');
  fs.writeFileSync(path.join(dir, 'index.html'), head + page.slice(0, i) + '</head>' + NL + '<body>' + NL + page.slice(i) + NL + '</body>' + NL + '</html>' + NL);
  fs.writeFileSync(path.join(dir, '.nojekyll'), '');
  fs.writeFileSync(path.join(dir, 'content.json'), contentJson);
  console.log('-> docs/index.html (GitHub Pages)');
}
console.log(`-> ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} КБ, связей ${links.length}, линеек ${Object.keys(lines).length})`);
