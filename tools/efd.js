#!/usr/bin/env node
// Распаковщик поставок 1С (1cv8.efd) без мастера установки — замена setup.exe для каталога шаблонов.
//
// Формат 1cv8.efd (сверено с onec_dtools/supply_reader.py и IngvarConsulting/efd_unpacker):
//   весь файл — один поток raw deflate; внутри:
//   u32 версия (=1), u32 число описаний
//   описание × N: u32 (?), wstr язык, wstr название, wstr поставщик, wstr путь к ReadMe
//   u32 число файлов
//   файл × M:     u32 (?), wstr путь, u64 FILETIME, u32 (?), u32 размер
//   затем содержимое файлов подряд в том же порядке.
//   wstr = u32 число символов UTF-16 + UTF-16LE. Пути вида \1c\<Продукт>\<версия>\<файл>.
//
// Вход — 1cv8.efd или zip поставки (*_setup1c.zip): efd читается из zip потоком.
// Использование:
//   node tools/efd.js <файл.zip|1cv8.efd|каталог с поставками> [--out <каталог шаблонов>] [--list] [--skip <regex>] [--force]
//   --out   по умолчанию ConfigurationTemplatesLocation из %APPDATA%\1C\1CEStart\1cestart.cfg
//   --skip  не записывать файлы, путь которых подходит под регулярку (например "\.dt$")
//   --force перезаписывать совпадающие файлы (иначе файл с тем же размером и датой пропускается)
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');

// ---------- zip: поиск записи и поток её данных (zip64-совместимо)
function zipEntry(file, wanted) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557 + 20);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('zip: не найден конец центрального каталога');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('zip64: нет локатора');
      const z64off = Number(tail.readBigUInt64LE(loc + 8));
      const z = Buffer.alloc(56);
      fs.readSync(fd, z, 0, 56, z64off);
      if (z.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64: неверная запись конца каталога');
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdOff = Number(z.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    for (let p = 0, n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: повреждён центральный каталог');
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      let lho = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nlen).toString('latin1');
      // zip64 extra (id 1): поля идут только для тех значений, что равны 0xFFFFFFFF
      for (let x = p + 46 + nlen; x < p + 46 + nlen + xlen;) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (lho === 0xffffffff) { lho = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        x += 4 + len;
      }
      if (name.toLowerCase() === wanted.toLowerCase()) {
        const lh = Buffer.alloc(30);
        fs.readSync(fd, lh, 0, 30, lho);
        if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('zip: неверный локальный заголовок');
        const start = lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        return { method, csize, usize, start };
      }
      p += 46 + nlen + xlen + clen;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function efdStream(file) {
  const parts = [];
  if (/\.zip$/i.test(file)) {
    const e = zipEntry(file, '1cv8.efd');
    if (!e) throw new Error(`${file}: в архиве нет 1cv8.efd`);
    parts.push(fs.createReadStream(file, { start: e.start, end: e.start + e.csize - 1, highWaterMark: 1 << 20 }));
    if (e.method === 8) parts.push(zlib.createInflateRaw());
    else if (e.method !== 0) throw new Error(`zip: метод сжатия ${e.method} не поддерживается`);
  } else {
    parts.push(fs.createReadStream(file, { highWaterMark: 1 << 20 }));
  }
  parts.push(zlib.createInflateRaw({ chunkSize: 1 << 20 }));
  let err = null;
  const out = pipeline(...parts, e => { if (e) err = e; });
  out.failed = () => err;
  return out;
}

// ---------- каталог поставки
const BOM = String.fromCharCode(0xfeff);
class Incomplete extends Error {}

function parseCatalog(buf) {
  let p = 0;
  const need = n => { if (p + n > buf.length) throw new Incomplete(); };
  const u32 = () => { need(4); const v = buf.readUInt32LE(p); p += 4; return v; };
  const u64 = () => { need(8); const v = buf.readBigUInt64LE(p); p += 8; return v; };
  const wstr = () => {
    const n = u32();
    if (n > 32768) throw new Error(`efd: неправдоподобная длина строки ${n}`);
    need(n * 2);
    const s = buf.subarray(p, p + n * 2).toString('utf16le').split(BOM).join('');
    p += n * 2;
    return s;
  };
  try {
    const version = u32();
    if (version !== 1) throw new Error(`efd: неизвестная версия формата ${version}`);
    const infoCount = u32();
    if (infoCount > 1000) throw new Error(`efd: неправдоподобное число описаний ${infoCount}`);
    const info = [];
    for (let i = 0; i < infoCount; i++) {
      u32();
      info.push({ lang: wstr(), name: wstr(), provider: wstr(), description: wstr() });
    }
    const fileCount = u32();
    if (fileCount > 1000000) throw new Error(`efd: неправдоподобное число файлов ${fileCount}`);
    const files = [];
    for (let i = 0; i < fileCount; i++) {
      u32();
      const name = wstr();
      const filetime = u64();
      u32();
      files.push({ path: name, filetime, size: u32() });
    }
    return { catalog: { info, files }, consumed: p };
  } catch (e) {
    if (e instanceof Incomplete) return null;
    throw e;
  }
}

// FILETIME (100 нс с 1601-01-01) -> Date; даты до 1970 не выставляем
// В поставках встречаются даты до 1970 и «максимальный» FILETIME (30828 год, БНО/БГУ) —
// такие считаем неизвестными: не выставляем и сравниваем файл только по размеру
const MAX_SANE_MS = Date.UTC(2100, 0, 1);
function fileDate(ft) {
  const ms = Number(ft / 10000n) - 11644473600000;
  return ms > 0 && ms < MAX_SANE_MS ? new Date(ms) : null;
}

function safeTarget(root, src) {
  const segs = src.split(/[\\/]+/).filter(Boolean);
  if (!segs.length || segs.some(s => s === '..' || s === '.' || /[:<>|?*\x00-\x1f]/.test(s))) {
    throw new Error(`efd: недопустимый путь записи «${src}»`);
  }
  return path.join(root, ...segs);
}

// Каталог шаблонов из 1cestart.cfg (файл в UTF-16LE с BOM). Без явной настройки — null:
// молча писать в «стандартный» %APPDATA%\1C\1cv8\tmplts нельзя, это 20+ ГБ не туда.
function defaultTemplatesDir() {
  const cfg = path.join(process.env.APPDATA || '', '1C', '1CEStart', '1cestart.cfg');
  if (!fs.existsSync(cfg)) return null;
  const b = fs.readFileSync(cfg);
  const text = (b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.toString('utf8')).split(BOM).join('');
  const m = text.match(/^\s*ConfigurationTemplatesLocation\s*=\s*(.+?)\s*$/m);
  return m ? m[1] : null;
}

const fmt = n => (n >= 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' ГБ' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' МБ' : (n / 1024).toFixed(0) + ' КБ');

// ---------- распаковка
async function unpack(file, opts) {
  const src = efdStream(file);
  let head = Buffer.alloc(0);
  let cat = null;
  let idx = -1, left = 0, cur = null;
  const stats = { written: 0, skipped: 0, bytes: 0 };

  const close = () => {
    if (!cur) return;
    fs.closeSync(cur.fd);
    fs.renameSync(cur.tmp, cur.target);
    const d = fileDate(cur.entry.filetime);
    // дата — не повод проваливать распаковку (EINVAL на части файлов поставки БГУ)
    if (d) try { fs.utimesSync(cur.target, d, d); } catch { /* оставляем текущую */ }
    stats.written++;
    cur = null;
  };
  // открыть следующую запись; записи нулевой длины закрываются сразу
  const next = () => {
    for (;;) {
      close();
      idx++;
      if (idx >= cat.files.length) return;
      const e = cat.files[idx];
      left = e.size;
      const target = safeTarget(opts.out, e.path);
      let write = !(opts.skip && opts.skip.test(e.path));
      if (write && !opts.force && fs.existsSync(target)) {
        const st = fs.statSync(target), d = fileDate(e.filetime);
        if (st.size === e.size && (!d || Math.abs(st.mtimeMs - d.getTime()) < 2000)) write = false;
      }
      if (write) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.efd-part`;
        cur = { fd: fs.openSync(tmp, 'w'), tmp, target, entry: e };
        if (e.size >= 50 << 20) console.log(`  ${e.path} (${fmt(e.size)})`);
      } else {
        stats.skipped++;
      }
      if (left > 0) return;
    }
  };

  for await (let chunk of src) {
    if (!cat) {
      head = Buffer.concat([head, chunk]);
      const r = parseCatalog(head);
      if (!r) continue;
      cat = r.catalog;
      const ru = cat.info.find(i => i.lang === 'ru') || cat.info[0] || {};
      const total = cat.files.reduce((s, f) => s + f.size, 0);
      const dir = cat.files.length ? cat.files[0].path.split(/[\\/]+/).filter(Boolean).slice(0, 3).join('/') : '';
      console.log(`${ru.name || '?'} (${ru.provider || '?'}): файлов ${cat.files.length}, ${fmt(total)}, каталог ${dir}`);
      if (opts.list) {
        for (const f of cat.files) console.log(`  ${String(f.size).padStart(12)}  ${(fileDate(f.filetime) || new Date(0)).toISOString().slice(0, 10)}  ${f.path}`);
        src.destroy();
        return { catalog: cat, stats };
      }
      chunk = head.subarray(r.consumed);
      head = null;
      next();
    }
    let off = 0;
    while (off < chunk.length && idx < cat.files.length) {
      const take = Math.min(left, chunk.length - off);
      if (cur) fs.writeSync(cur.fd, chunk, off, take);
      off += take;
      left -= take;
      stats.bytes += take;
      if (left === 0) next();
    }
  }
  if (src.failed && src.failed()) throw src.failed();
  if (!cat) throw new Error('efd: поток кончился раньше каталога файлов');
  if (idx < cat.files.length) {
    if (cur) { fs.closeSync(cur.fd); fs.rmSync(cur.tmp, { force: true }); }
    throw new Error(`efd: поток оборвался на записи ${idx + 1} из ${cat.files.length} (${cat.files[idx].path})`);
  }
  return { catalog: cat, stats };
}

module.exports = { unpack, parseCatalog, zipEntry, defaultTemplatesDir };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const file = argv.find((a, i) => !a.startsWith('--') && !['--out', '--skip'].includes(argv[i - 1]));
  if (!file) {
    console.error('Использование: node tools/efd.js <файл.zip|1cv8.efd> [--out <каталог>] [--list] [--skip <regex>] [--force]');
    process.exit(2);
  }
  const opts = {
    out: opt('--out') || defaultTemplatesDir(),
    // без --out и без настройки в 1cestart.cfg не пишем никуда
    list: argv.includes('--list'),
    skip: opt('--skip') ? new RegExp(opt('--skip'), 'i') : null,
    force: argv.includes('--force'),
  };
  if (!opts.out && !opts.list) {
    console.error('Каталог шаблонов не задан: нет ConfigurationTemplatesLocation в 1cestart.cfg. Укажите --out <каталог>.');
    process.exit(2);
  }
  if (!opts.list) console.log(`каталог шаблонов: ${opts.out}`);
  // каталог на входе — все поставки в нём (*.zip с 1cv8.efd и *.efd)
  const inputs = fs.statSync(file).isDirectory()
    ? fs.readdirSync(file).filter(f => /\.(zip|efd)$/i.test(f)).sort().map(f => path.join(file, f))
    : [file];
  (async () => {
    let failed = 0;
    for (const f of inputs) {
      const t0 = Date.now();
      if (inputs.length > 1) console.log(`== ${path.basename(f)}`);
      try {
        const { stats } = await unpack(f, opts);
        if (!opts.list) console.log(`готово за ${((Date.now() - t0) / 1000).toFixed(0)} с: записано ${stats.written}, пропущено ${stats.skipped}, ${fmt(stats.bytes)} -> ${opts.out}`);
      } catch (e) {
        failed++;
        console.error(`ОШИБКА ${path.basename(f)}: ${e.message}`);
      }
    }
    if (failed) process.exit(1);
  })();
}
