// Правила обмена EnterpriseData из кода CF: модули МенеджерОбменаЧерезУниверсальныйФормат*.
//   ЗаполнитьПравилаКонвертацииОбъектов: ветки НаправлениеОбмена = "Отправка" / "Получение" вызывают ДобавитьПКО_*;
//   ДобавитьПКО_X: ПравилоКонвертации.ОбъектДанных = Метаданные.<Коллекция>.<Имя>; .ОбъектФормата = "<Объект формата>".
// Результат: что конфигурация отправляет (объект ИБ -> объект формата) и что принимает (объект формата -> объект ИБ).
'use strict';

const ID = '[0-9A-Za-zА-Яа-яЁё_]+';
const COLLECTION = {
  'Документы': 'Документ', 'Справочники': 'Справочник', 'РегистрыСведений': 'Регистр сведений',
  'РегистрыНакопления': 'Регистр накопления', 'РегистрыБухгалтерии': 'Регистр бухгалтерии',
  'ПланыВидовХарактеристик': 'ПВХ', 'ПланыСчетов': 'План счетов', 'ПланыВидовРасчета': 'ПВР',
  'Перечисления': 'Перечисление', 'Константы': 'Константа', 'БизнесПроцессы': 'Бизнес-процесс', 'Задачи': 'Задача',
};

function methodBody(text, name) {
  const m = text.match(new RegExp(`^\\s*(?:Процедура|Функция)\\s+${name}\\s*\\([^)]*\\)[^\\n]*\\n([\\s\\S]*?)^\\s*Конец(?:Процедуры|Функции)`, 'm'));
  return m ? m[1] : null;
}

function edRulesFromModule(text) {
  // направления по веткам ЗаполнитьПравилаКонвертацииОбъектов
  const dirOf = new Map();
  const fill = methodBody(text, 'ЗаполнитьПравилаКонвертацииОбъектов');
  if (fill) {
    let dir = null;
    for (const line of fill.split('\n')) {
      const d = line.match(/НаправлениеОбмена\s*=\s*"(Отправка|Получение)"/);
      if (d) { dir = d[1]; continue; }
      const c = line.match(new RegExp(`^\\s*(ДобавитьПКО_${ID})\\s*\\(`));
      if (c && dir) {
        if (!dirOf.has(c[1])) dirOf.set(c[1], new Set());
        dirOf.get(c[1]).add(dir);
      }
    }
  }
  const rules = [];
  const re = new RegExp(`^Процедура\\s+(ДобавитьПКО_${ID})\\s*\\([^)]*\\)[^\\n]*\\n([\\s\\S]*?)^КонецПроцедуры`, 'gm');
  for (const m of text.matchAll(re)) {
    const body = m[2];
    const data = body.match(new RegExp(`\\.ОбъектДанных\\s*=\\s*Метаданные\\.(${ID})\\.(${ID})`));
    const format = body.match(/\.ОбъектФормата\s*=\s*"([^"]+)"/);
    if (!format) continue;
    let dirs = dirOf.get(m[1]);
    if (!dirs || !dirs.size) {
      dirs = new Set(/Получение$/.test(m[1]) ? ['Получение'] : /Отправка$|_Отпр$/.test(m[1]) ? ['Отправка'] : ['Отправка', 'Получение']);
    }
    rules.push({
      name: m[1].replace(/^ДобавитьПКО_/, ''),
      data: data ? `${COLLECTION[data[1]] || data[1]}.${data[2]}` : null,
      format: format[1],
      dirs: [...dirs],
    });
  }
  return rules;
}

// Свод по нескольким модулям (версии формата): уникальные пары отправки и получения
function edRules(modules) {
  const send = new Map(), receive = new Map();
  let count = 0;
  for (const { name, text } of modules) {
    for (const r of edRulesFromModule(text)) {
      count++;
      if (r.dirs.includes('Отправка') && r.data) send.set(`${r.data}|${r.format}`, [r.data, r.format, name]);
      if (r.dirs.includes('Получение') && r.data) receive.set(`${r.format}|${r.data}`, [r.format, r.data, name]);
    }
  }
  return {
    modules: modules.map(m => m.name),
    rules: count,
    send: [...send.values()].map(([d, f]) => [d, f]),
    receive: [...receive.values()].map(([f, d]) => [f, d]),
  };
}

module.exports = { edRules, edRulesFromModule };
