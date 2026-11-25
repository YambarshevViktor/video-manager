// Video Manager — service worker.
// Задачи: дефолты настроек, сброс session-флага скрытия бейджа,
// кэш диагностики по фреймам, открытие страницы настроек.

const DEFAULTS = {
  enabled: true,
  mode: 'smart', // smart | max | manual
  cap: 2160, // 360|480|720|1080|1081(1080 Ultra)|1440|2160
  considerSize: true,
  badgeDefaultVisible: true,
  closePanelOnShow: true, // V закрывает открытую панель, показывает только значок
  hotkey: 'v',
  siteMode: 'allowlist', // только HDRezka и её зеркала (sites = список зеркал)
  sites: ['rezka.ag'],
  perSite: {}, // host -> true/false
  badgeHiddenTabs: {}, // скрытие клавишей V — отдельно для каждой вкладки {tabId: true}, до перезапуска браузера
  // Скорость видео (ставится напрямую на video.playbackRate, меню плеера не трогаем)
  speed: 1, // текущая выбранная скорость, запоминается между сессиями
  speedStep: 0.5, // шаг клавиш S/D и кнопок −/+
  preferredSpeed: 2, // избранная скорость для клавиши G
  speedHotkeys: true, // S/D/R/G на странице с видео
  lastSpeedBeforeReset: 0, // что было до сброса R — повторный R возвращает (общее для всех фреймов вкладки)
  // Свои субтитры (.srt поверх видео, свой оверлей): текст всегда белый на чёрном,
  // настраиваются размер (%), прозрачность фона (0–1), отступ снизу (px) и сдвиг по времени (с)
  subSize: 35, // размер текста, % от базового
  subBgOpacity: 0.7, // прозрачность чёрного фона 0–1
  subBottomMargin: 32, // отступ снизу, px
  subShift: 0, // сдвиг по времени, с (+ — задерживает субтитры)
};

const DIAG_PREFIX = 'vmdiag:';
// ---------- Динамическая регистрация контент-скриптов (вместо static content_scripts)
// Работаем ТОЛЬКО на HDRezka и её зеркалах: sites = список зеркал (по умолчанию rezka.ag).
// Вне этих хостов нашего кода нет вообще — ни ошибок CSP в консоли, ни лишних процессов.
// Шаблоны зеркал ('rezka.ag', 'hdrezka.me') превращаем в match-паттерны Chrome.
const VM_CS_IDS = ['vm-main-world', 'vm-isolated-world'];
function normSiteHost(p) {
  let h = String(p || '').trim().toLowerCase();
  const slash = h.indexOf('/');
  if (slash >= 0) h = h.slice(0, slash);
  if (h.startsWith('*.')) h = h.slice(2);
  if (!h || h.includes(' ') || h.includes('*')) return '';
  return h;
}
function hostToMatches(h) {
  h = normSiteHost(h);
  if (!h) return [];
  // '*.host' в Chrome НЕ покрывает голый host — нужны оба паттерна
  return [`*://${h}/*`, `*://*.${h}/*`];
}
function computeTargets(s) {
  // Строго allowlist: только HDRezka и зеркала из sites + perSite-включения.
  // Старое значение siteMode='blacklist' игнорируем (осталось для совместимости импорта).
  const per = s.perSite || {};
  const on = new Set(), off = new Set();
  for (const p of (s.sites || [])) { const h = normSiteHost(p); if (h) on.add(h); }
  for (const [h, v] of Object.entries(per)) {
    const nh = normSiteHost(h);
    if (!nh) continue;
    if (v) on.add(nh); else off.add(nh);
  }
  for (const h of off) on.delete(h);
  if (!on.size) on.add('rezka.ag'); // страховка: пустой список = главная rezka.ag
  return {
    matches: [...on].flatMap(hostToMatches),
    exclude: [...off].flatMap(hostToMatches),
  };
}
// Статус последней регистрации (для самодиагностики в popup/options).
let lastReg = { ts: 0, ok: null, error: '', matches: [], note: 'not-run' };
async function applyContentScripts() {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) {
    lastReg = { ts: Date.now(), ok: false, error: 'no-chrome.scripting', matches: [], note: '' };
    return false;
  }
  let s = {};
  try { s = await chrome.storage.local.get(['siteMode', 'sites', 'perSite']); } catch (e) {}
  const { matches, exclude } = computeTargets(s);
  try { await chrome.scripting.unregisterContentScripts({ ids: VM_CS_IDS }); } catch (e) {}
  if (!matches.length) {
    lastReg = { ts: Date.now(), ok: true, error: '', matches: [], note: 'allowlist-empty' };
    return true; // allowlist пуст — никуда не внедряемся
  }
  const extra = exclude.length ? { excludeMatches: exclude } : {};
  const defs = [
    { id: VM_CS_IDS[0], js: ['injected_main.js'] },
    { id: VM_CS_IDS[1], js: ['content_isolated.js'] },
  ];
  const full = defs.map((d) => ({
    ...d, matches, ...extra,
    // matchAboutBlank здесь нет (API его не принимает — только манифест):
    // скрипты не встанут в about:blank-фреймы, для видео это не нужно.
    runAt: 'document_start', allFrames: true,
    persistAcrossSessions: true,
  }));
  const withWorlds = [
    { ...full[0], world: 'MAIN' },
    { ...full[1], world: 'ISOLATED' },
  ];
  try {
    await chrome.scripting.registerContentScripts(withWorlds);
    lastReg = { ts: Date.now(), ok: true, error: '', matches, note: 'MAIN+ISOLATED' };
    return true;
  } catch (e) {
    // Старый Chromium без world:MAIN в scripting API —
    // регистрируем оба в ISOLATED: DOM-адаптер и скорость работают как раньше
    try {
      await chrome.scripting.registerContentScripts(full);
      lastReg = { ts: Date.now(), ok: true, error: '', matches, note: 'ISOLATED-fallback' };
      return true;
    } catch (e2) {
      lastReg = { ts: Date.now(), ok: false, error: String((e2 && e2.message) || e2), matches, note: '' };
      return false;
    }
  }
}
// последние вкладки с видео — в session storage (переживает сон worker'а)
async function touchRecent(tabId, url) {
  try {
    const o = await chrome.storage.session.get('vmdiag:recent');
    const list = (o && o['vmdiag:recent']) || [];
    const now = Date.now();
    const upd = [{ tabId, url: url || '', ts: now },
      ...list.filter((x) => x.tabId !== tabId && now - x.ts < 600000)].slice(0, 10);
    await chrome.storage.session.set({ 'vmdiag:recent': upd });
  } catch (e) {}
}
// Двойное хранилище: session (переживает сон worker'а) + память
// (на случай, если chrome.storage.session недоступен в этом браузере).
const memDiag = new Map();
async function diagReport(tabId, frameId, url, payload) {
  const rec = { ts: Date.now(), url: url || '', payload: payload || {} };
  memDiag.set(tabId + ':' + frameId, rec);
  try {
    await chrome.storage.session.set({ [DIAG_PREFIX + tabId + ':' + frameId]: rec });
  } catch (e) {}
}
async function diagGet(tabId) {
  const byFrame = new Map();
  try {
    const all = await chrome.storage.session.get(null);
    for (const [k, v] of Object.entries(all || {})) {
      if (!k.startsWith(DIAG_PREFIX)) continue;
      const parts = k.split(':');
      if (parts[1] !== String(tabId) || !v) continue;
      byFrame.set(parts[2], { frameId: Number(parts[2]), ts: v.ts, url: v.url, ...(v.payload || {}) });
    }
  } catch (e) {}
  const now = Date.now();
  const staleSession = [];
  for (const [fid, f] of byFrame) {
    if (now - f.ts > 120000) {
      byFrame.delete(fid);
      staleSession.push(DIAG_PREFIX + tabId + ':' + fid);
    }
  }
  if (staleSession.length) { try { await chrome.storage.session.remove(staleSession); } catch (e) {} }
  for (const [k, v] of memDiag) {
    const [t, f] = k.split(':');
    if (t !== String(tabId) || now - v.ts > 120000) continue;
    if (!byFrame.has(f)) byFrame.set(f, { frameId: Number(f), ts: v.ts, url: v.url, ...(v.payload || {}) });
  }
  return [...byFrame.values()];
}

// ---------- Субтитры из сети (приём как у Raw Subtitle Downloader)
// Плеер (rezka/CDN) качает .vtt с чужого CDN: угадывать URL по HTML бесполезно
// (подписи протухают, CORS режет fetch), поэтому ловим ТОЧНЫЙ запрос, который
// плеер уже успешно выполнил (HTTP 2xx), и качаем его через chrome.downloads —
// там CORS не действует, куки подставляются сами.
const SUB_EXTS = ['.vtt', '.srt', '.ass', '.ssa', '.smi', '.sbv', '.ttml', '.ttml2',
  '.dfxp', '.stl', '.sub', '.idx', '.sup', '.scc', '.lrc', '.mks', '.usf', '.cap',
  '.dks', '.itt', '.jss', '.mpl', '.pjs', '.psb', '.qt.txt', '.qttext', '.rt'];
const SUB_PREFIX = 'vmsubs:';
const memSubs = new Map(); // tabId -> [{url, fileName, ext, ts}]
function subPathOf(url) {
  try {
    let end = url.length;
    const h = url.indexOf('#');
    if (h !== -1) end = h;
    const q = url.indexOf('?');
    if (q !== -1 && q < end) end = q;
    const s = url.indexOf('://');
    const a = s === -1 ? 0 : s + 3;
    const p = url.indexOf('/', a);
    if (p === -1 || p >= end) return '/';
    return url.slice(p, end);
  } catch (e) { return '/'; }
}
function subExtOf(pathname) {
  const lp = String(pathname || '').toLowerCase();
  for (const e of SUB_EXTS) { if (lp.endsWith(e)) return e; }
  return '';
}
async function persistNetSubs(tabId) {
  try {
    const arr = memSubs.get(tabId) || [];
    await chrome.storage.session.set({ [SUB_PREFIX + tabId]: { ts: Date.now(), arr } });
  } catch (e) {}
}
async function netSubsGet(tabId) {
  const now = Date.now();
  const mem = memSubs.get(tabId) || [];
  if (mem.length) return mem.filter((x) => now - x.ts < 600000);
  try {
    const o = await chrome.storage.session.get(SUB_PREFIX + tabId);
    const rec = o && o[SUB_PREFIX + tabId];
    if (rec && rec.arr && now - rec.ts < 600000) {
      memSubs.set(tabId, rec.arr);
      return rec.arr;
    }
  } catch (e) {}
  return [];
}
try {
  chrome.webRequest.onCompleted.addListener((d) => {
    try {
      if (!d || d.tabId === undefined || d.tabId < 0 || !d.url) return;
      if (!(d.statusCode >= 200 && d.statusCode <= 299)) return;
      const ext = subExtOf(subPathOf(d.url));
      if (!ext) return;
      let arr = memSubs.get(d.tabId);
      if (!arr) { arr = []; memSubs.set(d.tabId, arr); }
      if (arr.some((x) => x.url === d.url)) return;
      let fn = 'subtitle' + ext;
      try { fn = decodeURIComponent(subPathOf(d.url).split('/').pop()) || fn; } catch (e) {}
      arr.push({ url: d.url, fileName: fn, ext, ts: Date.now() });
      if (arr.length > 60) arr.splice(0, arr.length - 60);
      persistNetSubs(d.tabId);
    } catch (e) {}
  }, { urls: ['http://*/*', 'https://*/*'] });
} catch (e) {}
// Страховка: часть CDN отдаёт субтитры с URL без расширения (…/get?id=…).
// Такие ловим по Content-Type ответа — иначе дорожка остаётся без файла.
try {
  chrome.webRequest.onHeadersReceived.addListener((d) => {
    try {
      if (!d || d.tabId === undefined || d.tabId < 0 || !d.url) return;
      if (!(d.statusCode >= 200 && d.statusCode <= 299)) return;
      if (subExtOf(subPathOf(d.url))) return; // уже поймали по расширению
      let ct = '';
      try {
        for (const h of (d.responseHeaders || [])) {
          if (String((h && h.name) || '').toLowerCase() === 'content-type') { ct = String((h && h.value) || ''); break; }
        }
      } catch (e) {}
      if (!/vtt|webvtt|subrip|ttml|dfxp|microdvd|substationalpha|subtitle|caption/i.test(ct)) return;
      let arr = memSubs.get(d.tabId);
      if (!arr) { arr = []; memSubs.set(d.tabId, arr); }
      if (arr.some((x) => x.url === d.url)) return;
      const ext = /subrip/i.test(ct) ? '.srt' : (/ttml|dfxp/i.test(ct) ? '.ttml' : '.vtt');
      let fn = 'subtitle' + ext;
      try { fn = decodeURIComponent(subPathOf(d.url).split('/').pop()) || fn; } catch (e) {}
      if (!/\.(vtt|srt|ttml)$/i.test(fn)) fn = 'subtitle' + ext;
      arr.push({ url: d.url, fileName: fn, ext, ts: Date.now() });
      if (arr.length > 60) arr.splice(0, arr.length - 60);
      persistNetSubs(d.tabId);
    } catch (e) {}
  }, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);
} catch (e) {}

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (cur[k] === undefined) patch[k] = DEFAULTS[k];
  }
  // Миграция на HDRezka-only (v0.1.60): старого режима «везде» больше нет.
  // Был blacklist (хоть с исключениями, хоть без) — переводим на allowlist + rezka.ag:
  // прежний список в blacklist-семантике означал исключения, в allowlist он стал бы
  // «работать только там», поэтому его отбрасываем, perSite-правила сохраняем.
  if (cur.siteMode === 'blacklist') {
    patch.siteMode = 'allowlist';
    patch.sites = ['rezka.ag'];
  }
  await chrome.storage.local.set(patch);
  await applyContentScripts();
});

chrome.runtime.onStartup.addListener(async () => {
  // скрытие бейджа живёт только в пределах сессии браузера (но отдельно по вкладкам)
  await chrome.storage.local.set({ badgeHiddenTabs: {} });
  await applyContentScripts();
});

// Вкладку закрыли — её запись в карте скрытия больше не нужна
if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    try {
      const o = await chrome.storage.local.get('badgeHiddenTabs');
      const m = (o && o.badgeHiddenTabs) || {};
      if (m[tabId]) {
        delete m[tabId];
        await chrome.storage.local.set({ badgeHiddenTabs: m });
      }
    } catch (e) {}
    try {
      memSubs.delete(tabId);
      await chrome.storage.session.remove(SUB_PREFIX + tabId);
    } catch (e) {}
  });
}
// Вкладка начала перезагрузку — пойманные субтитры старой страницы не нужны
try {
  chrome.tabs.onUpdated.addListener((tabId, chg) => {
    try {
      if (chg && chg.status === 'loading') {
        memSubs.delete(tabId);
        chrome.storage.session.remove(SUB_PREFIX + tabId);
      }
    } catch (e) {}
  });
} catch (e) {}

// Смена списка сайтов / режима — перерегистрируем внедрение.
// Уже открытые вкладки подхватят только после перезагрузки (ограничение Chrome).
chrome.storage.onChanged.addListener((chg, area) => {
  if (area !== 'local') return;
  if (chg.siteMode || chg.sites || chg.perSite) {
    try { applyContentScripts(); } catch (e) {}
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'vm-tab-id') {
    // контент-скрипт узнаёт id своей вкладки (иначе повкладочное скрытие не сделать)
    sendResponse({ tabId: sender && sender.tab ? sender.tab.id : null });
    return true;
  }
  if (msg.type === 'vm-get-defaults') {
    sendResponse({ defaults: DEFAULTS });
    return true;
  }
  if (msg.type === 'vm-open-options') {
    try { chrome.runtime.openOptionsPage(); } catch (e) {}
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'vm-diag-report' && sender && sender.tab) {
    (async () => {
      try {
        await diagReport(sender.tab.id, sender.frameId !== undefined ? sender.frameId : 0, sender.url, msg.payload);
        touchRecent(sender.tab.id, sender.tab.url || sender.url);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }
  if (msg.type === 'vm-recent-tabs') {
    (async () => {
      try {
        const o = await chrome.storage.session.get('vmdiag:recent');
        const list = ((o && o['vmdiag:recent']) || []).filter((x) => Date.now() - x.ts < 600000);
        sendResponse({ tabs: list });
      } catch (e) {
        sendResponse({ tabs: [] });
      }
    })();
    return true;
  }
  if (msg.type === 'vm-apply-scripts') {
    // Самопочинка: popup/options дёргают при каждом открытии — если регистрация
    // не выполнилась при ⟳ расширения (onInstalled срабатывает не всегда),
    // она выполнится здесь. После этого вкладку с видео нужно перезагрузить.
    (async () => {
      try {
        const ok = await applyContentScripts();
        sendResponse({ ok, reg: lastReg });
      } catch (e) {
        sendResponse({ ok: false, reg: lastReg, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'vm-diag-get') {
    (async () => {
      try {
        let tabId = msg.tabId;
        if (!tabId) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = tab && tab.id;
        }
        const frames = tabId !== undefined ? await diagGet(tabId) : [];
        sendResponse({ tabId, frames, reg: lastReg });
      } catch (e) {
        sendResponse({ error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'vm-tab-diagnostics') {
    // fallback: прямой опрос вкладки (первый ответивший фрейм).
    // msg.tabId — конкретная вкладка (для options); иначе активная (для popup).
    (async () => {
      try {
        let tabId = msg.tabId;
        if (tabId === undefined) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab || tab.id === undefined) { sendResponse({ error: 'no-active-tab' }); return; }
          tabId = tab.id;
          msg._tabUrl = tab.url;
        } else {
          try {
            const tab = await chrome.tabs.get(tabId);
            msg._tabUrl = tab && tab.url;
          } catch (e) {}
        }
        const res = await chrome.tabs.sendMessage(tabId, { type: 'vm-collect-diagnostics' });
        sendResponse({ tab: { id: tabId, url: msg._tabUrl }, res });
      } catch (e) {
        sendResponse({ error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'vm-fetch-sub') {
    // Скачивание субтитров: страница/плеер часто отдают .vtt с чужого CDN без CORS,
    // из контент-скрипта fetch падает. У background есть host_permissions <all_urls>,
    // поэтому качаем здесь и возвращаем текст (субтитры — килобайты, лимит 2МБ с запасом).
    (async () => {
      try {
        const url = String((msg && msg.url) || '');
        if (!/^https?:\/\//i.test(url)) { sendResponse({ ok: false, error: 'bad-url' }); return; }
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) { sendResponse({ ok: false, error: 'HTTP ' + r.status }); return; }
        const text = await r.text();
        if (!text.trim() || text.length > 2000000) { sendResponse({ ok: false, error: 'bad-body' }); return; }
        sendResponse({ ok: true, text });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
      }
    })();
    return true;
  }
  if (msg.type === 'vm-subs-get') {
    // Что плеер реально подгрузил в этой вкладке (точные URL с подписями)
    (async () => {
      try {
        let tabId = msg.tabId;
        if (tabId === undefined) {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tab && tab.id;
          } catch (e) {}
        }
        const subs = (tabId !== undefined && tabId !== null) ? await netSubsGet(tabId) : [];
        sendResponse({ tabId, subs });
      } catch (e) {
        sendResponse({ tabId: null, subs: [] });
      }
    })();
    return true;
  }
  if (msg.type === 'vm-subs-download') {
    // Качаем через загрузки браузера: CORS не действует, куки подставляются сами.
    // Ждём реальный исход (complete/interrupted), чтобы честно сказать,
    // скачался ли файл, или ссылка битая и нужен запасной путь.
    (async () => {
      try {
        const url = String((msg && msg.url) || '');
        if (!/^https?:\/\//i.test(url)) { sendResponse({ ok: false, error: 'bad-url' }); return; }
        const id = await chrome.downloads.download({ url, filename: msg.filename || undefined, saveAs: false });
        const verdict = await new Promise((resolve) => {
          let done = false;
          const finish = (v) => { if (!done) { done = true; clearTimeout(to); try { chrome.downloads.onChanged.removeListener(onCh); } catch (e) {} resolve(v); } };
          const to = setTimeout(() => finish({ timeout: true }), 20000);
          function onCh(d) {
            try {
              if (!d || d.id !== id) return;
              if (d.state && d.state.current === 'complete') finish({ done: true });
              else if (d.error) finish({ err: d.error.current || 'interrupted' });
            } catch (e) {}
          }
          try { chrome.downloads.onChanged.addListener(onCh); }
          catch (e) { finish({ done: true }); }
        });
        if (verdict && (verdict.done || verdict.timeout)) sendResponse({ ok: true, id, pending: !!(verdict && verdict.timeout) });
        else sendResponse({ ok: false, error: String((verdict && verdict.err) || 'interrupted') });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
      }
    })();
    return true;
  }
});
