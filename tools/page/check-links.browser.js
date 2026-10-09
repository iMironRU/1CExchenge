// Проверка ссылок releases.1c.ru в браузере пользователя (вкладка releases.1c.ru, сессия ИТС).
// Ничего не скачивает и не вводит: смотрит, куда ведёт ссылка и что на странице.
// Статусы: ok — «Скачать дистрибутив» со ссылками на dl*.1c.ru; pin — редирект на login.1c.ru с запросом второго фактора;
//          notfound — «Указанный файл не найден»; login — нужен вход; other — иное.
// Вход: URLS = [...]; выход — массив [индекс, статус, число зеркал] (без адресов).
(async () => {
  const URLS = /*__URLS__*/[];
  const out = [];
  for (let i = 0; i < URLS.length; i++) {
    let st = 'other', mirrors = 0;
    try {
      const r = await fetch(URLS[i], { credentials: 'include' });
      const u = new URL(r.url);
      const ct = r.headers.get('content-type') || '';
      if (u.host === 'login.1c.ru') st = /twoFactorAuth/.test(r.url) ? 'pin' : 'login';
      else if (!/html/.test(ct)) st = 'ok';
      else {
        const t = await r.text();
        if (/Одноразовый код/.test(t)) st = 'pin';
        else if (/файл не найден/i.test(t)) st = 'notfound';
        else if (/Скачать дистрибутив/.test(t)) { st = 'ok'; mirrors = (t.match(/href="https:\/\/dl\d*\.1c\.ru/g) || []).length; }
        else if (/Войти|Вход в систему/.test(t)) st = 'login';
      }
    } catch (e) { st = 'error'; }
    out.push([i, st, mirrors]);
    await new Promise(res => setTimeout(res, 500));
  }
  window.__checkLinks = out;
  return out;
})()
