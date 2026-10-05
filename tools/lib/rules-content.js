// Содержимое правил КД2: что выгружается (ПВД), во что конвертируется (ПКО), что регистрируется.
// Результат компактный — для реестра и страницы.
'use strict';
const { parseXml, kids, kid, txt } = require('./xml');

// «СправочникСсылка.Номенклатура» -> { kind: 'Справочник', name: 'Номенклатура' }
const KIND = [
  [/^Справочник(Ссылка|Объект)?\./, 'Справочник'],
  [/^Документ(Ссылка|Объект)?\./, 'Документ'],
  [/^Перечисление(Ссылка)?\./, 'Перечисление'],
  [/^ПланВидовХарактеристик(Ссылка)?\./, 'ПВХ'],
  [/^ПланСчетов(Ссылка)?\./, 'План счетов'],
  [/^ПланВидовРасчета(Ссылка)?\./, 'ПВР'],
  [/^РегистрСведений(Запись|НаборЗаписей)?\./, 'Регистр сведений'],
  [/^РегистрНакопления(НаборЗаписей)?\./, 'Регистр накопления'],
  [/^РегистрБухгалтерии(НаборЗаписей)?\./, 'Регистр бухгалтерии'],
  [/^РегистрРасчета(НаборЗаписей)?\./, 'Регистр расчета'],
  [/^Константы?(МенеджерЗначения|Набор)?\./, 'Константа'],
  [/^БизнесПроцесс(Ссылка)?\./, 'Бизнес-процесс'],
  [/^Задача(Ссылка)?\./, 'Задача'],
  [/^ПланОбмена(Ссылка)?\./, 'План обмена'],
];
function objectRef(type) {
  if (!type) return null;
  const t = type.trim();
  for (const [re, kind] of KIND) if (re.test(t)) return { kind, name: t.replace(re, '') };
  return { kind: 'Прочее', name: t };
}
const short = r => (r ? `${r.kind}.${r.name}` : null);

// Обход правил с группами: <Группа><Правило/>…</Группа>, группы бывают вложенными
function walkRules(el, group, out) {
  for (const c of el.children) {
    if (c.name === 'Группа') walkRules(c, txt(c, 'Наименование') || txt(c, 'Код') || group, out);
    else if (c.name === 'Правило') out.push({ rule: c, group });
  }
  return out;
}

function conversionContent(root) {
  const top = kid(root, 'ПравилаОбмена');
  const pkoEl = kid(top, 'ПравилаКонвертацииОбъектов');
  const pvdEl = kid(top, 'ПравилаВыгрузкиДанных');
  const pko = new Map();
  for (const { rule } of pkoEl ? walkRules(pkoEl, null, []) : []) {
    const code = (txt(rule, 'Код') || '').trim();
    pko.set(code, {
      code,
      source: txt(rule, 'Источник'),
      target: txt(rule, 'Приемник'),
      props: kids(kid(rule, 'Свойства'), 'Свойство').length + kids(kid(rule, 'Свойства'), 'Группа').length,
    });
  }
  const exp = [];
  for (const { rule, group } of pvdEl ? walkRules(pvdEl, null, []) : []) {
    const code = (txt(rule, 'КодПравилаКонвертации') || '').trim();
    const p = pko.get(code);
    const src = objectRef(txt(rule, 'ОбъектВыборки') || (p && p.source));
    const dst = objectRef(p && p.target);
    exp.push({
      group: group || null,
      name: txt(rule, 'Наименование') || txt(rule, 'Код'),
      from: short(src),
      to: short(dst),
      off: rule.attrs['Отключить'] === 'true' || undefined,
    });
  }
  return { export: exp, pko: pko.size };
}

function registrationContent(root) {
  const top = kid(root, 'ПравилаРегистрации');
  const comp = kids(kid(top, 'СоставПланаОбмена'), 'Элемент').map(e => ({
    obj: short(objectRef(txt(e, 'Тип'))),
    auto: txt(e, 'Авторегистрация') === 'true' || undefined,
  }));
  const rulesEl = kid(top, 'ПравилаРегистрацииОбъектов');
  const reg = (rulesEl ? walkRules(rulesEl, null, []) : []).map(({ rule }) => {
    const obj = txt(rule, 'ОбъектМетаданныхИмя') || txt(rule, 'ОбъектНастройки');
    return short(objectRef(obj));
  }).filter(Boolean);
  return { composition: comp, registered: [...new Set(reg)] };
}

// Сводка по виду объектов: { Документ: 25, Справочник: 40, … }
function countByKind(list) {
  const res = {};
  for (const x of list) {
    if (!x) continue;
    const k = x.split('.')[0];
    res[k] = (res[k] || 0) + 1;
  }
  return res;
}

function rulesContent(text) {
  const root = parseXml(text);
  if (kid(root, 'ПравилаОбмена')) {
    const c = conversionContent(root);
    const on = c.export.filter(e => !e.off);
    return { kind: 'conversion', ...c, summary: countByKind(on.map(e => e.from)) };
  }
  if (kid(root, 'ПравилаРегистрации')) {
    const c = registrationContent(root);
    return { kind: 'registration', ...c, summary: countByKind(c.composition.map(e => e.obj)) };
  }
  return null;
}

module.exports = { rulesContent, objectRef, countByKind };
