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

// ---------- Рукописный EnterpriseData (1С:Мобильная касса): без ПКО — диспетчеры по типам
//   отправка:  ПолучитьОбъектXDTO — ветки «ТипЗнч(Данные) = Тип("ДокументОбъект.Чек")» -> Выгрузить*(…)
//              -> СоздатьОбъектXDTO(…, "Документ.ЧекККМ", …)
//   получение: ЗагрузитьОбъект — ветки «ОбъектXDTO.Тип().Имя = "Справочник.Номенклатура"» -> Загрузить*(…)
//              -> Справочники.Номенклатура.СоздатьЭлемент()
const TYPE_KIND = {
  'СправочникОбъект': 'Справочник', 'СправочникСсылка': 'Справочник', 'ДокументОбъект': 'Документ', 'ДокументСсылка': 'Документ',
  'РегистрСведенийНаборЗаписей': 'Регистр сведений', 'РегистрСведенийЗапись': 'Регистр сведений',
};
// объект формата верхнего уровня (не «КлючевыеСвойства…», не табличные части «….Строка»)
const TOP_FORMAT = /^(Документ|Справочник|РегистрСведений|ПланВидовХарактеристик)\.[^."]+$/;
const CREATE = new RegExp(`(Справочники|Документы|РегистрыСведений|РегистрыНакопления)\\.(${ID})\\.(?:СоздатьЭлемент|СоздатьГруппу|СоздатьДокумент|СоздатьНаборЗаписей|СоздатьМенеджерЗаписи)(?=\\s*\\()`, 'g');

// Ветки верхнего уровня первого «Если … ИначеЕсли … КонецЕсли» и следующих: [{cond, block}]
function topBranches(body) {
  const out = [];
  let depth = 0, cur = null, inCond = false;
  const thenEnd = s => /(^|\s)Тогда$/.test(s);
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (inCond) { cur.cond += ' ' + line; inCond = !thenEnd(line); continue; }
    const isIf = /^Если[\s(]/.test(line), oneLine = isIf && /КонецЕсли/.test(line);
    if ((depth === 0 && isIf && !oneLine) || (depth === 1 && /^ИначеЕсли[\s(]/.test(line))) {
      cur = { cond: line, block: '' };
      out.push(cur);
      depth = 1;
      inCond = !thenEnd(line);
      continue;
    }
    if (depth === 1 && /^Иначе$/.test(line)) { cur = { cond: '', block: '' }; out.push(cur); continue; }
    if (isIf && !oneLine) depth++;
    if (/^КонецЕсли/.test(line)) { depth--; if (depth === 0) { cur = null; continue; } }
    if (cur) cur.block += line + '\n';
  }
  return out;
}

const callsOf = (code, prefix) => [...new Set([...code.matchAll(new RegExp(`(?:^|[^0-9A-Za-zА-Яа-яЁё_.])(${prefix}${ID})\\s*\\(`, 'g'))].map(m => m[1]))];

// объекты формата, создаваемые функцией выгрузки (и вложенными Выгрузить*)
function createdFormats(text, fn, seen = new Set()) {
  if (seen.has(fn)) return [];
  seen.add(fn);
  const body = methodBody(text, fn);
  if (!body) return [];
  const own = [...body.matchAll(/СоздатьОбъектXDTO\(\s*[^,()]+,\s*"([^"]+)"/g)].map(m => m[1]).filter(f => TOP_FORMAT.test(f));
  const all = [...new Set([...own, ...callsOf(body, 'Выгрузить').flatMap(c => createdFormats(text, c, seen))])];
  // «Справочник.ШтрихкодыНоменклатурыЗаписи» при «Справочник.ШтрихкодыНоменклатуры» — тип строки, не объект
  return all.filter(f => !all.some(g => g !== f && f.startsWith(g) && /^(Запись|Записи|Строка)/.test(f.slice(g.length))));
}

// объекты ИБ, создаваемые функцией загрузки (и вложенными Загрузить*/НайтиДобавить*/Создать*)
function createdData(text, fn, depth = 0, seen = new Set()) {
  if (seen.has(fn) || depth > 2) return [];
  seen.add(fn);
  const body = methodBody(text, fn);
  if (!body) return [];
  const own = [...body.matchAll(CREATE)].map(m => `${COLLECTION[m[1]] || m[1]}.${m[2]}`);
  if (own.length) return [...new Set(own)];
  // без прямого создания: поиск/создание по ключевым свойствам, обновление найденного документа,
  // ссылки на объекты учётной системы в СсылкиОбъектовED, запись в найденную номенклатуру
  const refs = [
    ...[...body.matchAll(/СсылкаНаСправочникПоКлючевымСвойствам\([^;]*?,\s*"([^"]+)"\s*\)/g)].map(m => `Справочник.${m[1]}`),
    ...[...body.matchAll(/ДесериализоватьСсылкуНаДокумент\([^;]*?,\s*"([^"]+)"\s*\)/g)].map(m => `Документ.${m[1]}`),
    ...(/ТипыОбъектовEnterpriseData\./.test(body) ? ['Справочник.СсылкиОбъектовED'] : []),
    ...(/СсылкаНаНоменклатуру/.test(body) ? ['Справочник.Номенклатура'] : []),
  ];
  if (refs.length) return [...new Set(refs)];
  return [...new Set(callsOf(body, '(?:Загрузить|НайтиДобавить|Создать)').flatMap(c => createdData(text, c, depth + 1, seen)))];
}

function handEdRules(modules) {
  const send = new Map(), receive = new Map();
  let count = 0;
  for (const { text } of modules) {
    for (const b of topBranches(methodBody(text, 'ПолучитьОбъектXDTO') || '')) {
      const data = [...new Set([...b.cond.matchAll(new RegExp(`Тип\\("(${ID})\\.(${ID})"\\)`, 'g'))]
        .filter(m => TYPE_KIND[m[1]]).map(m => `${TYPE_KIND[m[1]]}.${m[2]}`))];
      const formats = [...new Set(callsOf(b.block, 'Выгрузить').flatMap(c => createdFormats(text, c)))];
      for (const f of formats) {
        count++;
        for (const d of data.length ? data : [null]) send.set(`${d}|${f}`, [d, f]);
      }
    }
    for (const b of topBranches(methodBody(text, 'ЗагрузитьОбъект') || '')) {
      const formats = [...new Set([...b.cond.matchAll(/Тип\(\)\.Имя\s*=\s*"([^"]+)"/g)].map(m => m[1]).filter(f => TOP_FORMAT.test(f)))];
      if (!formats.length) continue;
      const data = [...new Set(callsOf(b.block, '(?:Загрузить|НайтиДобавить)').flatMap(c => createdData(text, c)))];
      for (const f of formats) {
        count++;
        for (const d of data.length ? data : [null]) receive.set(`${f}|${d}`, [f, d]);
      }
    }
  }
  // отправка из структуры (штрихкоды, цены) — объект ИБ по встречной загрузке того же объекта формата
  const recvData = f => [...receive.values()].filter(([rf, d]) => rf === f && d).map(([, d]) => d);
  const sendRows = [...send.values()].flatMap(([d, f]) => (d ? [[d, f]] : recvData(f).length ? recvData(f).map(x => [x, f]) : [[null, f]]));
  return { modules: modules.map(m => m.name), rules: count, hand: true, send: sendRows, receive: [...receive.values()] };
}

module.exports = { edRules, edRulesFromModule, handEdRules, topBranches };
