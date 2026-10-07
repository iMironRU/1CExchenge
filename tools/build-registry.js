#!/usr/bin/env node
// Сборка реестра обменов/переходов из результатов сканирования поставок.
// Вход: data/templates.json (scan-templates.js), data/annotations.json (ручная разметка).
// Выход: data/registry.json, data/registry.csv, REGISTRY.md
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./lib/products');

const ROOT = path.join(__dirname, '..');
const scan = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'templates.json'), 'utf8'));
const ann = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'annotations.json'), 'utf8'));
const procRules = ann.processings.map(a => ({ ...a, re: new RegExp(a.match, 'i') }));

const links = new Map();

// Одинаковые правила лежат в нескольких поставках (УТ 11.5 и 11.6) — сливаем в одну связь
// со списком поставок; ключ включает версии, на которые собраны правила.
// Те же правила, найденные и файлом поставки, и макетом в CF, тоже сливаются (источник — оба).
function addLink(l) {
  // правила КД2 различаем по версиям, на которые собраны; остальные связи — уровня линейки конфигурации
  const versioned = /^КД2: правила конвертации/.test(l.mechanism);
  const c = x => (versioned ? `${P.display(x)}@${x.version || ''}` : P.line(x));
  const key = [c(l.from), c(l.to), l.kind, l.mechanism].join('|');
  const ex = links.get(key);
  const ev = l.evidence.map(e => `${l.shippedIn.product} ${l.shippedIn.version}: ${e}`);
  const source = l.source || 'files';
  if (ex) {
    if (!ex.shippedIn.some(s => s.path === l.shippedIn.path)) ex.shippedIn.push(l.shippedIn);
    for (const e of ev) if (!ex.evidence.includes(e)) ex.evidence.push(e);
    for (const n of l.notes) if (!ex.notes.includes(n)) ex.notes.push(n);
    if (!ex.sources.includes(source)) ex.sources.push(source);
    if (l.exchangePlan && !(ex.exchangePlan || '').split(', ').includes(l.exchangePlan)) {
      ex.exchangePlan = ex.exchangePlan ? `${ex.exchangePlan}, ${l.exchangePlan}` : l.exchangePlan;
    }
    for (const n of l.notes) if (!ex.notes.includes(n)) ex.notes.push(n);
    ex.content = ex.content || l.content || null;
    if (l.formatVersions) ex.formatVersions = l.formatVersions;
    for (const u of l.urls || []) if (!(ex.urls || (ex.urls = [])).includes(u)) ex.urls.push(u);
    return;
  }
  links.set(key, { ...l, shippedIn: [l.shippedIn], evidence: ev, sources: [source] });
}

// У правил иногда не указана версия стороны (Аспект 7.7 -> УТ); если это продукт самой
// поставки — берём редакцию поставки
function withSelf(c, self) {
  if (c && !c.edition && c.product === self.product) return { ...c, edition: self.edition };
  // общий код: в Больнице правила подписаны «МедицинаПоликлиника» — это она сама
  // (и правила в собственном CF, подписанные старой версией: Поликлиника 3.0 с правилами «1.4»)
  if (c && ((ann.selfAliases || {})[self.product] || []).includes(c.product)) return { ...self, version: c.version };
  return c;
}

// Что передают правила: включённые ПВД (откуда → куда, группа), число ПКО, состав регистрации
function linkContent(conv, reg) {
  const c = conv && conv.content;
  if (!c || c.kind !== 'conversion') return null;
  const on = c.export.filter(e => !e.off);
  const r = reg && reg.content && reg.content.kind === 'registration' ? reg.content : null;
  return {
    summary: c.summary, pko: c.pko, off: c.export.length - on.length,
    export: on.map(e => [e.from, e.to, e.group]),
    reg: r ? { summary: r.summary, count: r.composition.length } : null,
  };
}

function evidence(a) {
  return a.entry ? `${a.file} :: ${a.entry}` : a.file;
}

for (const t of scan.templates) {
  const self = P.fromTemplate(t);
  const shippedIn = { path: t.path, product: self.product, version: t.version, name: t.name };
  // для обработок версия «себя» не несёт информации (это версия поставки, она в shippedIn)
  const selfRef = { ...self, version: null };
  const resolve = label => (label === '$self' ? selfRef : P.fromLabel(label));

  // группируем по папке внутри поставки: одна папка = один обмен (правила + описание)
  const groups = new Map();
  for (const a of t.artifacts) {
    const dir = path.dirname(a.file);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(a);
  }

  for (const [dir, items] of groups) {
    const conv = items.filter(a => a.type === 'rules' && a.kind === 'conversion');
    const reg = items.filter(a => a.type === 'rules' && a.kind === 'registration');
    const procs = items.filter(a => a.type === 'processing');
    const docs = items.filter(a => a.type === 'doc');
    const section = (items.find(a => a.section) || {}).section || null;
    const partner = (items.find(a => a.partner) || {}).partner || null;
    let produced = 0;

    for (const a of conv) {
      const from = withSelf(P.fromRules(a.source), self);
      const to = withSelf(P.fromRules(a.target), self);
      const legacy = from && from.edition === null && /7\.7/.test(from.product);
      const kind = section === 'transition' || legacy ? 'переход' : 'синхронизация';
      // правила регистрации той же папки/архива, относящиеся к стороне-источнику
      const plan = reg.find(r => r.file === a.file) || reg[0];
      const notes = [];
      if (/первый обмен/i.test(a.file + (a.entry || ''))) notes.push('правила первого обмена');
      if (a.title) notes.push(`«${a.title}»`);
      addLink({
        from, to, kind,
        mechanism: 'КД2: правила конвертации',
        exchangePlan: plan ? plan.exchangePlan : null,
        content: linkContent(a, plan),
        rulesFormat: a.formatVersion,
        rulesCreated: a.created,
        shippedIn,
        evidence: [evidence(a), ...(plan ? [evidence(plan)] : []), ...docs.map(evidence)],
        notes,
      });
      produced++;
    }

    for (const a of procs) {
      const r = procRules.find(x => x.re.test(a.file + (a.entry ? '/' + a.entry : '')));
      if (!r) {
        if (section) addLink({
          from: selfRef, to: P.fromLabel(partner), kind: section === 'transition' ? 'переход' : 'синхронизация',
          mechanism: 'обработка (не размечена)', exchangePlan: null, shippedIn,
          evidence: [evidence(a)], notes: ['нужна ручная разметка в data/annotations.json'],
        });
        continue;
      }
      if (r.skip) continue;
      const from = r.from ? resolve(r.from) : self;
      const to = r.to ? resolve(r.to) : P.fromLabel(partner);
      addLink({
        from, to, kind: r.kind, mechanism: r.mechanism, exchangePlan: null, shippedIn,
        evidence: [evidence(a), ...docs.map(evidence)], notes: r.note ? [r.note] : [],
      });
      produced++;
    }

    // папка обмена только с описанием: обмен встроен в конфигурацию
    if (!produced && section === 'exchange' && partner && docs.length) {
      addLink({
        from: selfRef, to: P.fromLabel(partner), kind: 'синхронизация',
        mechanism: 'встроен в конфигурацию (в поставке только описание)', exchangePlan: null, shippedIn,
        evidence: docs.map(evidence), notes: [],
      });
    }
  }
}

// ---------- CF: планы обмена, встроенные правила, корреспонденты EnterpriseData, обработки перехода
const cfDir = path.join(ROOT, 'data', 'cf');
const cfScans = fs.existsSync(cfDir)
  ? fs.readdirSync(cfDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(cfDir, f), 'utf8')))
  : [];
const skipPlans = new RegExp(ann.skipPlans || '^$');
const cfProc = (ann.cfProcessors || []).map(a => ({ ...a, re: new RegExp(a.match) }));
// обмен по плану в собственном XDTO-формате конфигураций (не EnterpriseData), правила — в модуле менеджера обмена
const OWN_FORMAT = 'собственный формат XDTO';
const planPartners = (ann.planPartners || []).map(a => ({ ...a, re: new RegExp(a.plan) }));
const enterpriseData = [];

for (const cf of cfScans) {
  const self = P.fromTemplate(cf);
  const selfRef = { ...self, version: null };
  const shippedIn = { path: cf.path, product: self.product, version: cf.version, name: cf.name };
  const base = { shippedIn, source: 'cf' };
  enterpriseData.push({ config: self, declared: cf.enterpriseData.declared, packages: cf.enterpriseData.xdtoPackages });

  for (const p of cf.exchangePlans) {
    if (skipPlans.test(p.name)) continue;
    const where = `CF: ПланОбмена.${p.name}`;
    for (const r of p.rules.filter(r => r.kind === 'conversion')) {
      addLink({
        ...base, kind: 'синхронизация', mechanism: 'КД2: правила конвертации', exchangePlan: p.name,
        from: withSelf(P.fromRules(r.source), self), to: withSelf(P.fromRules(r.target), self),
        rulesFormat: r.formatVersion, rulesCreated: r.created,
        evidence: [`${where}.Макет.${r.template}`], notes: r.title ? [`«${r.title}»`] : [],
        content: linkContent(r, p.rules.find(x => x.kind === 'registration')),
      });
    }
    // партнёры планов без корреспондентов в коде — по ручной разметке
    for (const a of planPartners) {
      if (!a.re.test(p.name) || (a.for && !a.for.includes(self.product))) continue;
      for (const label of a.partners) {
        const corr = P.withCurrent(P.fromLabel(label));
        const common = { ...base, kind: 'синхронизация', exchangePlan: p.name, evidence: [where], notes: a.note ? [a.note] : [],
          mechanism: a.mechanism || ((cf.planRules || {})[p.name] ? OWN_FORMAT : p.xdto ? 'EnterpriseData' : 'КД2: план обмена, правила из файла') };
        if (a.direction !== 'in') addLink({ ...common, from: selfRef, to: corr });
        if (a.direction !== 'out') addLink({ ...common, from: corr, to: selfRef });
      }
    }
    if (!p.xdto) continue;
    for (const c of p.correspondents) {
      if (c.offered === false || c.name === 'ДругаяПрограмма') continue;
      const notes = [`вариант настройки: ${c.title || c.name}`, ...(c.offered === null ? ['доступность варианта не проверена'] : [])];
      const common = { ...base, kind: 'синхронизация', mechanism: 'EnterpriseData', exchangePlan: p.name,
        formatVersions: cf.enterpriseData.declared, evidence: [where], notes };
      // «1С:ERP Управление предприятием 2 / Комплексная автоматизация, редакция 2» — два корреспондента
      for (const label of (c.title || c.name).split(/\s+\/\s+/)) {
        const corr = P.withCurrent(P.fromLabel(label));
        addLink({ ...common, from: selfRef, to: corr });
        addLink({ ...common, from: corr, to: selfRef });
      }
    }
  }

  // интеграции без плана обмена (веб-сервисы, HTTP, расширение у партнёра) — по ручной разметке;
  // direction: out — отсюда к партнёру, in — от партнёра сюда, both (по умолчанию)
  for (const a of ann.integrations || []) {
    if (!a.for.includes(self.product)) continue;
    for (const label of a.partners) {
      const corr = P.withCurrent(P.fromLabel(label));
      const common = { ...base, kind: 'синхронизация', exchangePlan: a.plan || null, mechanism: a.mechanism,
        evidence: (a.evidence || []).map(e => `CF: ${e}`), notes: a.note ? [a.note] : [] };
      if (a.direction !== 'in') addLink({ ...common, from: selfRef, to: corr });
      if (a.direction !== 'out') addLink({ ...common, from: corr, to: selfRef });
    }
  }

  const conversions = d => d.rules.filter(r => r.kind === 'conversion' && !/ПустыеПравила/i.test(r.template));
  for (const d of cf.processors) {
    const rules = cfProc.filter(a => a.re.test(d.name) && (!a.for || a.for.includes(self.product)));
    if (rules.some(a => a.skip)) continue;
    const where = `CF: Обработка.${d.name}`;
    if (rules.length) {
      for (const a of rules) {
        const notes = a.note ? [a.note] : [];
        for (const s of a.sources || []) {
          addLink({ ...base, kind: 'переход', mechanism: 'встроенная обработка', exchangePlan: null,
            from: P.fromLabel(s), to: selfRef, evidence: [where], notes });
        }
        for (const t of a.targets || []) {
          addLink({ ...base, kind: 'переход', mechanism: 'встроенная обработка', exchangePlan: null,
            from: selfRef, to: P.fromLabel(t), evidence: [where], notes });
        }
        // правила КД2 в макетах обработки описывают направление сами
        if (a.rulesKind) for (const r of conversions(d)) {
          addLink({ ...base, kind: a.rulesKind, mechanism: 'КД2: правила конвертации', exchangePlan: null,
            from: withSelf(P.fromRules(r.source), self), to: withSelf(P.fromRules(r.target), self),
            rulesFormat: r.formatVersion, rulesCreated: r.created,
            evidence: [`${where}.Макет.${r.template}`], notes: [...notes, ...(r.title ? [`«${r.title}»`] : [])] });
        }
      }
      continue;
    }
    // не размечено: правила КД2 в макетах обработки или «говорящее» имя
    for (const r of conversions(d)) {
      addLink({ ...base, kind: 'переход', mechanism: 'встроенная обработка + правила КД2', exchangePlan: null,
        from: withSelf(P.fromRules(r.source), self), to: withSelf(P.fromRules(r.target), self),
        evidence: [`${where}.Макет.${r.template}`],
        notes: ['нужна проверка: data/annotations.json → cfProcessors'] });
    }
    // имя «ПомощникПереходаС…/ЗагрузкаДанныхИз…/ПереносДанныхИз…» без разметки — источник из синонима
    const m = /^(ПомощникПереходаС|ЗагрузкаДанныхИз|ПереносДанныхИз)/.test(d.name) &&
      (d.synonym || '').match(/(?:перехода|переноса данных|загрузки данных|загрузка данных|загрузка)\s+(?:с|из)\s+(.+)$/i);
    if (!d.rules.length && m) {
      addLink({ ...base, kind: 'переход', mechanism: 'встроенная обработка', exchangePlan: null,
        from: P.fromLabel(m[1]), to: selfRef, evidence: [where],
        notes: [`«${d.synonym}»`, 'нужна проверка: data/annotations.json → cfProcessors'] });
    }
  }
}

// ---------- releases.1c.ru: пакеты перехода среди файлов последних версий (API Апдейкона)
const filesPath = path.join(ROOT, 'data', 'catalog-files.json');
const catPath = path.join(ROOT, 'data', 'catalog-ru.json');
if (fs.existsSync(filesPath) && fs.existsSync(catPath)) {
  const files = JSON.parse(fs.readFileSync(filesPath, 'utf8')).files;
  const relRules = (ann.releaseFiles || []).map(a => ({ ...a, re: new RegExp(a.match, 'i') }));
  for (const c of JSON.parse(fs.readFileSync(catPath, 'utf8')).configs) {
    const f = files[c.id];
    if (!f || !f.files) continue;
    const self = P.fromTemplate({ name: c.name, version: f.version, synonym: c.title });
    const shippedIn = { path: `releases:${f.nick}/${f.version}`, product: self.product, version: f.version, name: c.name };
    for (const x of f.files) {
      const title = x.title.replace(/^.*Версия [\d.]+\.\s*/, '');
      const r = relRules.find(a => a.re.test(title));
      if (!r || r.skip) continue;
      for (const s of r.from) {
        addLink({
          shippedIn, source: 'releases', kind: 'переход', mechanism: r.mechanism || 'пакет перехода',
          exchangePlan: null, from: P.fromLabel(s), to: { ...self, version: null },
          evidence: [`releases.1c.ru: ${x.path}`], notes: [`«${title}» (${c.title})`], urls: [x.url],
        });
      }
    }
  }
}

// ---------- EnterpriseData: какие объекты «ездят» — отправка одной стороны ∩ получение другой по объекту формата
const verCmp = (a, b) => String(a).split('.').map(Number).reduce((r, x, i) => r || x - (String(b).split('.').map(Number)[i] || 0), 0);
const edBy = new Map();
for (const cf of cfScans) {
  const r = cf.enterpriseData && cf.enterpriseData.rules;
  if (!r || !r.rules) continue;
  const self = P.fromTemplate(cf);
  const ln = P.line(self);
  const prev = edBy.get(ln);
  if (!prev || verCmp(cf.version, prev.version) > 0) edBy.set(ln, { ...r, version: cf.version, display: P.display(self) });
}
// линейки без своей поставки берём по родственной конфигурации (общая кодовая база)
const ED_ALIAS = { 'БП КОРП 3.0': 'БП 3.0', 'ЗУП 3': 'ЗУП КОРП 3', 'ЗУП КОРП 3': 'ЗУП 3', 'ERP 2': 'КА 2', 'ДО КОРП': 'ДО КОРП 3' };
const edFor = line => edBy.get(line) || (ED_ALIAS[line] && edBy.get(ED_ALIAS[line]) ? { ...edBy.get(ED_ALIAS[line]), alias: ED_ALIAS[line] } : null);

// Правила обменов в собственном формате (planRules): линейка -> план -> {send, receive}
const planBy = new Map();
for (const cf of cfScans) {
  const ln = P.line(P.fromTemplate(cf));
  for (const [plan, r] of Object.entries(cf.planRules || {})) if (r && r.rules) planBy.set(ln + '|' + plan, r);
}

function edContent(fromLine, toLine, plan) {
  const get = plan ? ln => planBy.get(ln + '|' + plan) || null : edFor;
  const A = get(fromLine), B = get(toLine);
  if (!A && !B) return null;
  const rows = [];
  if (A) {
    const recv = new Map();
    if (B) for (const [f, d] of B.receive) { if (!recv.has(f)) recv.set(f, []); recv.get(f).push(d); }
    for (const [d, f] of A.send) {
      if (!B) { rows.push([d, null, f]); continue; }
      for (const y of recv.get(f) || []) rows.push([d, y, f]);
    }
  } else {
    for (const [f, y] of B.receive) rows.push([null, y, f]);
  }
  const objs = [...new Set(rows.map(r => r[0] || r[1]))];
  const summary = {};
  for (const o of objs) { const k = o.split('.')[0]; summary[k] = (summary[k] || 0) + 1; }
  const basis = [];
  if (A && A.alias) basis.push(`отправка — по ${A.alias} (общая кодовая база)`);
  if (B && B.alias) basis.push(`получение — по ${B.alias} (общая кодовая база)`);
  if (!A) basis.push(`правила ${fromLine} не разобраны: показано всё, что умеет принимать ${toLine} — фактический состав меньше`);
  if (!B) basis.push(`правила ${toLine} не разобраны: показано всё, что умеет отправлять ${fromLine} — фактический состав меньше`);
  return { ed: true, summary, export: rows, formats: new Set(rows.map(r => r[2])).size, pko: null, off: 0, reg: null, basis };
}
for (const l of links.values()) {
  if (l.mechanism !== 'EnterpriseData' && l.mechanism !== OWN_FORMAT) continue;
  l.content = planBy.has(P.line(l.from) + '|' + l.exchangePlan) || planBy.has(P.line(l.to) + '|' + l.exchangePlan)
    ? edContent(P.line(l.from), P.line(l.to), l.exchangePlan)
    : edContent(P.line(l.from), P.line(l.to));
}

const list = [...links.values()].sort((a, b) =>
  P.line(a.from).localeCompare(P.line(b.from), 'ru') || P.line(a.to).localeCompare(P.line(b.to), 'ru') ||
  a.shippedIn[0].path.localeCompare(b.shippedIn[0].path));
list.forEach((l, i) => { l.id = i + 1; });

// ---------- классификация: направление, механизм, учётная задача, актуальность
const { familyOf: familyOfProduct, is77 } = require('./lib/families');
const familyOf = c => familyOfProduct(c.product);

// актуальные линейки — последние редакции из каталога Апдейкона
const currentLines = new Set();
if (fs.existsSync(catPath)) {
  for (const c of JSON.parse(fs.readFileSync(catPath, 'utf8')).configs) {
    currentLines.add(P.line(P.fromTemplate({ name: c.name, version: c.version })));
  }
}
// поддержка по всему каталогу (tools/fetch-support.js): последняя редакция и дата последнего релиза
const supPath = path.join(ROOT, 'data', 'catalog-support.json');
const support = fs.existsSync(supPath) ? JSON.parse(fs.readFileSync(supPath, 'utf8')).lines : {};
const YEAR = 365 * 864e5;
const recent = d => !!d && Date.now() - Date.parse(d) <= YEAR;
// актуальная — последняя редакция с релизами за год; поддерживается — не последняя, но релизы за год ещё выходят
// (Розница 2.3 при Рознице 3.0); без даты в каталоге — по последним редакциям «типовых» (ERP, ЗБУ)
function supportOf(c) {
  if (is77(c)) return 'устаревшая';
  const ln = P.line(c), s = support[ln];
  if ((ann.supportOverride || {})[ln]) return ann.supportOverride[ln];
  if (s && s.lastRelease) return recent(s.lastRelease) ? (s.latest ? 'актуальная' : 'поддерживается') : 'устаревшая';
  // линейка без редакции (Касса, Архив, Мобильная касса, сервисы) — одна, она и актуальна
  if (!c.edition || ln === c.product || currentLines.has(ln)) return 'актуальная';
  return 'устаревшая';
}
const isCurrent = c => supportOf(c) !== 'устаревшая';

function mechClass(m) {
  if (/^КД2: правила конвертации/.test(m)) return 'Правила КД2';
  if (/правила из файла/.test(m)) return 'КД2, правила из файла';
  if (/EnterpriseData/.test(m)) return 'EnterpriseData';
  if (m === OWN_FORMAT) return 'Собственный формат';
  if (/пакет перехода|дистрибутив обновления/.test(m)) return 'Пакет перехода';
  if (/встроен в конфигурацию/.test(m)) return 'Только описание';
  if (/веб-сервис|HTTP/i.test(m)) return 'Веб-сервис (HTTP)';
  return 'Обработка';
}

function task(l) {
  const a = familyOf(l.from), b = familyOf(l.to), fams = new Set([a, b]);
  if (l.kind === 'переход') {
    if (is77(l.from)) return 'Переход с 1С 7.7';
    if (a === b) return 'Переход на новую редакцию';
    return 'Переход на другую программу';
  }
  if (l.from.product === l.to.product) return 'Между базами одной программы';
  // Клиент ЭДО — электронный обмен документами с контрагентами, а не внутренний документооборот
  if (l.from.product === 'Клиент ЭДО' || l.to.product === 'Клиент ЭДО') return 'ЭДО с контрагентами ↔ учёт';
  // MDM — центр нормативно-справочной информации: раздаёт и собирает справочники
  if (fams.has('НСИ (MDM)')) return 'НСИ (MDM) ↔ учётные системы';
  if (l.from.product === 'Корпоративный университет' || l.to.product === 'Корпоративный университет') return 'Обучение персонала ← кадры';
  if (fams.has('Документооборот')) return 'Документооборот и архив';
  if (fams.has('Госсектор')) return 'Госсектор';
  if (fams.has('Зарплата и кадры')) return 'Зарплата и кадры → учёт';
  if (fams.has('Бухгалтерия')) return 'Оперативный учёт ↔ бухгалтерия';
  if (fams.has('Розница и касса')) return 'Розница и касса ↔ управление';
  // УПП ↔ УТ 10.3, КА ↔ УПП, УНФ ↔ УТ 11 — разные программы оперативного учёта
  return 'Оперативный учёт: между программами';
}

const pairKey = l => `${P.line(l.from)}→${P.line(l.to)}`;
const syncPairs = new Set(list.filter(l => l.kind === 'синхронизация').map(pairKey));
for (const l of list) {
  l.class = {
    task: task(l),
    mech: mechClass(l.mechanism),
    dir: l.kind === 'переход' ? 'перенос' : syncPairs.has(`${P.line(l.to)}→${P.line(l.from)}`) ? 'двусторонняя' : 'односторонняя',
    // переход со старой программы — норма: актуален, если приёмник актуален
    actual: (l.kind === 'переход' ? isCurrent(l.to) : isCurrent(l.from) && isCurrent(l.to)) ? 'актуальная' : 'устаревшая сторона',
  };
}

// ---- JSON
const out = {
  generated: new Date().toISOString(),
  templatesRoot: scan.root,
  templates: scan.templates.map(t => ({ path: t.path, name: t.name, version: t.version, synonym: t.synonym })),
  links: list.map(l => ({
    id: l.id, kind: l.kind, mechanism: l.mechanism,
    from: { ...l.from, line: P.line(l.from) }, to: { ...l.to, line: P.line(l.to) },
    exchangePlan: l.exchangePlan, rulesFormat: l.rulesFormat || null, rulesCreated: l.rulesCreated || null,
    formatVersions: l.formatVersions || null, content: l.content || null,
    class: l.class, sources: l.sources, shippedIn: l.shippedIn, evidence: l.evidence, notes: l.notes, urls: l.urls || [],
  })),
  enterpriseData: enterpriseData.map(e => ({ config: P.display(e.config), line: P.line(e.config), version: e.config.version, declared: e.declared, packages: e.packages })),
  // линейки: семейство и актуальность — для выбора пары на странице
  lines: Object.fromEntries([...new Map(list.flatMap(l => [l.from, l.to]).map(c => [P.line(c), c])).entries()].map(([ln, c]) => [ln, { product: c.product, edition: c.edition || null, family: familyOf(c), current: isCurrent(c), support: supportOf(c) }])),
};
fs.writeFileSync(path.join(ROOT, 'data', 'registry.json'), JSON.stringify(out, null, 1));

// ---- CSV (Excel: UTF-8 BOM, разделитель «;»)
const csvq = v => {
  const s = v == null ? '' : String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const header = ['id', 'Тип', 'Источник', 'Версия источника', 'Приёмник', 'Версия приёмника', 'Механизм',
  'План обмена', 'Где найдено (поставки)', 'Примечание', 'Файлы'];
const rows = out.links.map(l => [l.id, l.kind, l.from.line, l.from.version, l.to.line, l.to.version, l.mechanism,
  l.exchangePlan, l.shippedIn.map(s => `${s.product} ${s.version}`).join(', '), l.notes.join('; '), l.evidence.join(' | ')]);
fs.writeFileSync(path.join(ROOT, 'data', 'registry.csv'),
  '﻿' + [header, ...rows].map(r => r.map(csvq).join(';')).join('\r\n') + '\r\n');

// ---- Markdown
const md = [];
md.push('# Реестр обменов и переходов типовых конфигураций 1С', '');
md.push(`Сгенерировано ${out.generated.slice(0, 10)} из поставок в \`${scan.root}\` (\`tools/build-registry.js\`).`, '');
md.push('## Просканированные поставки', '', '| Поставка | Конфигурация | Версия | Связей |', '|---|---|---|---|');
for (const t of scan.templates) {
  const n = out.links.filter(l => l.shippedIn.some(s => s.path === t.path)).length;
  md.push(`| \`${t.path}\` | ${t.synonym || t.name} | ${t.version} | ${n} |`);
}

// матрица по линейкам: строка = источник, столбец = приёмник
const lines = [...new Set(out.links.flatMap(l => [l.from.line, l.to.line]))].sort((a, b) => a.localeCompare(b, 'ru'));
const cell = new Map();
for (const l of out.links) {
  const k = `${l.from.line}→${l.to.line}`;
  if (!cell.has(k)) cell.set(k, new Set());
  cell.get(k).add(l.kind === 'переход' ? 'П' : l.kind === 'синхронизация' ? 'С' : '·');
}
md.push('', '## Матрица «из → в»', '', 'Строка — источник, столбец — приёмник. **С** — синхронизация (обмен), **П** — переход (перенос данных).', '');
md.push(`| из \\ в | ${lines.join(' | ')} |`, `|---|${lines.map(() => ':-:').join('|')}|`);
for (const a of lines) {
  const r = lines.map(b => (cell.has(`${a}→${b}`) ? [...cell.get(`${a}→${b}`)].sort().join('') : ''));
  if (r.some(Boolean)) md.push(`| **${a}** | ${r.join(' | ')} |`);
}

// версии EnterpriseData: что объявляет каждая конфигурация и общие версии пар
if (out.enterpriseData.length) {
  md.push('', '## EnterpriseData: версии формата', '',
    'Объявленные для обмена версии (`ВерсииФормата.Вставить(...)` в коде CF). Обмен через EnterpriseData возможен, если у пары есть общая версия.', '',
    '| Конфигурация | Версия поставки | Объявленные версии формата |', '|---|---|---|');
  for (const e of out.enterpriseData) md.push(`| ${e.config} | ${e.version} | ${e.declared.join(', ') || '—'} |`);
  const ed = out.enterpriseData.filter(e => e.declared.length);
  if (ed.length > 1) {
    md.push('', 'Максимальная общая версия для пар:', '', `| | ${ed.map(e => e.config).join(' | ')} |`, `|---|${ed.map(() => ':-:').join('|')}|`);
    const cmp = (a, b) => a.split('.').map(Number).reduce((r, x, i) => r || x - (b.split('.').map(Number)[i] || 0), 0);
    for (const a of ed) {
      md.push(`| **${a.config}** | ${ed.map(b => {
        if (a === b) return '—';
        const common = a.declared.filter(v => b.declared.includes(v)).sort(cmp);
        return common.length ? common[common.length - 1] : '✗';
      }).join(' | ')} |`);
    }
  }
}

md.push('', '## Связи', '', 'Источник: **ф** — файл поставки, **CF** — объект конфигурации, **rel** — файл версии на releases.1c.ru.', '',
  '| # | Тип | Из | В | Механизм | План обмена | Ист. | Где найдено |', '|---|---|---|---|---|---|---|---|');
for (const l of out.links) {
  const ver = c => (c.version ? ` <sub>${c.version}</sub>` : '');
  const where = l.evidence.slice(0, 2).map(e => '`' + e + '`').join('<br>') + (l.evidence.length > 2 ? `<br><sub>…ещё ${l.evidence.length - 2}</sub>` : '');
  const notes = l.notes.length ? `<br><sub>${l.notes.join('; ')}</sub>` : '';
  const src = l.sources.map(s => ({ cf: 'CF', releases: 'rel' })[s] || 'ф').join('+');
  md.push(`| ${l.id} | ${l.kind} | ${l.from.line}${ver(l.from)} | ${l.to.line}${ver(l.to)} | ${l.mechanism}${notes} | ${l.exchangePlan ? '`' + l.exchangePlan + '`' : ''} | ${src} | ${where} |`);
}
fs.writeFileSync(path.join(ROOT, 'REGISTRY.md'), md.join('\n') + '\n');

console.log(`links: ${out.links.length} (${Object.entries(out.links.reduce((a, l) => (a[l.kind] = (a[l.kind] || 0) + 1, a), {})).map(([k, v]) => `${k} ${v}`).join(', ')})`);
console.log('-> data/registry.json, data/registry.csv, REGISTRY.md');
