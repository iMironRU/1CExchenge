#!/usr/bin/env node
// Сервис обновлений 1С (update-api.1c.ru/update-platform) — то же, что делает БИП «ПолучениеОбновленийПрограммы»,
// только справочные методы без логина/пароля ИТС:
//   POST /programs/update/info  {programName, versionNumber, platformVersion, programNewName, redactionNumber, updateType, additionalParameters}
//        -> configurationUpdateResponse (версия, upgradeSequence — цепочка файлов, programVersionUin, platformVersion мин.),
//           platformUpdateResponse (platformVersion, distributionUin, releaseUrl, recommended)
//   POST /platform/getInfo      {programName, versionNumber} -> platformVersionMin / platformVersionRecommended
//   POST /patches/getInfo       {programVersionList:[{programName, versionNumber}], installedPatchesList:[]} -> patchUpdateList
// Файлы (/programs/update/, /patches/getFiles) требуют логин/пароль ИТС — не вызываются.
// Вход: data/ids.json (идентификаторы подсистем) — версия основной подсистемы и библиотек.
// Результат: data/update-info.json. Использование: node tools/update-info.js [--platform 8.3.27.1859]
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const PLATFORM = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : '8.3.27.1859';
const API = 'https://update-api.1c.ru/update-platform';
const ids = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'ids.json'), 'utf8')).configs;

const add = (cfgName, ver) => Object.entries({
  ClientPlatformType: 'Windows_x86_64', ClientOSVersion: 'Windows 10', PlatformVersion: PLATFORM,
  ConfigName: cfgName, ConfigVersion: ver, Vendor: 'Фирма "1С"', ConfigLanguage: 'ru', ConfigMainLanguage: 'ru',
  CurLocalizationCode: 'ru_RU', SystemLanguage: 'ru', ClientTimeOffsetGMT: '10800', countryId: '', IBIsSeparated: 'false', platform64Supported: 'true',
}).map(([key, value]) => ({ key, value }));

async function call(op, body) {
  const r = await fetch(API + op, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { error: `${r.status} ${t.slice(0, 200)}` }; }
}

(async () => {
  const out = { checked: new Date().toISOString(), platform: PLATFORM, configs: {} };
  for (const [id, c] of Object.entries(ids)) {
    const main = c.subsystems.find(s => s.programName && s.isMain);
    if (!main) continue;
    const libs = c.subsystems.filter(s => s.programName && s.version);
    const ap = add(c.configName, main.version);
    const info = await call('/programs/update/info', { programName: main.programName, versionNumber: main.version, platformVersion: PLATFORM,
      programNewName: '', redactionNumber: '', updateType: 'NewConfigurationAndOrPlatform', additionalParameters: ap });
    const plat = await call('/platform/getInfo', { programName: main.programName, versionNumber: main.version, additionalParameters: ap });
    const patches = await call('/patches/getInfo', { programVersionList: libs.map(s => ({ programName: s.programName, versionNumber: s.version })),
      installedPatchesList: [], additionalParameters: ap });
    const cu = info.configurationUpdateResponse || {};
    const pu = info.platformUpdateResponse || {};
    const p0 = Array.isArray(plat) ? plat[0] || {} : {};
    out.configs[id] = {
      programName: main.programName, version: main.version, libraries: libs.filter(s => s !== main).map(s => `${s.programName} ${s.version}`),
      next: cu.configurationVersion || null, chainFiles: (cu.upgradeSequence || []).length, nextPlatformMin: cu.platformVersion || null,
      supportEnd: info.currentReleaseSupportEndDate || cu.supportEndDate || null, newsUrl: cu.updateInfoUrl || null,
      platformMin: p0.platformVersionMin || null, platformRecommended: p0.platformVersionRecommended || null,
      platformUpdate: pu.platformVersion ? { version: pu.platformVersion, recommended: pu.recommended, size: pu.size, releaseUrl: pu.releaseUrl } : null,
      patches: (patches.patchUpdateList || []).map(p => ({ name: p.name, ueid: p.ueid, description: (p.description || '').slice(0, 300),
        metadata: p.modificatedMetadata, size: p.size, built: p.buildDate ? new Date(p.buildDate).toISOString().slice(0, 10) : null,
        applyTo: (p.applyToVersion || []).map(a => `${a.programName} ${a.versionNumber}`) })),
      error: info.errorMessage || patches.errorMessage || null,
    };
    const o = out.configs[id];
    console.log(`${id.padEnd(44)} ${o.programName.padEnd(18)} ${o.version.padEnd(12)} -> ${String(o.next).padEnd(12)} цепочка ${o.chainFiles}  платформа ${o.platformMin}/${o.platformRecommended}  исправлений ${o.patches.length}`);
    await new Promise(res => setTimeout(res, 300));
  }
  fs.writeFileSync(path.join(ROOT, 'data', 'update-info.json'), JSON.stringify(out, null, 1));
  console.log('-> data/update-info.json');
})();
