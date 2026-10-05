// Минимальный читатель zip без зависимостей: central directory + inflateRaw.
// Имена без флага UTF-8 (бит 11) в архивах 1С обычно в cp866.
'use strict';
const zlib = require('zlib');

const cp866 = new TextDecoder('ibm866');
const utf8 = new TextDecoder('utf-8');

function findEocd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('zip: EOCD not found');
}

function listEntries(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central header');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nlen);
    const name = (flags & 0x800 ? utf8 : cp866).decode(rawName);
    entries.push({ name, method, csize, size, lho, dir: name.endsWith('/') });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

function readEntry(buf, e) {
  const p = e.lho;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('zip: bad local header');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`zip: unsupported method ${e.method}`);
}

module.exports = { listEntries, readEntry };
