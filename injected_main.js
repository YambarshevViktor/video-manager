/* Video Manager — MAIN world script (document_start).
 * Перехватывает инстансы плееров (hls.js / dash.js / shaka / video.js+VHS / YouTube),
 * выбирает уровень качества по режиму и управляет им напрямую.
 * Общение с isolated-миром — только через window.postMessage (Chrome API тут нет).
 */
(() => {
  if (window.__VM_MAIN_LOADED__) return;
  window.__VM_MAIN_LOADED__ = true;

  // ---------- Лестница качеств (по рангу, не по высоте: 1080 Ultra — отдельный шаг)
  // cap: 360|480|720|1080|1081(1080 Ultra)|1440|2160
  const CAPS = [
    { v: 360, h: 360, rank: 0 },
    { v: 480, h: 480, rank: 1 },
    { v: 720, h: 720, rank: 2 },
    { v: 1080, h: 1080, rank: 3 },
    { v: 1081, h: 1080, rank: 3.5, ultra: true },
    { v: 1440, h: 1440, rank: 4 },
    { v: 2160, h: 2160, rank: 5 },
  ];
  const rankOfCap = (v) => (CAPS.find((c) => c.v === v) || CAPS[CAPS.length - 1]).rank;
  const heightOfCap = (v) => (CAPS.find((c) => c.v === v) || CAPS[CAPS.length - 1]).h;

  const settings = {
    enabled: true, mode: 'smart', cap: 2160, considerSize: true,
  };

  const players = new Map(); // id -> entry
  const videoMeta = new WeakMap(); // video -> {vid, waitingSince, stableSince, stalls}
  const eventLog = [];
  let seq = 0;

  function logEvent(text) {
    eventLog.push({ t: new Date().toISOString(), text });
    if (eventLog.length > 30) eventLog.shift();
  }

  // ---------- Утилиты уровней
  function normLevels(raw) {
    // raw: [{label,height,bitrate}] -> сортировка по (height, bitrate), rank по высоте
    const arr = raw.map((l, i) => ({
      i,
      label: String(l.label ?? (l.height ? l.height + 'p' : 'auto')),
      height: Number(l.height) || 0,
      bitrate: Number(l.bitrate) || 0,
    })).filter((l) => l.height > 0 || /ultra|2k|4k/i.test(l.label));
    arr.sort((a, b) => (a.height - b.height) || (a.bitrate - b.bitrate));
    // эвристика Ultra: два уровня 1080 — верхний считаем Ultra (rank 3.5)
    const h1080 = arr.filter((l) => l.height === 1080);
    if (h1080.length > 1) {
      const top = h1080[h1080.length - 1];
      if (/ultra/i.test(top.label)) top.rank = 3.5;
      else if (top.bitrate > h1080[0].bitrate * 1.4) top.rank = 3.5;
    }
    arr.forEach((l) => {
      if (l.rank === undefined) {
        if (/ultra/i.test(l.label)) l.rank = 3.5;
        else if (/4k|2160/i.test(l.label)) l.rank = 5;
        else if (/2k|1440/i.test(l.label)) l.rank = 4;
        else if (l.height >= 2000) l.rank = 5;
        else if (l.height >= 1300) l.rank = 4;
        else if (l.height >= 1000) l.rank = 3;
        else if (l.height >= 650) l.rank = 2;
        else if (l.height >= 430) l.rank = 1;
        else l.rank = 0;
      }
    });
    return arr;
  }

  function sizeCapRank(video) {
    try {
      const fs = document.fullscreenElement;
      let h = 0;
      if (fs) h = fs.clientHeight || window.screen.height;
      else if (video) h = video.clientHeight || (video.parentElement && video.parentElement.clientHeight) || 0;
      if (!h || h < 120) return 5;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const target = h * dpr;
      if (target <= 400) return 0;
      if (target <= 560) return 1;
      if (target <= 900) return 2;
      if (target <= 1200) return 3;
      if (target <= 1700) return 4;
      return 5;
    } catch (e) { return 5; }
  }

  function pickIndex(levels, video) {
    if (!levels.length) return -1;
    let maxRank = rankOfCap(settings.cap);
    if (settings.mode === 'max') {
      // «Максимум»: размер окна игнорируется всегда
    } else if (settings.mode === 'smart' && settings.considerSize) {
      maxRank = Math.min(maxRank, sizeCapRank(video));
    }
    // manual: потолок пользователя, без учёта окна
    let best = 0;
    for (let k = 0; k < levels.length; k++) {
      if (levels[k].rank <= maxRank + 1e-9) best = k;
    }
    return best;
  }

  // ---------- Реестр и применение
  function register(kind, ref, getLevels, setLevel, getCurrent) {
    const id = 'p' + (++seq);
    const e = {
      id, kind, ref, getLevels, setLevel, getCurrent,
      levels: [], current: -1, video: null,
      target: -1, cooldownUntil: 0, stableSince: Date.now(), manualLock: false,
    };
    players.set(id, e);
    logEvent(kind + ' player attached (' + id + ')');
    refreshLevels(e);
    reportSoon();
    return e;
  }

  function refreshLevels(e) {
    try {
      const raw = e.getLevels() || [];
      e.levels = normLevels(raw);
      if (e.levels.length) {
        e.video = guessVideo(e);
        watchVideo(e.video);
        applyTarget(e, 'init');
      }
    } catch (err) { /* ignore */ }
  }

  function guessVideo(e) {
    try {
      if (e.ref && e.ref.media && e.ref.media.tagName === 'VIDEO') return e.ref.media;
      if (e.kind === 'youtube') {
        const mv = document.getElementById('movie_player');
        const v = mv && mv.querySelector ? mv.querySelector('video') : document.querySelector('#movie_player video');
        if (v) return v;
      }
      const vids = Array.from(document.querySelectorAll('video'));
      if (vids.length === 1) return vids[0];
      // VHS/videojs: ищем video рядом нет — берём самое большое видимое
      let best = null, bestArea = 0;
      for (const v of vids) {
        const a = (v.clientWidth || 0) * (v.clientHeight || 0);
        if (a > bestArea) { bestArea = a; best = v; }
      }
      return best || vids[0] || null;
    } catch (err) { return null; }
  }

  function markVideo(e) {
    try {
      if (e.video && !e.video.dataset.vmVid) e.video.dataset.vmVid = e.id;
    } catch (err) {}
  }

  function applyTarget(e, why) {
    if (!settings.enabled) return;
    if (!e.levels.length) { refreshLevels(e); if (!e.levels.length) return; }
    const idx = pickIndex(e.levels, e.video);
    if (idx < 0) return;
    e.target = idx;
    markVideo(e);
    const cur = safeCurrent(e);
    if (cur !== idx) {
      try {
        e.setLevel(idx, e.levels[idx]);
        e.current = idx;
        e.stableSince = Date.now();
        logEvent(e.kind + ' -> ' + e.levels[idx].label + ' (' + why + ')');
      } catch (err) { logEvent(e.kind + ' setLevel failed: ' + err); }
    } else {
      e.current = cur;
    }
    reportSoon();
  }

  function safeCurrent(e) {
    try {
      const c = e.getCurrent();
      if (typeof c === 'number' && c >= 0 && c < e.levels.length) return c;
    } catch (err) {}
    return e.current;
  }

  function stepDown(e, why) {
    const cur = safeCurrent(e);
    if (cur > 0) {
      const n = cur - 1;
      try {
        e.setLevel(n, e.levels[n]);
        e.current = n; e.target = n;
        e.cooldownUntil = Date.now() + 15000;
        e.stableSince = Date.now();
        logEvent(e.kind + ' step down -> ' + e.levels[n].label + ' (' + why + ')');
        reportSoon();
      } catch (err) {}
    }
  }

  function stepUp(e) {
    const cur = safeCurrent(e);
    const maxIdx = pickIndex(e.levels, e.video);
    if (cur >= 0 && cur < maxIdx) {
      const n = cur + 1;
      if (e.levels[n].rank <= rankOfCap(settings.cap) + 1e-9) {
        try {
          e.setLevel(n, e.levels[n]);
          e.current = n; e.target = n;
          e.stableSince = Date.now();
          logEvent(e.kind + ' step up -> ' + e.levels[n].label + ' (stable)');
          reportSoon();
        } catch (err) {}
      }
    }
  }

  // ---------- Видео: метки, stall-детект
  function watchVideo(v) {
    if (!v || videoMeta.has(v)) return;
    const m = { waitingSince: 0, stalls: 0 };
    videoMeta.set(v, m);
    v.addEventListener('waiting', () => { m.waitingSince = Date.now(); });
    v.addEventListener('stalled', () => { if (!m.waitingSince) m.waitingSince = Date.now(); });
    const clear = () => { m.waitingSince = 0; m.waitConfirm = false; };
    v.addEventListener('playing', clear);
    v.addEventListener('canplay', clear);
  }

  setInterval(() => {
    try {
      const now = Date.now();
      for (const e of players.values()) {
        if (!e.video) { e.video = guessVideo(e); if (e.video) watchVideo(e.video); }
        if (!e.video) continue;
        // Пассивный режим скорости (>2×): как VSC — автоматика качества
        // (степ-дауны, степ-апы, энфорс) заморожена, чтобы не перезагружать
        // поток на высокой скорости. Явные клики пользователя (vm-force) идут мимо.
        let fast = false;
        try { fast = ((e.video.playbackRate || 1) > 2); } catch (err) {}
        if (fast) { try { e.stableSince = Date.now(); } catch (err2) {} continue; }
        const m = videoMeta.get(e.video);
        // smart: шаг вниз при устойчивом зависшем waiting — только со второго
        // подряд подтверждения (одно тиканье прощаем: тик теперь раз в 5с,
        // итого степ-даун не раньше ~10с непрерывной буферизации)
        if (settings.enabled && settings.mode === 'smart' && m && m.waitingSince) {
          if (now - m.waitingSince > 2500 && now > e.cooldownUntil) {
            if (!m.waitConfirm) {
              m.waitConfirm = true;
              m.waitingSince = now; // ждём следующего тика для подтверждения
            } else {
              m.waitConfirm = false;
              m.stalls++;
              m.waitingSince = now; // чтобы не тикать каждый цикл
              stepDown(e, 'buffering');
            }
          }
        } else if (m) {
          m.waitConfirm = false;
        }
        // smart: шаг вверх после долгой стабильности (редко: 90с, перепроверка через 15с)
        if (settings.enabled && settings.mode === 'smart' && e.kind !== 'dom') {
          if (now > e.cooldownUntil && now - e.stableSince > 90000) {
            let buffered = 0;
            try {
              const b = e.video.buffered, t = e.video.currentTime || 0;
              for (let i = 0; i < b.length; i++) {
                if (b.start(i) <= t && t <= b.end(i)) { buffered = b.end(i) - t; break; }
              }
            } catch (err) {}
            if (buffered > 12) stepUp(e);
            else e.stableSince = now - 75000; // перепроверить позже (через ~15с)
          }
        }
        // перепроверка текущего уровня (сайт мог перетереть). Редко: раз в 15с,
        // и только если уровень реально не тот — зря поток не перезагружаем.
        if (settings.enabled && (settings.mode === 'max' || settings.mode === 'manual')) {
          if (!e._enforceT || now - e._enforceT > 15000) {
            e._enforceT = now;
            const cur = safeCurrent(e);
            if (cur !== e.target && e.target >= 0) {
              try { e.setLevel(e.target, e.levels[e.target]); e.current = e.target; }
              catch (err) {}
            }
          }
        }
      }
    } catch (err) {}
  }, 5000); // редко: чаще дёргать плеер незачем — шаг вниз подтверждается дважды, энфорс раз в 15с

  // ---------- Перехват библиотек
  function hookProp(name, cb) {
    let internal;
    try { internal = window[name]; } catch (e) { internal = undefined; }
    const fire = (v) => { try { cb(v); } catch (e) {} };
    if (internal) fire(internal);
    try {
      Object.defineProperty(window, name, {
        configurable: true, enumerable: true,
        get() { return internal; },
        set(v) {
          if (v && v.__vm_hooked) { internal = v; return; }
          internal = v;
          if (v) fire(v);
        },
      });
    } catch (e) { /* неперехватываемое свойство — полагаемся на polling */ }
  }

  // hls.js
  hookProp('Hls', (Hls) => {
    if (!Hls || Hls.__vm_hooked) return;
    try {
      const Wrapped = new Proxy(Hls, {
        construct(t, args) {
          const inst = new t(...args);
          try {
            register(
              'hls', inst,
              () => (inst.levels || []).map((l) => ({ label: l.name || (l.height ? l.height + 'p' : ''), height: l.height, bitrate: l.bitrate })),
              (idx) => { try { inst.autoLevelEnabled = false; } catch (e) {} inst.currentLevel = idx; try { inst.nextLevel = idx; } catch (e) {} },
              () => (typeof inst.currentLevel === 'number' ? inst.currentLevel : inst.nextLevel)
            );
            if (Hls.Events && inst.on) {
              inst.on(Hls.Events.MANIFEST_PARSED, () => {
                const e = [...players.values()].find((p) => p.ref === inst);
                if (e) refreshLevels(e);
              });
              inst.on(Hls.Events.LEVEL_SWITCHED, (ev, data) => {
                const e = [...players.values()].find((p) => p.ref === inst);
                if (e && data && typeof data.level === 'number') { e.current = data.level; reportSoon(); }
              });
            }
          } catch (e) {}
          return inst;
        },
      });
      Wrapped.__vm_hooked = true;
      window.Hls = Wrapped; // попадёт в наш setter как hooked
    } catch (e) {}
  });

  // dash.js
  hookProp('dashjs', (dashjs) => {
    try {
      const MP = dashjs && dashjs.MediaPlayer && dashjs.MediaPlayer.prototype;
      if (!MP || MP.__vm_hooked) return;
      const orig = MP.create;
      MP.create = function () {
        const p = orig.apply(this, arguments);
        try {
          register(
            'dash', p,
            () => {
              const infos = p.getBitrateInfoListFor ? p.getBitrateInfoListFor('video') : [];
              return (infos || []).map((b) => ({ label: (b.height ? b.height + 'p' : (b.bitrate ? Math.round(b.bitrate / 1000) + 'k' : '')), height: b.height, bitrate: b.bitrate }));
            },
            (idx) => { try { p.setAutoSwitchQualityFor('video', false); } catch (e) {} p.setQualityFor('video', idx); },
            () => { try { return p.getQualityFor ? p.getQualityFor('video') : -1; } catch (e) { return -1; } }
          );
        } catch (e) {}
        return p;
      };
      MP.__vm_hooked = true;
    } catch (e) {}
  });

  // shaka
  hookProp('shaka', (shaka) => {
    try {
      if (!shaka || !shaka.Player || shaka.Player.__vm_hooked) return;
      const Orig = shaka.Player;
      const Wrapped = new Proxy(Orig, {
        construct(t, args) {
          const inst = new t(...args);
          try {
            if (inst.configure) inst.configure({ abr: { enabled: false } });
            register(
              'shaka', inst,
              () => {
                const tracks = inst.getVariantTracks ? inst.getVariantTracks().filter((x) => x.type === 'variant' || x.videoId !== undefined) : [];
                const seen = new Map();
                for (const tr of tracks) {
                  const h = tr.height || 0;
                  if (!seen.has(h) || (tr.bandwidth || 0) > seen.get(h).bitrate) {
                    seen.set(h, { label: (h ? h + 'p' : ''), height: h, bitrate: tr.bandwidth || 0, track: tr });
                  }
                }
                const arr = [...seen.values()];
                arr._tracks = arr.map((x) => x.track);
                return arr;
              },
              (idx, level) => { if (level && level.track && inst.selectVariantTrack) inst.selectVariantTrack(level.track, true); },
              () => {
                try {
                  const act = inst.getVariantTracks ? inst.getVariantTracks().find((x) => x.active) : null;
                  if (!act) return -1;
                  const e = [...players.values()].find((p) => p.ref === inst);
                  if (!e) return -1;
                  return e.levels.findIndex((l) => l.height === act.height);
                } catch (e2) { return -1; }
              }
            );
            if (inst.addEventListener) {
              inst.addEventListener('trackschanged', () => reportSoon());
            }
          } catch (e) {}
          return inst;
        },
      });
      Wrapped.__vm_hooked = true;
      shaka.Player = Wrapped;
    } catch (e) {}
  });

  // video.js + VHS (http-streaming): polling, т.к. обёртка videojs рискованна
  setInterval(() => {
    try {
      const vjs = window.videojs;
      if (!vjs || !vjs.players) return;
      for (const key of Object.keys(vjs.players)) {
        const p = vjs.players[key];
        if (!p || p.__vm_id) continue;
        try {
          const ql = p.qualityLevels ? p.qualityLevels() : null;
          if (!ql || !ql.length) continue;
          p.__vm_id = true;
          register(
            'vhs', p,
            () => {
              const out = [];
              for (let i = 0; i < ql.length; i++) {
                const q = ql[i];
                out.push({ label: (q.height ? q.height + 'p' : (q.label || '')), height: q.height || 0, bitrate: q.bitrate || 0, q });
              }
              return out;
            },
            (idx, level) => {
              for (let i = 0; i < ql.length; i++) ql[i].enabled = (ql[i] === (level && level.q));
            },
            () => {
              for (let i = 0; i < ql.length; i++) {
                if (ql[i].enabled) {
                  const e = [...players.values()].find((pp) => pp.ref === p);
                  if (!e || !e.levels.length) return i;
                  const h = ql[i].height || 0;
                  const k = e.levels.findIndex((l) => l.height === h);
                  return k >= 0 ? k : i;
                }
              }
              return -1;
            }
          );
        } catch (e) {}
      }
    } catch (e) {}
  }, 2000);

  // YouTube (#movie_player)
  const YT_LABELS = { hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360, small: 240, tiny: 144 };
  setInterval(() => {
    try {
      const mp = document.getElementById('movie_player');
      if (!mp || typeof mp.getAvailableQualityLevels !== 'function') return;
      let e = [...players.values()].find((p) => p.kind === 'youtube');
      if (!e) {
        e = register(
          'youtube', mp,
          () => {
            const lv = mp.getAvailableQualityLevels ? mp.getAvailableQualityLevels() : [];
            return (lv || []).map((name) => ({ label: name, height: YT_LABELS[name] || 0 }));
          },
          (idx, level) => {
            if (level && mp.setPlaybackQualityRange) mp.setPlaybackQualityRange(level.label, level.label);
            if (level && mp.setPlaybackQuality) { try { mp.setPlaybackQuality(level.label); } catch (x) {} }
          },
          () => {
            try {
              const cur = mp.getPlaybackQuality ? mp.getPlaybackQuality() : '';
              const ee = [...players.values()].find((p) => p.kind === 'youtube');
              if (!ee) return -1;
              return ee.levels.findIndex((l) => l.label === cur);
            } catch (x) { return -1; }
          }
        );
      } else {
        // сайт мог перетереть качество — энфорс (кроме пассивного режима >2×).
        // Редко: не чаще раза в 15с.
        let fast = false;
        try { const vv = mp.querySelector ? mp.querySelector('video') : null; fast = (vv && (vv.playbackRate || 1) > 2); } catch (x) {}
        if (fast) return;
        const cur = safeCurrent(e);
        if (settings.enabled && e.target >= 0 && cur !== e.target) {
          const now = Date.now();
          if (!e._enforceT || now - e._enforceT > 15000) {
            e._enforceT = now;
            try {
              const lv = e.levels[e.target];
              if (lv && mp.setPlaybackQualityRange) mp.setPlaybackQualityRange(lv.label, lv.label);
            } catch (x) {}
          }
        }
      }
    } catch (e) {}
  }, 2500);

  // ---------- Мост в isolated-мир
  let reportTimer = 0;
  function reportSoon() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => { reportTimer = 0; report(); }, 300);
  }
  function report() {
    try {
      const list = [...players.values()].map((e) => ({
        id: e.id, kind: e.kind,
        levels: e.levels.map((l) => ({ label: l.label, height: l.height, bitrate: l.bitrate, rank: l.rank })),
        current: safeCurrent(e), target: e.target,
      }));
      const vids = Array.from(document.querySelectorAll('video')).slice(0, 8).map((v) => ({
        vmVid: v.dataset ? (v.dataset.vmVid || null) : null,
        w: v.clientWidth || 0, h: v.clientHeight || 0,
        src: (v.currentSrc || v.src || '').slice(0, 160),
      }));
      window.postMessage({
        source: 'vm-main', type: 'vm-state',
        players: list, videos: vids, events: eventLog.slice(-12),
        url: location.href,
      }, '*');
    } catch (e) {}
  }
  setInterval(report, 4000);

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || m.source !== 'vm-cmd') return;
    try {
      if (m.type === 'vm-settings' && m.settings) {
        const s = m.settings;
        const prev = settings.mode + '|' + settings.cap;
        settings.enabled = !!s.enabled;
        settings.mode = s.mode || 'smart';
        settings.cap = Number(s.cap) || 2160;
        settings.considerSize = s.considerSize !== false;
        if ((settings.mode + '|' + settings.cap) !== prev) {
          for (const e of players.values()) { e.cooldownUntil = 0; applyTarget(e, 'settings'); }
        }
        reportSoon();
      }
      if (m.type === 'vm-force' && m.playerId != null && m.index != null) {
        const e = players.get(m.playerId);
        if (e && e.levels[m.index]) {
          e.setLevel(m.index, e.levels[m.index]);
          e.current = m.index; e.target = m.index;
          e.cooldownUntil = Date.now() + 15000;
          e.stableSince = Date.now();
          logEvent(e.kind + ' -> ' + e.levels[m.index].label + ' (manual click)');
          reportSoon();
        }
      }
      if (m.type === 'vm-ping') report();
    } catch (e) {}
  });

  // сканим video для stall-детекта даже без API-плеера (нужно DOM-адаптеру? нет, но метки пригодятся)
  setInterval(() => {
    try {
      for (const v of document.querySelectorAll('video')) watchVideo(v);
    } catch (e) {}
  }, 3000);

  logEvent('main world ready @ ' + location.host);
});
