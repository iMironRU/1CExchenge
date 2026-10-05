// Декодирование XML-файлов поставки и разбор заголовков правил КД2
// (ПравилаОбмена = правила конвертации, ПравилаРегистрации = правила регистрации).
'use strict';

const dec = {
  utf8: new TextDecoder('utf-8'),
  utf8strict: new TextDecoder('utf-8', { fatal: true }),
  utf16le: new TextDecoder('utf-16le'),
  utf16be: new TextDecoder('utf-16be'),
  cp1251: new TextDecoder('windows-1251'),
};

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return dec.utf8.decode(buf.subarray(3));
  if (buf[0] === 0xff && buf[1] === 0xfe) return dec.utf16le.decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return dec.utf16be.decode(buf.subarray(2));
  const head = buf.subarray(0, 200).toString('latin1');
  const m = head.match(/encoding\s*=\s*["']([^"']+)["']/i);
  if (m && /1251/.test(m[1])) return dec.cp1251.decode(buf);
  try { return dec.utf8strict.decode(buf); } catch { return dec.cp1251.decode(buf); }
}

function unescapeXml(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });
}

function rootElement(text) {
  const s = text.replace(/^\s*(<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*/, '');
  const m = s.match(/^<([^\s>\/]+)/);
  return m ? m[1].replace(/^[\w-]+:/, '') : null;
}

function attrs(s) {
  const out = {};
  for (const m of (s || '').matchAll(/([^\s=]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

// Первое вхождение простого элемента <Имя атрибуты>текст</Имя> в заголовке
function el(head, name) {
  const m = head.match(new RegExp(`<${name}(\\s[^>]*)?>([^<]*)</${name}>`));
  if (!m) return null;
  return { attrs: attrs(m[1]), text: unescapeXml(m[2]).trim() };
}

function cfg(e) {
  if (!e) return null;
  return {
    name: e.text,
    version: e.attrs['ВерсияКонфигурации'] || null,
    synonym: e.attrs['СинонимКонфигурации'] || null,
    platform: e.attrs['ВерсияПлатформы'] || null,
  };
}

// Разбор заголовка; возвращает null, если это не правила КД2
function parseRules(text) {
  const root = rootElement(text);
  // заголовок идёт до первого «большого» блока; 30К символов хватает с запасом
  const head = text.slice(0, 30000);
  const fv = el(head, 'ВерсияФормата');
  const common = {
    root,
    formatVersion: fv ? fv.text : null,
    compatibility: fv ? fv.attrs['РежимСовместимости'] || null : null,
    id: (el(head, 'Ид') || {}).text || null,
    title: (el(head, 'Наименование') || {}).text || null,
    created: (el(head, 'ДатаВремяСоздания') || {}).text || null,
  };
  if (root === 'ПравилаОбмена') {
    return { kind: 'conversion', ...common, source: cfg(el(head, 'Источник')), target: cfg(el(head, 'Приемник')) };
  }
  if (root === 'ПравилаРегистрации') {
    const plan = el(head, 'ПланОбмена');
    return {
      kind: 'registration', ...common,
      exchangePlan: plan ? plan.attrs['Имя'] || plan.text.replace(/^ПланОбменаСсылка\./, '') : null,
      config: cfg(el(head, 'Конфигурация')),
    };
  }
  return null;
}

module.exports = { decodeText, rootElement, parseRules, attrs, unescapeXml };
