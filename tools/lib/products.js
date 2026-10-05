// Нормализация конфигураций: имя из правил/папки поставки -> продукт + редакция.
// Ключ продукта (key) — короткое устойчивое обозначение для реестра и матрицы.
'use strict';

// В JS-регулярках \b и \w — только ASCII. В шаблонах ниже \B означает «конец слова»,
// \W — «буква/цифра» с учётом кириллицы (подменяются в re()).
const W = '[0-9a-zа-яё_]';
const re = s => new RegExp(s.replace(/\\B/g, `(?!${W})`).replace(/\\W/g, W), 'i');

// Порядок важен: более специфичные шаблоны раньше
const PRODUCTS = [
  { key: 'БНО', names: [/^БухгалтерияНекоммерческойОрганизации/], labels: [re('некоммерческой организации')] },
  { key: 'ЗКГУ', names: [/^ЗарплатаИКадрыГосударственногоУчреждения/], labels: [re('зарплат\\W* и кадр\\W* государственного')] },
  { key: 'ЗБУ', names: [/^ЗарплатаИКадрыБюджетногоУчреждения/], labels: [re('зарплат\\W* и кадр\\W* бюджетного')] },
  { key: 'БГУ', names: [/^БухгалтерияГосударственногоУчреждения/], labels: [re('бухгалтери\\W* государственного учреждения|^бгу\\B')] },
  { key: 'Вещевое довольствие', names: [/^ВещевоеДовольствие/], labels: [re('вещевое довольствие')] },
  { key: 'Больничная аптека', names: [/^БольничнаяАптека/], labels: [re('больничная аптека')] },
  { key: 'Плановое питание', names: [/^ПлановоеПитание/], labels: [re('планов\\W* питани')] },
  { key: 'БП КОРП', names: [/^БухгалтерияПредприятияКОРП/], labels: [re('бухгалтери[яи] предприятия.*корп|^бп корп|^бп,? ред\\.? ?[\\d.]+ корп')] },
  { key: 'БП', names: [/^БухгалтерияПредприятия(Базовая\d?)?$/], labels: [re('бухгалтери[яи] предприятия|^бп\\B')] },
  { key: 'УТ', names: [/^УправлениеТорговлей(Базовая|\d*)$/], labels: [re('управлени[ея] торговлей|^ут\\B')] },
  { key: 'Розница', names: [/^Розница(Базовая)?$/], labels: [re('розниц')] },
  { key: 'УНФ', names: [/^УправлениеНебольшойФирмой/], labels: [re('управлени[ея] нашей фирмой|небольшой фирмой|^унф\\B')] },
  { key: 'УПП', names: [/^УправлениеПроизводственнымПредприятием/], labels: [re('производственным предприятием|^упп\\B')] },
  { key: 'ERP', names: [/^УправлениеПредприятием\d*$/, /^ERP/i], labels: [re('(^|[^a-z])erp\\B|управление предприятием')] },
  { key: 'КА', names: [/^КомплекснаяАвтоматизация/], labels: [re('комплексн\\W+ автоматизац|^ка\\d?\\B')] },
  { key: 'ДО КОРП', names: [/^Документооборот(КОРП)?\d*$/], labels: [re('документооборот')] },
  { key: 'ЗУП КОРП', names: [/^ЗарплатаИУправлениеПерсоналомКОРП/], labels: [re('зарплат\\W+ и управлени\\W+ персоналом.*корп')] },
  { key: 'ЗУП', names: [/^ЗарплатаИУправлениеПерсоналом$/], labels: [re('зарплат\\W+ и управлени\\W+ персоналом|^зуп\\B')] },
  { key: 'Отчетность предпринимателя', names: [/^ОтчетностьПредпринимателя/], labels: [re('отчетность предпринимателя')] },
  { key: '1С:Мобильная касса', names: [/^МобильнаяКасса$/], labels: [re('мобильная касса')] },
  { key: '1С:Касса', names: [/^КассаБазовая$/, /^Касса$/], labels: [re('1с:? ?касса')] },
  { key: 'РМК', names: [/^РабочееМестоКассира/], labels: [re('рабочее место кассира')] },
  { key: 'ТиС 7.7', names: [/Торговля\+Склад/i], labels: [re('торговля\\s*\\+\\s*склад|^ут92$|^conv9_2$|^conv77_8$')] },
  { key: 'Аспект 7.7', names: [/Аспект/i], labels: [re('аспект|^conv_asp$')] },
  { key: 'ЗиК 7.7', names: [/ЗарплатаИКадры/i], labels: [re('^зик\\B|зарплата и кадры')] },
  { key: 'Бухгалтерия 7.7', names: [/^Бухгалтерия77/i], labels: [re('^бухгалтерия 7\\.7')] },
  { key: 'КАМИН Зарплата', names: [/^КаминЗарплата/], labels: [re('камин')] },
  { key: 'Клиент ЭДО', names: [/^КлиентЭДО/], labels: [re('клиент эдо')] },
  { key: 'Конвертация данных', names: [/^КонвертацияДанных/], labels: [re('конвертаци\\W+ данных')] },
  { key: 'БСП', names: [/^БиблиотекаСтандартныхПодсистем/], labels: [] },
];

// Редакция = major.minor; у конфигураций 7.7 версия вида 7.70.xxx — редакцию не выделяем
function edition(version) {
  if (!version) return null;
  const p = String(version).trim().split('.');
  if (p[0] === '7' && /^70/.test(p[1] || '')) return '7.7';
  return p.length >= 2 ? `${p[0]}.${p[1]}` : p[0];
}

function byName(name) {
  const n = (name || '').trim();
  return PRODUCTS.find(p => p.names.some(r => r.test(n))) || null;
}

function byLabel(label) {
  const l = (label || '').trim();
  return PRODUCTS.find(p => p.labels.some(r => r.test(l))) || null;
}

// Конфигурация из заголовка правил {name, version, synonym}
function fromRules(c) {
  if (!c) return null;
  const p = byName(c.name) || byLabel(c.synonym) || byLabel(c.name);
  // «Торговля+Склад, редакция 9.2» / «1С:Аспект 7.7 (версия 7.70.022)»: версия в имени
  const ver = c.version || ((c.name || '').match(/версия\s+([\d.]+)/i) || [])[1] || null;
  return {
    product: p ? p.key : c.name,
    edition: p && /7\.7$/.test(p.key) ? null : edition(ver),
    version: ver,
    name: c.name,
    synonym: c.synonym || null,
  };
}

// Конфигурация из подписи папки: «Розница ред. 2», «БП, ред. 3.0 КОРП», «ERP Управление предприятием, ред. 2.0»
function fromLabel(label) {
  if (!label) return null;
  const p = byLabel(label);
  // «…, ред. 3.0» / «…, редакция 11»; иначе — номер в конце («1С:ERP Управление предприятием 2.0»)
  const m = label.match(/ред(?:\.|акция)?\s*([\d.]+)/i) || label.match(/\s(\d+(?:\.\d+)?)\s*$/);
  const legacy = p && /7\.7$/.test(p.key);
  return {
    product: p ? p.key : label,
    edition: m && !legacy ? m[1].replace(/\.$/, '') : null,
    version: null,
    name: null,
    synonym: label,
  };
}

// Шаблон поставки {name, version, synonym}
function fromTemplate(t) {
  const p = byName(t.name);
  return { product: p ? p.key : t.name, edition: edition(t.version), version: t.version, name: t.name, synonym: t.synonym };
}

function display(c) {
  if (!c) return '?';
  return c.edition ? `${c.product} ${c.edition}` : c.product;
}

// Линейка для матрицы: внутри «длинных» редакций (УТ 11.x, Розница 2.x, …) minor не различаем
const MAJOR_LINES = { 'УТ': 11, 'Розница': 2, 'КА': 2, 'ERP': 2, 'ЗУП': 3, 'ЗУП КОРП': 3, 'ЗКГУ': 3, 'УНФ': 3, 'ДО КОРП': 3 };
function line(c) {
  if (!c) return '?';
  if (!c.edition) return c.product;
  const major = parseInt(c.edition, 10);
  if (c.product in MAJOR_LINES && major >= MAJOR_LINES[c.product]) return `${c.product} ${major}`;
  return `${c.product} ${c.edition}`;
}

module.exports = { fromRules, fromLabel, fromTemplate, display, line, edition };
