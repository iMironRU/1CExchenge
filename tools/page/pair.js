// ---------- Пара: «у меня есть А и Б — что с ними можно сделать и что будет передаваться»
const LINES = Object.keys(lineInfo).sort(byOrder);
const bySlug = Object.fromEntries(LINES.map(l => [lineInfo[l].slug, l]));
const FAM_ORDER = ['Бухгалтерия', 'Торговля и производство', 'Розница и касса', 'Малый бизнес', 'Зарплата и кадры', 'Документооборот', 'НСИ (MDM)', 'Госсектор', 'Прочее'];
const POPULAR = ['УТ 11', 'БП 3.0', 'КА 2', 'ERP 2', 'Розница 3', 'УНФ 3', 'ЗУП КОРП 3', 'ДО КОРП 3', 'РМК 1.1', 'Розница 2'].filter(l => lineInfo[l]);
const MECH_ORDER = ['EnterpriseData', 'Собственный формат', 'Правила КД2', 'КД2, правила из файла', 'Веб-сервис (HTTP)', 'Только описание', 'Обработка', 'Пакет перехода'];
const MECH_TEXT = {
  'Веб-сервис (HTTP)': 'через веб-сервис / HTTP (собственный протокол, без плана обмена БСП)',
  'EnterpriseData': 'через универсальный формат EnterpriseData',
  'Собственный формат': 'в собственном XDTO-формате (не EnterpriseData)',
  'Правила КД2': 'по правилам конвертации (КД2)',
  'КД2, правила из файла': 'по правилам КД2, загружаемым из файла',
  'Только описание': 'встроенный обмен (в поставке только описание)',
  'Обработка': 'обработкой',
  'Пакет перехода': 'пакетом перехода с releases.1c.ru',
};
const KIND_SHORT = { 'Документ': 'док', 'Справочник': 'спр', 'Регистр сведений': 'рег', 'Регистр накопления': 'рег.н', 'Регистр бухгалтерии': 'рег.б', 'План счетов': 'план сч', 'Константа': 'конст', 'ПВХ': 'ПВХ', 'Перечисление': 'пер', 'Прочее': 'проч' };
const PA = { a: 'УТ 11', b: 'БП 3.0' };

// КОРП-редакции и базовые — одна кодовая база: связи одной считаются и для другой (с пометкой)
const TWIN = { 'ЗУП КОРП 3': 'ЗУП 3', 'ЗУП 3': 'ЗУП КОРП 3', 'БП КОРП 3.0': 'БП 3.0', 'БП 3.0': 'БП КОРП 3.0' };
const side = x => [x, TWIN[x]].filter(v => v && lineInfo[v]);
const between = (x, y) => {
  const own = links.filter(l => l.from.line === x && l.to.line === y);
  const twin = links.filter(l => side(x).includes(l.from.line) && side(y).includes(l.to.line) && !(l.from.line === x && l.to.line === y))
    .filter(l => !own.some(o => o.cls && l.cls && o.cls.mech === l.cls.mech));
  return [...own, ...twin.map(l => ({ ...l, twin: true }))];
};
// служебные приложения и сервисы — не годятся как «третья программа»
const NOT_VIA = new Set(['1С:Касса', '1С:Мобильная касса', '1С:Кабинет клиента', 'Маркировка', '1С:Архив']);
const verNum = v => (v || '').split('.').map(n => n.padStart(6, '0')).join('.');
// для перехода старый источник — норма: актуальность по приёмнику
const isAct = l => (l.k === 't' ? !!(lineInfo[l.to.line] || {}).cur : !!(l.cls && l.cls.actual === 'актуальная'));

function fillSelect(sel) {
  const groups = new Map();
  for (const l of LINES) {
    const f = lineInfo[l].fam;
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(l);
  }
  sel.innerHTML = [...groups].sort((x, y) => FAM_ORDER.indexOf(x[0]) - FAM_ORDER.indexOf(y[0])).map(([f, ls]) =>
    `<optgroup label="${esc(f)}">${ls.sort((x, y) => (lineInfo[y].cur - lineInfo[x].cur) || byOrder(x, y))
      .map(l => `<option value="${esc(l)}">${esc(l)}${!lineInfo[l].cur ? ' · устаревшая' : lineInfo[l].sup === 'поддерживается' ? ' · поддерживается' : ''}</option>`).join('')}</optgroup>`).join('');
}

// лучшая связь направления: актуальная, с содержимым побольше, правила посвежее
function best(list) {
  return [...list].sort((x, y) => (isAct(y) - isAct(x)) || ((y.cs ? y.cs.n : 0) - (x.cs ? x.cs.n : 0)) ||
    verNum(y.from.ver).localeCompare(verNum(x.from.ver)))[0] || null;
}

function sumText(cs) {
  if (!cs) return '';
  return Object.entries(cs.summary).sort((a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]))
    .map(([k, n]) => `${n} ${KIND_SHORT[k] || k}`).join(' · ');
}

function edOf(line) {
  const list = DATA.ed.filter(e => e.line === line && e.declared.length);
  return list.sort((a, b) => verNum(b.version).localeCompare(verNum(a.version)))[0] || null;
}
function commonEd(A, B) {
  const a = edOf(A), b = edOf(B);
  if (!a || !b) return null;
  const cmp = (x, y) => x.split('.').map(Number).reduce((r, v, i) => r || v - (y.split('.').map(Number)[i] || 0), 0);
  return a.declared.filter(v => b.declared.includes(v)).sort(cmp);
}

// список «что во что» одной связи — человеческими названиями, по видам, с поиском
function objListHtml(l) {
  const rows = rowsOf(l);
  if (!rows) return '<div class="dim">загрузка…</div>';
  if (!rows.length) return '<div class="dim">состав в правилах не найден</div>';
  const split = s => (s ? [s.slice(0, s.indexOf('.')), s] : [null, null]);
  const byKind = new Map();
  for (const [from, to, via] of rows) {
    const [k] = split(from || to);
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push({ from, to, via });
  }
  const unknown = l.cs && l.cs.ed ? 'не разобрано' : 'выбирается в обработчике';
  const groups = [...byKind].sort((a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0])).map(([k, list]) => {
    const items = list.map(r => {
      const a = r.from ? human(r.from) : `<span class="dim">${unknown}</span>`;
      const b = !r.to ? `<span class="dim">${unknown}</span>` : human(r.to);
      const same = r.from && r.to && human(r.from) === human(r.to);
      const via = l.cs && l.cs.ed && r.via ? `<span class="via">${esc(human(r.via))}</span>` : '';
      const key = [r.from, r.to, r.via].filter(Boolean).join(' ').toLowerCase() + ' ' + [human(r.from), human(r.to)].join(' ').toLowerCase();
      return `<li data-k="${esc(key)}">${same ? esc(a) : `${r.from ? esc(a) : a} <span class="arr">→</span> ${r.to ? esc(b) : b}`}${via}</li>`;
    }).join('');
    const uniq = new Set(list.map(r => r.from || r.to)).size;
    return `<li class="kh">${esc(KIND_PL[k] || k || 'прочее')} <span class="dim">${uniq}</span></li>${items}`;
  }).join('');
  return `<input type="search" class="ofilter" placeholder="Найти объект…" aria-label="Найти объект"><ul class="olist">${groups}</ul>`;
}

function dirBlock(x, y, list) {
  if (!list.length) return `<div class="dir none"><div class="dh2">${esc(x)} → ${esc(y)}</div><div class="dim">в эту сторону нет</div></div>`;
  const main = list.filter(l => !/переход с КД2/.test(l.mech));
  const b = best(main.length ? main : list);
  const ver = b.from.ver || b.to.ver ? `<div class="dim mono">правила собраны для ${esc(b.from.ver || '—')} → ${esc(b.to.ver || '—')}</div>` : '';
  const others = list.filter(l => l !== b && l.mech === b.mech).length;
  const more = others && !(b.cs && b.cs.ed) ? `<div class="dim">ещё вариантов правил: ${others} (другие версии)</div>` : '';
  return `<div class="dir"><div class="dh2">${esc(x)} → ${esc(y)}</div>
    ${b.cs && b.cs.n === 0 ? '<div class="dim">по правилам обмена в эту сторону ничего не передаётся</div>'
      : b.cs ? `<div class="sum">${sumText(b.cs)}</div>`
      : b.cls && b.cls.mech === 'Веб-сервис (HTTP)' ? '<div class="dim">состав — в описании выше</div>' : '<div class="dim">состав не разобран</div>'}
    ${b.cs && b.cs.basis && b.cs.basis.length ? `<div class="notes warn">${esc(b.cs.basis.join(' · '))}</div>` : ''}
    ${ver}${more}
    ${b.cs ? `<details class="objs" data-link="${b.id}"><summary>Что будет передаваться</summary><div class="objs-body"></div></details>` : ''}</div>`;
}

function mechBlock(A, B, mech, group) {
  const ab = group.filter(l => side(A).includes(l.from.line)), ba = group.filter(l => side(B).includes(l.from.line));
  const act = group.some(isAct);
  const plans = [...new Set(group.flatMap(l => (l.plan || '').split(', ').filter(Boolean)))];
  const req = [];
  if (mech === 'EnterpriseData') {
    const c = commonEd(A, B);
    if (c && c.length) req.push(`Общие версии формата: ${c.join(', ')} — будет использована <b>${c[c.length - 1]}</b>.`);
  }
  if (plans.length) req.push(`План обмена: <span class="mono">${plans.map(esc).join(', ')}</span>.`);
  const srcs = new Set(group.flatMap(l => l.src));
  if (/^КД2|^Правила/.test(mech) && srcs.has('files')) req.push('Правила лежат файлом в поставке — их загружают в настройке обмена.');
  if (mech === 'EnterpriseData' && group.some(l => /переход с КД2/.test(l.mech))) req.push('В поставке есть обработка перевода действующего обмена по правилам КД2 на EnterpriseData.');
  if (srcs.has('releases')) req.push('Файл — на странице версии releases.1c.ru.');
  const urls = [...new Set(group.flatMap(l => l.urls || []))];
  // у интеграций без плана обмена протокол и состав описаны в разметке — показываем целиком
  const http = mech === 'Веб-сервис (HTTP)';
  if (http) req.push(`Протокол: ${[...new Set(group.map(l => l.mech))].map(esc).join('; ')}.`);
  if (http) for (const n of new Set(group.flatMap(l => l.notes))) req.push(esc(n));
  const notes = http ? [] : [...new Set(group.flatMap(l => l.notes).filter(n => /не уточнено|не проверена|нужна|только описание/.test(n)))];
  const tw = group.filter(l => l.twin).map(l => `${l.from.line} → ${l.to.line}`);
  if (tw.length) req.push(`Найдено для родственной редакции (общая кодовая база): ${[...new Set(tw)].map(esc).join(', ')}.`);
  const evid = [...new Set(group.flatMap(l => l.ev))].slice(0, 6);
  return `<div class="mech">
    <div class="mh"><span class="mt">${esc(MECH_TEXT[mech] || mech)}</span>
      <span class="pill ${act ? 'ok' : 'old'}">${act ? 'актуально' : 'устаревшие редакции'}</span>
      <span class="pill n">${ab.length && ba.length ? 'в обе стороны' : 'в одну сторону'}</span></div>
    ${req.length ? `<div class="req">${req.join(' ')}</div>` : ''}
    ${urls.length ? `<div class="req">${urls.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">открыть файл на releases.1c.ru</a>`).join(' · ')}</div>` : ''}
    ${notes.length ? `<div class="notes warn">${esc(notes.join(' · '))}</div>` : ''}
    <div class="dirs">${dirBlock(A, B, ab)}${dirBlock(B, A, ba)}</div>
    <details class="more"><summary>откуда это известно</summary><ul class="ev">${evid.map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>
  </div>`;
}

function transBlock(x, y, list) {
  const groups = new Map();
  for (const l of list) { const m = l.cls ? l.cls.mech : l.mech; if (!groups.has(m)) groups.set(m, []); groups.get(m).push(l); }
  const items = [...groups].sort((a, b) => MECH_ORDER.indexOf(a[0]) - MECH_ORDER.indexOf(b[0])).map(([m, g]) => {
    const b = best(g);
    const urls = [...new Set(g.flatMap(l => l.urls || []))];
    const notes = [...new Set(g.flatMap(l => l.notes))].slice(0, 3);
    return `<div class="mech"><div class="mh"><span class="mt">${esc(MECH_TEXT[m] || m)}</span>
        <span class="pill ${g.some(isAct) ? 'ok' : 'old'}">${g.some(isAct) ? 'актуально' : 'устаревшие редакции'}</span></div>
      ${notes.length ? `<div class="req">${esc(notes.join(' · '))}</div>` : ''}
      ${urls.length ? `<div class="req">${urls.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">открыть файл на releases.1c.ru</a>`).join(' · ')}</div>` : ''}
      ${b.cs ? `<div class="sum">${sumText(b.cs)}</div><details class="objs" data-link="${b.id}"><summary>Что переносится</summary><div class="objs-body"></div></details>` : ''}
      <details class="more"><summary>откуда это известно</summary><ul class="ev">${[...new Set(g.flatMap(l => l.ev))].slice(0, 6).map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>
    </div>`;
  }).join('');
  return `<div class="pcard"><div class="ph"><span class="pi t">→</span><h2>Переход ${esc(x)} → ${esc(y)}</h2></div>${items}</div>`;
}

function fallbackHtml(A, B) {
  const out = [];
  const c = commonEd(A, B);
  if (c && c.length) {
    out.push(`<div class="mech"><div class="mh"><span class="mt">Универсальный обмен EnterpriseData</span><span class="pill n">возможно</span></div>
      <div class="req">Прямого варианта настройки нет, но обе программы объявляют общие версии формата: ${c.join(', ')}.
      Обычно такой обмен настраивается вариантом «Другая программа» (универсальный); состав — пересечение того, что одна сторона отправляет, а другая принимает.</div></div>`);
  }
  const near = l => links.filter(x => x.k === 's' && (x.from.line === l || x.to.line === l)).map(x => (x.from.line === l ? x.to.line : x.from.line));
  const na = new Set(near(A)), nb = new Set(near(B));
  const via = [...na].filter(x => nb.has(x) && x !== A && x !== B && !NOT_VIA.has(x) && lineInfo[x].cur).sort((x, y) => (lineInfo[y].cur - lineInfo[x].cur) || byOrder(x, y)).slice(0, 8);
  if (via.length) {
    out.push(`<div class="mech"><div class="mh"><span class="mt">Через третью программу</span></div>
      <div class="req">Обе программы синхронизируются с:</div>
      <div class="chips">${via.map(v => `<button class="chip" data-pa="${esc(A)}" data-pb="${esc(v)}">${esc(A)} ↔ ${esc(v)}</button> <button class="chip" data-pa="${esc(v)}" data-pb="${esc(B)}">${esc(v)} ↔ ${esc(B)}</button>`).join(' ')}</div></div>`);
  }
  return out.length ? `<div class="pcard"><div class="ph"><span class="pi">?</span><h2>Прямой синхронизации нет</h2></div>${out.join('')}</div>`
    : `<div class="pcard"><div class="ph"><span class="pi">?</span><h2>Прямой синхронизации нет</h2></div><div class="req">Ни общих версий EnterpriseData, ни общих партнёров по обмену в реестре не найдено.</div></div>`;
}

// Ограничения базовых версий: заметки по продукту; with — только в паре с этими продуктами
function baseBlock(A, B) {
  const pa = lineInfo[A].prod, pb = lineInfo[B].prod;
  const hit = (p, other) => (DATA.baseNotes || []).filter(n => n.products.includes(p) && (!n.with || n.with.includes(other)));
  const rows = [...new Set([...hit(pa, pb), ...hit(pb, pa)])];
  if (!rows.length) return '';
  return `<details class="base"><summary>Если одна из программ — базовая версия</summary><ul>${
    rows.map(n => `<li><b>${esc(n.products.join(', '))}:</b> ${esc(n.text)}</li>`).join('')}</ul></details>`;
}

function renderPair() {
  const A = PA.a, B = PA.b;
  $('#pa').value = A;
  $('#pb').value = B;
  try { history.replaceState(null, '', '#' + lineInfo[A].slug + '~' + lineInfo[B].slug); } catch { /* превью */ }
  const ab = between(A, B), ba = between(B, A);
  const syncs = [...ab, ...ba].filter(l => l.k === 's');
  const trAB = ab.filter(l => l.k === 't'), trBA = ba.filter(l => l.k === 't');
  // без b — заметка о программе, показывается в любой её паре
  const notes = (DATA.pairNotes || []).filter(n => (n.b ? (n.a === A && n.b === B) || (n.a === B && n.b === A) : n.a === A || n.a === B));
  const html = [];
  const cur = l => (!lineInfo[l].cur ? ' <span class="pill old">устаревшая редакция</span>'
    : lineInfo[l].sup === 'поддерживается' ? ' <span class="pill n">поддерживается, есть новая редакция</span>' : '');
  html.push(`<div class="ptitle">${esc(A)}${cur(A)} <span class="arr">и</span> ${esc(B)}${cur(B)}</div>`);
  for (const n of notes) html.push(`<div class="pnote ${n.kind === 'warn' ? 'warn' : ''}">${esc(n.text)}</div>`);
  if (A === B) {
    html.push('<div class="pcard"><div class="req">Выбрана одна и та же программа. Обмен между её базами показан, если он есть в реестре.</div></div>');
  }
  if (syncs.length) {
    const groups = new Map();
    for (const l of syncs) { const m = l.cls ? l.cls.mech : l.mech; if (!groups.has(m)) groups.set(m, []); groups.get(m).push(l); }
    const ordered = [...groups].sort((a, b) => (b[1].some(isAct) - a[1].some(isAct)) || MECH_ORDER.indexOf(a[0]) - MECH_ORDER.indexOf(b[0]));
    const task = syncs.find(l => l.cls) ? syncs.find(l => l.cls).cls.task : '';
    html.push(`<div class="pcard"><div class="ph"><span class="pi s">⇄</span><h2>Синхронизация</h2><span class="dim">${esc(task)}</span></div>
      ${ordered.map(([m, g]) => mechBlock(A, B, m, g)).join('')}${baseBlock(A, B)}</div>`);
  } else if (A !== B) {
    html.push(fallbackHtml(A, B));
  }
  if (trAB.length) html.push(transBlock(A, B, trAB));
  if (trBA.length) html.push(transBlock(B, A, trBA));
  if (!trAB.length && !trBA.length) html.push(`<div class="pcard muted"><div class="ph"><span class="pi t">→</span><h2>Переход</h2></div><div class="req">Инструментов перехода между ${esc(A)} и ${esc(B)} в поставках не найдено.</div></div>`);
  $('#presult').innerHTML = html.join('');
}

function initPair() {
  fillSelect($('#pa'));
  fillSelect($('#pb'));
  // пара из адреса #slugA~slugB
  const fromHash = () => {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h.includes('~')) return false;
    const [a, b] = h.split('~');
    if (bySlug[a]) PA.a = bySlug[a];
    if (bySlug[b]) PA.b = bySlug[b];
    return true;
  };
  if (!fromHash()) {
    const saved = store.get('pair', null);
    if (saved && lineInfo[saved.a] && lineInfo[saved.b]) Object.assign(PA, saved);
  }
  // ссылка на другую пару при уже открытой странице
  window.addEventListener('hashchange', () => { if (fromHash()) { showTab('pair'); renderPair(); } });
  $('#ppop').innerHTML = '<span class="dim">быстро:</span> ' + POPULAR.map(l => `<button class="chip" data-quick="${esc(l)}">${esc(l)}</button>`).join(' ');
  const set = (k, v) => { PA[k] = v; store.set('pair', PA); renderPair(); };
  $('#pa').addEventListener('change', e => set('a', e.target.value));
  $('#pb').addEventListener('change', e => set('b', e.target.value));
  $('#pswap').addEventListener('click', () => { [PA.a, PA.b] = [PA.b, PA.a]; store.set('pair', PA); renderPair(); });
  // быстрый выбор: в поле, которое было последним в фокусе (по умолчанию — второе)
  let lastSel = 'b';
  $('#pa').addEventListener('focus', () => { lastSel = 'a'; });
  $('#pb').addEventListener('focus', () => { lastSel = 'b'; });
  $('#ppop').addEventListener('click', e => { const c = e.target.closest('[data-quick]'); if (c) set(lastSel, c.dataset.quick); });
  const res = $('#presult');
  res.addEventListener('toggle', e => {
    const d = e.target;
    if (!d.matches || !d.matches('details.objs') || !d.open) return;
    const l = links.find(x => String(x.id) === d.dataset.link);
    const body = d.querySelector('.objs-body');
    body.innerHTML = objListHtml(l);
    if (!CT) ensureCT().then(() => { body.innerHTML = objListHtml(l); });
  }, true);
  res.addEventListener('input', e => {
    if (!e.target.matches('.ofilter')) return;
    const q = e.target.value.trim().toLowerCase();
    for (const li of e.target.nextElementSibling.querySelectorAll('li[data-k]')) li.hidden = q && !li.dataset.k.includes(q);
  });
  res.addEventListener('click', e => {
    const c = e.target.closest('[data-pa]');
    if (c) { PA.a = c.dataset.pa; PA.b = c.dataset.pb; store.set('pair', PA); renderPair(); window.scrollTo({ top: 0 }); }
  });
  document.addEventListener('click', e => {
    const o = e.target.closest('[data-open-a]');
    if (!o) return;
    PA.a = o.dataset.openA; PA.b = o.dataset.openB; store.set('pair', PA);
    showTab('pair'); renderPair(); window.scrollTo({ top: 0 });
  });
  renderPair();
}
initPair();
