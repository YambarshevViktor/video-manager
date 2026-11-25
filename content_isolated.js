/* Video Manager — isolated world content script (document_start, all_frames).
 * - грузит настройки, проверяет вкл/сайты, шлёт настройки в MAIN-мир;
 * - DOM-адаптер качества (меню сайта: rezka и generic) — клик по пункту меню;
 * - бейдж поверх плеера (Shadow DOM, стекло), мини-панель, хоткей, фуллскрин;
 * - диагностика для popup/options.
 */
(() => {
  if (window.__VM_ISO_LOADED__) return;
  window.__VM_ISO_LOADED__ = true;
  const VM_VERSION = '0.1.61'; // <-- сверяйте с manifest.json; если в диагностике версия меньше — вкладка не перезагружена

  // ---------- «Добавлено»: дата заливки серии/фильма (data/updates.json в репозитории)
  // Сборщик .github/workflows/updates-collect.yml раз в день парсит главную
  // («Горячие обновления»: дата + тайтл + сезон/серия + озвучка как есть) и
  // дописывает records в data/updates.json. Бэкфилл — снапшоты главной из
  // веб-архива (~1 в неделю, окно каждого ~3 дня).
  // Форматы ключей — как в scripts/collect_updates.py:
  //   сериал: "<id>:s<season>e<episode>:<voice_norm>"
  //   фильм:  "<id>:m:<voice_norm>" (без сезона/серии)
  //   «Завершён»: "<id>:done:<voice_norm>" (строка уровня тайтла)
  //   перезаливы — отдельные записи: тот же key, другая date + reupload=true.
  // Расширение тянет JSON с raw.githubusercontent (CORS открыт), ищет точное
  // совпадение, иначе «залито целиком», иначе «неизвестно».
  // Что ещё тянет сборщик и зачем: title/url/type/year — для сверки и отладки
  // (видны в --dump); quality и рейтинг осознанно НЕ тащим — скачут и врут в истории.
  const DEFAULT_UPDATES_URL = 'https://raw.githubusercontent.com/YambarshevViktor/video-manager/main/data/updates.json';
  // ^-- зеркало истории заливок (data/updates.json этого же репозитория; сборщик —
  // scripts/collect_updates.py + .github/workflows/updates-collect.yml).
  // Свой источник задаётся через storage в консоли options:
  // chrome.storage.local.set({updatesUrl: 'https://.../updates.json'}).
  const UPDATES_TTL = 24 * 3600 * 1000;
  const updatesCache = { at: 0, byKey: new Map(), byId: new Map(), loaded: false, error: '', url: '' };
  function normVoiceJs(v) {
    try {
      return String(v || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
    } catch (e) { return ''; }
  }
  function updatesUrl() {
    try {
      if (S.updatesUrl) return S.updatesUrl;
    } catch (e) {}
    return DEFAULT_UPDATES_URL;
  }
  function updatesIndex(records) {
    updatesCache.byKey.clear(); updatesCache.byId.clear();
    for (const r of (records || [])) {
      if (!r || !r.key) continue;
      if (!updatesCache.byKey.has(r.key)) updatesCache.byKey.set(r.key, []);
      updatesCache.byKey.get(r.key).push(r);
      const id = Number(r.id) || 0;
      if (id) {
        if (!updatesCache.byId.has(id)) updatesCache.byId.set(id, []);
        updatesCache.byId.get(id).push(r);
      }
    }
    for (const [, arr] of updatesCache.byKey) arr.sort((a, b) => String(a.date) < String(b.date) ? -1 : 1);
  }
  function updatesEnsure() {
    try {
      const url = updatesUrl();
      if (!url || /USERNAME\/REPO/.test(url)) return; // URL-заглушка — не дёргаем сеть
      if (updatesCache.loaded && Date.now() - updatesCache.at < UPDATES_TTL && updatesCache.url === url) return;
      if (updatesCache._busy) return;
      updatesCache._busy = true;
      const done = (records, err) => {
        updatesCache._busy = false;
        if (records) {
          updatesIndex(records);
          updatesCache.loaded = true; updatesCache.error = ''; updatesCache.at = Date.now(); updatesCache.url = url;
          try { chrome.storage.local.set({ vmUpdatesCache: { at: updatesCache.at, records } }); } catch (e) {}
          try { refreshVideoInfos(); } catch (e) {}
        } else if (err) {
          updatesCache.error = String(err).slice(0, 120);
        }
      };
      // сначала кэш из storage (чтобы «Добавлено» было сразу), потом сеть
      try {
        chrome.storage.local.get(['vmUpdatesCache'], (o) => {
          try {
            const c = o && o.vmUpdatesCache;
            if (c && c.records && c.records.length && Date.now() - (c.at || 0) < UPDATES_TTL) {
              updatesIndex(c.records);
              updatesCache.loaded = true; updatesCache.at = c.at; updatesCache.url = url;
              try { refreshVideoInfos(); } catch (e) {}
              if (Date.now() - c.at < UPDATES_TTL) { updatesCache._busy = false; return; }
            }
          } catch (e) {}
          fetch(url, { credentials: 'omit' }).then((r) => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          }).then((j) => done((j && j.records) || [], '')).catch((e) => done(null, (e && e.message) || e));
        });
      } catch (e) {
        fetch(url, { credentials: 'omit' }).then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then((j) => done((j && j.records) || [], '')).catch((e2) => done(null, (e2 && e2.message) || e2));
      }
    } catch (e) {}
  }
  function rezkaVoiceName() {
    try {
      const docs = [document];
      try { if (window.top && window.top !== window && window.top.document) docs.push(window.top.document); } catch (e) {}
      for (const d of docs) {
        try {
          const a = d.querySelector('#translators-list .active');
          if (a && a.textContent && a.textContent.trim()) return a.textContent.trim();
        } catch (e) {}
      }
    } catch (e) {}
    return '';
  }
  function fmtDateRu(iso) {
    try {
      const m = String(iso || '').match(/(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return String(iso || '');
      const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
      return parseInt(m[3], 10) + ' ' + months[parseInt(m[2], 10) - 1] + ' ' + m[1];
    } catch (e) { return String(iso || ''); }
  }
  function updatesLinesSync() {
    // Синхронно для mediaRowsPlain/диагностики (там только строки). Сеть — в фоне.
    try {
      const p = (typeof rezkaStreamParams === 'function') ? rezkaStreamParams() : null;
      if (!p) return [];
      try {
        const u = updatesUrl();
        if (!u || /USERNAME\/REPO/.test(u)) return; // URL не настроен — строки «Добавлено» нет
      } catch (e) { return []; }
      updatesEnsure();
      const voiceRaw = rezkaVoiceName();
      const vn = normVoiceJs((voiceRaw || '').split(',')[0]);
      const lines = [];
      const fmtRec = (r) => {
        let s = fmtDateRu(r.date);
        if (r.season && r.episode) s += ' — ' + r.season + ' сезон ' + r.episode + ' серия';
        else if (r.episode) s += ' — ' + r.episode + ' серия';
        if (r.voice) s += ' (' + r.voice + ')';
        if (r.reupload) s += ' — перезалив';
        return s;
      };
      if (!updatesCache.loaded) {
        return updatesCache.error ? ['История недоступна: ' + updatesCache.error] : ['Загружаю историю заливок…'];
      }
      const exactKey = p.isSeries
        ? (p.id + ':s' + (p.season || 0) + 'e' + (p.episode || 0) + ':' + (vn || '-'))
        : (p.id + ':m:' + (vn || '-'));
      const exact = updatesCache.byKey.get(exactKey) || [];
      for (const r of exact) lines.push(fmtRec(r));
      // «Завершён» — строка уровня тайтла, показываем вместе с серией
      if (p.isSeries) {
        const doneRecs = updatesCache.byKey.get(p.id + ':done:' + (vn || '-')) || [];
        for (const r of doneRecs) lines.push(fmtDateRu(r.date) + ' — сериал завершён' + (r.voice ? ' (' + r.voice + ')' : ''));
      }
      if (lines.length) return lines;
      // Точного совпадения нет: та же озвучка целиком? или вообще что-то по id?
      const pool = updatesCache.byId.get(p.id) || [];
      if (!pool.length) return ['Дата заливки неизвестна — в истории нет этого тайтла'];
      const sameVoice = vn ? pool.filter((r) => (r.voice_norm || '') === vn) : [];
      if (sameVoice.length) {
        const ds = sameVoice.map((r) => r.date).sort();
        return ['Точная серия не найдена — в этой озвучке залито целиком (' + fmtDateRu(ds[0]) + (ds.length > 1 ? ' … ' + fmtDateRu(ds[ds.length - 1]) : '') + ')'];
      }
      return ['Точная серия не найдена — залито целиком, озвучка другая'];
    } catch (e) { return []; }
  }

  const DEFAULTS = {
    enabled: true, mode: 'smart', cap: 2160, considerSize: true,
    badgeDefaultVisible: true, hotkey: 'v', closePanelOnShow: true,
    siteMode: 'allowlist', sites: ['rezka.ag'], perSite: {}, badgeHiddenTabs: {},
    speed: 1, speedStep: 0.5, preferredSpeed: 2, speedHotkeys: true, lastSpeedBeforeReset: 0,
    updatesUrl: '', // свой URL updates.json (по умолчанию DEFAULT_UPDATES_URL)
    subSize: 35, // свои субтитры: размер текста, % от базового
    subBgOpacity: 0.7, // свои субтитры: прозрачность чёрного фона 0–1
    subBottomMargin: 32, // свои субтитры: отступ снизу, px
    subShift: 0, // свои субтитры: сдвиг по времени, с (+ — задерживает)
  };
  let S = { ...DEFAULTS };
  let mainState = { players: [], videos: [], events: [] };
  let mainAlive = false;
  let myTabId = null; // id своей вкладки (для повкладочного скрытия бейджа)

  // id вкладки — спрашиваем у background (в контент-скрипте его иначе не узнать)
  function requestTabId() {
    return new Promise((resolve) => {
      if (myTabId !== null && myTabId !== undefined) { resolve(myTabId); return; }
      try {
        chrome.runtime.sendMessage({ type: 'vm-tab-id' }, (res) => {
          const id = res && res.tabId !== undefined && res.tabId !== null ? res.tabId : null;
          if (id !== null) myTabId = id;
          resolve(id);
        });
      } catch (e) { resolve(null); }
    });
  }

  // ---------- настройки
  async function loadSettings() {
    try {
      const got = await chrome.storage.local.get(Object.keys(DEFAULTS).concat(['badgeHidden']));
      S = { ...DEFAULTS, ...got };
      delete S.badgeHidden; // legacy-флаг больше не используем
      if (S.mode !== 'smart' && S.mode !== 'max' && S.mode !== 'manual') {
        S.mode = 'smart'; // откат «быстрого»: чиним застрявшее значение
        try { chrome.storage.local.set({ mode: 'smart' }); } catch (e) {}
      }
      // старый общий флаг скрытия больше не используем — разово чистим;
      // новая загрузка страницы и так показывает бейдж (сброс в init)
      if (got.badgeHidden !== undefined) {
        try { await chrome.storage.local.remove('badgeHidden'); } catch (e) {}
      }
      // свои субтитры: чиним мусор из storage (границы ползунков в настройках)
      S.subSize = clampNum(S.subSize, 0, 250, 35);
      S.subBgOpacity = clampNum(S.subBgOpacity, 0, 1, 0.7);
      S.subBottomMargin = clampNum(S.subBottomMargin, 0, 200, 32);
      S.subShift = clampNum(S.subShift, -10, 10, 0);
    } catch (e) { S = { ...DEFAULTS }; }
  }
  function clampNum(v, min, max, fb) {
    let n = (typeof v === 'string') ? parseFloat(String(v).replace(',', '.')) : Number(v);
    if (!isFinite(n)) return fb;
    if (n < min) return min;
    if (n > max) return max;
    return Math.round(n * 100) / 100;
  }
  function pushSettingsToMain() {
    try {
      window.postMessage({
        source: 'vm-cmd', type: 'vm-settings',
        settings: { enabled: S.enabled, mode: S.mode, cap: S.cap, considerSize: S.considerSize },
      }, '*');
    } catch (e) {}
  }
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((chg, area) => {
      if (area !== 'local') return;
      let need = false;
      for (const k of Object.keys(DEFAULTS)) {
        if (chg[k]) { S[k] = chg[k].newValue; need = true; }
      }
      if (need) {
        pushSettingsToMain();
        // скрытие повкладочное: панели закрываем только в той вкладке, где скрыли
        if (chg.badgeHiddenTabs && S.closePanelOnShow !== false && myTabId !== null && myTabId !== undefined) {
          try {
            const ov = chg.badgeHiddenTabs.oldValue && chg.badgeHiddenTabs.oldValue[myTabId];
            const nv = chg.badgeHiddenTabs.newValue && chg.badgeHiddenTabs.newValue[myTabId];
            if (nv && !ov) {
              for (const rec of badges.values()) {
                rec.open = false;
                if (rec.panel) rec.panel.classList.remove('open');
              }
            }
          } catch (e) {}
        }
        // скорость могли поменять из попапа/настроек/другого фрейма —
        // доводим до видео принудительно (включая сброс в 1.0)
        if (chg.speed) { try { applySpeedAll(true); } catch (e) {} }
        // настройки своих субтитров — перекрашиваем оверлеи на месте
        if (chg.subSize || chg.subBgOpacity || chg.subBottomMargin || chg.subShift) {
          try { refreshSubOverlays(); } catch (e) {}
        }
        refreshAllBadges();
      }
    });
  }

  // ---------- сайты
  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
  }
  function patternMatch(pattern, host) {
    const p = String(pattern || '').trim().toLowerCase();
    if (!p) return false;
    if (p === host) return true;
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return host === base || host.endsWith('.' + base);
    }
    // "rezka.ag" матчит и поддомены
    return host === p || host.endsWith('.' + p);
  }
  function siteAllowed(host) {
    // Только HDRezka и зеркала: sites = список зеркал, siteMode игнорируем (всегда allowlist).
    if (S.perSite && S.perSite[host] === true) return true;
    if (S.perSite && S.perSite[host] === false) return false;
    const listed = (S.sites || []).some((p) => patternMatch(p, host));
    if (listed) return true;
    // страховка при пустом списке: главная rezka.ag работает всегда
    if (!(S.sites || []).length) return patternMatch('rezka.ag', host);
    return false;
  }
  function isActive() {
    if (!S.enabled) return false;
    try {
      if (window.top !== window) {
        // во фрейме: уважаем и хост фрейма, и хост топа (берём топ, если доступен)
        const topHost = hostOf(window.top.location.href);
        if (topHost && !siteAllowed(topHost)) return false;
      }
    } catch (e) { /* cross-origin top — проверяем свой хост */ }
    return siteAllowed(hostOf(location.href));
  }

  // ---------- мост с MAIN
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.source === 'vm-main' && (m.type === 'vm-state')) {
      mainAlive = true;
      mainState = m;
      onMainState();
    }
  });
  // fallback: если MAIN-мир недоступен (старый Chromium без world:MAIN) —
  // инжектим script-тегом. На сайтах со строгим CSP (YouTube) это режется
  // самим сайтом — тогда работает только DOM-адаптер из isolated-мира.
  // ВАЖНО: флаг window.__VM_MAIN_LOADED__ из isolated-мира не виден
  // (у миров разный JS-контекст), единственный сигнал — postMessage.
  setTimeout(() => {
    if (mainAlive) return;
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('injected_main.js');
      s.onload = () => s.remove();
      s.onerror = () => s.remove();
      (document.documentElement || document.head || document.body).appendChild(s);
      setTimeout(() => {
        try { window.postMessage({ source: 'vm-cmd', type: 'vm-ping' }, '*'); } catch (e) {}
      }, 800);
    } catch (e) {}
  }, 2500);

  setInterval(() => {
    try { window.postMessage({ source: 'vm-cmd', type: 'vm-ping' }, '*'); } catch (e) {}
  }, 10000);

  // ---------- DOM-адаптер качества (меню сайта)
  // Строгий парсер: голые числа принимаем только из известных высот,
  // иначе годы («2024») и прочий мусор ломали бы выбор уровня.
  const KNOWN_H = [144, 240, 360, 480, 540, 720, 800, 1080, 1440, 2160, 2880, 4320];
  function parseQLabel(text) {
    const t = String(text || '').trim();
    const ultra = /ultra/i.test(t);
    let m = t.match(/(\d{3,4})\s*p\b/i);
    if (!m) {
      const bare = t.match(/^(\d{3,4})$/);
      if (bare && KNOWN_H.includes(parseInt(bare[1], 10))) m = bare;
    }
    if (m) {
      const h = parseInt(m[1], 10);
      let rank = h >= 2000 ? 5 : h >= 1300 ? 4 : h >= 1000 ? 3 : h >= 650 ? 2 : h >= 430 ? 1 : 0;
      if (ultra && h === 1080) rank = 3.5;
      return { label: t, height: h, ultra, rank };
    }
    if (/4k|uhd/i.test(t)) return { label: t, height: 2160, rank: 5 };
    if (/2k/i.test(t)) return { label: t, height: 1440, rank: 4 };
    if (/fhd/i.test(t)) return { label: t, height: 1080, rank: 3 };
    if (/^hd$/i.test(t)) return { label: t, height: 720, rank: 2 };
    if (/^sd$/i.test(t)) return { label: t, height: 480, rank: 1 };
    return null;
  }
  // Вытаскивает чистый токен качества из составного текста
  // («Качество 360p» -> «360p», «1080p Ultra» -> «1080p Ultra»).
  function extractQToken(t) {
    const s = String(t || '');
    let m = s.match(/(\d{3,4}\s*p\s*ultra)/i);
    if (m) return m[1].replace(/\s+/g, ' ').trim();
    m = s.match(/(\d{3,4}\s*p)\b/i);
    if (m) return m[1].replace(/\s+/g, '').trim();
    m = s.match(/\b(4k|uhd|2k|fhd)\b/i);
    if (m) return m[1].toUpperCase();
    m = s.match(/^(hd|sd)$/i);
    if (m) return m[1].toUpperCase();
    m = s.match(/(\d{3,4})/);
    if (m && KNOWN_H.includes(parseInt(m[1], 10))) return m[1] + 'p';
    return null;
  }
  function capRank() {
    const map = { 360: 0, 480: 1, 720: 2, 1080: 3, 1081: 3.5, 1440: 4, 2160: 5 };
    return map[S.cap] !== undefined ? map[S.cap] : 5;
  }
  function sizeCapRankFor(video) {
    try {
      const fs = document.fullscreenElement;
      let h = fs ? (fs.clientHeight || screen.height) : (video ? (video.clientHeight || 0) : 0);
      if (!h || h < 120) return 5;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const t = h * dpr;
      if (t <= 400) return 0;
      if (t <= 560) return 1;
      if (t <= 900) return 2;
      if (t <= 1200) return 3;
      if (t <= 1700) return 4;
      return 5;
    } catch (e) { return 5; }
  }
  function targetRank(video) {
    let r = capRank();
    if (S.mode === 'max') return 5; // максимум берёт высший доступный (потолок не применяется)
    if (S.mode === 'smart' && S.considerSize) r = Math.min(r, sizeCapRankFor(video));
    return r;
  }
  // max: всегда высший доступный уровень (потолок не применяется — так задумано)

  function visible(el) {
    try {
      const r = el.getBoundingClientRect();
      if (!r || r.width < 2 || r.height < 2) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch (e) { return false; }
  }
  function findQualityItems(root) {
    const out = [];
    try {
      // pjsdiv/[fid]/[f2id] — кастомные теги меню CDN-плеера (rezka и зеркала)
      const SEL = 'button,li,div,span,a,pjsdiv,[fid],[f2id],[role="menuitem"],[role="option"]';
      const els = (root && root !== document) ? root.querySelectorAll(SEL) : deepQueryAll(SEL);
      for (const el of els) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (!txt || txt.length > 24) continue;
        // пункт должен выглядеть как качество, а не контейнер с кучей текста
        if (el.children.length > 2) continue;
        const q = parseQLabel(txt.split('\n')[0]);
        if (!q) continue;
        if (!visible(el)) continue;
        out.push({ el, q });
      }
    } catch (e) {}
    return out;
  }
  // ---------- глубокий поиск по DOM + открытым shadowRoot (плеер может жить в тени)
  let rootCache = { t: 0, roots: [] };
  function scanRoots() {
    const now = Date.now();
    if (rootCache.roots.length && now - rootCache.t < 10000) return rootCache.roots;
    const roots = [document];
    try {
      const queue = [document];
      let guard = 0;
      while (queue.length && roots.length < 50 && guard++ < 50000) {
        const node = queue.shift();
        let all;
        try { all = node.querySelectorAll ? node.querySelectorAll('*') : []; }
        catch (e) { continue; }
        for (const el of all) {
          try {
            if (el.shadowRoot && !roots.includes(el.shadowRoot)) {
              roots.push(el.shadowRoot);
              queue.push(el.shadowRoot);
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    rootCache = { t: now, roots };
    return roots;
  }
  function deepQueryAll(sel) {
    const out = [];
    for (const r of scanRoots()) {
      try { for (const el of r.querySelectorAll(sel)) out.push(el); }
      catch (e) {}
    }
    return out;
  }
  function describeEl(el) {
    try {
      const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const attrs = [];
      if (el.getAttribute) {
        for (const a of ['fid', 'f2id', 'aria-label', 'title', 'role', 'id']) {
          const v = el.getAttribute(a);
          if (v) attrs.push(a + '=' + String(v).slice(0, 30));
        }
        const cl = (el.getAttribute('class') || '').slice(0, 40);
        if (cl) attrs.push('class=' + cl);
      }
      return (el.tagName || '?').toLowerCase() + ' "' + t + '"' + (attrs.length ? ' [' + attrs.join(' ') + ']' : '');
    } catch (e) { return '?'; }
  }
  // «Человеческий» клик: серия событий с координатами + el.click().
  // Часть плееров слушает mousedown, а не click — покрываем оба.
  function mouseClick(el) {
    try {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
      try { el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, isPrimary: true })); } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}
      try { if (el.focus) el.focus({ preventScroll: true }); } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('click', opts)); } catch (e) {}
      try { el.click(); } catch (e) {}
    } catch (e) {}
  }
  function isActiveItem(item) {
    const el = item.el;
    try {
      if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true') return true;
      const c = (el.className || '').toString().toLowerCase();
      // pjs-cdnplayer-active-menu — активный пункт CDN-плеера (rezka и зеркала)
      if (/active-menu/.test(c)) return true;
      if (/inactive/.test(c)) return false;
      if (/(^|\s)active(\s|$)/.test(' ' + c + ' ') || /(selected|current|checked)/.test(c)) return true;
      if (el.parentElement) {
        const pc = (el.parentElement.className || '').toString().toLowerCase();
        if (/active|selected/.test(pc) && el.parentElement.querySelectorAll) {
          // эвристика: родитель подсвечен — считаем активным только если нет соседей с подсветкой
        }
      }
    } catch (e) {}
    return false;
  }

  let gidSeq = 0;
  // Группируем кандидатов по контейнеру-меню. Настоящее меню качества —
  // это 2+ пункта с разными рангами в одном контейнере. Одиночные совпадения
  // (годы, «HD»-плашки, жанры) отбрасываем — это был главный источник мусора.
  function groupByMenu(items) {
    const groups = new Map();
    for (const it of items) {
      let cont = null;
      try {
        cont = it.el.closest('[role="menu"],[role="listbox"],ul,[class*="menu" i],[class*="quality" i],[class*="settings" i],[class*="resolution" i]') || it.el.parentElement;
      } catch (e) { cont = null; }
      const k = cont ? (cont.__vm_gid || (cont.__vm_gid = ++gidSeq)) : 0;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    let best = null;
    for (const g of groups.values()) {
      const ranks = new Set(g.map((x) => x.q.rank));
      if (ranks.size < 2) continue; // не меню
      if (!best || g.length > best.length) best = g;
    }
    return best || [];
  }
  // Кнопка, открывающая меню качества. ВАЖЕН ПОРЯДОК:
  // 1) строка «Качество ...» ([fid]) — кликать надо именно её, а не внутреннюю
  //    подпись-значение (у неё pointer-events:none, клик по ней ничего не строит);
  // 2) aria/title про качество; 3) маленькие кнопки с уровнем (вне [fid]-строк).
  function findQualityOpener() {
    try {
      const els = deepQueryAll('button,[role="button"],pjsdiv,[fid]');
      // 1) строка «Качество»
      for (const el of els) {
        const txt = (el.innerText || el.textContent || '').trim() || '';
        if (!/качеств/i.test(txt)) continue;
        if (!extractQToken(txt)) continue;
        try {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        } catch (e) { continue; }
        // предпочитаем саму строку [fid], а не её внутренности
        if (el.hasAttribute && el.hasAttribute('fid')) return el;
      }
      for (const el of els) {
        const txt = (el.innerText || el.textContent || '').trim() || '';
        if (!/качеств/i.test(txt)) continue;
        if (!extractQToken(txt)) continue;
        try {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        } catch (e) { continue; }
        return el;
      }
      // 2) aria/title
      for (const el of els) {
        const a = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || ''));
        if (/качеств|quality|resolution/i.test(a) && visible(el)) return el;
      }
      // 3) маленькая кнопка с уровнем — но НЕ внутри [fid]-строки
      for (const el of els) {
        try {
          if (el.closest && el.closest('[fid]')) continue;
        } catch (e) {}
        const txt = (el.innerText || el.textContent || '').trim().split('\n')[0] || '';
        if (!txt || txt.length > 14) continue;
        if (el.children.length > 1) continue;
        if (parseQLabel(txt) && visible(el)) return el;
      }
    } catch (e) {}
    return null;
  }

  // ---------- pjs-адаптер (CDN-плеер rezka и зеркал: <pjsdiv f2id="1..7">)
  // Пункты существуют в DOM всегда (пусть и скрытые), клик по скрытому пункту
  // работает — плеер перезагружает поток. Поэтому видимость здесь не требуем,
  // а применение проверяем по переезду класса активного пункта.
  // Если подменю нет в DOM — открываем цепочку: шестерёнка -> «Качество».
  function pjsRows(root) {
    const out = [];
    try {
      const els = (root && root !== document && root.querySelectorAll)
        ? root.querySelectorAll('[f2id]')
        : deepQueryAll('[f2id]');
      for (const el of els) {
        const txt = (el.innerText || el.textContent || '').trim().split('\n')[0] || '';
        const tok = extractQToken(txt);
        if (!tok) continue; // заголовок «Качество» (f2id=0) отсеивается сам
        const q = parseQLabel(tok);
        if (!q) continue;
        out.push({ el, q });
      }
    } catch (e) {}
    return out;
  }
  // Кандидаты в шестерёнки: видимые кликабельные иконки без текста.
  // Полноэкранный режим синтетическим кликом не включается (нужен жест),
  // play/pause/mute — откатываем назад, риск минимален.
  function gearCandidates(root) {
    const out = [];
    try {
      const scope = (root && root.querySelectorAll) ? root : document;
      const els = scope.querySelectorAll('pjsdiv,button,div,span,a,[role="button"]');
      for (const el of els) {
        try {
          if (el.tagName === 'VIDEO') continue;
          if (el.querySelector && el.querySelector('video')) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          if ((cs.cursor || '') !== 'pointer') continue;
          const r = el.getBoundingClientRect();
          if (!r || r.width < 16 || r.height < 16 || r.width > 70 || r.height > 70) continue;
          const txt = (el.innerText || el.textContent || '').trim();
          if (txt.length > 0) continue;
          if (!el.querySelector || !el.querySelector('svg')) continue;
          out.push(el);
        } catch (e) {}
      }
    } catch (e) {}
    return out;
  }
  function fpOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return el.tagName + '|' + (el.className || '').toString().slice(0, 60) + '|' +
        Math.round(r.left) + 'x' + Math.round(r.top) + '|' + (el.innerHTML || '').length;
    } catch (e) { return 'x' + Math.random(); }
  }
  function settingsVisible() {
    try {
      const s = deepQueryAll('#cdnplayer_settings')[0] || document.getElementById('cdnplayer_settings');
      if (s) {
        const cs = getComputedStyle(s);
        if (cs.display !== 'none' && cs.visibility !== 'hidden') return true;
      }
      const fids = deepQueryAll('[fid]');
      for (const f of fids) {
        try {
          const cs = getComputedStyle(f);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const t = (f.innerText || f.textContent || '').trim();
          if (/качеств/i.test(t)) return true;
        } catch (e) {}
      }
    } catch (e) {}
    return false;
  }
  function snapPlayback(v) {
    try { return { paused: v.paused, muted: v.muted, volume: v.volume }; }
    catch (e) { return {}; }
  }
  function revertPlayback(v, s) {
    if (!s) return;
    try {
      if (typeof s.muted === 'boolean' && v.muted !== s.muted) v.muted = s.muted;
      if (typeof s.volume === 'number' && Math.abs(v.volume - s.volume) > 0.01) v.volume = s.volume;
      if (s.paused === false && v.paused === true) {
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      }
      if (s.paused === true && v.paused === false) v.pause();
    } catch (e) {}
  }
  // Перебор кнопок-кандидатов: по одной за раз, с проверкой результата.
  // Возвращает true, если цепочкой занимается (generic-путь пропускаем).
  function gearStep(video, ctl) {
    const now = Date.now();
    if (ctl.gearTest) {
      const t = ctl.gearTest;
      if (now - t.t < 800) return true; // ждём реакцию плеера
      const opened = settingsVisible();
      revertPlayback(video, t.snap);
      ctl.gearTest = null;
      if (opened) {
        ctl.gear = t.el;
        logDom('DOM: шестерёнка найдена, настройки открыты');
      } else {
        logDom('DOM: кнопка не открыла настройки, пробую следующую');
      }
      return true;
    }
    if (ctl.gear) {
      if (settingsVisible()) return true;
      if (now - (ctl.lastGearTry || 0) < 2500) return true;
      ctl.lastGearTry = now;
      try { mouseClick(ctl.gear); logDom('DOM: клик по известной шестерёнке -> ' + describeEl(ctl.gear)); } catch (e) {}
      return true;
    }
    if (now - (ctl.lastGearTry || 0) < 2500) return true;
    let list = gearCandidates(containerOf(video));
    if (!list.length) list = gearCandidates(document);
    if (!list.length) return false;
    if (!ctl.gearTried) ctl.gearTried = new Set();
    const next = list.find((el) => !ctl.gearTried.has(fpOf(el)));
    if (!next) {
      if (now - (ctl.gearReset || 0) > 60000) { ctl.gearTried = new Set(); ctl.gearReset = now; }
      else logDom('DOM: все кнопки перебраны, шестерёнка не найдена');
      return true;
    }
    ctl.gearTried.add(fpOf(next));
    ctl.lastGearTry = now;
    const snap = snapPlayback(video);
    try { mouseClick(next); } catch (e) {}
    ctl.gearTest = { el: next, t: now, snap };
    logDom('DOM: пробую кнопку настроек (' + ctl.gearTried.size + '/' + list.length + ') -> ' + describeEl(next));
    return true;
  }
  function pjsTick(video, ctl, force) {
    const now = Date.now();
    const root = containerOf(video);
    let rows = pjsRows(root);
    if (!rows.length && root !== document) rows = pjsRows(document);
    if (rows.length < 2) return false; // не pjs-меню — пусть работает generic-путь
    const seen = new Map();
    for (const r of rows) {
      const k = r.q.rank;
      if (!seen.has(k)) seen.set(k, r);
    }
    const uniq = [...seen.values()].sort((a, b) => a.q.rank - b.q.rank);
    ctl.uniq = uniq;
    ctl.items = uniq.map((u) => ({ label: u.q.label, rank: u.q.rank }));
    ctl.pjs = true;
    const active = uniq.find((u) => isActiveItem({ el: u.el }));
    // проверка прошлого клика: класс активного переехал?
    if (ctl.pendingRank != null) {
      if (active && Math.abs(active.q.rank - ctl.pendingRank) < 1e-9) {
        logDom('DOM pjs OK: применилось ' + active.q.label);
        ctl.pendingRank = null;
        ctl.curRank = active.q.rank;
        ctl.settled = true; // дошли до цели — дальше спим, не дёргаем
      } else if (now - ctl.pendingSince > 9000) {
        logDom('DOM pjs НЕ применилось за 9с — попробуем ещё раз');
        ctl.pendingRank = null;
        ctl.settled = false;
      } else {
        ctl.curRank = active ? active.q.rank : ctl.curRank;
        return true; // ждём перезагрузку потока
      }
    }
    if (active) ctl.curRank = active.q.rank;
    const wantMax = S.mode === 'max';
    const tr = wantMax ? 99 : targetRank(video);
    let want = null;
    for (const u of uniq) { if (u.q.rank <= tr + 1e-9) want = u; }
    if (!want) want = uniq[0];
    const activeRank = active ? active.q.rank : -1;
    if (Math.abs(activeRank - want.q.rank) < 1e-9) { ctl.settled = true; ctl.blindClicks = 0; return true; } // уже то — спим
    // Активное не прочиталось — вслепую не кликаем (перезагрузка потока зря):
    // один заходный клик на видео, дальше ждём читаемого состояния или force.
    if (!active && (ctl.blindClicks || 0) >= 1 && !force) return true;
    if (now - ctl.lastClick < 6000) return true;
    if (ctl.clicks >= 4 && !ctl.stallArmed) return true;
    try {
      mouseClick(want.el);
      ctl.lastClick = now; ctl.clicks++;
      ctl.pendingRank = want.q.rank; ctl.pendingSince = now;
      ctl.curRank = want.q.rank;
      ctl.settled = false; // кликнули — ждём применения, потом снова проверим
      if (!active) ctl.blindClicks = (ctl.blindClicks || 0) + 1;
      logDom('DOM pjs click -> ' + want.q.label + ' @ ' + describeEl(want.el));
    } catch (e) {}
    return true;
  }

  const domCtl = new WeakMap(); // video -> {items, clicks, lastClick, stable}
  function containerOf(video) {
    try {
      const c = video.closest('[class*="player" i],[id*="player" i],[class*="video" i],[class*="media" i]');
      if (c) return c;
      return video.parentElement || document;
    } catch (e) { return document; }
  }

  function domTick(video, force) {
    if (!isActive()) return;
    if (speedPassive()) return; // >2×: не трогаем плеер, только скорость (как VSC)
    if (video.dataset && video.dataset.vmVid) {
      // этим видео управляет API-плеер — DOM не трогаем
      const bound = (mainState.players || []).some((p) => p.id === video.dataset.vmVid);
      if (bound) return;
    }
    let ctl = domCtl.get(video);
    if (!ctl) { ctl = { clicks: 0, lastClick: 0, curRank: -1, lastScan: 0, settled: false, lastFull: 0 }; domCtl.set(video, ctl); }
    const now = Date.now();
    // Дисциплина «только при необходимости» (по режимам необходимость разная,
    // но правило одно): довёл качество до цели — спим. Полная проверка с правом
    // клика — не чаще раза в 30с; пока ждём применения своего клика (pendingRank)
    // или идёт явный запрос (force) — проверяем как обычно.
    if (!force && ctl.settled && ctl.pendingRank == null && now - (ctl.lastFull || 0) < 30000) return;
    ctl.lastFull = now;
    // CDN-плеер rezka: сначала точечный pjs-адаптер (работает и со скрытым меню)
    try {
      if (pjsTick(video, ctl, force)) {
        const rec = badges.get(video);
        if (rec) updateBadge(rec);
        return;
      }
    } catch (e) {}
    let uniq = ctl.uniq || null;
    if (!uniq || force || now - ctl.lastScan >= 3000) {
      ctl.lastScan = now;
      const root = containerOf(video);
      // меню может быть в оверлее на уровне body (rezka) — ищем и в контейнере, и в body
      let items = findQualityItems(root);
      if (!items.length && root !== document) items = findQualityItems(document);
      let grouped = groupByMenu(items);
      if (!grouped.length) {
        // меню закрыто — пробуем открыть кнопку качества (не чаще раза в 30 c:
        // открывалка тоже дёргает плеер, без нужды не жмём)
        const op = findQualityOpener();
        if (op) {
          const tok = extractQToken((op.innerText || op.textContent || '').trim());
          const oq = tok ? parseQLabel(tok) : null;
          if (oq) { // на кнопке написан текущий уровень — показываем его в бейдже
            ctl.items = [{ label: oq.label, rank: oq.rank }];
            ctl.curRank = oq.rank;
          }
          if (now - (ctl.lastOpener || 0) > 30000) {
            ctl.lastOpener = now;
            try { mouseClick(op); logDom('DOM: клик-открывалка -> ' + describeEl(op)); } catch (e) {}
          }
        } else {
          // не на что нажать — ищем шестерёнку перебором (с откатом состояния)
          try { gearStep(video, ctl); } catch (e) {}
        }
        if (!ctl.items) return;
        uniq = ctl.uniq || null;
        if (!uniq) return;
      } else {
        // дедуплика по label
        const seen = new Map();
        for (const it of grouped) {
          const key = it.q.rank + '|' + it.q.label.toLowerCase();
          if (!seen.has(key)) seen.set(key, it);
        }
        uniq = [...seen.values()].sort((a, b) => a.q.rank - b.q.rank);
        ctl.uniq = uniq;
        ctl.items = uniq.map((u) => ({ label: u.q.label, rank: u.q.rank }));
      }
    }
    let active = uniq.find((u) => isActiveItem(u));
    const wantMax = S.mode === 'max';
    const tr = wantMax ? 99 : targetRank(video);
    let want = null;
    for (const u of uniq) { if (u.q.rank <= tr + 1e-9) want = u; }
    if (!want) want = uniq[0];
    const activeRank = active ? active.q.rank : -1;
    ctl.curRank = activeRank;
    if (Math.abs(activeRank - want.q.rank) < 1e-9) { ctl.settled = true; ctl.blindClicks = 0; return; } // уже то — спим
    // Активное качество не прочиталось — вслепую не кликаем: каждый такой клик
    // перезагружает поток зря. Даём один заходный клик на видео (вдруг меню врёт),
    // дальше ждём читаемого состояния или явного force (кнопка «Обновить», vm-force).
    if (!active && (ctl.blindClicks || 0) >= 1 && !force) return;
    // защита от циклов: не чаще 1 клика в 6 c, не больше 4 авто-кликов, кроме отката при stall
    if (now - ctl.lastClick < 6000) return;
    if (ctl.clicks >= 4 && !ctl.stallArmed) return;
    try {
      mouseClick(want.el);
      ctl.lastClick = now; ctl.clicks++;
      ctl.curRank = want.q.rank;
      ctl.settled = false; // кликнули — ждём применения, потом снова проверим
      if (!active) ctl.blindClicks = (ctl.blindClicks || 0) + 1;
      logDom('DOM click -> ' + want.q.label + ' (mode=' + S.mode + ')');
    } catch (e) {}
  }

  // Только чтение уровней без кликов/открывалок/шестерёнки.
  // Нужно для пассивного режима (>2×): автоматика заморожена, но бейдж
  // не должен вечно висеть в «Поиск…», а ручные клики (vm-force) нуждаются
  // в известных уровнях. Скан дешёвый (DOM-запросы), поток не дёргает.
  function domScanOnly(video) {
    try {
      let ctl = domCtl.get(video);
      if (!ctl) { ctl = { clicks: 0, lastClick: 0, curRank: -1, lastScan: 0, settled: false, lastFull: 0 }; domCtl.set(video, ctl); }
      // pjs: пункты лежат в DOM всегда, видимость не требуем (как pjsTick)
      try {
        const root = containerOf(video);
        let rows = pjsRows(root);
        if (!rows.length && root !== document) rows = pjsRows(document);
        if (rows.length >= 2) {
          const seen = new Map();
          for (const r of rows) { if (!seen.has(r.q.rank)) seen.set(r.q.rank, r); }
          const uniq = [...seen.values()].sort((a, b) => a.q.rank - b.q.rank);
          ctl.uniq = uniq;
          ctl.items = uniq.map((u) => ({ label: u.q.label, rank: u.q.rank }));
          ctl.pjs = true;
          const active = uniq.find((u) => isActiveItem({ el: u.el }));
          if (active) ctl.curRank = active.q.rank;
          const rec0 = badges.get(video);
          if (rec0) updateBadge(rec0);
          return true;
        }
      } catch (e) {}
      // generic: только уже видимое меню, ничего не открываем
      try {
        const root = containerOf(video);
        let items = findQualityItems(root);
        if (!items.length && root !== document) items = findQualityItems(document);
        const grouped = groupByMenu(items);
        if (grouped.length) {
          const seen = new Map();
          for (const it of grouped) {
            const key = it.q.rank + '|' + it.q.label.toLowerCase();
            if (!seen.has(key)) seen.set(key, it);
          }
          const uniq = [...seen.values()].sort((a, b) => a.q.rank - b.q.rank);
          ctl.uniq = uniq;
          ctl.items = uniq.map((u) => ({ label: u.q.label, rank: u.q.rank }));
          const active = uniq.find((u) => isActiveItem(u));
          if (active) ctl.curRank = active.q.rank;
          const rec1 = badges.get(video);
          if (rec1) updateBadge(rec1);
          return true;
        }
        // на кнопке написан текущий уровень — хотя бы его показываем в бейдже
        try {
          const op = findQualityOpener();
          if (op) {
            const tok = extractQToken(((op.innerText || op.textContent || '').trim()));
            const oq = tok ? parseQLabel(tok) : null;
            if (oq) {
              ctl.items = [{ label: oq.label, rank: oq.rank }];
              ctl.curRank = oq.rank;
              const rec2 = badges.get(video);
              if (rec2) updateBadge(rec2);
              return true;
            }
          }
        } catch (e) {}
      } catch (e) {}
      const rec = badges.get(video);
      if (rec) updateBadge(rec);
    } catch (e) {}
    return false;
  }

  // stall-детект для DOM-плееров: два подряд waiting>2.5с — шаг вниз
  const stallMap = new WeakMap();
  function watchStall(video) {
    if (stallMap.has(video)) return;
    const st = { waitingSince: 0, bad: 0 };
    stallMap.set(video, st);
    video.addEventListener('waiting', () => { st.waitingSince = Date.now(); });
    video.addEventListener('playing', () => {
      st.waitingSince = 0;
      const ctl = domCtl.get(video);
      if (ctl) ctl.stallArmed = false;
    });
    setInterval(() => {
      try {
        if (!st.waitingSince) return;
        if (speedPassive()) { st.waitingSince = 0; st.bad = 0; return; } // >2×: степ-даунов нет
        if (Date.now() - st.waitingSince < 2500) return;
        st.waitingSince = Date.now();
        st.bad++;
        if (st.bad < 2) return; // один stall прощаем
        st.bad = 0;
        if (S.mode !== 'smart') return;
        if (video.dataset && video.dataset.vmVid) return; // API-плеер сам разрулит
        const ctl = domCtl.get(video);
        if (!ctl || !ctl.items || !ctl.items.length) return;
        ctl.stallArmed = true; // разрешаем клик сверх лимита
        // кликаем на шаг ниже текущего
        const cur = ctl.curRank;
        const lower = ctl.items.filter((x) => x.rank < cur - 1e-9).pop();
        const target = lower || ctl.items[0];
        // найти элемент заново (findQualityItems кэширует seen — сбросим флаги)
        const root = containerOf(video);
        const items = findQualityItems(root);
        const cand = items.find((u) => Math.abs(u.q.rank - target.rank) < 1e-9) ||
          (root !== document ? findQualityItems(document).find((u) => Math.abs(u.q.rank - target.rank) < 1e-9) : null);
        if (cand) {
          try { mouseClick(cand.el); ctl.lastClick = Date.now(); ctl.curRank = target.rank; ctl.settled = false; logDom('DOM step down -> ' + target.label + ' @ ' + describeEl(cand.el)); } catch (e) {}
        }
      } catch (e) {}
    }, 1500);
  }

  // ---------- Скорость видео (напрямую video.playbackRate, без меню плеера)
  // Ставится в isolated-мире: video-элемент общий для обоих миров, поэтому
  // MAIN-мир не нужен — работает и на generic/mp4, и под строгим CSP.
  // Качество по-прежнему переключается через меню сайта, скорость — только так.
  const SPEED_MIN = 0.07, SPEED_MAX = 16; // широкий диапазон: 0.07–16
  const speedApplyAt = new WeakMap(); // media -> ts последнего применения (анти-зацикливание)
  const speedRetry = new WeakMap(); // media -> id таймера дотяжки (чтобы не копились)
  // Пропущенное из-за 400мс-троттлинга применение не теряем: одна отложенная
  // дотяжка, которая перечитает свежее want. Анти-зацикливание сохраняется —
  // чаще ~2 раз в секунду элемент не дёргаем.
  function queueSpeedRetry(m, force) {
    try {
      if (speedRetry.has(m)) return; // уже ждёт — она перечитает актуальное want
      const id = setTimeout(() => {
        try { speedRetry.delete(m); } catch (e) {}
        try { applySpeed(m, force); } catch (e) {}
      }, 420);
      speedRetry.set(m, id);
    } catch (e) {}
  }
  const speedTouched = new WeakSet(); // media, которым скорость ставили МЫ (их доводим всегда, даже до 1.0)
  function clampSpeed(n) {
    n = Number(n);
    if (!isFinite(n)) return 1;
    return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(n * 100) / 100));
  }
  function desiredSpeed() {
    const v = Number(S.speed);
    return isFinite(v) ? clampSpeed(v) : 1;
  }
  // Пассивный режим скорости (>2×): как VSC — только ставим playbackRate
  // и НЕ трогаем плеер. Любой наш клик по меню качества = перезагрузка
  // потока сайтом, а на высокой скорости это срывает буфер (кадры, пропавший
  // звук). Качество остаётся как есть (какое выбрал пользователь/сайт),
  // вся автоматика (сканы, клики, степ-дауны, пробы веса) замирает
  // до возврата скорости к ≤2. Явные клики пользователя по уровням в
  // мини-панели (vm-force) при этом работают всегда.
  function speedPassive() {
    try { return desiredSpeed() > 2; } catch (e) { return false; }
  }
  function speedStep() {
    const v = Number(S.speedStep);
    return v > 0 && isFinite(v) ? Math.min(4, v) : 0.5;
  }
  // force=true — явный выбор пользователя (кнопка/хоткей/попап): доводим до видео
  // всегда, включая сброс в 1.0. Без force нетронутое видео при want==1 не трогаем.
  function applySpeed(m, force) {
    if (!isActive()) return;
    const want = desiredSpeed();
    try {
      if (Math.abs((m.playbackRate || 1) - want) < 1e-6) return;
      if (!force && Math.abs(want - 1) < 1e-9 && !speedTouched.has(m)) return;
      const last = speedApplyAt.get(m) || 0;
      if (Date.now() - last < 400) { queueSpeedRetry(m, force); return; }
      speedApplyAt.set(m, Date.now());
      m.playbackRate = want;
      speedTouched.add(m);
      logDom('DOM speed -> ' + want + '×');
    } catch (e) {}
  }
  function applySpeedAll(force) {
    try {
      for (const m of document.querySelectorAll('video,audio')) applySpeed(m, force);
    } catch (e) {}
  }
  async function setSpeed(n) {
    const v = clampSpeed(n);
    S.speed = v;
    try { await chrome.storage.local.set({ speed: v }); } catch (e) {}
    applySpeedAll(true);
    refreshAllBadges();
  }
  function watchSpeed(m) {
    if (!m || m.__vm_speedWatched) return;
    m.__vm_speedWatched = true;
    // fightback: сайт сбросил скорость — возвращаем выбранную.
    // Нетронутое нами видео при want==1 оставляем сайту; наши доводим всегда.
    m.addEventListener('ratechange', () => {
      try {
        const want = desiredSpeed();
        if (!isActive()) return;
        if (Math.abs((m.playbackRate || 1) - want) < 1e-6) return;
        if (Math.abs(want - 1) < 1e-9 && !speedTouched.has(m)) return;
        setTimeout(() => { try { applySpeed(m); } catch (e) {} }, 120);
      } catch (e) {}
    });
    // новый поток / перемотка на новый src — сайт мог сбросить скорость
    m.addEventListener('loadedmetadata', () => { try { applySpeed(m); } catch (e) {} });
    m.addEventListener('play', () => { try { applySpeed(m); } catch (e) {} });
  }

  const domLog = [];
  function logDom(t) {
    domLog.push({ t: new Date().toISOString(), text: t });
    if (domLog.length > 20) domLog.shift();
  }

  // ---------- Бейдж (Shadow DOM, стекло)
  const badges = new Map(); // video -> {host, shadow, els}
  function badgeAllowed() {
    // скрытие — только для своей вкладки; новая вкладка всегда начинает с видимого бейджа
    return S.badgeDefaultVisible && !(S.badgeHiddenTabs && myTabId !== null && myTabId !== undefined && S.badgeHiddenTabs[myTabId]);
  }
  function playerForVideo(video) {
    const id = video.dataset && video.dataset.vmVid;
    if (!id) return null;
    return (mainState.players || []).find((p) => p.id === id) || null;
  }
  function currentLabel(video) {
    const p = playerForVideo(video);
    if (p && p.levels && p.levels.length && p.current >= 0 && p.levels[p.current]) {
      return { text: p.levels[p.current].label, state: S.mode, api: true, player: p };
    }
    const ctl = domCtl.get(video);
    if (ctl && ctl.items && ctl.items.length && ctl.curRank >= 0) {
      const it = ctl.items.find((x) => Math.abs(x.rank - ctl.curRank) < 1e-9) || ctl.items[ctl.items.length - 1];
      return { text: it.label, state: S.mode, api: false, player: null };
    }
    return { text: 'Поиск…', state: 'unknown', api: false, player: null };
  }

  const DOT = { max: '#38d977', smart: '#3aa0ff', manual: '#a8adb7', unknown: '#ff5d5d' };

  function ensureBadge(video) {
    if (badges.has(video)) return badges.get(video);
    const host = document.createElement('div');
    host.setAttribute('data-vm-badge', '1');
    const sh = host.attachShadow({ mode: 'open' });
    const css = document.createElement('style');
    css.textContent = `
      :host{position:absolute;left:50%;top:14px;transform:translateX(-50%);z-index:2147483646;font-family:Inter,-apple-system,'SF Pro Text','Segoe UI',Roboto,sans-serif;pointer-events:auto}
      .b{display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.02em;color:#fff;cursor:pointer;user-select:none;
        background:linear-gradient(135deg,rgba(30,32,44,.62),rgba(30,32,44,.42));border:1px solid rgba(255,255,255,.22);
        -webkit-backdrop-filter:blur(14px) saturate(1.4);backdrop-filter:blur(14px) saturate(1.4);
        box-shadow:0 4px 18px rgba(0,0,0,.35);transition:opacity .25s,transform .25s}
      .b:hover{transform:translateY(-1px)}
      .b{touch-action:none}
      .dot{width:8px;height:8px;border-radius:50%;background:#3aa0ff;box-shadow:0 0 6px currentColor}
      .panel{position:absolute;left:50%;transform:translateX(-50%);top:calc(100% + 8px);width:230px;padding:12px;border-radius:18px;color:#f2f3f6;display:none;
        background:linear-gradient(160deg,rgba(38,40,54,.78),rgba(24,25,34,.72));border:1px solid rgba(255,255,255,.18);
        -webkit-backdrop-filter:blur(20px) saturate(1.5);backdrop-filter:blur(20px) saturate(1.5);box-shadow:0 12px 40px rgba(0,0,0,.45)}
      .panel.open{display:block}
      .pt{font-size:11px;opacity:.65;margin:14px 0 6px;text-transform:uppercase;letter-spacing:.08em}
      .panel>.pt:first-child{margin-top:2px}
      .row{display:flex;gap:6px;margin-bottom:8px}
      .mbtn{flex:1;padding:7px 0;font-size:11.5px;font-weight:600;text-align:center;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.07);color:#fff;cursor:pointer}
      .mbtn.on{background:linear-gradient(135deg,#5b8cff,#8b5cf6);border-color:transparent}
      .caps{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
      .c{padding:5px 9px;font-size:11px;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#fff;cursor:pointer}
      .c.on{background:linear-gradient(135deg,#5b8cff,#8b5cf6);border-color:transparent}
      .lvls{display:flex;flex-wrap:wrap;gap:6px;max-height:96px;overflow:auto;margin-bottom:8px}
      .frow{display:flex;gap:6px;margin-top:10px}
      .frow+.frow{margin-top:6px}
      .fbtn{flex:1;padding:7px 0;font-size:11px;text-align:center;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:#fff;cursor:pointer}
      .fbtn:hover{background:rgba(255,255,255,.14)}
      .frow3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:10px}
      .fwide{margin-top:6px;width:100%}
      .subs{display:flex;flex-direction:column;gap:6px;margin-top:6px;max-height:132px;overflow:auto}
      .subbtn{padding:6px 9px;font-size:11px;text-align:left;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#fff;cursor:pointer}
      .subbtn:hover{background:rgba(255,255,255,.14)}
      .subnote{font-size:10.5px;opacity:.65;line-height:1.4}
      .subhead{font-size:10px;opacity:.55;margin-top:4px;text-transform:uppercase;letter-spacing:.05em}
      .subbtn.pending{opacity:.8;border-style:dashed}
      .substatus{margin-top:6px}
      .subrow{display:flex;gap:6px;margin-top:6px}
      .subrow .subbtn{flex:1}
      .hide{opacity:0;pointer-events:none}
    `;
    sh.appendChild(css);
    const b = document.createElement('div');
    b.className = 'b';
    b.innerHTML = '<span class="dot"></span><span class="t">Поиск…</span>';
    const panel = document.createElement('div');
    panel.className = 'panel';
    sh.appendChild(b);
    sh.appendChild(panel);
    const rec = { host, sh, b, panel, video, open: false };
    badges.set(video, rec);

    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (rec.justDragged) { rec.justDragged = false; return; }
      rec.open = !rec.open;
      panel.classList.toggle('open', rec.open);
      if (rec.open) renderPanel(rec);
    });
    // drag: тянем за бейдж, клик после перетаскивания панель не открывает
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button > 0) return;
      const startX = e.clientX, startY = e.clientY;
      const origLeft = host.offsetLeft, origTop = host.offsetTop;
      let moved = false;
      const move = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
        moved = true;
        host.style.left = (origLeft + dx) + 'px';
        host.style.top = (origTop + dy) + 'px';
        host.style.transform = 'none';
        host.style.right = 'auto';
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        if (moved) {
          rec.justDragged = true;
          setTimeout(() => { rec.justDragged = false; }, 80);
          saveBadgePos(host);
        }
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
    placeBadge(video, host);
    updateBadge(rec);
    return rec;
  }

  function placeBadge(video, host) {
    try {
      let wrap = null;
      try { wrap = video.closest('[class*="player" i],[id*="player" i]') || video.parentElement; } catch (e) {}
      if (!wrap || wrap === document.body || wrap === document.documentElement) {
        // fallback: фиксированное позиционирование
        host.style.position = 'fixed';
        document.documentElement.appendChild(host);
      } else {
        const pos = getComputedStyle(wrap).position;
        if (pos === 'static') wrap.style.position = 'relative';
        wrap.appendChild(host);
        host.style.position = 'absolute';
      }
      if (!applySavedPos(host)) setDefaultPos(host);
    } catch (e) {
      try { document.documentElement.appendChild(host); } catch (x) {}
    }
  }

  // ---------- перетаскивание бейджа + запоминание позиции на домен
  let badgePosCache = null;
  async function getBadgePos() {
    if (badgePosCache) return badgePosCache;
    try {
      const o = await chrome.storage.local.get('badgePos');
      badgePosCache = (o && o.badgePos) || {};
    } catch (e) { badgePosCache = {}; }
    return badgePosCache;
  }
  function setDefaultPos(host) {
    host.style.left = '50%';
    host.style.top = '14px';
    host.style.transform = 'translateX(-50%)';
    host.style.right = 'auto';
  }
  function applySavedPos(host) {
    try {
      const p = badgePosCache && badgePosCache[location.host];
      if (p && typeof p.left === 'string' && typeof p.top === 'string') {
        // Самопочинка: позиция могла сохраниться за экраном (случайный драг,
        // смена размера окна) — такой бейдж выглядел бы «пропавшим навсегда».
        // Проверяем px-координаты против вьюпорта, мусор игнорируем.
        const m = 80; // допуск на пол-бейджа за краем
        const lx = parseFloat(p.left), tx = parseFloat(p.top);
        const vw = (window.innerWidth || 0), vh = (window.innerHeight || 0);
        if (isFinite(lx) && isFinite(tx) && vw > 0 && vh > 0) {
          const isPx = /px\s*$/.test(p.left) && /px\s*$/.test(p.top);
          if (isPx && (lx < -m || lx > vw + m || tx < -m || tx > vh + m)) return false;
        }
        host.style.left = p.left;
        host.style.top = p.top;
        host.style.transform = 'none';
        host.style.right = 'auto';
        return true;
      }
    } catch (e) {}
    return false;
  }
  async function saveBadgePos(host) {
    try {
      const pos = await getBadgePos();
      pos[location.host] = { left: host.style.left, top: host.style.top };
      badgePosCache = pos;
      await chrome.storage.local.set({ badgePos: pos });
    } catch (e) {}
  }
  async function resetBadgePos(host) {
    try {
      const pos = await getBadgePos();
      delete pos[location.host];
      badgePosCache = pos;
      await chrome.storage.local.set({ badgePos: pos });
    } catch (e) {}
    setDefaultPos(host);
  }

  // ---------- Инфо-панель прямо на видео (полупрозрачный фон, левый верхний угол)
  // Включается кнопкой «Инфо на видео» в мини-панели, закрывается крестиком
  // или повторным нажатием. Всё — прямыми свойствами элемента, простым языком.
  const infoOverlays = new Map(); // video -> host div (Shadow DOM)
  function fmtClock(s) {
    if (s === null || s === undefined || !isFinite(s)) return '—';
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  }
  function fmtRate(n) {
    n = Math.round(Number(n) * 100) / 100;
    if (!isFinite(n)) return '?';
    return String(n) + '×';
  }
  // R — переключатель «1.0 ↔ скорость до сброса»: первое нажатие запоминает текущую
  // и сбрасывает в 1.0, повторное — возвращает запомненную, третье — снова сброс. И так по кругу.
  function toggleResetSpeed() {
    const cur = desiredSpeed();
    if (Math.abs(cur - 1) < 1e-9) {
      const last = Number(S.lastSpeedBeforeReset) || 0;
      if (Math.abs(last - 1) > 1e-9) setSpeed(last);
    } else {
      S.lastSpeedBeforeReset = cur;
      try { chrome.storage.local.set({ lastSpeedBeforeReset: cur }); } catch (e) {}
      setSpeed(1);
    }
  }
  function shortSrc(s) {
    s = String(s || '');
    if (!s) return '';
    try {
      const u = new URL(s);
      if (u.protocol === 'blob:') return 'поток в памяти (blob)';
      return u.hostname + (u.pathname || '').slice(0, 30);
    } catch (e) { return s.slice(0, 60); }
  }
  // Строки простым языком: каждая мелочь — с новой строки и с большой буквы,
  // без точек-разделителей и скобок. Всё, что элемент вообще отдаёт.
  function trSum(r) {
    let n = 0, total = 0;
    try {
      if (r && r.length) {
        n = r.length;
        for (let i = 0; i < r.length; i++) { try { total += r.end(i) - r.start(i); } catch (e) {} }
      }
    } catch (e) {}
    return { n, total: Math.round(total * 10) / 10 };
  }
  function fmtBytes(n) {
    try {
      n = Number(n);
      if (!isFinite(n) || n <= 0) return '';
      if (n >= 1073741824) return (Math.round(n / 1073741824 * 10) / 10) + ' ГБ';
      if (n >= 1048576) return (Math.round(n / 1048576 * 10) / 10) + ' МБ';
      if (n >= 1024) return Math.round(n / 1024) + ' КБ';
      return Math.round(n) + ' Б';
    } catch (e) { return ''; }
  }
  // ---------- Вес потока и проверка «по факту идёт»: один лёгкий опрос на адрес.
  // Прямой файл (.mp4) — HEAD, читаем Content-Length (размер CDN отдаёт всегда).
  // HLS — качаем текстовый плейлист (килобайты), считаем куски и длительность;
  // объём подгрузки считаем по performance-ресурсам (уже скачанные .ts).
  const streamMetaCache = new Map(); // url -> {len}|{segs,dur}|null
  const videoStreamMeta = new WeakMap(); // video -> meta|null
  function streamUrlFor(video) {
    try {
      const rs = performance.getEntriesByType('resource') || [];
      for (const r of rs) {
        const n = (r && r.name) || '';
        if (!n || n.startsWith('blob:')) continue;
        if (/\.m3u8(\?|$)/i.test(n)) return n;
      }
      for (const r of rs) {
        const n = (r && r.name) || '';
        if (!n || n.startsWith('blob:')) continue;
        if (/\.ts(\?|$)/i.test(n)) return n;
      }
    } catch (e) {}
    try {
      const cs = video.currentSrc || video.src || '';
      if (cs && /^https?:/i.test(cs)) return cs;
    } catch (e) {}
    return '';
  }
  function probeStreamMeta(video) {
    try {
      if (videoStreamMeta.has(video)) return; // уже знаем (включая «пусто»)
      const u = streamUrlFor(video);
      if (!u) return;
      if (streamMetaCache.has(u)) { videoStreamMeta.set(video, streamMetaCache.get(u)); return; }
      streamMetaCache.set(u, null); // застолбили: повторных опросов не будет
      videoStreamMeta.set(video, null);
      if (/\.m3u8(\?|$)/i.test(u)) {
        fetch(u, { credentials: 'omit' }).then((r) => r.text()).then((txt) => {
          let pl = txt || '';
          try {
            const lines = pl.split('\n').map((s) => s.trim()).filter(Boolean);
            const vi = lines.findIndex((s) => s.indexOf('#EXT-X-STREAM-INF') === 0);
            if (vi >= 0) {
              const next = lines.slice(vi + 1).find((s) => s && s[0] !== '#');
              if (next) return fetch(new URL(next, u).href, { credentials: 'omit' }).then((r2) => r2.text());
            }
          } catch (e) {}
          return pl;
        }).then((pl) => {
          let n = 0, dur = 0;
          try {
            const lines = String(pl || '').split('\n');
            for (const s of lines) {
              const m = s.match(/#EXTINF:([\d.]+)/);
              if (m) { n++; dur += parseFloat(m[1]) || 0; }
            }
          } catch (e) {}
          const meta = n > 0 ? { segs: n, dur: Math.round(dur) } : null;
          streamMetaCache.set(u, meta);
          try { videoStreamMeta.delete(video); } catch (e) {}
          try { refreshVideoInfos(); } catch (e) {}
        }).catch(() => {});
      } else {
        fetch(u, { method: 'HEAD', credentials: 'omit' }).then((r) => {
          let len = 0;
          try { len = parseInt(r.headers.get('content-length') || '0', 10) || 0; } catch (e) {}
          const meta = len > 0 ? { len } : null;
          streamMetaCache.set(u, meta);
          try { videoStreamMeta.delete(video); } catch (e) {}
          try { refreshVideoInfos(); } catch (e) {}
        }).catch(() => {});
      }
    } catch (e) {}
  }
  function loadedTsBytes() {
    let n = 0, total = 0;
    try {
      const rs = performance.getEntriesByType('resource') || [];
      for (const r of rs) {
        const nm = (r && r.name) || '';
        if (!nm || nm.startsWith('blob:') || !/\.ts(\?|$)/i.test(nm)) continue;
        n++;
        try { total += r.encodedBodySize || 0; } catch (e) {}
      }
    } catch (e) {}
    return { n, total };
  }
  // ---------- Вес по качествам: повторяем запрос плеера за потоком (только rezka-подобные
  // страницы с get_cdn_series), расшифровываем ссылки (clearTrash) и опрашиваем размер
  // каждого .mp4. Один набор опросов на серию+озвучку за сессию.
  // Как у HDrezka-Helper (src/background.js, clearTrash): мусор — все комбинации
  // '@ # ! ^ $' длиной 2 и 3, их base64 вычищается из строки без '//_//'.
  function clearTrash(data) {
    try {
      const trashList = ['@', '#', '!', '^', '$'];
      const codes = [];
      const gen = (prefix, len) => {
        if (len === 0) { try { codes.push(btoa(prefix)); } catch (e) {} return; }
        for (const c of trashList) gen(prefix + c, len - 1);
      };
      gen('', 2); gen('', 3);
      let s = String(data || '').split('//_//').join('');
      // Helper убирает только первое '#h'; убираем все — '#' не входит
      // в base64-алфавит, живых данных там быть не может.
      s = s.split('#h').join('');
      for (const c of codes) { if (c) s = s.split(c).join(''); }
      s = s.replace(/\s+/g, '');
      // Чистый base64 кратен 4 — допаддим (Helper этого не делает и падает).
      const pad = s.length % 4;
      if (pad) s += '===='.slice(pad);
      const bin = atob(s);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch (e) { return ''; }
  }
  function parseQStreams(decoded) {
    // Как у Helper'а: кусок '...[720p]ссылка1 or ссылка2,...', дедуп ссылок.
    // Отличие: принимаем .mp4 с query-хвостом (?md5=...) и .m3u8 (поле kind) —
    // голый endsWith('.mp4') такие ссылки роняет.
    const out = [];
    const seen = new Set();
    try {
      for (const part of String(decoded || '').split(',')) {
        const a = part.indexOf('['), b = part.indexOf(']');
        if (a < 0 || b < 0 || b <= a) continue;
        const label = part.slice(a + 1, b).replace(/<[^>]*>/g, '').trim();
        if (!label) continue;
        const rest = part.slice(b + 1);
        for (const cand of rest.split(' or ')) {
          const chunk = (cand || '').trim();
          if (!chunk || seen.has(chunk)) continue;
          let url = chunk;
          try {
            const m = chunk.match(/https?:\/\/[^\s"'<>]+/);
            if (m && m[0]) url = m[0];
          } catch (e) {}
          if (!/^https?:\/\//i.test(url)) continue;
          let kind = '';
          if (/\.mp4(\?|#|$)/i.test(url)) kind = 'mp4';
          else if (/\.m3u8(\?|#|$)/i.test(url)) kind = 'm3u8';
          else continue;
          seen.add(chunk);
          out.push({ label, url, kind });
        }
      }
    } catch (e) {}
    return out;
  }
  // Вес HLS-вариантов: мастер-плейлист -> BANDWIDTH × длительность.
  // Ответ сервера всё чаще — m3u8-ссылки, а не mp4; парсер выше их уже
  // отличает (kind), здесь считаем вес каждого качества без скачивания видео.
  function hlsDurAndSegs(txt) {
    let dur = 0, n = 0;
    const segs = [];
    try {
      for (const ln of String(txt || '').split('\n')) {
        const s = (ln || '').trim();
        const m = s.match(/#EXTINF:([\d.]+)/);
        if (m) { n++; dur += parseFloat(m[1]) || 0; continue; }
        if (s && s[0] !== '#' && /\.(ts|m4s|mp4)(\?|#|$)/i.test(s)) segs.push(s);
      }
    } catch (e) {}
    return { dur, n, segs };
  }
  function probeHlsSizes(entries) {
    const fetchTxt = (u) => fetch(u, { credentials: 'omit' }).then((r) => {
      if (!r.ok) throw 0;
      return r.text();
    });
    const headLen = (u) => fetch(u, { method: 'HEAD', credentials: 'omit' }).then((r) => {
      try { return parseInt(r.headers.get('content-length') || '0', 10) || 0; } catch (e) { return 0; }
    }).catch(() => 0);
    return Promise.all((entries || []).map((en) => fetchTxt(en.url).then((txt) => {
      const lines = String(txt || '').split('\n').map((s) => (s || '').trim());
      const hasMaster = lines.some((s) => s.indexOf('#EXT-X-STREAM-INF') === 0);
      if (!hasMaster) return [{ uri: en.url, bw: 0, res: '', baseLabel: en.label, masterUrl: en.url }];
      const vars = [];
      for (let i = 0; i < lines.length; i++) {
        const s = lines[i];
        if (s.indexOf('#EXT-X-STREAM-INF') !== 0) continue;
        let bw = 0, res = '';
        try {
          const mb = s.match(/BANDWIDTH=(\d+)/);
          if (mb) bw = parseInt(mb[1], 10) || 0;
          const mr = s.match(/RESOLUTION=(\d+x\d+)/i);
          if (mr) res = mr[1];
        } catch (e) {}
        let uri = '';
        for (let j = i + 1; j < lines.length; j++) {
          const t = lines[j];
          if (!t) continue;
          if (t[0] === '#') continue;
          uri = t; break;
        }
        if (!uri) continue;
        try { uri = new URL(uri, en.url).href; } catch (e) {}
        vars.push({ uri, bw, res, baseLabel: en.label, masterUrl: en.url });
      }
      return vars.length ? vars : [{ uri: en.url, bw: 0, res: '', baseLabel: en.label, masterUrl: en.url }];
    }).catch(() => []))).then((groups) => {
      const flat = [];
      for (const g of groups || []) for (const v of g || []) flat.push(v);
      return Promise.all(flat.map((v) => fetchTxt(v.uri).then((txt) => {
        const { dur, n, segs } = hlsDurAndSegs(txt);
        let label = v.baseLabel;
        try {
          const m = String(v.res || '').match(/(\d+)\s*x\s*(\d+)/);
          if (m) label = m[2] + 'p';
        } catch (e) {}
        if (v.bw > 0 && dur > 0) {
          return { label, bytes: Math.round((v.bw / 8) * dur) };
        }
        if (n > 0 && segs.length) {
          // Нет BANDWIDTH — меряем первые 3 сегмента, средний × число кусков.
          const sample = segs.slice(0, 3).map((s) => {
            try { return new URL(s, v.uri).href; } catch (e) { return s; }
          });
          return Promise.all(sample.map(headLen)).then((lens) => {
            const good = (lens || []).filter((x) => x > 0);
            if (!good.length) return null;
            const avg = good.reduce((a, b) => a + b, 0) / good.length;
            return { label, bytes: Math.round(avg * n) };
          });
        }
        return null;
      }).catch(() => null)));
    }).then((arr) => {
      const map = {};
      for (const a of arr || []) {
        if (!a || !a.label || !(a.bytes > 0)) continue;
        if (!map[a.label] || a.bytes > map[a.label]) map[a.label] = a.bytes;
      }
      return map;
    });
  }
  const qsLogged = new Set(); // ключ -> уже писали в события (чтобы не спамить)
  function qsLog(key, msg) {
    try {
      if (qsLogged.has(key)) return;
      qsLogged.add(key);
      logDom(msg);
    } catch (e) {}
  }
  function rezkaStreamParams() {
    try {
      // Видео обычно в iframe плеера, а post_id и список озвучек — в топ-документе.
      // Смотрим оба (топ — только если тот же origin, иначе молча пропускаем).
      // Селекторы и тип — как у HDrezka-Helper (MAIN-мир): #simple-seasons-tabs,
      // #simple-episodes-tabs, #translators-list .active, meta og:type.
      const docs = [];
      try { docs.push({ d: document, href: location.href, base: location.origin, tag: 'кадр' }); } catch (e) {}
      try {
        if (window.top && window.top !== window && window.top.document) {
          docs.push({ d: window.top.document, href: window.top.location.href, base: window.top.location.origin, tag: 'топ' });
        }
      } catch (e) {}
      lastQsMarker = false;
      for (const { d, href, base, tag } of docs) {
        let id = 0;
        try {
          const pid = d.getElementById('post_id');
          if (pid && pid.value) id = parseInt(pid.value, 10) || 0;
          if (!id) {
            try {
              const uf = d.getElementById('user-favorites-holder');
              if (uf && uf.getAttribute('data-post_id')) id = parseInt(uf.getAttribute('data-post_id'), 10) || 0;
            } catch (e) {}
          }
          if (!id) {
            const sid = d.getElementById('send-video-issue');
            if (sid && sid.getAttribute('data-id')) id = parseInt(sid.getAttribute('data-id'), 10) || 0;
          }
        } catch (e) {}
        if (!id) {
          try {
            const m = href.match(/\/(\d+)-[^/]*\.html/);
            if (m) id = parseInt(m[1], 10) || 0;
          } catch (e) {}
        }
        try {
          if (d.querySelector('#translators-list [data-translator_id]')) lastQsMarker = true;
        } catch (e) {}
        if (!id) continue;
        let ftype = '';
        try {
          const mt = d.querySelector('meta[property="og:type"]');
          if (mt) ftype = mt.getAttribute('content') || '';
        } catch (e) {}
        const isSeries = ftype !== 'video.movie';
        let tr = 0;
        try {
          const active = d.querySelector('#translators-list .active');
          if (active && active.getAttribute('data-translator_id')) {
            tr = parseInt(active.getAttribute('data-translator_id'), 10) || 0;
          }
        } catch (e) {}
        if (!tr) {
          try {
            // Запасной путь Helper'а: id из initCDNEvents в коде страницы.
            const initEv = isSeries ? 'initCDNSeriesEvents' : 'initCDNMoviesEvents';
            const parts = d.documentElement.textContent.split('sof.tv.' + initEv);
            if (parts.length > 1) tr = parseInt(parts.pop().split('{')[0].split(',')[1], 10) || 0;
          } catch (e) {}
        }
        if (!tr) { qsLog(id + '/notr', 'QS: есть post_id (' + tag + '), но нет активной озвучки'); continue; }
        let season = 0, episode = 0;
        try {
          const se = d.querySelector('#simple-seasons-tabs .active');
          const ep = d.querySelector('#simple-episodes-tabs .active');
          if (se) season = parseInt(se.getAttribute('data-tab_id'), 10) || 0;
          if (ep) episode = parseInt(ep.getAttribute('data-episode_id'), 10) || 0;
        } catch (e) {}
        if (!season || !episode) {
          try {
            const sm = href.match(/\/(\d+)-season\/(\d+)-episode/);
            if (sm) { season = parseInt(sm[1], 10) || 0; episode = parseInt(sm[2], 10) || 0; }
          } catch (e) {}
        }
        qsLog(id + '/' + tr, 'QS: параметры найдены (' + tag + ', ' + (isSeries ? 'сериал' : 'фильм') + ', сезон ' + (season || '?') + ', серия ' + (episode || '?') + ')');
        return { base, id, tr, season, episode, isSeries };
      }
      // Не rezka-страница — молчим, чтобы не спамить события на YouTube и прочих.
      if (lastQsMarker) qsLog('notrans', 'QS: есть список озвучек, но нет post_id');
      return null;
    } catch (e) { return null; }
  }
  const qsizeCache = new Map(); // "id/tr/s/e" -> {label:bytes}|null
  const videoQSize = new WeakMap(); // video -> {label:bytes}|null
  const qsNote = new Map(); // key -> текст причины обрыва (для строки «Вес»)
  const videoQErr = new WeakMap(); // video -> текст причины обрыва
  let lastQsMarker = false; // в этом кадре есть признаки rezka (список озвучек)
  function setQErr(video, text) {
    try { videoQErr.set(video, text); } catch (e) {}
  }
  function readTopQsizes(cb) {
    // То, что насобирал топ-кадр (у него есть post_id и та же origin, что у AJAX).
    try {
      chrome.storage.local.get(['vmQsizes'], (o) => {
        try { cb(o && o.vmQsizes); } catch (e) { cb(null); }
      });
    } catch (e) { cb(null); }
  }
  function fetchQSizes(p, key, cb) {
    // p: {base,id,tr,season,episode,isSeries}; cb(map|null). Итог и причину пишет в кэши.
    // Размер — как у Helper'а: сначала HEAD, если пусто — GET (CDN бывает молчит на HEAD).
    try {
      const isSeries = !!p.isSeries;
      const body = isSeries
        ? { id: p.id, translator_id: p.tr, season: p.season, episode: p.episode, action: 'get_stream' }
        : { id: p.id, translator_id: p.tr, action: 'get_movie' };
      // Как у Helper'а (makeRequest): пустые поля не шлём — season=0/episode=0
      // сервер понимает как ошибку, а не как «первую серию».
      try {
        for (const k of Object.keys(body)) { if (!body[k]) delete body[k]; }
      } catch (e) {}
      const sizeOf = (url) => {
        const readLen = (rh) => {
          try { return parseInt(rh.headers.get('content-length') || '0', 10) || 0; } catch (e) { return 0; }
        };
        return fetch(url, { method: 'HEAD', credentials: 'omit' }).then((rh) => {
          const n = readLen(rh);
          if (n > 0) return n;
          return fetch(url, { credentials: 'omit' }).then((rg) => {
            try { rg.body.cancel(); } catch (e) {}
            return readLen(rg);
          }).catch(() => 0);
        }).catch(() => 0);
      };
      fetch(p.base + '/ajax/get_cdn_series/', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: new URLSearchParams(body).toString(),
      }).then((r) => {
        qsLog(key + '/post', 'QS: POST ответил ' + r.status);
        if (!r.ok) { qsNote.set(key, 'сервер ответил ' + r.status); throw 0; }
        return r.json();
      }).then((j) => {
        if (!j || !j.success || !j.url) { qsNote.set(key, 'в ответе нет ссылки на поток'); qsLog(key + '/empty', 'QS: ответ без ссылки на поток'); throw 0; }
        let decoded = clearTrash(j.url);
        if (!decoded) decoded = String(j.url || ''); // мягкий фолбэк как у Helper'а
        const qs = parseQStreams(decoded);
        qsLog(key + '/dec', 'QS: расшифровано ссылок: ' + qs.length + ' (mp4: ' + qs.filter((q) => q.kind === 'mp4').length + ', m3u8: ' + qs.filter((q) => q.kind === 'm3u8').length + ')');
        if (!qs.length) {
          qsNote.set(key, 'ссылки не расшифровались');
          try {
            qsLog(key + '/raw', 'QS: превью ответа: ' + String(decoded || '').slice(0, 80));
          } catch (e) {}
          throw 0;
        }
        const mp4s = qs.filter((q) => q.kind === 'mp4');
        if (!mp4s.length) {
          // Сервер отдал только HLS-варианты — вес считаем по плейлистам.
          qsLog(key + '/hls', 'QS: mp4 нет, считаю вес по HLS-плейлистам (' + qs.length + ')');
          return probeHlsSizes(qs).then((map) => ({ hlsMap: map, qs }));
        }
        return Promise.all(mp4s.map((q) =>
          sizeOf(q.url).then((bytes) => ({ label: q.label, bytes }))
        )).then((arr) => ({ mp4arr: arr }));
      }).then((res) => {
        let map = {};
        if (res && res.hlsMap) {
          map = res.hlsMap;
        } else {
          const arr = (res && res.mp4arr) || [];
          // Как у Helper'а: первое удачное значение на качество.
          for (const a of arr || []) {
            if (a && a.label && a.bytes > 0 && !map[a.label]) map[a.label] = a.bytes;
          }
        }
        const total = (res && res.hlsMap) ? (res.qs || []).length : ((res && res.mp4arr) || []).length;
        qsLog(key + '/head', 'QS: размеров получено: ' + Object.keys(map).length + '/' + total);
        const fin = Object.keys(map).length ? map : null;
        if (!fin) qsNote.set(key, 'CDN не отдал размеры');
        qsizeCache.set(key, fin);
        try { cb(fin); } catch (e) {}
      }).catch(() => {
        if (!qsNote.has(key)) qsNote.set(key, 'ошибка запроса');
        qsizeCache.set(key, null);
        try { cb(null); } catch (e) {}
      });
    } catch (e) { try { cb(null); } catch (e2) {} }
  }
  function topQsTick() {
    // Топ-кадр: свои параметры + свой origin — качаем и кладём в общее хранилище,
    // кадры с видео (даже чужие iframe) заберут оттуда.
    try {
      if (window.top !== window) return;
      const p = rezkaStreamParams();
      if (!p) return;
      const key = p.id + '/' + p.tr + '/' + (p.season > 0 && p.episode > 0 ? p.season + '/' + p.episode : 'm');
      if (qsizeCache.has(key)) return;
      qsizeCache.set(key, null); // застолбили на время запроса
      fetchQSizes(p, key, (map) => {
        try {
          chrome.storage.local.set({ vmQsizes: { tab: (myTabId !== null && myTabId !== undefined) ? myTabId : 0, key, map, at: Date.now() } });
        } catch (e) {}
        try { refreshVideoInfos(); } catch (e) {}
      });
    } catch (e) {}
  }
  function probeStreamSizes(video) {
    try {
      if (videoQSize.has(video)) return; // уже знаем (включая «пусто»)
      const p = rezkaStreamParams();
      if (p) {
        const key = p.id + '/' + p.tr + '/' + (p.season > 0 && p.episode > 0 ? p.season + '/' + p.episode : 'm');
        if (qsizeCache.has(key)) {
          videoQSize.set(video, qsizeCache.get(key));
          const nt0 = qsNote.get(key);
          if (!qsizeCache.get(key) && nt0) setQErr(video, nt0);
          return;
        }
        qsizeCache.set(key, null); // застолбили: повторных цепочек не будет
        videoQSize.set(video, null);
        fetchQSizes(p, key, (map) => {
          try { videoQSize.delete(video); } catch (e) {} // следующий тик заберёт итог
          const nt = qsNote.get(key);
          if (!map && nt) setQErr(video, nt);
          try { refreshVideoInfos(); } catch (e) {}
        });
        return;
      }
      // Параметров нет в этом кадре (видео в чужом iframe) — ждём топ-кадр.
      if (!lastQsMarker) return; // не rezka — молча, без мусора в «Вес»
      readTopQsizes((en) => {
        try {
          if (videoQSize.has(video)) return;
          if (en && en.map && Object.keys(en.map).length && (!en.tab || en.tab === myTabId)) {
            videoQSize.set(video, en.map);
            try { refreshVideoInfos(); } catch (e) {}
          } else {
            setQErr(video, 'топ-кадр пока не отдал размеры');
          }
        } catch (e) {}
      });
    } catch (e) {}
  }
  function mediaRowsPlain(v) {
    const rows = [];
    const L = (label, lines) => {
      const clean = (lines || []).map((s) => String(s === undefined || s === null ? '' : s).trim()).filter(Boolean);
      if (clean.length) rows.push([label, clean.join('\n')]);
    };
    try {
      const st = [];
      try {
        if (v.ended) st.push('Видео закончилось');
        else if (v.paused) st.push('Стоит на паузе');
        else if (v.readyState < 3) st.push('Ждёт данные — крутится загрузка');
        else st.push('Играет');
      } catch (e) {}
      try { st.push(trSum(v.seekable).n > 0 ? 'Перемотка работает' : 'Перемотку сайт не разрешает'); } catch (e) {}
      try { if (v.seeking) st.push('Прямо сейчас перематывает'); } catch (e) {}
      L('Состояние', st);
      const tm = ['Сейчас идёт ' + fmtClock(v.currentTime)];
      try {
        if (isFinite(v.duration) && v.duration > 0) {
          tm.push('Всего длится ' + fmtClock(v.duration));
          tm.push('Просмотрено ' + Math.round((v.currentTime / v.duration) * 100) + '%');
        } else {
          tm.push('Это прямой эфир');
          tm.push('Конца нет — идёт в реальном времени');
        }
      } catch (e) {}
      try {
        const pl = trSum(v.played);
        if (pl.n > 0) {
          tm.push('Смотреных кусков: ' + pl.n);
          tm.push('Суммарно смотрено ' + fmtClock(pl.total));
        }
      } catch (e) {}
      L('Время', tm);
      const ql = [];
      try {
        const info = currentLabel(v);
        ql.push('Сейчас ' + info.text);
        if (info.player && info.player.levels) ql.push('Всего уровней: ' + info.player.levels.length);
        ql.push(info.state === 'smart' ? 'Режим: умный' : info.state === 'max' ? 'Режим: максимум' : info.state === 'manual' ? 'Режим: ручной' : 'Режим: определяется');
      } catch (e) {}
      L('Качество', ql);
      const sp = ['Сейчас ' + fmtRate(v.playbackRate)];
      try {
        const want = desiredSpeed();
        sp.push(Math.abs(want - 1) > 1e-9 ? 'Выбрано ' + fmtRate(want) : 'Обычная скорость без ускорения');
      } catch (e) {}
      try {
        const pp = v.preservesPitch !== undefined ? v.preservesPitch : v.webkitPreservesPitch !== undefined ? v.webkitPreservesPitch : v.mozPreservesPitch;
        if (pp !== undefined) sp.push(pp ? 'Голос не меняется' : 'Голос становится выше и быстрее');
      } catch (e) {}
      L('Скорость', sp);
      const au = [];
      try { au.push(v.muted ? 'Звук выключен' : 'Звук включён'); } catch (e) {}
      try { au.push('Громкость ' + Math.round(v.volume * 100) + '%'); } catch (e) {}
      try { if (v.defaultMuted) au.push('Сайт запускает видео без звука'); } catch (e) {}
      try {
        const at = v.audioTracks;
        if (at && at.length) {
          au.push('Звуковых дорожек: ' + at.length);
          for (let i = 0; i < at.length; i++) {
            const t = at[i];
            au.push('Дорожка ' + (i + 1) + ': ' + (t.label || 'без названия'));
            if (t.language) au.push('Язык: ' + t.language);
            au.push(t.enabled ? 'Статус: играет сейчас' : 'Статус: запасная');
          }
        } else {
          au.push('Дорожка одна — та, что зашита в видео');
        }
      } catch (e) {}
      try {
        if (typeof v.sinkId === 'string' && v.sinkId) au.push('Куда играет: ' + v.sinkId);
      } catch (e) {}
      L('Звук', au);
      const sub = [];
      try {
        const tt = v.textTracks;
        if (tt && tt.length) {
          sub.push('Дорожек субтитров: ' + tt.length);
          for (let i = 0; i < tt.length; i++) {
            const t = tt[i];
            sub.push('Субтитры ' + (i + 1) + ': ' + (t.label || t.language || 'без названия'));
            if (t.language && t.label) sub.push('Язык: ' + t.language);
            let modeStr = t.mode;
            try { modeStr = t.mode === 'showing' ? 'Показаны на экране' : t.mode === 'hidden' ? 'Скрыты' : 'Выключены'; } catch (e) {}
            sub.push('Статус: ' + modeStr);
            try { if (t.cues) sub.push('Фраз всего: ' + t.cues.length); } catch (e) {}
            try { if (t.activeCues && t.activeCues.length) sub.push('Сейчас видно фраз: ' + t.activeCues.length); } catch (e) {}
          }
        } else {
          sub.push('Субтитров нет');
        }
      } catch (e) {}
      L('Субтитры', sub);
      const vd = [];
      try {
        const vt = v.videoTracks;
        if (vt && vt.length) {
          vd.push('Видеодорожек: ' + vt.length);
          for (let i = 0; i < vt.length; i++) {
            const t = vt[i];
            vd.push('Видео ' + (i + 1) + ': ' + (t.label || 'без названия'));
            vd.push(t.selected ? 'Статус: выбрана' : 'Статус: запасная');
          }
        } else {
          vd.push('Дорожка одна — та, что в видео');
        }
      } catch (e) {}
      L('Видеодорожки', vd);
      L('Картинка', [
        'Кадр ' + (v.videoWidth || 0) + ' на ' + (v.videoHeight || 0) + ' точек',
        'Окно плеера ' + (v.clientWidth || 0) + ' на ' + (v.clientHeight || 0),
      ]);
      try {
        const qq = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
        if (qq) {
          L('Кадры', [
            'Показано ' + qq.totalVideoFrames,
            'Пропущено ' + qq.droppedVideoFrames,
            'Битых ' + (qq.corruptedVideoFrames || 0),
            qq.droppedVideoFrames > 0 ? 'Есть пропуски — слабый декодер или сеть' : 'Всё гладко, без пропусков',
          ]);
        }
      } catch (e) {}
      let bufAhead = 0;
      try {
        const b = v.buffered, t = v.currentTime || 0;
        for (let i = 0; i < b.length; i++) {
          if (b.start(i) <= t && t <= b.end(i)) { bufAhead = Math.round((b.end(i) - t) * 10) / 10; break; }
        }
      } catch (e) {}
      const NS = ['пусто', 'простой', 'грузит', 'нет источника'];
      const RS = ['нет данных', 'метаданные получены', 'текущий кадр есть', 'можно играть', 'запас большой'];
      L('Буфер и сеть', [
        'Впереди подгружено ' + bufAhead + ' с',
        'Всего в кэше ' + trSum(v.buffered).total + ' с',
        'Кусков в кэше: ' + trSum(v.buffered).n,
        'Сеть сейчас: ' + (NS[v.networkState] || v.networkState),
        'Готовность: ' + (RS[v.readyState] || v.readyState),
      ]);
      const so = [];
      try {
        const raw = v.currentSrc || v.src || '';
        if (raw) {
          so.push('Адрес: ' + shortSrc(raw));
          if (raw.startsWith('blob:')) so.push('Тип: поток, который собрал плеер сайта');
          else if (!isFinite(v.duration)) so.push('Тип: прямой эфир');
          else so.push('Тип: обычный видеофайл');
        } else {
          so.push('Адрес пока пуст — поток не подключён');
        }
      } catch (e) {}
      try {
        const co = v.getAttribute ? v.getAttribute('crossorigin') : null;
        so.push(co === null ? 'Чужому сайту не отдаётся' : 'Доступ чужому сайту: ' + (co || 'разрешён'));
      } catch (e) {}
      L('Источник', so);
      // Вес: сначала точная разбивка по качествам (повтор запроса плеера),
      // иначе — прямой файл целиком или куски HLS + что уже подгружено.
      const qs = videoQSize.get(v) || null;
      const qsw = qs ? Object.keys(qs).map((k) => k + ' — ' + fmtBytes(qs[k])).filter(Boolean) : [];
      if (qsw.length) {
        L('Вес', qsw);
      } else {
        const sm = videoStreamMeta.get(v) || null;
        let wShown = false;
        if (sm && sm.len) {
          L('Вес', ['Весит ' + fmtBytes(sm.len)]); wShown = true;
        } else if (sm && sm.segs) {
          const lb = loadedTsBytes();
          const wl = ['Поток идёт кусками (HLS)', 'Кусков в списке: ' + sm.segs];
          if (lb.n > 0) wl.push('Подгружено кусков: ' + lb.n);
          if (lb.total > 0) wl.push('Подгружено объёмом ' + fmtBytes(lb.total));
          try {
            const qe0 = videoQErr.get(v) || '';
            if (qe0) wl.push('Разбивки нет: ' + qe0);
          } catch (e) {}
          L('Вес', wl); wShown = true;
        }
        if (!wShown) {
          const qe = videoQErr.get(v) || '';
          if (qe) L('Вес', ['Не получилось: ' + qe]);
        }
      }
      // По факту — всегда: реальный кадр + сходимость с выбранным качеством.
      const pf = [];
      try {
        const w = v.videoWidth || 0, h = v.videoHeight || 0;
        pf.push(w > 0 && h > 0 ? 'Идёт ' + w + ' на ' + h + ' точек' : 'Кадр пока неизвестен — поток не начался');
      } catch (e) {}
      try {
        const info = currentLabel(v);
        const txt = info.text || '';
        let exp = 0;
        try {
          const m = String(txt).match(/(\d{3,4})/);
          if (m) exp = parseInt(m[1], 10);
        } catch (e) {}
        const vh = v.videoHeight || 0;
        const dur = v.duration || 0;
        if (/ultra/i.test(txt) && dur > 0 && dur < 600) {
          pf.push('Похоже на тизер — вместо фильма заглушка, для Ultra нужен премиум');
        } else if (exp > 0 && vh > 0 && vh < exp * 0.9) {
          pf.push('Ниже выбранного: выбрано ' + txt);
        } else if (exp > 0 && txt) {
          pf.push('Сходится с выбранным (' + txt + ')');
        }
      } catch (e) {}
      L('По факту', pf);
      // Дата заливки: точное совпадение (id+сезон+серия+озвучка), иначе
      // «залито целиком», иначе «неизвестно». Перезаливы — отдельными строками.
      try {
        const al = updatesLinesSync();
        if (al && al.length) L('Добавлено', al);
      } catch (e) {}
      const misc = [];
      try { misc.push(v.autoplay ? 'Автозапуск включён' : 'Само не запускается'); } catch (e) {}
      try { misc.push(v.loop ? 'Повтор по кругу включён' : 'Повтор выключен'); } catch (e) {}
      try { misc.push(v.controls ? 'Кнопки браузера показаны' : 'Кнопок браузера нет'); } catch (e) {}
      try { misc.push(v.disableRemotePlayback ? 'Трансляция на телевизор запрещена' : 'Можно отправить на телевизор'); } catch (e) {}
      try {
        if (v.mediaKeys) misc.push('Стоит защита от копирования');
        else misc.push('Защиты от копирования нет');
      } catch (e) {}
      try {
        if (v.error && v.error.code) misc.push('Ошибка видео! Код ' + v.error.code);
      } catch (e) {}
      L('Прочее', misc);
    } catch (e) {}
    return rows;
  }
  function toggleVideoInfo(video) {
    const old = infoOverlays.get(video);
    if (old) { try { old.remove(); } catch (e) {} infoOverlays.delete(video); return; }
    const host = document.createElement('div');
    host.setAttribute('data-vm-info', '1');
    const sh = host.attachShadow({ mode: 'open' });
    const css = document.createElement('style');
    css.textContent = `
      .box{position:relative;min-width:220px;max-width:280px;padding:10px 12px;border-radius:14px;
        font-family:Inter,-apple-system,'SF Pro Text','Segoe UI',Roboto,sans-serif;font-size:11.5px;line-height:1.5;color:#fff;
        background:rgba(0,0,0,.62);border:1px solid rgba(255,255,255,.16);
        -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:0 8px 28px rgba(0,0,0,.45)}
      .box h5{margin:0 24px 6px 0;font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.7}
      .x{position:absolute;top:4px;right:6px;width:22px;height:22px;border:none;background:none;color:#fff;opacity:.7;font-size:14px;cursor:pointer}
      .x:hover{opacity:1}
      .box table{width:100%;border-collapse:collapse}
      .box td{padding:2px 0;vertical-align:top}
      .box td.k{opacity:.6;width:38%;padding-right:8px}
      .box td.v{word-break:break-word;white-space:pre-line}
      .box::-webkit-scrollbar{width:6px}
      .box::-webkit-scrollbar-thumb{background:rgba(255,255,255,.25);border-radius:3px}`;
    sh.appendChild(css);
    const box = document.createElement('div');
    box.className = 'box';
    const x = document.createElement('button');
    x.className = 'x'; x.textContent = '×'; x.title = 'Закрыть';
    x.addEventListener('click', (ev) => { ev.stopPropagation(); toggleVideoInfo(video); });
    box.appendChild(x);
    const h = document.createElement('h5');
    h.textContent = 'Инфо';
    box.appendChild(h);
    const t = document.createElement('table');
    box.appendChild(t);
    sh.appendChild(box);
    try {
      const rec = badges.get(video);
      const parent = (rec && rec.host && rec.host.parentElement) || video.parentElement || document.documentElement;
      if (parent !== document.documentElement) {
        try { if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'; } catch (e) {}
        host.style.cssText = 'position:absolute;left:10px;top:10px;z-index:2147483647;';
      } else {
        host.style.cssText = 'position:fixed;left:10px;top:10px;z-index:2147483647;';
      }
      parent.appendChild(host);
    } catch (e) {
      try { document.documentElement.appendChild(host); } catch (x2) {}
    }
    infoOverlays.set(video, host);
    renderVideoInfo(video);
  }
  function renderVideoInfo(video) {
    const host = infoOverlays.get(video);
    if (!host || !host.isConnected) return;
    try {
      const t = host.shadowRoot && host.shadowRoot.querySelector('table');
      if (!t) return;
      t.innerHTML = '';
      for (const [k, val] of mediaRowsPlain(video)) {
        const tr = document.createElement('tr');
        const a = document.createElement('td'); a.className = 'k'; a.textContent = k;
        const b = document.createElement('td'); b.className = 'v'; b.textContent = String(val);
        tr.appendChild(a); tr.appendChild(b); t.appendChild(tr);
      }
      // Скролл плашки — только когда видео НЕ во весь экран (в фуллскрине места хватает).
      // Лимит — по высоте родительского блока плеера, а не вьюпорта: иначе в маленьком
      // плеере плашка вылезает за его края и режется (у родителя overflow:hidden).
      try {
        const box = host.shadowRoot && host.shadowRoot.querySelector('.box');
        if (box) {
          if (document.fullscreenElement) { box.style.maxHeight = ''; box.style.overflowY = ''; }
          else {
            let cap = '';
            try {
              const pe = host.parentElement;
              if (pe && pe.clientHeight > 140) cap = Math.max(120, pe.clientHeight - 20) + 'px';
            } catch (e) {}
            if (!cap) cap = '70vh';
            box.style.maxHeight = cap; box.style.overflowY = 'auto';
          }
        }
      } catch (e) {}
    } catch (e) {}
  }
  function refreshVideoInfos() {
    try {
      for (const [v] of infoOverlays) {
        if (!v.isConnected) {
          try { const h = infoOverlays.get(v); if (h) h.remove(); } catch (e) {}
          infoOverlays.delete(v);
          continue;
        }
        renderVideoInfo(v);
      }
    } catch (e) {}
  }

  const MODE_NAMES = { smart: 'Умный режим', max: 'Максимум', manual: 'Ручной потолок', unknown: 'Определение…' };
  function updateBadge(rec) {
    try {
      const info = currentLabel(rec.video);
      const t = rec.sh.querySelector('.t');
      const dot = rec.sh.querySelector('.dot');
      // Скорость и качество — всегда: текущая (живая) скорость видео + уровень.
      let live = 1;
      try { live = rec.video.playbackRate || 1; } catch (e) {}
      const txt = info.text;
      const rate = fmtRate(live);
      const it = (live - 1 > 1e-9) ? ' style="font-style:italic"' : '';
      if (t) t.innerHTML = escapeHtml(txt) + ' · <span' + it + '>' + escapeHtml(rate) + '</span>';
      if (dot) {
        const c = DOT[info.state] || DOT.unknown;
        dot.style.background = c; dot.style.color = c;
      }
      const b = rec.sh.querySelector('.b');
      if (b) b.title = 'Video Manager · ' + (MODE_NAMES[info.state] || info.state) + ' · ' + info.text;
      const show = badgeAllowed() && isActive();
      rec.host.style.display = show ? '' : 'none';
    } catch (e) {}
  }
  function refreshAllBadges() {
    for (const rec of badges.values()) {
      updateBadge(rec);
      if (rec.open) renderPanel(rec);
    }
    refreshVideoInfos();
  }

  function renderPanel(rec) {
    const p = rec.panel;
    const info = currentLabel(rec.video);
    const spd = desiredSpeed();
    const step = speedStep();
    const spdTxt = (Math.round(spd * 100) / 100) + '×';
    const caps = [[360, '360p'], [480, '480p'], [720, '720p'], [1080, '1080p'], [1081, '1080U'], [1440, '2K'], [2160, '4K']];
    const SPD_PRESETS = [0.5, 1, 1.5, 2, 3];
    p.innerHTML = `
      <div class="pt">Video Manager · ${escapeHtml(info.text)}</div>
      <div class="row">
        <button class="mbtn${S.mode === 'smart' ? ' on' : ''}" data-mode="smart">Умный</button>
        <button class="mbtn${S.mode === 'max' ? ' on' : ''}" data-mode="max">Макс</button>
        <button class="mbtn${S.mode === 'manual' ? ' on' : ''}" data-mode="manual">Ручной</button>
      </div>
      <div class="pt">Потолок</div>
      <div class="caps">${caps.map(([v, l]) => `<button class="c${S.cap === v ? ' on' : ''}" data-cap="${v}">${l}</button>`).join('')}</div>
      <div class="pt">Скорость · ${escapeHtml(spdTxt)}</div>
      <div class="caps">${SPD_PRESETS.map((v) => `<button class="c${Math.abs(spd - v) < 1e-9 ? ' on' : ''}" data-spd="preset:${v}">${v}×</button>`).join('')}</div>
      <div class="frow3">
        <button class="fbtn" data-act="info">Инфо</button>
        <button class="fbtn" data-act="settings">Настройки</button>
        <button class="fbtn" data-act="pos">Сбросить позицию</button>
      </div>
      <button class="fbtn fwide" data-act="subs">Скачать субтитры</button>
      <button class="fbtn fwide" data-act="customsubs">Свои субтитры (.srt)</button>
      <input type="file" accept=".srt" style="display:none">
      <div class="customsub" style="display:none"></div>
      <div class="subs" style="display:none"></div>
      <div class="substatus subnote" style="display:none"></div>`;
    p.querySelectorAll('[data-mode]').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await chrome.storage.local.set({ mode: btn.dataset.mode });
    }));
    p.querySelectorAll('[data-cap]').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await chrome.storage.local.set({ cap: parseInt(btn.dataset.cap, 10) });
    }));
    p.querySelectorAll('[data-spd]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = btn.dataset.spd;
      if (a && a.startsWith('preset:')) setSpeed(parseFloat(a.slice(7)));
    }));
    const posBtn = p.querySelector('[data-act="pos"]');
    if (posBtn) posBtn.addEventListener('click', (e) => { e.stopPropagation(); resetBadgePos(rec.host); });
    const st = p.querySelector('[data-act="settings"]');
    if (st) st.addEventListener('click', (e) => {
      e.stopPropagation();
      try { chrome.runtime.sendMessage({ type: 'vm-open-options' }); } catch (x) {}
      try { window.open(chrome.runtime.getURL('options.html'), '_blank'); } catch (x) {}
    });
    const infoBtn = p.querySelector('[data-act="info"]');
    if (infoBtn) infoBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleVideoInfo(rec.video); });
    const subsBtn = p.querySelector('[data-act="subs"]');
    if (subsBtn) subsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      rec._subsOpen = !rec._subsOpen;
      const box = p.querySelector('.subs');
      const stEl = p.querySelector('.substatus');
      if (box) box.style.display = rec._subsOpen ? 'flex' : 'none';
      if (stEl) stEl.style.display = 'none';
      if (rec._subsOpen) { try { rec._subsCache = null; } catch (e) {} renderSubsList(rec, true); }
    });
    if (rec._subsOpen) {
      const box = p.querySelector('.subs');
      if (box) { box.style.display = 'flex'; renderSubsList(rec); }
    }
    try { paintCustomSub(rec); } catch (e) {}
    const csBtn = p.querySelector('[data-act="customsubs"]');
    const csFile = p.querySelector('input[type="file"]');
    if (csBtn && csFile) csBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try { csFile.click(); } catch (x) {}
    });
    if (csFile) csFile.addEventListener('change', (e) => {
      e.stopPropagation();
      const f = csFile.files && csFile.files[0];
      if (f) loadCustomSrt(rec, f);
      try { csFile.value = ''; } catch (x) {}
    });
  }

  function forceDomRank(video, rank) {
    try {
      const root = containerOf(video);
      const items = findQualityItems(root).concat(root !== document ? findQualityItems(document) : []);
      const cand = items.find((u) => Math.abs(u.q.rank - rank) < 1e-9);
      if (cand) {
        try {
          mouseClick(cand.el);
          const ctl = domCtl.get(video);
          if (ctl) { ctl.lastClick = Date.now(); ctl.curRank = rank; }
          logDom('DOM force click -> ' + describeEl(cand.el));
        } catch (e) {}
      }
    } catch (e) {}
  }

  // ---------- субтитры: сбор источников + скачивание
  // Главный источник — сеть: background ловит webRequest'ом точные URL .vtt/.srt,
  // которые плеер уже успешно подгрузил, качаем их через chrome.downloads
  // (CORS не мешает, куки подставляются сами). Полный список дорожек читаем
  // из меню «Субтитры» плеера ([fid]-строка + пункты [f2id]): плеер регистрирует
  // в video/textTracks обычно только включённую дорожку. Имена файлов при
  // скачивании — человеческие («Русские-ru.vtt»), хеш CDN — запасной вариант.
  // Встроенные дорожки без файла (HLS/вшитые) сохраняем генерацией SRT из cues.
  function fmtSubTime(sec, forSrt) {
    try {
      sec = Math.max(0, Number(sec) || 0);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60), ms = Math.floor((sec % 1) * 1000);
      const p = (n, l) => String(n).padStart(l, '0');
      return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + (forSrt ? ',' : '.') + p(ms, 3);
    } catch (e) { return forSrt ? '00:00:00,000' : '00:00:00.000'; }
  }
  function cuesToSrt(track) {
    try {
      const cues = (track && track.cues) ? Array.from(track.cues) : [];
      if (!cues.length) return '';
      let n = 0, out = '';
      for (const c of cues) {
        let txt = '';
        try { txt = c.text || ''; } catch (e) {}
        if (!txt) {
          try {
            const d = document.createElement('div');
            d.appendChild(c.getCueAsHTML());
            txt = d.textContent || d.innerText || '';
          } catch (e) {}
        }
        txt = String(txt).replace(/\r\n?/g, '\n').trim();
        if (!txt) continue;
        n++;
        out += n + '\n' + fmtSubTime(c.startTime, true) + ' --> ' + fmtSubTime(c.endTime, true) + '\n' + txt + '\n\n';
      }
      return out;
    } catch (e) { return ''; }
  }
  function subFileName(label, ext, i) {
    try {
      let base = String(label || ('subs' + ((i || 0) + 1))).trim()
        .replace(/\s+/g, '-').replace(/[\\/:*?"<>|]/g, '').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_\-.]+/g, '').slice(0, 60);
      if (!base) base = 'subs' + ((i || 0) + 1);
      return base + '.' + (ext || 'srt');
    } catch (e) { return 'subs.srt'; }
  }
  function normSubLabel(s) {
    try { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
    catch (e) { return ''; }
  }
  // Человеческое название дорожки («Русские»): имена файлов и заглушки отсеиваем
  function humanSubLabel(item) {
    try {
      const cands = [item && item.label, item && item.lang];
      for (const c of cands) {
        const s = String(c || '').trim();
        if (!s) continue;
        if (/\.(vtt|srt|ttml|ass|ssa|smi|sbv)$/i.test(s)) continue; // dvrqv4s09o.vtt — имя файла, не название
        if (/^(файл|субтитры|subtitle?s|subs?|track|дорожка)\s*\d*$/i.test(s)) continue; // заглушки
        if (/^[a-z0-9]{8,}(\.\w+)?$/i.test(s)) continue; // хеш CDN
        return s;
      }
    } catch (e) {}
    return '';
  }
  // Имя файла для сохранения: «Русские-ru.vtt» вместо хеша CDN
  function niceSubName(item, ext) {
    try {
      const h = humanSubLabel(item);
      if (!h) return '';
      let base = h;
      const lang = String((item && item.lang) || '').trim();
      if (lang && normSubLabel(lang) !== normSubLabel(h) && !/\.(vtt|srt|ttml|ass|ssa|smi|sbv)$/i.test(lang)) base += ' (' + lang + ')';
      return subFileName(base, ext, (item && item._idx) || 0);
    } catch (e) { return ''; }
  }
  function saveBlobAs(blob, name) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      try { a.style.display = 'none'; document.documentElement.appendChild(a); } catch (e) {}
      try { a.click(); } catch (e) { try { mouseClick(a); } catch (x) {} }
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e) {} }, 4000);
    } catch (e) {}
  }
  // ---------- свои субтитры: .srt с компьютера поверх видео (пока только .srt, rezka/зеркала)
  // Файл никуда не уходит: читаем локально, конвертим srt→vtt, вешаем свой <track>
  // на тот же <video> и включаем textTrack в showing. Живёт до перезагрузки страницы.
  function sayCustom(rec, msg) {
    try {
      const st = rec.panel && rec.panel.querySelector('.substatus');
      if (!st) return;
      st.textContent = msg;
      st.style.display = 'block';
    } catch (e) {}
  }
  function decodeSrtBuffer(buf) {
    try {
      const u8 = new Uint8Array(buf);
      let s = '';
      try { s = new TextDecoder('utf-8', { fatal: true }).decode(u8); return s; }
      catch (e) { /* не utf-8 — пробуем windows-1251 (частый кейс русских .srt) */ }
      try { s = new TextDecoder('windows-1251').decode(u8); return s; }
      catch (e) {}
      try { s = new TextDecoder('utf-8').decode(u8); return s; } catch (e) {}
      return '';
    } catch (e) { return ''; }
  }
  function srtToVtt(text) {
    try {
      let t = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      if (!/-->/.test(t)) return '';
      // запятые в таймкодах → точки; чиним «00:00:00,000 --> 00:00:02,000»
      t = t.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      t = t.replace(/\n{3,}/g, '\n\n').trim();
      if (!t) return '';
      return 'WEBVTT\n\n' + t + '\n';
    } catch (e) { return ''; }
  }
  // ---------- свои субтитры: свой оверлей поверх видео (не <track>) ----------
  // Нативный ::cue не умеет отступ снизу и сдвиг по времени, поэтому рисуем сами:
  // парсим .srt в cues [{start,end,text}], тикаем по video.currentTime + сдвиг,
  // показываем в div поверх видео (белый текст на чёрном, настройки из storage).
  function srtTimeToSec(s) {
    try {
      const m = String(s || '').trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/);
      if (!m) return null;
      const h = parseInt(m[1] || '0', 10), mi = parseInt(m[2], 10), se = parseInt(m[3], 10);
      const ms = parseInt((m[4] + '000').slice(0, 3), 10);
      return h * 3600 + mi * 60 + se + ms / 1000;
    } catch (e) { return null; }
  }
  function parseSrtCues(raw) {
    try {
      const text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      if (!/-->/.test(text)) return [];
      const blocks = text.split(/\n\s*\n/);
      const out = [];
      for (const b of blocks) {
        const lines = b.split('\n').map((x) => x.trim()).filter((x) => x);
        if (!lines.length) continue;
        let ti = lines.findIndex((x) => /-->/.test(x));
        if (ti < 0) continue;
        const parts = lines[ti].split('-->');
        const st = srtTimeToSec(parts[0]), en = srtTimeToSec(parts[1]);
        if (st === null || en === null || en <= st) continue;
        const txt = lines.slice(ti + 1).join('\n').replace(/<[^>]*>/g, '').trim();
        if (!txt) continue;
        out.push({ start: st, end: en, text: txt });
      }
      out.sort((a, b) => a.start - b.start);
      return out;
    } catch (e) { return []; }
  }
  function subTextToHtml(s) {
    return escapeHtml(s).replace(/\n/g, '<br>');
  }
  function subWrapOf(rec) {
    try {
      const v = rec.video;
      if (!v || !v.isConnected) return null;
      // тот же контейнер, что у бейджа: обычно он и уходит в fullscreen
      let wrap = null;
      try { wrap = v.closest('[class*="player" i],[id*="player" i]') || v.parentElement; } catch (e) {}
      if (!wrap || wrap === document.body || wrap === document.documentElement) wrap = v.parentElement || document.body;
      return wrap;
    } catch (e) { return null; }
  }
  function ensureSubOverlay(rec) {
    try {
      let ov = rec._subOverlay;
      if (ov && ov.isConnected) return ov;
      const wrap = subWrapOf(rec);
      if (!wrap) return null;
      try {
        if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
      } catch (e) {}
      ov = document.createElement('div');
      ov.setAttribute('data-vm-subs', 'custom');
      ov.style.cssText = 'position:absolute;left:0;right:0;text-align:center;pointer-events:none;z-index:2147483646;display:none;';
      const inner = document.createElement('span');
      ov.appendChild(inner);
      wrap.appendChild(ov);
      rec._subOverlay = ov;
      rec._subOverlayInner = inner;
      rec._subStyleKey = null;
      applySubOverlayStyle(rec);
      return ov;
    } catch (e) { return null; }
  }
  function applySubOverlayStyle(rec) {
    try {
      const ov = rec._subOverlay, inner = rec._subOverlayInner;
      if (!ov || !inner || !ov.isConnected) return;
      const size = clampNum(S.subSize, 0, 250, 35);
      const op = clampNum(S.subBgOpacity, 0, 1, 0.7);
      const bottom = clampNum(S.subBottomMargin, 0, 200, 32);
      let base = 20;
      try {
        const h = (rec.video && rec.video.clientHeight) || 0;
        if (h > 0) base = Math.max(14, h * 0.055);
      } catch (e) {}
      // пол: пропорционально плееру, но не мельче 12px — иначе в маленьком окне
      // мелкий процент (35%) даёт нечитаемые ~8px; фулскрин это не затрагивает
      let fs = Math.round(base * size / 100);
      if (size > 0) fs = Math.max(12, fs);
      const cacheKey = size + '|' + op + '|' + bottom + '|' + fs;
      if (rec._subStyleKey === cacheKey) return;
      rec._subStyleKey = cacheKey;
      ov.style.bottom = bottom + 'px';
      inner.style.cssText = 'display:inline-block;max-width:88%;padding:.25em .6em;border-radius:.35em;'
        + 'color:#fff;background:rgba(0,0,0,' + op + ');'
        + 'font-size:' + fs + 'px;line-height:1.35;font-weight:500;white-space:pre-line;';
    } catch (e) {}
  }
  function refreshSubOverlays() {
    try {
      for (const rec of badges.values()) {
        try {
          if (rec._customSub && rec._customSub.cues) {
            ensureSubOverlay(rec);
            applySubOverlayStyle(rec);
            tickCustomSub(rec);
          }
        } catch (e) {}
      }
    } catch (e) {}
  }
  function tickCustomSub(rec) {
    try {
      const cs = rec._customSub;
      const ov = rec._subOverlay, inner = rec._subOverlayInner;
      if (!cs || !cs.cues || !ov || !inner || !ov.isConnected) return;
      const v = rec.video;
      if (!v || !v.isConnected) { ov.style.display = 'none'; return; }
      if (cs.hidden) { ov.style.display = 'none'; return; }
      if (clampNum(S.subSize, 0, 250, 35) <= 0) { ov.style.display = 'none'; return; }
      let ct = 0;
      try { ct = v.currentTime || 0; } catch (e) {}
      const shift = clampNum(S.subShift, -10, 10, 0);
      const act = [];
      for (const c of cs.cues) {
        if (ct >= c.start + shift && ct <= c.end + shift) act.push(c.text);
        else if (c.start + shift > ct && act.length) break;
        if (act.length >= 2) break;
      }
      if (!act.length) { ov.style.display = 'none'; return; }
      applySubOverlayStyle(rec);
      inner.innerHTML = act.map(subTextToHtml).join('<br>');
      ov.style.display = 'block';
    } catch (e) {}
  }
  function tickCustomSubsAll() {
    try {
      for (const rec of badges.values()) {
        try { if (rec._customSub && rec._customSub.cues) tickCustomSub(rec); } catch (e) {}
      }
    } catch (e) {}
  }
  function setCustomTrackMode(rec, mode) {
    try {
      const cs = rec._customSub;
      if (!cs) return false;
      cs.hidden = (mode !== 'showing');
      try { tickCustomSub(rec); } catch (e) {}
      return true;
    } catch (e) { return false; }
  }
  function clearCustomSub(rec, silent) {
    try {
      const cs = rec._customSub;
      if (!cs && !rec._subOverlay) return;
      try { if (rec._subOverlay) rec._subOverlay.remove(); } catch (e) {}
      rec._subOverlay = null;
      rec._subOverlayInner = null;
      rec._customSub = null;
      try { paintCustomSub(rec); } catch (e) {}
      if (!silent) sayCustom(rec, 'Свои субтитры убраны');
    } catch (e) {}
  }
  function paintCustomSub(rec) {
    try {
      const box = rec.panel && rec.panel.querySelector('.customsub');
      if (!box) return;
      const cs = rec._customSub;
      if (!cs) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.style.display = 'block';
      box.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'subnote';
      head.textContent = '✓ ' + cs.name + ' · фраз: ' + cs.cues.length + (cs.hidden ? ' (скрыты)' : ' (показываю)');
      box.appendChild(head);
      const row = document.createElement('div');
      row.className = 'subrow';
      const tgl = document.createElement('button');
      tgl.className = 'subbtn';
      tgl.textContent = cs.hidden ? 'Показать' : 'Скрыть';
      tgl.addEventListener('click', (e) => {
        e.stopPropagation();
        setCustomTrackMode(rec, cs.hidden ? 'showing' : 'disabled');
        try { paintCustomSub(rec); } catch (x) {}
      });
      const del = document.createElement('button');
      del.className = 'subbtn';
      del.textContent = 'Убрать';
      del.addEventListener('click', (e) => { e.stopPropagation(); clearCustomSub(rec); });
      row.appendChild(tgl);
      row.appendChild(del);
      box.appendChild(row);
    } catch (e) {}
  }
  async function loadCustomSrt(rec, file) {
    try {
      const fname = (file && file.name) || 'свои.srt';
      if (!/\.srt$/i.test(fname)) { sayCustom(rec, 'Пока беру только .srt — выберите файл с расширением .srt'); return; }
      let buf = null;
      try { buf = await file.arrayBuffer(); } catch (e) { sayCustom(rec, 'Не прочитался файл'); return; }
      const raw = decodeSrtBuffer(buf);
      if (!raw || !/-->/.test(raw)) { sayCustom(rec, 'Это не похоже на .srt (нет строк со временем)'); return; }
      const cues = parseSrtCues(raw);
      if (!cues.length) { sayCustom(rec, 'Не смог понять .srt'); return; }
      const video = rec.video;
      if (!video || !video.isConnected) { sayCustom(rec, 'Видео уже нет на странице — откройте панель заново'); return; }
      // старые свои субтитры (и остатки <track> от прошлой версии) сносим
      try { clearCustomSub(rec, true); } catch (e) {}
      try {
        if (video.querySelectorAll) {
          for (const t of video.querySelectorAll('track')) {
            try { if (t.src && String(t.src).startsWith('blob:')) t.remove(); } catch (e) {}
          }
        }
      } catch (e) {}
      let short = String(fname).replace(/\.srt$/i, '').slice(0, 40) || 'Свои';
      rec._customSub = { name: short, cues, hidden: false };
      try { ensureSubOverlay(rec); } catch (e) {}
      try { applySubOverlayStyle(rec); } catch (e) {}
      try { tickCustomSub(rec); } catch (e) {}
      try { paintCustomSub(rec); } catch (e) {}
      sayCustom(rec, '«' + short + '» поверх видео (' + cues.length + ' фраз). Вид — в настройках расширения.');
    } catch (e) { try { sayCustom(rec, 'Не получилось подключить'); } catch (x) {} }
  }
  function collectSubtitles(video) {
    const out = [];
    const seenSrc = new Set();
    // 1) <track> элементы: прямой src файла (обычно то же, что в меню субтитров плеера)
    try {
      const els = [];
      try { if (video.querySelectorAll) for (const t of video.querySelectorAll('track')) els.push(t); } catch (e) {}
      try { for (const t of deepQueryAll('track')) { if (!els.includes(t)) els.push(t); } } catch (e) {}
      for (const el of els) {
        let src = '';
        try { src = el.src || (el.getAttribute && el.getAttribute('src')) || ''; } catch (e) {}
        if (!src) continue;
        try { src = new URL(src, location.href).href; } catch (e) {}
        if (seenSrc.has(src)) continue;
        seenSrc.add(src);
        let label = '', lang = '', kind = '';
        try {
          label = (el.getAttribute && el.getAttribute('label')) || el.label || '';
          lang = (el.getAttribute && el.getAttribute('srclang')) || el.srclang || '';
          kind = ((el.getAttribute && el.getAttribute('kind')) || el.kind || '').toLowerCase();
        } catch (e) {}
        if (kind && kind !== 'subtitles' && kind !== 'captions' && kind !== 'metadata') continue;
        out.push({ label: label || lang || ('Субтитры ' + (out.length + 1)), lang, src, kind, trackIndex: -1, cues: null, mode: '' });
      }
    } catch (e) {}
    // 2) video.textTracks: привязываем src по языку/названию, остальное — встроенные (скачаем через cues → .srt)
    try {
      const tt = video.textTracks;
      if (tt) {
        for (let i = 0; i < tt.length; i++) {
          const t = tt[i];
          let label = '', lang = '', mode = '', cues = null;
          try { label = t.label || ''; lang = t.language || ''; mode = t.mode || ''; } catch (e) {}
          try { cues = (t.cues && t.cues.length !== undefined) ? t.cues.length : null; } catch (e) {}
          let matched = null;
          for (const o of out) {
            if (o.trackIndex !== -1) continue;
            const sameLang = o.lang && lang && o.lang.toLowerCase() === String(lang).toLowerCase();
            const sameLabel = o.label && label && o.label === label;
            if (sameLang || sameLabel) { matched = o; break; }
          }
          if (matched) {
            matched.trackIndex = i; matched.cues = cues; matched.mode = mode;
            if (!matched.label) matched.label = label || lang;
            continue;
          }
          if (out.some((o) => o.trackIndex === i)) continue;
          out.push({ label: label || lang || ('Субтитры ' + (out.length + 1)), lang, src: '', kind: '', trackIndex: i, cues, mode });
        }
      }
    } catch (e) {}
    // 3) ресурсы .vtt/.srt/.ttml, которые плеер уже подгрузил мимо <track>
    try {
      const entries = (performance.getEntriesByType) ? performance.getEntriesByType('resource') : [];
      for (const en of entries) {
        const u = (en && en.name) || '';
        if (!/\.(vtt|srt|ttml)(\?|#|$)/i.test(u)) continue;
        if (seenSrc.has(u)) continue;
        seenSrc.add(u);
        let fn = '';
        try { fn = decodeURIComponent(u.split('/').pop().split('?')[0].split('#')[0]); } catch (e) {}
        out.push({ label: fn || ('Файл ' + (out.length + 1)), lang: '', src: u, kind: 'file', trackIndex: -1, cues: null, mode: '' });
      }
    } catch (e) {}
    // 4) прямые ссылки <a href="*.vtt|*.srt"> на странице
    try {
      for (const a of deepQueryAll('a[href]')) {
        let href = '';
        try { href = a.href || (a.getAttribute && a.getAttribute('href')) || ''; } catch (e) {}
        if (!/\.(vtt|srt)(\?|#|$)/i.test(href)) continue;
        let abs = href;
        try { abs = new URL(href, location.href).href; } catch (e) {}
        if (seenSrc.has(abs)) continue;
        seenSrc.add(abs);
        const txt = ((a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)) || abs.split('/').pop();
        out.push({ label: txt, lang: '', src: abs, kind: 'link', trackIndex: -1, cues: null, mode: '' });
      }
    } catch (e) {}
    // 5) URL субтитров, зашитые в скрипты/разметку: CDN-плеер (rezka и зеркала)
    // держит ссылки на .vtt в JS-конфиге, а не в <track> — вытягиваем их из HTML
    try {
      const html = document.documentElement ? document.documentElement.innerHTML : '';
      if (html && html.length < 8000000) {
        const re = /https?:\/\/[^\s"'<>\\\]]+?\.(vtt|srt|ttml)(\?[^\s"'<>\\\]]*)?/gi;
        let mm = null, guard = 0;
        while ((mm = re.exec(html)) && guard++ < 50) {
          const u = mm[0];
          if (seenSrc.has(u)) continue;
          seenSrc.add(u);
          let fn = '';
          try { fn = decodeURIComponent(u.split('/').pop().split('?')[0]); } catch (e) {}
          out.push({ label: fn || ('Файл ' + (out.length + 1)), lang: '', src: u, kind: 'page', trackIndex: -1, cues: null, mode: '' });
        }
      }
    } catch (e) {}
    // 6) меню «Субтитры» CDN-плеера: ПОЛНЫЙ список дорожек с человеческими названиями.
    // Плеер регистрирует в video/textTracks обычно только включённую дорожку,
    // а пункты его меню лежат в DOM всегда (как пункты качества [f2id]) —
    // читаем их, чтобы показать все дорожки, а не только загруженную.
    try {
      // 6а) строка «Субтитры …» ([fid]) — какая дорожка выбрана сейчас
      try {
        for (const el of deepQueryAll('[fid]')) {
          const t = (((el.innerText || el.textContent) || '').trim().replace(/\s+/g, ' '));
          if (!/субтитр/i.test(t)) continue;
          const m = t.replace(/субтитры?/i, '').replace(/^[\s:—–-]+/, '').trim();
          if (m && !/^(выкл|off|нет)/i.test(m)) { out._menuActive = m; break; }
        }
      } catch (e) {}
      // 6б) пункты-кандидаты: со словами, но не качество и не скорость
      try {
        const seenMenu = new Set();
        for (const el of deepQueryAll('[f2id],[role="menuitem"],[role="option"]')) {
          try { if (el.getAttribute && el.getAttribute('f2id') === '0') continue; } catch (e) {} // заголовок «Субтитры»
          // Скрытые пункты тоже берём (меню обычно закрыто) — но только из подменю
          // «Субтитры»: проверяем заголовок f2id=0 в том же контейнере. Без заголовка
          // (generic-плееры) — берём с обычными фильтрами.
          let ownSub = 0;
          try {
            const par = el.parentElement;
            if (par && par.querySelectorAll) {
              const hs = par.querySelectorAll('[f2id="0"]');
              ownSub = 0;
              for (const h of hs) {
                let ht = '';
                try { ht = (((h.innerText || h.textContent) || '').trim().replace(/\s+/g, ' ')); } catch (e) {}
                if (!ht) continue;
                if (/субтитр/i.test(ht)) { ownSub = 1; break; }
                if (/качеств|скорост|масштаб|звук|audio|quality|speed/i.test(ht)) { ownSub = -1; break; }
              }
              if (ownSub < 0) continue;
            }
          } catch (e) {}
          let t = '';
          try {
            const kids = el.querySelectorAll ? el.querySelectorAll('*') : [];
            for (const c of kids) {
              let st = '';
              try { st = (c.getAttribute && c.getAttribute('style')) || ''; } catch (e) {}
              if (/float\s*:\s*left/i.test(st)) {
                try { t = ((((c.innerText || c.textContent) || '').trim().split('\n')[0]) || '').trim(); } catch (e) {}
                if (t) break;
              }
            }
            if (!t) t = ((((el.innerText || el.textContent) || '').trim().split('\n')[0] || '').trim());
          } catch (e) {}
          if (!t || t.length > 40) continue;
          if (!/[а-яА-ЯёЁa-zA-Z]/.test(t)) continue; // «1.5» скорости не берём
          if (/^(выкл|off|нет|disabled|откл)/i.test(t)) continue; // «без субтитров»
          if (/^(обычная|normal|standard)$/i.test(t)) continue; // значение скорости, не дорожка
          if (/качеств|скорост|субтитр|звук|аудио|audio|quality|speed|масштаб|airplay|параметр/i.test(t)) continue;
          if (extractQToken(t)) continue; // пункты качества
          // синяя метка активного пункта прямо в меню (надёжнее строки [fid])
          try {
            let mkA = false;
            try { if (el.getAttribute && el.getAttribute('aria-selected') === 'true') mkA = true; } catch (e) {}
            if (!mkA) {
              try {
                const cnA = (el.className && el.className.baseVal !== undefined) ? el.className.baseVal : el.className;
                if (/(^|[^a-z])active([^a-z]|$)/i.test(String(cnA || ''))) mkA = true;
              } catch (e) {}
            }
            if (mkA && ownSub >= 0 && t) out._menuActive = t;
          } catch (e) {}
          const k = normSubLabel(t);
          if (!k || seenMenu.has(k)) continue;
          seenMenu.add(k);
          const ex = out.find((o) => normSubLabel(o.label) === k || (o.lang && normSubLabel(o.lang) === k));
          const isActive = !!(out._menuActive && normSubLabel(out._menuActive) === k);
          if (ex) { ex.menuName = true; if (isActive) ex.menuActive = true; continue; }
          out.push({ label: t, lang: '', src: '', kind: 'menu', trackIndex: -1, cues: null, mode: '', menuName: true, menuActive: isActive });
        }
      } catch (e) {}
    } catch (e) {}
    out.forEach((it, i) => { it._idx = i; });
    return out;
  }
  // Текст файла: сначала напрямую, при отказе (CORS чужого CDN) — через background,
  // у него host_permissions и страницевый CORS не мешает.
  async function fetchSubText(url) {
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      if (!t.trim()) throw new Error('пустой файл');
      return t;
    } catch (e) {
      let res = null;
      try { res = await chrome.runtime.sendMessage({ type: 'vm-fetch-sub', url }); }
      catch (x) { throw e; }
      if (res && res.ok && res.text) return res.text;
      throw new Error((res && res.error) || (e && e.message) || 'fetch-fail');
    }
  }
  // Автооткрытие меню «Субтитры» плеера (как цепочка качества): читаем ВСЕ дорожки
  // без кликов пользователя. Возвращает {items:[{label,el,active}], active, close}.
  // Если подменю уже открыто — просто читаем видимое. Закрытие — через Escape.
  async function subsMenuSnapshot(video, keepOpen) {
    const out = { items: [], active: '', close: async () => {} };
    try {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      let wideScope = false;
      let scopeEl = null;
      try { scopeEl = containerOf(video); } catch (e) {}
      const inScope = (el) => {
        if (wideScope) return true;
        if (!scopeEl || scopeEl === document) return true;
        try { return !!(scopeEl.contains && scopeEl.contains(el)); } catch (e) { return true; }
      };
      // Пункты меню плеера: [f2id] (f2id=0 — заголовок «Субтитры», пропускаем),
      // название — в дочернем блоке с float:left. Обычные div страницы НЕ трогаем.
      const isSubItem = (el) => {
        try { if (el.getAttribute && el.getAttribute('f2id') === '0') return ''; } catch (e) {}
        let t = '';
        try {
          const kids = el.querySelectorAll ? el.querySelectorAll('*') : [];
          for (const c of kids) {
            let st = '';
            try { st = (c.getAttribute && c.getAttribute('style')) || ''; } catch (e) {}
            if (/float\s*:\s*left/i.test(st)) {
              try { t = ((((c.innerText || c.textContent) || '').trim().split('\n')[0]) || '').trim(); } catch (e) {}
              if (t) break;
            }
          }
          if (!t) t = ((((el.innerText || el.textContent) || '').trim().split('\n')[0] || '').trim());
        } catch (e) {}
        if (!t || t.length > 40) return '';
        if (!/[а-яА-ЯёЁa-zA-Z]/.test(t)) return '';
        if (/^(выкл|off|нет|disabled|откл)/i.test(t)) return '';
        if (/качеств|скорост|субтитр|звук|аудио|audio|quality|speed|масштаб|airplay|параметр/i.test(t)) return '';
        try { if (extractQToken(t)) return ''; } catch (e) {}
        return t;
      };
      const isActiveEl = (el) => {
        try {
          if (el.getAttribute && (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true')) return true;
          const cn = (el.className && el.className.baseVal !== undefined) ? el.className.baseVal : el.className;
          if (/(^|[^a-z])active([^a-z]|$)|selected|checked|current/i.test(String(cn || ''))) return true;
        } catch (e) {}
        return false;
      };
      const readVisible = () => {
        const arr = [];
        try {
          for (const el of deepQueryAll('[f2id],[role="menuitem"],[role="option"]')) {
            if (!inScope(el)) continue;
            let vis = false;
            try { vis = visible(el); } catch (e) {}
            if (!vis) continue;
            const t = isSubItem(el);
            if (!t) continue;
            arr.push({ label: t, el, active: isActiveEl(el) });
          }
        } catch (e) {}
        const seen = new Set(); const res = [];
        for (const it of arr) {
          const k = normSubLabel(it.label);
          if (!k || seen.has(k)) continue;
          seen.add(k); res.push(it);
        }
        return res;
      };
      const pressEsc = async () => {
        try {
          const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
          try { (document.activeElement || document.body || document).dispatchEvent(ev); } catch (e) {}
          try { document.dispatchEvent(ev); } catch (e) {}
        } catch (e) {}
        await wait(350);
      };
      out.close = pressEsc;
      const finish = async () => { if (!keepOpen) await pressEsc(); return out; };
      // 1) подменю уже открыто — читаем видимое
      let items = readVisible();
      if (!items.length) { wideScope = true; try { items = readVisible(); } catch (e) {} }
      if (items.length) {
        out.items = items;
        const a = items.find((x) => x.active);
        if (a) out.active = a.label;
        return finish();
      }
      // 2) прямая кнопка субтитров (CC)
      let opener = null;
      try {
        const btns = deepQueryAll('button,[role="button"],pjsdiv');
        for (const el of btns) {
          if (!inScope(el)) continue;
          let vis = false;
          try { vis = visible(el); } catch (e) {}
          if (!vis) continue;
          let a = '';
          try { a = ((el.getAttribute && (el.getAttribute('aria-label') || '')) + ' ' + ((el.getAttribute && (el.getAttribute('title') || '')))); } catch (e) {}
          if (/субтитр|subtitle|caption/i.test(a)) { opener = el; break; }
        }
        if (!opener) {
          for (const el of btns) {
            if (!inScope(el)) continue;
            let vis = false;
            try { vis = visible(el); } catch (e) {}
            if (!vis) continue;
            let t = '';
            try { t = (((el.innerText || el.textContent) || '').trim()); } catch (e) {}
            if (/^(cc|субтитры)$/i.test(t)) { opener = el; break; }
          }
        }
      } catch (e) {}
      if (opener) {
        try { mouseClick(opener); logDom('SUBS: клик по кнопке субтитров -> ' + describeEl(opener)); } catch (e) {}
        await wait(600);
        items = readVisible();
        if (items.length) {
          out.items = items;
          const a = items.find((x) => x.active);
          if (a) out.active = a.label;
        } else {
          try { await pressEsc(); } catch (e) {}
          try { mouseClick(opener); } catch (e) {}
          await wait(400);
        }
        return finish();
      }
      // 3) через шестерёнку: настройки → строка «Субтитры»
      let gear = null;
      try {
        const ctl = domCtl.get(video);
        if (ctl && ctl.gear) {
          let alive = false;
          try { alive = !!(document.contains ? document.contains(ctl.gear) : true); } catch (e) { alive = true; }
          if (alive) {
            let vis = false;
            try { vis = visible(ctl.gear); } catch (e) {}
            if (vis) gear = ctl.gear;
          }
        }
      } catch (e) {}
      if (gear) {
        try { mouseClick(gear); logDom('SUBS: клик по шестерёнке -> ' + describeEl(gear)); } catch (e) {}
        await wait(500);
        let row = null;
        try {
          for (const el of deepQueryAll('[fid],button,[role="button"],pjsdiv')) {
            if (!inScope(el)) continue;
            let vis = false;
            try { vis = visible(el); } catch (e) {}
            if (!vis) continue;
            let t = '';
            try { t = (((el.innerText || el.textContent) || '').trim().replace(/\s+/g, ' ')); } catch (e) {}
            if (!/субтитр/i.test(t)) continue;
            try { if (extractQToken(t)) continue; } catch (e) {}
            row = el; break;
          }
        } catch (e) {}
        if (row) {
          try { mouseClick(row); logDom('SUBS: клик по строке субтитров -> ' + describeEl(row)); } catch (e) {}
          await wait(600);
          items = readVisible();
          if (items.length) {
            out.items = items;
            const a = items.find((x) => x.active);
            if (a) out.active = a.label;
          }
        }
        return finish();
      }
      // 3b) шестерёнка не закэширована (цепочка качества её не искала —
      // [fid]-строки нашлись сразу): ищем как цепочка качества, по одной
      // кнопке за ~2.5с, пока не откроются настройки
      if (!gear) {
        try {
          let ctl3b = null;
          try { ctl3b = domCtl.get(video); } catch (e) { ctl3b = null; }
          if (!ctl3b) { ctl3b = {}; try { domCtl.set(video, ctl3b); } catch (e) {} }
          for (let gi = 0; gi < 6 && !gear; gi++) {
            let opened = false;
            try { opened = settingsVisible(); } catch (e) {}
            if (opened) break;
            try { gearStep(video, ctl3b); } catch (e) {}
            await wait(2600);
            try {
              if (ctl3b.gear) {
                let alive = false;
                try { alive = !!(document.contains ? document.contains(ctl3b.gear) : true); } catch (e) { alive = true; }
                if (alive) { let v = false; try { v = visible(ctl3b.gear); } catch (e) {} if (v) gear = ctl3b.gear; }
              }
            } catch (e) {}
          }
        } catch (e) {}
        if (gear) {
          try { mouseClick(gear); logDom('SUBS: клик по найденной шестерёнке -> ' + describeEl(gear)); } catch (e) {}
          await wait(500);
          let row = null;
          try {
            for (const el of deepQueryAll('[fid],button,[role="button"],pjsdiv')) {
              if (!inScope(el)) continue;
              let vis = false;
              try { vis = visible(el); } catch (e) {}
              if (!vis) continue;
              let t = '';
              try { t = (((el.innerText || el.textContent) || '').trim().replace(/\s+/g, ' ')); } catch (e) {}
              if (!/субтитр/i.test(t)) continue;
              try { if (extractQToken(t)) continue; } catch (e) {}
              row = el; break;
            }
          } catch (e) {}
          if (row) {
            try { mouseClick(row); logDom('SUBS: клик по строке субтитров -> ' + describeEl(row)); } catch (e) {}
            await wait(600);
            items = readVisible();
            if (items.length) {
              out.items = items;
              const a = items.find((x) => x.active);
              if (a) out.active = a.label;
            }
          }
          try { await pressEsc(); } catch (e) {}
          return finish();
        }
      }
      return finish();
    } catch (e) {}
    return out;
  }
  // Включить дорожку в самом плеере (клик по пункту его меню) — для скачивания в один клик
  // Текущая дорожка по строке «Субтитры …» ([fid]) — для проверки переключения.
  function readMenuActiveSub() {
    let seen = false, val = '';
    try {
      for (const el of deepQueryAll('[fid]')) {
        let t = '';
        try { t = (((el.innerText || el.textContent) || '').trim().replace(/\s+/g, ' ')); } catch (e) {}
        if (!/субтитр/i.test(t)) continue;
        seen = true;
        const m = t.replace(/субтитры?/i, '').replace(/^[\s:—–-]+/, '').trim();
        if (m && !/^(выкл|off|нет)/i.test(m)) { val = m; break; }
      }
    } catch (e) {}
    return { seen, val };
  }
  async function enableMenuSub(video, label) {
    try {
      const k = normSubLabel(label);
      if (!k) return false;
      for (let att = 0; att < 3; att++) {
        let snap = null;
        try { snap = await subsMenuSnapshot(video, true); } catch (e) { snap = null; }
        let tgt = null;
        try { tgt = ((snap && snap.items) || []).find((x) => normSubLabel(x.label) === k); } catch (e) {}
        // пункт мог отстегнуться от DOM между чтением и кликом (плеер перерисовал
        // меню) — ищем свежий элемент с тем же названием прямо в документе
        let el = (tgt && tgt.el && tgt.el.isConnected) ? tgt.el : null;
        if (!el) {
          try {
            const all = deepQueryAll('[f2id],[role="menuitem"],[role="option"]');
            for (const c of all) {
              let t = '';
              try { t = ((((c.innerText || c.textContent) || '').trim().split('\n')[0]) || '').trim(); } catch (e) {}
              if (t && normSubLabel(t) === k && c.isConnected) { el = c; break; }
            }
          } catch (e) {}
        }
        if (!el) { try { if (snap) await snap.close(); } catch (e) {} continue; }
        try { mouseClick(el); logDom('SUBS: включаю дорожку -> ' + describeEl(el)); } catch (e) {}
        await new Promise((r) => setTimeout(r, 900));
        let chk = { seen: false, val: '' };
        try { chk = readMenuActiveSub() || chk; } catch (e) {}
        try { if (snap) await snap.close(); } catch (e) {}
        if (chk.val && normSubLabel(chk.val) === k) return true;
        if (!chk.seen) return true; // строку не видно — считаем, что клик дошёл
        await new Promise((r) => setTimeout(r, 600));
      }
      return false;
    } catch (e) { return false; }
  }
  async function downloadSubtitle(item, video, statusEl, rec, retry) {
    const say = (t) => { try { if (statusEl) { statusEl.style.display = ''; statusEl.textContent = t; } } catch (e) {} };
    const hname = humanSubLabel(item) || item.label || 'дорожка';
    try {
      say('Качаю…');
      // дорожка из меню плеера без файла: включаем её сами и качаем (как с качеством — в один клик).
      // Переключение субтитров мгновенное (видео не перезапускается): плеер тут же
      // тянет файл — ловим его опросом сети и качаем сразу с человеческим именем.
      if (!item.netUrl && !item.src && item.menuName && rec && !retry) {
        let known = null;
        try {
          known = new Set();
          const r0 = await chrome.runtime.sendMessage({ type: 'vm-subs-get' });
          for (const n of ((r0 && r0.subs) || [])) { if (n && n.url) known.add(n.url); }
          for (const x of (rec._subsItems || [])) { if (x && (x.netUrl || x.src)) known.add(x.netUrl || x.src); }
        } catch (e) { try { known = new Set(); } catch (e2) {} }
        say('Включаю «' + hname + '»…');
        let ok = false;
        try { ok = await enableMenuSub(video, humanSubLabel(item) || item.label); } catch (e) { ok = false; }
        if (!ok) { say('Не получилось включить «' + hname + '» — попробуйте чуть позже'); return; }
        say('Подтягиваю «' + hname + '»…');
        let fresh = null;
        try {
          for (let i = 0; i < 7 && !fresh; i++) {
            await new Promise((r) => setTimeout(r, 700));
            let r1 = null;
            try { r1 = await chrome.runtime.sendMessage({ type: 'vm-subs-get' }); } catch (e) {}
            const arr = (r1 && r1.subs) || [];
            for (let k = arr.length - 1; k >= 0; k--) {
              const u = arr[k] && arr[k].url;
              if (u && known && !known.has(u)) { fresh = arr[k]; break; }
            }
          }
        } catch (e) {}
        try { rec._subsMenuAt = 0; rec._subsCache = null; await renderSubsList(rec); } catch (e) {}
        if (fresh && fresh.url) {
          const m = String(fresh.url).match(/\.(vtt|srt|ttml|ass|ssa|smi|sbv)(\?|#|$)/i);
          const g = m ? m[1].toLowerCase() : (fresh.ext ? String(fresh.ext).replace(/^\./, '') : 'vtt');
          const dn = niceSubName(item, g) || fresh.fileName || subFileName(item.label, g, item._idx || 0);
          try {
            const res = await chrome.runtime.sendMessage({ type: 'vm-subs-download', url: fresh.url, filename: dn });
            if (res && res.ok) { say(res.pending ? ('Качается в фоне: ' + dn) : ('Готово: ' + dn)); return; }
          } catch (e) {}
          try {
            const text = await fetchSubText(fresh.url);
            saveBlobAs(new Blob([text], { type: 'text/plain;charset=utf-8' }), dn);
            say('Готово: ' + dn);
            return;
          } catch (e) {}
        }
        let upd = null;
        try { upd = (rec._subsItems || []).find((x) => normSubLabel(x.label) === normSubLabel(humanSubLabel(item) || item.label)); } catch (e) {}
        if (upd && (upd.netUrl || upd.src)) { try { await downloadSubtitle(upd, video, statusEl, rec, true); } catch (e) {} return; }
        say('«' + hname + '» пока не подгрузилась — откройте список чуть позже и нажмите снова');
        return;
      }
      const url = item.netUrl || item.src;
      if (url) {
        const m = String(url).match(/\.(vtt|srt|ttml|ass|ssa|smi|sbv)(\?|#|$)/i);
        const guessExt = m ? m[1].toLowerCase() : 'vtt';
        // имя — человеческое («Русские-ru.vtt»), хеш CDN — только запасной вариант
        const dlName = niceSubName(item, guessExt) || item.netFile || subFileName(item.label, guessExt, item._idx || 0);
        // 1) загрузки браузера по точному URL: CORS не мешает, куки подставляются сами
        try {
          const res = await chrome.runtime.sendMessage({ type: 'vm-subs-download', url, filename: dlName });
          if (res && res.ok) { say(res.pending ? ('Качается в фоне: ' + dlName) : ('Готово: ' + dlName)); return; }
        } catch (e) {}
        // 2) запасной путь: fetch (напрямую, при отказе — через background)
        try {
          const text = await fetchSubText(url);
          const isVtt = /^\s*(﻿)?WEBVTT/i.test(text);
          const name = niceSubName(item, isVtt ? 'vtt' : guessExt) || subFileName(item.label, isVtt ? 'vtt' : guessExt, item._idx || 0);
          saveBlobAs(new Blob([text], { type: 'text/plain;charset=utf-8' }), name);
          say('Готово: ' + name);
          return;
        } catch (e) {}
        say('Не получилось скачать «' + hname + '» — попробуйте ещё раз чуть позже');
        return;
      }
      // 3) файла нет: пробуем подтянуть фразы из плеера (hidden грузит, но не показывает)      let track = null;
      try { track = video.textTracks && video.textTracks[item.trackIndex]; } catch (e) {}
      if (!track) { say('«' + hname + '» ещё не подгружена — попробуйте чуть позже'); return; }
      say('Подтягиваю «' + hname + '»…');
      try { track.mode = 'hidden'; } catch (e) {}
      await new Promise((r) => setTimeout(r, 1500));
      const srt = cuesToSrt(track);
      if (!srt) { say('Фраз пока нет — попробуйте чуть позже'); return; }
      const name = niceSubName(item, 'srt') || subFileName(item.label, 'srt', item._idx || 0);
      saveBlobAs(new Blob([srt], { type: 'text/plain;charset=utf-8' }), name);
      say('Готово: ' + name);
    } catch (e) { say('Ошибка: ' + String((e && e.message) || e).slice(0, 120)); }
  }
  function paintSubsList(rec, box, items) {
    try {
      box.innerHTML = '';
      if (!items.length) {
        const d = document.createElement('div');
        d.className = 'subnote';
        d.textContent = 'Субтитры пока не найдены — загляните чуть позже';
        box.appendChild(d);
        return;
      }
      for (const it of items) {
        const b = document.createElement('button');
        b.className = 'subbtn' + (it._ready ? '' : ' pending');
        const nm = humanSubLabel(it) || it.label || 'Субтитры';
        const extra = (!it.netUrl && !it.src && it.cues) ? ' · фраз: ' + it.cues : '';
        b.textContent = '↓ ' + nm + ((it.lang && normSubLabel(it.lang) !== normSubLabel(nm)) ? ' (' + it.lang + ')' : '') + extra;
        b.title = (it.netUrl || it.src) ? ('Скачать ' + nm) : (it.menuName ? ('Нажмите — включим «' + nm + '» и скачаем') : 'Встроенная дорожка — сохраним как .srt');
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const st = rec.panel.querySelector('.substatus');
          downloadSubtitle(it, rec.video, st, rec);
        });
        box.appendChild(b);
      }
    } catch (e) {}
  }

  async function renderSubsList(rec, forceSnap) {
    try {
      const box = rec.panel.querySelector('.subs');
      if (!box) return;
      const now = Date.now();
      // кэш на 30с — панель перерисовывается каждые 5с, не дёргаем сеть каждый раз
      if (rec._subsCache && now - rec._subsCache.t < 30000 && rec._subsCache.items) {
        paintSubsList(rec, box, rec._subsCache.items);
      } else {
        box.innerHTML = '<div class="subnote">Ищу субтитры…</div>';
      }
      if (rec._subsCache && now - rec._subsCache.t < 30000 && rec._subsCache.items) return;
      let items = [];
      try { items = collectSubtitles(rec.video); } catch (e) { items = []; }
      const menuActiveSnap = (items && items._menuActive) || '';
      // авточтение меню субтитров (как цепочка качества) — не чаще раза в 45с,
      // чтобы не мигать настройками плеера при каждой перерисовке
      let snap = null;
      try {
        const now2 = Date.now();
        if (forceSnap || !rec._subsMenuAt || now2 - rec._subsMenuAt > 45000) {
          rec._subsMenuAt = now2;
          snap = await subsMenuSnapshot(rec.video, false);
        }
      } catch (e) { snap = null; }
      if (snap && snap.items && snap.items.length) {
        for (const sm of snap.items) {
          const k = normSubLabel(sm.label);
          const ex = items.find((o) => normSubLabel(o.label) === k || (o.lang && normSubLabel(o.lang) === k));
          const isActive = !!((snap.active && normSubLabel(snap.active) === k) || sm.active);
          if (ex) { ex.menuName = true; if (isActive) ex.menuActive = true; continue; }
          items.push({ label: sm.label, lang: '', src: '', kind: 'menu', trackIndex: -1, cues: null, mode: '', menuName: true, menuActive: isActive });
        }
        if (snap.active) items._menuActive = snap.active;
      }
      const menuActive = (items && items._menuActive) || '';
      // сеть: что плеер реально подгрузил (точные URL с подписями — качаются без CORS)
      try {
        const res = await chrome.runtime.sendMessage({ type: 'vm-subs-get' });
        const net = (res && res.subs) || [];
        const rest = [];
        for (const n of net) {
          if (!n || !n.url) continue;
          const ex = items.find((it) => it.src === n.url);
          if (ex) {
            ex.netUrl = n.url; ex.netFile = n.fileName;
            if (!ex.label || (/^(Файл |Субтитры )/i.test(ex.label) && !ex.lang && ex.trackIndex < 0 && !ex.menuName)) ex.label = n.fileName;
            continue;
          }
          rest.push(n);
        }
        // самый свежий пойманный файл ↔ активная дорожка:
        // включили в меню плеера — плеер именно этот файл и подгрузил
        const nameHit = (nm) => items.find((it) => !it.netUrl && (normSubLabel(it.label) === nm || (it.lang && normSubLabel(it.lang) === nm)));
        if (rest.length && menuActive) {
          const tgt = nameHit(normSubLabel(menuActive));
          if (tgt) { const n = rest[rest.length - 1]; tgt.netUrl = n.url; tgt.netFile = n.fileName; rest.splice(rest.indexOf(n), 1); }
        }
        if (rest.length === 1) {
          const freeMenu = items.filter((it) => it.menuName && !it.netUrl && !it.src);
          if (freeMenu.length === 1) {
            const n = rest[0];
            freeMenu[0].netUrl = n.url; freeMenu[0].netFile = n.fileName; rest.length = 0;
          }
        }
        if (rest.length) {
          const sh = items.find((it) => !it.netUrl && !it.src && it.mode === 'showing' && humanSubLabel(it));
          if (sh) { const n = rest[rest.length - 1]; sh.netUrl = n.url; sh.netFile = n.fileName; rest.splice(rest.indexOf(n), 1); }
        }
        // свежий файл (появился после прошлого прохода) клеим к единственной
        // активной дорожке без файла — даже если снимок меню в этот раз пропустили
        try {
          if (!(rec._knownNet instanceof Set)) rec._knownNet = new Set();
          const freshOnes = rest.filter((n) => n && n.url && !rec._knownNet.has(n.url));
          if (freshOnes.length === 1) {
            const cand = items.filter((it) => !it.netUrl && !it.src && (it.menuActive || it.mode === 'showing' || it.menuName));
            const act = cand.filter((it) => it.menuActive || it.mode === 'showing');
            const tgt = act.length === 1 ? act[0] : (cand.length === 1 ? cand[0] : null);
            if (tgt) { const n = freshOnes[0]; tgt.netUrl = n.url; tgt.netFile = n.fileName; rest.splice(rest.indexOf(n), 1); }
          }
          try { for (const n of net) { if (n && n.url) rec._knownNet.add(n.url); } } catch (e) {}
        } catch (e) {}
        // Финал без висячих хэшей: все неприкаянные файлы — в общий пул
        // (остатки сети + найденные в странице), самый свежий уходит активной
        // дорожке — пункт списка становится кнопкой скачивания. Остальные
        // неприкаянные прячем, чтобы не плодить дубли-хэши.
        try {
          const normA2 = menuActive ? normSubLabel(menuActive) : '';
          let tgt2 = null;
          if (normA2) tgt2 = items.find((it) => !it.netUrl && !it.src && (normSubLabel(it.label) === normA2 || (it.lang && normSubLabel(it.lang) === normA2)));
          if (!tgt2) tgt2 = items.find((it) => !it.netUrl && !it.src && it.mode === 'showing' && humanSubLabel(it));
          if (!tgt2) {
            const frees2 = items.filter((it) => !it.netUrl && !it.src && it.menuName);
            if (frees2.length === 1) tgt2 = frees2[0];
          }
          const pool = [];
          try {
            for (const li of items) {
              if ((li.netUrl || li.src) && !li.menuName && !li.menuActive && li.mode !== 'showing') pool.push({ url: li.netUrl || li.src, fileName: li.netFile || '', item: li });
            }
          } catch (e) {}
          try { for (const rn of rest) { if (rn && rn.url) pool.push({ url: rn.url, fileName: rn.fileName || '', item: null }); } } catch (e) {}
          try { rest.length = 0; } catch (e) {}
          const seenU = new Set(); const uniq = [];
          try {
            for (let pi = pool.length - 1; pi >= 0; pi--) {
              const cp = pool[pi];
              if (!cp || !cp.url || seenU.has(cp.url)) continue;
              seenU.add(cp.url); uniq.push(cp);
            }
            uniq.reverse();
          } catch (e) {}
          if (uniq.length) {
            const newest = uniq[uniq.length - 1];
            if (!tgt2 && normA2) {
              tgt2 = { label: menuActive, lang: '', src: '', kind: 'menu', trackIndex: -1, cues: null, mode: '', menuName: true, menuActive: true };
              items.push(tgt2);
            }
            if (tgt2) {
              tgt2.netUrl = newest.url;
              try { tgt2.netFile = newest.fileName || decodeURIComponent(String(newest.url).split('/').pop().split('?')[0]); } catch (e) {}
              if (newest.item) { const gi = items.indexOf(newest.item); if (gi !== -1) items.splice(gi, 1); }
            } else if (uniq.length === 1 && newest.item) {
              try {
                const lb = String(newest.item.label || '');
                if (/\.(vtt|srt|ttml|ass|ssa|smi|sbv)(\?|#|$)/i.test(lb) || /^[a-z0-9]{8,}$/i.test(lb.replace(/\.\w+$/, '')) || /^(файл|субтитры)\s*\d*$/i.test(lb)) newest.item.label = 'Субтитры';
              } catch (e) {}
            }
            for (const cp of uniq) {
              if (cp === newest) continue;
              if (cp.item) { const gi = items.indexOf(cp.item); if (gi !== -1) items.splice(gi, 1); }
            }
          }
        } catch (e) {}
      } catch (e) {}
      items.forEach((it, i) => { it._idx = i; it._ready = !!(it.netUrl || (it.cues && it.cues > 0)); });
      // готовые первыми, остальные по названию
      try { items.sort((a, b) => (((b._ready ? 1 : 0) - (a._ready ? 1 : 0)) || String(a.label || '').localeCompare(String(b.label || ''), 'ru'))); } catch (e) {}
      rec._subsItems = items;
      rec._subsCache = { t: Date.now(), items };
      const box2 = rec.panel.querySelector('.subs');
      if (!box2 || !box2.isConnected || box2 !== box) return; // панель уже перерисована — новый проход сам всё покажет
      paintSubsList(rec, box2, items);
    } catch (e) {}
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Клавиша V показывает только значок бейджа: открытая панель при этом закрывается.
  // Отключается чекбоксом «V закрывает открытую панель» в настройках.
  function closeAllPanels() {
    try {
      for (const rec of badges.values()) {
        rec.open = false;
        if (rec.panel) rec.panel.classList.remove('open');
      }
    } catch (e) {}
  }

  async function toggleBadgeHidden(force) {
    const id = await requestTabId();
    if (id === null || id === undefined) return; // без id вкладки точечно не скрыть
    const map = { ...(S.badgeHiddenTabs || {}) };
    const v = typeof force === 'boolean' ? force : !map[id];
    if (v) map[id] = true; else delete map[id];
    S.badgeHiddenTabs = map;
    if (S.closePanelOnShow !== false) closeAllPanels();
    try { await chrome.storage.local.set({ badgeHiddenTabs: map }); } catch (e) {}
    refreshAllBadges();
  }

  // ---------- фуллскрин: переносим бейдж внутрь fullscreen-элемента
  document.addEventListener('fullscreenchange', () => {
    try {
      const fs = document.fullscreenElement;
      for (const [video, rec] of badges) {
        if (fs && fs.contains(video)) {
          if (rec.host.parentElement !== fs && !fs.contains(rec.host)) {
            fs.appendChild(rec.host);
            rec.host.style.position = 'fixed';
            rec.host.style.left = '50%';
            rec.host.style.top = '14px';
            rec.host.style.transform = 'translateX(-50%)';
          }
          // свои субтитры едут следом за бейджем, иначе их не видно
          try {
            if (rec._subOverlay && rec._subOverlay.isConnected &&
                rec._subOverlay.parentElement !== fs && !fs.contains(rec._subOverlay)) {
              fs.appendChild(rec._subOverlay);
            }
          } catch (e) {}
        } else {
          if (!video.isConnected) { rec.host.remove(); badges.delete(video); continue; }
          placeBadge(video, rec.host);
          try {
            if (rec._subOverlay && !rec._subOverlay.isConnected) {
              rec._subOverlay = null; rec._subOverlayInner = null;
              if (rec._customSub && rec._customSub.cues) ensureSubOverlay(rec);
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  });

  // ---------- хоткей: срабатывает по физическому коду клавиши, поэтому работает
  // и в русской раскладке; слушаем в каждом фрейме, скрытие общее для фреймов вкладки через storage)
  document.addEventListener('keydown', (e) => {
    try {
      if (!e || e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // IME-композиция (CJK-ввод) и dead keys — не наше нажатие
      if (e.isComposing || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const hk = (S.hotkey || 'v').toLowerCase();
      const code = e.code || '';
      const expectedCode = hk.length === 1 && /[a-z]/.test(hk) ? 'Key' + hk.toUpperCase() : '';
      const byCode = expectedCode && code === expectedCode;
      const byKey = (e.key || '').toLowerCase() === hk;
      const byKeyCode = hk === 'v' && (e.keyCode === 86 || e.which === 86);
      if (byCode || byKey || byKeyCode) {
        e.stopPropagation();
        toggleBadgeHidden();
        return;
      }
      // Скорость — по физическому коду клавиши, работает и в русской раскладке:
      // S — медленнее, D — быстрее, R — сброс к 1.0 / возврат к скорости до сброса, G — переключение с избранной.
      // V занята показом/скрытием бейджа и здесь не используется.
      if (S.speedHotkeys !== false && isActive()) {
        const spdMap = { KeyS: 's', KeyD: 'd', KeyR: 'r', KeyG: 'g' };
        const bySpdCode = spdMap[e.code || ''] || null;
        const k = (e.key || '').toLowerCase();
        const bySpdKey = (k === 's' || k === 'd' || k === 'r' || k === 'g') ? k : null;
        const sk = bySpdCode || bySpdKey;
        if (sk) {
          let hasMedia = false;
          try { hasMedia = !!document.querySelector('video,audio'); } catch (x) {}
          if (!hasMedia) return;
          e.stopPropagation();
          try { e.preventDefault(); } catch (x) {}
          if (sk === 's') setSpeed(desiredSpeed() - speedStep());
          else if (sk === 'd') setSpeed(desiredSpeed() + speedStep());
          else if (sk === 'r') toggleResetSpeed();
          else if (sk === 'g') {
            const pref = clampSpeed(S.preferredSpeed || 2);
            setSpeed(Math.abs(desiredSpeed() - 1) < 1e-9 ? pref : 1);
          }
        }
      }
    } catch (err) {}
  }, true);

  // ---------- главный цикл
  function onMainState() {
    if (!isActive()) { refreshAllBadges(); return; }
    const passive = speedPassive(); // >2×: скорость ставим, плеер не трогаем
    for (const v of document.querySelectorAll('video')) {
      try {
        if (v.__vm_skip) continue;
        watchStall(v);
        watchSpeed(v);
        applySpeed(v);
        ensureBadge(v);
        if (!passive) domTick(v);
      } catch (e) {}
    }
    // аудио без картинки: бейдж не нужен, а скорость — да
    try {
      for (const a of document.querySelectorAll('audio')) {
        try { watchSpeed(a); applySpeed(a); } catch (e) {}
      }
    } catch (e) {}
    refreshAllBadges();
    maybeReport(false);
  }

  const mo = new MutationObserver(() => {
    if (!isActive()) return;
    for (const v of document.querySelectorAll('video')) {
      try {
        if (v.__vm_skip) continue;
        watchStall(v);
        watchSpeed(v);
        applySpeed(v);
        ensureBadge(v);
      } catch (e) {}
    }
    maybeReport(false);
  });

  // ---------- диагностика
  function buildDiagnostics() {
    const vids = Array.from(document.querySelectorAll('video')).slice(0, 6).map((v) => {
      const ctl = domCtl.get(v);
      return {
        size: (v.clientWidth || 0) + 'x' + (v.clientHeight || 0),
        vmVid: (v.dataset && v.dataset.vmVid) || null,
        sizeCapRank: sizeCapRankFor(v),
        rate: (() => { try { return v.playbackRate; } catch (e) { return '?'; } })(),
        // Прямые свойства медиаэлемента (читаются без плеера — для таблицы техинфо в попапе)
        media: (() => {
          try {
            let bufAhead = 0;
            try {
              const b = v.buffered, t = v.currentTime || 0;
              for (let i = 0; i < b.length; i++) {
                if (b.start(i) <= t && t <= b.end(i)) { bufAhead = Math.round((b.end(i) - t) * 10) / 10; break; }
              }
            } catch (e) {}
            return {
              paused: !!v.paused, muted: !!v.muted,
              volume: (() => { try { return Math.round(v.volume * 100) / 100; } catch (e) { return '?'; } })(),
              time: (() => { try { return Math.round((v.currentTime || 0) * 10) / 10; } catch (e) { return '?'; } })(),
              dur: (() => { try { return isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : null; } catch (e) { return null; } })(),
              buf: bufAhead, rs: v.readyState, ns: v.networkState,
              frame: (v.videoWidth || 0) + 'x' + (v.videoHeight || 0),
              loop: !!v.loop,
              drop: (() => { try { const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null; return q ? { d: q.droppedVideoFrames || 0, t: q.totalVideoFrames || 0, c: q.corruptedVideoFrames || 0 } : null; } catch (e) { return null; } })(),
              played: trSum(v.played),
              bufAll: trSum(v.buffered),
              seekN: (() => { try { return (v.seekable && v.seekable.length) || 0; } catch (e) { return 0; } })(),
              ended: !!v.ended, seeking: !!v.seeking,
              autoplay: !!v.autoplay, controls: !!v.controls, defaultMuted: !!v.defaultMuted,
              cors: (() => { try { return v.getAttribute ? (v.getAttribute('crossorigin') || '') : ''; } catch (e) { return ''; } })(),
              pitch: (() => { try { const p = v.preservesPitch !== undefined ? v.preservesPitch : v.webkitPreservesPitch !== undefined ? v.webkitPreservesPitch : v.mozPreservesPitch; return p === undefined ? null : !!p; } catch (e) { return null; } })(),
              sink: (() => { try { return (typeof v.sinkId === 'string' && v.sinkId) ? v.sinkId : ''; } catch (e) { return ''; } })(),
              drm: (() => { try { return !!v.mediaKeys; } catch (e) { return false; } })(),
              err: (() => { try { return (v.error && v.error.code) || 0; } catch (e) { return 0; } })(),
              slen: (() => { try { const m = videoStreamMeta.get(v); return (m && m.len) || 0; } catch (e) { return 0; } })(),
              segs: (() => { try { const m = videoStreamMeta.get(v); return (m && m.segs) || 0; } catch (e) { return 0; } })(),
              loaded: loadedTsBytes().total || 0,
              qerr: videoQErr.get(v) || '',
              qsizes: videoQSize.get(v) || null, // вес по качествам {label:bytes} (повтор запроса плеера)
              tracksA: (() => { try { const o = []; const at = v.audioTracks; if (at) for (let i = 0; i < at.length; i++) o.push({ label: at[i].label || '', lang: at[i].language || '', on: !!at[i].enabled }); return o; } catch (e) { return []; } })(),
              tracksV: (() => { try { const o = []; const vt = v.videoTracks; if (vt) for (let i = 0; i < vt.length; i++) o.push({ label: vt[i].label || '', on: !!vt[i].selected }); return o; } catch (e) { return []; } })(),
              tracksT: (() => { try { const o = []; const tt = v.textTracks; if (tt) for (let i = 0; i < tt.length; i++) { let cues = null; try { cues = tt[i].cues ? tt[i].cues.length : 0; } catch (e) {} o.push({ label: tt[i].label || '', lang: tt[i].language || '', mode: tt[i].mode || '', cues }); } return o; } catch (e) { return []; } })(),
            };
          } catch (e) { return {}; }
        })(),
        src: (v.currentSrc || v.src || '').slice(0, 200),
        domLevels: ctl && ctl.items ? ctl.items : [],
        domCurRank: ctl ? ctl.curRank : -1,
        domClicks: ctl ? ctl.clicks : 0,
        domOpenerAgoSec: ctl && ctl.lastOpener ? Math.round((Date.now() - ctl.lastOpener) / 1000) : -1,
        subSrcs: (() => { try { const o = []; for (const t of v.querySelectorAll('track')) { try { if (t.src) o.push(t.src.slice(0, 160)); } catch (e) {} } return o; } catch (e) { return []; } })(),
      };
    });
    return {
      version: VM_VERSION,
      frameUrl: location.href,
      isTop: window.top === window,
      active: isActive(),
      // разведка: где вообще лежат пункты меню в этом документе
      recon: (() => {
        try {
          let shadowHosts = 0;
          let shadowF2id = 0;
          try {
            for (const r of scanRoots()) {
              if (r !== document) {
                shadowHosts++;
                try { shadowF2id += r.querySelectorAll('[f2id]').length; } catch (e) {}
              }
            }
          } catch (e) {}
          let fidQVis = false;
          try {
            for (const f of deepQueryAll('[fid]')) {
              const cs = getComputedStyle(f);
              if (cs.display === 'none' || cs.visibility === 'hidden') continue;
              if (/качеств/i.test((f.innerText || f.textContent || ''))) { fidQVis = true; break; }
            }
          } catch (e) {}
          return {
            videos: document.querySelectorAll('video').length,
            iframes: document.querySelectorAll('iframe').length,
            f2id: deepQueryAll('[f2id]').length,
            fid: deepQueryAll('[fid]').length,
            cdnsettings: deepQueryAll('#cdnplayer_settings').length > 0,
            pjsdiv: deepQueryAll('pjsdiv').length,
            gearBtns: (() => { try { return gearCandidates(document).length; } catch (e) { return -1; } })(),
            settingsOpen: (() => { try { return settingsVisible(); } catch (e) { return false; } })(),
            fidQualityVisible: fidQVis,
            shadowHosts,
            shadowF2id,
          };
        } catch (e) { return { error: String(e) }; }
      })(),
      settings: { enabled: S.enabled, mode: S.mode, cap: S.cap, considerSize: S.considerSize, siteMode: S.siteMode },
      speed: { want: desiredSpeed(), step: speedStep(), preferred: clampSpeed(S.preferredSpeed || 2), hotkeys: S.speedHotkeys !== false },
      mainAlive,
      players: mainState.players || [],
      videos: vids,
      added: (() => { try { return updatesLinesSync(); } catch (e) { return []; } })(),
      updates: (() => { try { return { loaded: updatesCache.loaded, error: updatesCache.error || '', at: updatesCache.at || 0 }; } catch (e) { return {}; } })(),
      events: (mainState.events || []).concat(domLog),
    };
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'vm-collect-diagnostics') return;
    try {
      // свежий скан перед ответом — прямой запрос всегда показывает актуальное
      const vids = Array.from(document.querySelectorAll('video'));
      const respond = () => {
        try { sendResponse(buildDiagnostics()); }
        catch (e) { sendResponse({ error: String(e), version: VM_VERSION }); }
      };
      for (const v of vids) {
        try { watchStall(v); watchSpeed(v); applySpeed(v); ensureBadge(v); if (!speedPassive()) domTick(v, true); else domScanOnly(v); } catch (e) {}
      }
      if (!vids.length && !(mainState.players || []).length) {
        // пустой фрейм отвечает с задержкой — первым отвечает фрейм с видео
        setTimeout(respond, 500);
      } else {
        respond();
      }
    }
    catch (e) { sendResponse({ error: String(e), version: VM_VERSION }); }
    // и сразу шлём репорт — каждое нажатие «Обновить» гарантированно
    // наполняет кэш и список вкладок, даже если интервал ещё не сработал
    try { setTimeout(() => maybeReport(true), 300); } catch (e) {}
    return true; // асинхронный ответ (случай с setTimeout)
  });
  // периодический репорт в background (для попапа/настроек: все фреймы вкладки)
  let lastReport = 0;
  function maybeReport(force) {
    try {
      const now = Date.now();
      if (!force && now - lastReport < 5000) return;
      if (!document.querySelector('video') && !(mainState.players || []).length) return;
      lastReport = now;
      chrome.runtime.sendMessage({ type: 'vm-diag-report', payload: buildDiagnostics() }, () => {
        if (chrome.runtime.lastError) { /* background спит — проснётся от следующего */ }
      });
    } catch (e) {}
  }
  setInterval(() => maybeReport(true), 5000);

  // ---------- init
  (async () => {
    await requestTabId(); // id вкладки нужен badgeAllowed и сбросу скрытия при загрузке
    await loadSettings();
    // новая загрузка страницы = «старт»: скрытие этой вкладки сбрасывается, бейдж снова показывается.
    // Только топ-фрейм (перезагрузка рекламного iframe не должна возвращать бейдж).
    try {
      if (window.top === window && S.badgeDefaultVisible !== false &&
          myTabId !== null && myTabId !== undefined && S.badgeHiddenTabs && S.badgeHiddenTabs[myTabId]) {
        const m = { ...S.badgeHiddenTabs };
        delete m[myTabId];
        S.badgeHiddenTabs = m;
        await chrome.storage.local.set({ badgeHiddenTabs: m });
      }
    } catch (e) {}
    getBadgePos();
    pushSettingsToMain();
    try { updatesEnsure(); } catch (e) {} // «Добавлено»: тянем updates.json в фоне
    try {
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) {}
    try { window.postMessage({ source: 'vm-cmd', type: 'vm-ping' }, '*'); } catch (e) {}
    setInterval(() => {
      if (!isActive()) return;
      const passive = speedPassive(); // >2×: только скорость, без сканов/проб (не отъедаем трафик у потока)
      for (const v of document.querySelectorAll('video')) {
        try { applySpeed(v); if (!passive) { domTick(v); probeStreamMeta(v); probeStreamSizes(v); } else { domScanOnly(v); } } catch (e) {}
      }
      if (!passive) { try { topQsTick(); } catch (e) {} } // топ-кадр собирает размеры для всех (видео обычно в iframe)
      try {
        for (const a of document.querySelectorAll('audio')) {
          try { applySpeed(a); } catch (e) {}
        }
      } catch (e) {}
      refreshAllBadges();
    }, 5000);
    // свои субтитры: частый тик (5 с — слишком редко для фраз), дёшево: только видимые cues
    setInterval(() => {
      try { if (isActive()) tickCustomSubsAll(); } catch (e) {}
    }, 250);
  })();
})();
