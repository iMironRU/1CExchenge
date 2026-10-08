// Контейнер 1С:Предприятия 8 (cf, epf, erf): чтение без платформы.
// Формат: заголовок 16 байт (FF FF FF 7F, размер страницы, версия, резерв), далее документы страницами;
// у каждой страницы заголовок «\r\n<размер документа> <размер страницы> <адрес следующей> \r\n» (8 hex-цифр).
// Первый документ — оглавление: тройки int32 (адрес заголовка элемента, адрес данных, FF FF FF 7F).
// Заголовок элемента: 8 + 8 байт дат, 4 байта атрибутов, имя UTF-16LE. Данные — обычно raw deflate,
// внутри может быть вложенный контейнер. Вариант с 64-битными адресами (16 hex-цифр) — для больших файлов.
'use strict';
const zlib = require('zlib');

const END32 = 0x7fffffff;

function isContainer(buf) {
  return buf.length >= 16 && buf.readUInt32LE(0) === END32;
}

function readDoc(buf, addr) {
  // заголовок страницы: \r\n + 8 hex + ' ' + 8 hex + ' ' + 8 hex + ' ' + \r\n = 31 байт
  const head = buf.toString('latin1', addr, addr + 31);
  const m = head.match(/^\r\n([0-9a-fA-F]{8}) ([0-9a-fA-F]{8}) ([0-9a-fA-F]{8}) \r\n$/);
  if (!m) throw new Error(`не страница контейнера по адресу ${addr}`);
  const size = parseInt(m[1], 16);
  const parts = [];
  let got = 0, pageAddr = addr, pageSize = parseInt(m[2], 16), next = parseInt(m[3], 16);
  for (;;) {
    const take = Math.min(pageSize, size - got);
    parts.push(buf.subarray(pageAddr + 31, pageAddr + 31 + take));
    got += take;
    if (got >= size || next === END32) break;
    pageAddr = next;
    const h = buf.toString('latin1', pageAddr, pageAddr + 31).match(/^\r\n([0-9a-fA-F]{8}) ([0-9a-fA-F]{8}) ([0-9a-fA-F]{8}) \r\n$/);
    if (!h) throw new Error(`битая цепочка страниц по адресу ${pageAddr}`);
    pageSize = parseInt(h[2], 16);
    next = parseInt(h[3], 16);
  }
  return Buffer.concat(parts);
}

// Элементы контейнера: [{name, data}] (data как есть, без распаковки)
function entries(buf) {
  if (!isContainer(buf)) throw new Error('не контейнер 1С');
  const toc = readDoc(buf, 16);
  const out = [];
  for (let i = 0; i + 12 <= toc.length; i += 12) {
    const hdrAddr = toc.readUInt32LE(i), dataAddr = toc.readUInt32LE(i + 4);
    if (hdrAddr === END32 || hdrAddr === 0) continue;
    const hdr = readDoc(buf, hdrAddr);
    const name = hdr.subarray(20).toString('utf16le').replace(/\0.*$/s, '');
    const data = dataAddr === END32 ? Buffer.alloc(0) : readDoc(buf, dataAddr);
    out.push({ name, data });
  }
  return out;
}

function inflate(data) {
  try { return zlib.inflateRawSync(data); } catch { return data; }
}

// Все листовые элементы с распаковкой и вложенными контейнерами: [{path, data}]
function walk(buf, prefix = '', depth = 0) {
  const out = [];
  for (const e of entries(buf)) {
    const data = inflate(e.data);
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (depth < 4 && isContainer(data)) {
      try { out.push(...walk(data, p, depth + 1)); continue; } catch { /* не контейнер — лист */ }
    }
    out.push({ path: p, data });
  }
  return out;
}

module.exports = { isContainer, entries, walk, inflate };
