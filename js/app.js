// Поиск номеров — веб-версия (iPhone / Android / ПК). Порт Android-приложения PlateFinder.
import { PlateText, Matcher, RED, GREEN, parsePlateLine, consensus } from './matcher.js';
import { POWIATS } from './powiats.js';
import { scanFrame, OCR_PARAMS, OCR_INIT } from './pipeline.js';

const VERSION = '1.1-web';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ иконки
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  list: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h10M7 17h6"/>'),
  history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
  pin: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/>'),
  place: svg('<path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
  flash: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  flashOff: svg('<path d="M13 2 9.5 7M16 10h3l-3.5 4.6M10 22l1-8H4l3-4M2 2l20 20"/>'),
  back: svg('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  map: svg('<path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>'),
  video: svg('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4z"/>'),
  bell: svg('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'),
  download: svg('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>'),
  upload: svg('<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>'),
  camera: svg('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
  save: svg('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>'),
};

// ============================================================ хранение (на устройстве)
const store = {
  get(key, def) {
    try { const v = localStorage.getItem('pf.' + key); return v == null ? def : JSON.parse(v); } catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem('pf.' + key, JSON.stringify(val)); } catch (e) { toast('Не удалось сохранить: память браузера переполнена'); }
  },
};

// Фото и видео — в IndexedDB (может быть большим)
const media = (() => {
  let dbp;
  const open = () => (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('platefinder', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('media');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('media', mode);
      const q = fn(t.objectStore('media'));
      t.oncomplete = () => res(q?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    put: (id, blob) => tx('readwrite', (s) => s.put(blob, id)),
    get: (id) => tx('readonly', (s) => s.get(id)),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
    clear: () => tx('readwrite', (s) => s.clear()),
  };
})();

const DEFAULT_SETTINGS = { sound: true, vibrate: true, fuzzy: true, showAll: true, autoLog: true, hiRes: false, videoAudio: false };
const state = {
  plates: store.get('plates', []),          // [{plate, color, note, addedAt}]
  prefixes: store.get('prefixes', {}),      // {code: '#hex'}
  journal: store.get('journal', []),        // [{id, time, type, plates, lat, lon, acc, media}]
  settings: { ...DEFAULT_SETTINGS, ...store.get('settings', {}) },
};
const powiatMap = new Map(POWIATS.map(([code, name, region, svc]) => [code, { code, name, region, service: !!svc }]));
const PREFIX_PALETTE = ['#FF9F0A', '#FFD60A', '#64D2FF', '#0A84FF', '#BF5AF2', '#FF375F', '#30D158', '#AC8E68'];

let matcher = null;
function rebuildMatcher() {
  matcher = new Matcher(state.plates, state.prefixes, powiatMap, state.settings.fuzzy);
  updateStatus();
}
const savePlates = () => { store.set('plates', state.plates); rebuildMatcher(); };
const savePrefixes = () => { store.set('prefixes', state.prefixes); rebuildMatcher(); };
const saveJournal = () => store.set('journal', state.journal);
const saveSettings = () => { store.set('settings', state.settings); rebuildMatcher(); };

let lastId = 0;
function newId() {
  lastId = Math.max(Date.now(), lastId + 1, (state.journal[0]?.id || 0) + 1);
  return lastId;
}
function addLog(entry) {
  state.journal.unshift(entry);
  if (state.journal.length > 3000) {
    for (const e of state.journal.splice(3000)) if (e.media) media.del(e.id).catch(() => {});
  }
  saveJournal();
  if (currentSheet === 'journal') renderSheet();
}
function updateLog(id, patch) {
  const e = state.journal.find((x) => x.id === id);
  if (!e) return;
  Object.assign(e, patch);
  saveJournal();
  if (currentSheet === 'journal') renderSheet();
}

// ============================================================ звук / вибрация
let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const b = audioCtx.createBuffer(1, 1, 22050), s = audioCtx.createBufferSource();
    s.buffer = b; s.connect(audioCtx.destination); s.start(0);
  } catch { /* без звука */ }
}
function beep(freq, dur, at = 0, vol = 0.35) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime + at;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = 'square'; o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.setValueAtTime(vol, t + dur - 0.02);
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(g).connect(audioCtx.destination);
  o.start(t); o.stop(t + dur);
}
function alertFor(color) {
  const s = state.settings;
  if (s.sound) {
    if (color === 'red') { beep(1320, 0.14, 0); beep(1320, 0.14, 0.2); beep(1320, 0.14, 0.4); beep(990, 0.3, 0.6); }
    else beep(880, 0.12, 0, 0.2);
  }
  if (s.vibrate && navigator.vibrate) navigator.vibrate(color === 'red' ? [250, 120, 250, 120, 250] : [120]);
}
const click = () => { if (navigator.vibrate) navigator.vibrate(20); };

// ============================================================ геолокация
function getLocation() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      () => res(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
    );
  });
}

// ============================================================ камера
const video = $('#video');
const overlay = $('#overlay');
let stream = null, track = null;
let nativeZoom = null;      // {min,max} если камера умеет зум
let zoom = 1;
let torchOn = false;

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  });
  video.srcObject = stream;
  await video.play().catch(() => {});
  track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  nativeZoom = caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max } : null;
  $('#btnTorch').hidden = !caps.torch;
  renderZoom();
  await new Promise((r) => (video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true })));
}

function maxZoom() { return nativeZoom ? Math.min(nativeZoom.max, 10) : 4; }
async function setZoom(z) {
  zoom = Math.max(1, Math.min(maxZoom(), z));
  if (nativeZoom) {
    try { await track.applyConstraints({ advanced: [{ zoom: Math.max(nativeZoom.min, zoom) }] }); } catch { /* */ }
    video.style.transform = '';
  } else {
    video.style.transform = zoom > 1 ? `scale(${zoom})` : '';
  }
  renderZoom();
}
function renderZoom() {
  const steps = [1, 2, 3, 5, 10].filter((s) => s <= maxZoom() + 0.01);
  const near = steps.reduce((a, b) => (Math.abs(b - zoom) < Math.abs(a - zoom) ? b : a), 1);
  $('#zoom').innerHTML = steps.map((s) =>
    `<button data-z="${s}" class="${s === near ? 'on' : ''}">${s === near && Math.abs(zoom - s) > 0.05 ? zoom.toFixed(1) : s}×</button>`).join('');
}
$('#zoom').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setZoom(+b.dataset.z); });

// щипок для зума
(() => {
  let d0 = 0, z0 = 1;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  $('#stage').addEventListener('touchstart', (e) => { if (e.touches.length === 2) { d0 = dist(e.touches); z0 = zoom; } }, { passive: true });
  $('#stage').addEventListener('touchmove', (e) => { if (e.touches.length === 2 && d0) setZoom(z0 * dist(e.touches) / d0); }, { passive: true });
  $('#stage').addEventListener('touchend', () => { d0 = 0; });
})();

$('#btnTorch').addEventListener('click', async () => {
  torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { torchOn = false; toast('Фонарь недоступен'); }
  $('#btnTorch').classList.toggle('on', torchOn);
  $('#btnTorch .ic').innerHTML = torchOn ? I.flash : I.flashOff;
});

/** Видимая на экране часть кадра (в пикселях видео) и масштаб видео → экран. */
function visibleRegion() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const W = video.clientWidth, H = video.clientHeight;
  const z = nativeZoom ? 1 : zoom;
  const scale = Math.max(W / vw, H / vh) * z;
  const w = W / scale, h = H / scale;
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h, scale };
}

// ============================================================ распознавание
let workers = [];
let running = false;
let tracks = [];            // [{box:{x0,y0,x1,y1} в пикселях экрана, hit, seen}]
let cycleMs = 800;
const lastSeen = new Map(); // plate -> ms
const SIGHTING_GAP = 15000;
let memory = [];            // [{box, reads[], seen}] — прочтения табличек для голосования
const MEMORY_TTL = 2500;

async function initOCR(onProgress) {
  const n = (navigator.hardwareConcurrency || 2) >= 4 ? 2 : 1;
  const prog = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const w = await Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (running || typeof m.progress !== 'number') return; // после запуска прогресс не нужен
        prog[i] = m.progress; onProgress(prog.reduce((a, b) => a + b, 0) / n);
      },
    }, OCR_INIT);
    await w.setParameters(OCR_PARAMS);
    workers.push(w);
  }
}

/**
 * Главный цикл: снимок видимой части кадра → поиск табличек → чтение вырезок
 * (параллельно всеми потоками Tesseract) → рамки и сигналы.
 */
async function scanLoop() {
  const frame = document.createElement('canvas');
  const fctx = frame.getContext('2d', { willReadFrequently: true });
  while (running) {
    if (document.hidden || video.readyState < 2 || !video.videoWidth || !matcher) { await sleep(250); continue; }
    const g = visibleRegion();
    // длинная сторона снимка: больше — читает дальше, но медленнее
    const target = state.settings.hiRes ? 1920 : 1280;
    const s = Math.min(1, target / Math.max(g.w, g.h));
    frame.width = Math.round(g.w * s);
    frame.height = Math.round(g.h * s);
    fctx.drawImage(video, g.x, g.y, g.w, g.h, 0, 0, frame.width, frame.height);
    const t0 = performance.now();
    let res;
    try { res = await scanFrame(frame, workers, matcher, state.settings.hiRes ? 10 : 8); }
    catch { await sleep(300); continue; }
    cycleMs = cycleMs * 0.7 + (performance.now() - t0) * 0.3;
    handleFrame(res.detections, g.scale / s);
    if (!res.regions.length) await sleep(120); // пустой кадр — даём телефону отдохнуть
  }
}

function handleFrame(found, k) {
  const now = Date.now();
  const toBox = (b) => ({ x0: b.x0 * k, y0: b.y0 * k, x1: b.x1 * k, y1: b.y1 * k });
  // один номер — одна рамка
  const byKey = new Map();
  for (const f of found) {
    const key = f.hit.watch?.plate || f.hit.plate;
    if (!byKey.has(key) || byKey.get(key).hit.score < f.hit.score) byKey.set(key, f);
  }
  const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

  // Голосование: прочтения одной и той же таблички за последние секунды (по месту в кадре)
  memory = memory.filter((m) => now - m.seen < MEMORY_TTL);
  const fresh = [...byKey.values()].map((f) => {
    const box = toBox(f.box);
    let mem = memory.find((m) => overlaps(m.box, box));
    if (!mem) { mem = { box, reads: [], seen: now }; memory.push(mem); }
    const read = f.hit.kind === 'list' && !f.hit.fuzzy ? f.hit.watch.plate : f.hit.plate;
    mem.reads = mem.reads.concat(read).slice(-8);
    mem.box = box; mem.seen = now;
    let hit = f.hit;
    const voted = consensus(mem.reads);
    if (voted && voted !== hit.plate) {
      const h2 = matcher.classify(voted);
      if (h2 && h2.score >= hit.score) hit = h2;
    }
    // подтверждения номера из списка: сколько прочтений совпали с ним
    const listVotes = hit.kind === 'list'
      ? mem.reads.filter((r) => { const h = matcher.classify(r); return h?.kind === 'list' && h.watch.plate === hit.watch.plate; }).length
      : 0;
    return { box, hit, seen: now, listVotes };
  });
  const ttl = Math.max(900, cycleMs * 1.8);
  tracks = tracks.filter((o) => now - o.seen < ttl && !fresh.some((f) => overlaps(f.box, o.box))).concat(fresh);
  drawOverlay();
  updateStatus();

  for (const t of fresh) {
    if (t.hit.kind !== 'list') continue;
    // точное совпадение — сразу; «примерное» (≈) — только после двух подтверждений
    if (t.hit.fuzzy && t.listVotes < 2) continue;
    const w = t.hit.watch;
    const prev = lastSeen.get(w.plate);
    lastSeen.set(w.plate, now);
    if (prev && now - prev < SIGHTING_GAP) continue;
    alertFor(w.color);
    showBanner(w, t.hit);
    if (state.settings.autoLog) {
      const id = newId();
      addLog({ id, time: now, type: 'match', plates: [w.plate] });
      getLocation().then((loc) => loc && updateLog(id, loc));
    }
  }
}

// Устаревшие рамки убираем, даже если кадры не приходят
setInterval(() => {
  if (!tracks.length) return;
  const ttl = Math.max(900, cycleMs * 1.8);
  const n = tracks.length;
  tracks = tracks.filter((t) => Date.now() - t.seen < ttl);
  if (tracks.length !== n) { drawOverlay(); updateStatus(); }
}, 300);

// ============================================================ отрисовка рамок
function drawOverlay() {
  const dpr = window.devicePixelRatio || 1;
  const W = overlay.clientWidth, H = overlay.clientHeight;
  if (overlay.width !== Math.round(W * dpr) || overlay.height !== Math.round(H * dpr)) {
    overlay.width = Math.round(W * dpr); overlay.height = Math.round(H * dpr);
  }
  const c = overlay.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const order = { plate: 0, prefix: 1, list: 2 };
  for (const t of [...tracks].sort((a, b) => order[a.hit.kind] - order[b.hit.kind])) {
    const h = t.hit;
    if (h.kind === 'plate' && !state.settings.showAll) continue;
    const pad = 6;
    const l = t.box.x0 - pad, tp = t.box.y0 - pad, r = t.box.x1 + pad, b = t.box.y1 + pad;
    const col = h.color;
    const sw = h.kind === 'list' ? 4 : h.kind === 'prefix' ? 3 : 2;
    if (h.kind === 'list') { c.fillStyle = hexA(col, 0.22); roundRect(c, l, tp, r - l, b - tp, 8); c.fill(); }
    c.strokeStyle = hexA(col, h.kind === 'plate' ? 0.3 : 0.4); c.lineWidth = sw / 2.5;
    roundRect(c, l, tp, r - l, b - tp, 6); c.stroke();
    c.strokeStyle = hexA(col, h.kind === 'plate' ? 0.8 : 1); c.lineWidth = sw; c.lineCap = 'round';
    const len = Math.min(r - l, b - tp) * 0.35;
    c.beginPath();
    for (const [x, y, dx, dy] of [[l, tp, 1, 1], [r, tp, -1, 1], [l, b, 1, -1], [r, b, -1, -1]]) {
      c.moveTo(x + dx * len, y); c.lineTo(x, y); c.lineTo(x, y + dy * len);
    }
    c.stroke();

    const title = (h.fuzzy ? '≈ ' : '') + PlateText.pretty(h.watch?.plate || h.plate);
    const sub = h.kind === 'list' ? (h.watch.note || (h.watch.color === 'green' ? 'в списке · свой' : 'в списке · ИСКОМЫЙ'))
      : h.kind === 'prefix' && h.powiat ? `${h.powiat.code} · ${h.powiat.name}` : null;
    const bg = h.kind === 'plate' ? 'rgba(0,0,0,.55)' : col;
    const fg = h.kind === 'plate' ? '#fff' : (lum(col) > 0.6 ? '#000' : '#fff');
    drawLabel(c, title, sub, l, tp, bg, fg, W);
  }
}
function drawLabel(c, title, sub, x, top, bg, fg, W) {
  c.font = '700 15px ' + getComputedStyle(document.body).getPropertyValue('--mono');
  const tw = c.measureText(title).width;
  c.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--font');
  const sw = sub ? c.measureText(sub).width : 0;
  const w = Math.max(tw, sw) + 16, h = 15 + (sub ? 13 : 0) + 8;
  const y = Math.max(0, top - h - 6), lx = Math.max(0, Math.min(x, W - w));
  c.fillStyle = bg; roundRect(c, lx, y, w, h, 6); c.fill();
  c.fillStyle = fg;
  c.font = '700 15px ' + getComputedStyle(document.body).getPropertyValue('--mono');
  c.fillText(title, lx + 8, y + 4 + 13);
  if (sub) { c.globalAlpha = 0.85; c.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--font'); c.fillText(sub, lx + 8, y + 4 + 15 + 11); c.globalAlpha = 1; }
}
function roundRect(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
window.addEventListener('resize', drawOverlay);

// ============================================================ статус, баннер, тост
function visiblePlates() {
  return [...new Set(tracks.filter((t) => t.hit.kind !== 'plate' || state.settings.showAll).map((t) => t.hit.watch?.plate || t.hit.plate))];
}
function updateStatus() {
  if (!running) return;
  const red = state.plates.filter((p) => p.color !== 'green').length;
  const txt = recorder
    ? `Запись ${fmtDur(Date.now() - recStart)}`
    : `В кадре: ${visiblePlates().length} · искомых ${red} · своих ${state.plates.length - red} · кодов ${Object.keys(state.prefixes).length} · ${(cycleMs / 1000).toFixed(1)} с`;
  $('#status').textContent = txt;
  $('#dot').className = 'dot' + (recorder ? ' rec' : '');
}
let bannerTimer;
function showBanner(w, hit) {
  const col = w.color === 'green' ? GREEN : RED;
  const el = $('#banner');
  el.innerHTML = `<div class="banner" style="background:${hexA(col, 0.94)}"><div>
      <div class="t">${hit.fuzzy ? 'ВОЗМОЖНО, НОМЕР ИЗ СПИСКА' : w.color === 'green' ? 'Номер из списка (свой)' : 'НАЙДЕН ИСКОМЫЙ НОМЕР'}</div>
      ${w.note ? `<div class="n">${esc(w.note)}</div>` : ''}
      ${hit.plate !== w.plate ? `<div class="n">распознано: ${esc(PlateText.pretty(hit.plate))}</div>` : ''}
    </div>${plateHtml(w.plate, true)}</div>`;
  el.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => (el.hidden = true), 4500);
}
let toastTimer;
function toast(text, action, fn) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  el.style.paddingRight = action ? '' : '18px';
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; fn(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 3500 : 2200);
}
const fmtDur = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const plateHtml = (p, lg) => `<span class="plate${lg ? ' lg' : ''}"><span class="eu">PL</span><span class="num">${esc(PlateText.pretty(p))}</span></span>`;

// ============================================================ фото / видео
let recorder = null, recChunks = [], recStart = 0, recPlates = [], recAudio = null;

async function takePhoto() {
  click();
  const seen = visiblePlates();
  const c = document.createElement('canvas');
  const g = visibleRegion();
  c.width = Math.round(g.w); c.height = Math.round(g.h);
  c.getContext('2d').drawImage(video, g.x, g.y, g.w, g.h, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  const id = newId();
  try { await media.put(id, blob); } catch { /* без сохранения в журнал */ }
  addLog({ id, time: Date.now(), type: 'photo', plates: seen, media: 'image/jpeg' });
  getLocation().then((loc) => loc && updateLog(id, loc));
  offerSave(blob, 'Фото готово');
}

async function startVideo() {
  if (recorder || !window.MediaRecorder) { if (!window.MediaRecorder) toast('Видео не поддерживается этим браузером'); return; }
  click();
  recPlates = visiblePlates();
  const tracksForRec = [...stream.getVideoTracks()];
  if (state.settings.videoAudio) {
    try { recAudio = await navigator.mediaDevices.getUserMedia({ audio: true }); tracksForRec.push(...recAudio.getAudioTracks()); }
    catch { recAudio = null; }
  }
  const mime = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
  recorder = new MediaRecorder(new MediaStream(tracksForRec), mime ? { mimeType: mime } : undefined);
  recChunks = [];
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.onstop = async () => {
    const type = recorder.mimeType || mime || 'video/mp4';
    const blob = new Blob(recChunks, { type });
    recorder = null;
    recAudio?.getTracks().forEach((t) => t.stop()); recAudio = null;
    $('#shutter').classList.remove('rec');
    $('#hint').textContent = 'Нажмите — фото · удерживайте — видео';
    updateStatus();
    const id = newId();
    try { await media.put(id, blob); } catch { /* слишком большое */ }
    addLog({ id, time: Date.now(), type: 'video', plates: recPlates, media: type });
    getLocation().then((loc) => loc && updateLog(id, loc));
    offerSave(blob, 'Видео готово');
  };
  recorder.start(1000);
  recStart = Date.now();
  $('#shutter').classList.add('rec');
  $('#hint').textContent = 'Отпустите, чтобы остановить запись';
}
function stopVideo() { if (recorder && recorder.state !== 'inactive') recorder.stop(); }
setInterval(() => recorder && updateStatus(), 500);

// Нажатие — фото, удержание — видео
(() => {
  const btn = $('#shutter');
  let timer = null, held = false;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.classList.add('down');
    held = false;
    timer = setTimeout(() => { held = true; timer = null; startVideo(); }, 450);
  });
  const up = () => {
    btn.classList.remove('down');
    if (timer) { clearTimeout(timer); timer = null; takePhoto(); }
    else if (held) { held = false; stopVideo(); }
  };
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
})();

/** Сохранение файла: на iPhone — через меню «Поделиться» → «Сохранить изображение/видео». */
function offerSave(blob, title) {
  const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('webm') ? 'webm' : 'jpg';
  const name = `PF_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.${ext}`;
  const file = new File([blob], name, { type: blob.type });
  const url = URL.createObjectURL(blob);
  const isImg = blob.type.startsWith('image');
  openDialog(`
    <h3>${esc(title)}</h3>
    ${isImg ? `<img src="${url}" style="width:100%;border-radius:12px">` : `<video src="${url}" controls playsinline style="width:100%;border-radius:12px"></video>`}
    <div class="small">Файл сохранён в журнале приложения. Чтобы он появился в галерее — нажмите «Сохранить» и выберите «Сохранить ${isImg ? 'изображение' : 'видео'}».</div>
    <div class="btns"><button data-close>Закрыть</button><button class="ok" id="saveFile">Сохранить</button></div>`,
  () => URL.revokeObjectURL(url));
  $('#saveFile').onclick = () => shareOrDownload(file);
}
async function shareOrDownload(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ============================================================ точка GPS
$('#btnPoint').addEventListener('click', async () => {
  click();
  const seen = visiblePlates();
  toast('Определяю координаты…');
  const loc = await getLocation();
  if (!loc) return toast('Нет координат. Разрешите геолокацию для Safari в Настройках iPhone');
  addLog({ id: newId(), time: Date.now(), type: 'point', plates: seen, ...loc });
  toast(`Точка сохранена · ±${Math.round(loc.acc)} м`, 'Журнал', () => openSheet('journal'));
});

// ============================================================ панели
let currentSheet = null;
const ui = { tab: 'plates', q: '', filter: 'all', pq: '', onlyActive: false, jfilter: 'all', confirm: null };

function openSheet(name) { currentSheet = name; renderSheet(); }
function closeSheet() { currentSheet = null; $('#sheets').innerHTML = ''; ui.confirm = null; }

function renderSheet() {
  const host = $('#sheets');
  if (!currentSheet) { host.innerHTML = ''; return; }
  const scroll = host.querySelector('.sheet-body')?.scrollTop || 0;
  const focusId = document.activeElement?.id;
  const caret = document.activeElement?.selectionStart;
  host.innerHTML = { list: listSheet, journal: journalSheet, settings: settingsSheet }[currentSheet]();
  const body = host.querySelector('.sheet-body');
  if (body) body.scrollTop = scroll;
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch {} } }
}

const head = (title, actions = '') =>
  `<div class="sheet-head"><button class="icon-btn" data-act="close" aria-label="Назад">${I.back}</button><h2>${title}</h2>${actions}</div>`;

// ---------- списки
function listSheet() {
  return `<div class="sheet">${head('Списки')}
    <div class="tabs"><button data-act="tab" data-v="plates" class="${ui.tab === 'plates' ? 'on' : ''}">Номера</button>
    <button data-act="tab" data-v="powiats" class="${ui.tab === 'powiats' ? 'on' : ''}">Коды повятов</button></div>
    <div class="sheet-body">${ui.tab === 'plates' ? platesTab() : powiatsTab()}</div>
    ${ui.tab === 'plates' ? `<div class="fab"><button class="sec" data-act="import">Импорт</button><button data-act="add">+ Номер</button></div>` : ''}
  </div>`;
}
function platesTab() {
  const q = PlateText.normalize(ui.q);
  const red = state.plates.filter((p) => p.color !== 'green').length;
  const shown = state.plates
    .filter((p) => !q || p.plate.includes(q) || (p.note || '').toLowerCase().includes(ui.q.toLowerCase()))
    .filter((p) => ui.filter === 'all' || p.color === ui.filter)
    .sort((a, b) => (a.color === 'green') - (b.color === 'green') || a.plate.localeCompare(b.plate));
  const rows = shown.map((p) => {
    const col = p.color === 'green' ? GREEN : RED;
    const confirm = ui.confirm === p.plate;
    return `<div class="row"><span class="stripe" style="background:${col}"></span>
      <button class="main" data-act="edit" data-p="${p.plate}">${plateHtml(p.plate)}
        <span class="meta">${p.note ? esc(p.note) : (p.color === 'green' ? 'свой' : 'искомый')}</span></button>
      ${confirm
        ? `<button class="act" data-act="del" data-p="${p.plate}" style="color:var(--red)">Удалить</button><button class="icon-btn" data-act="nodel">✕</button>`
        : `<button class="toggle" data-act="color" data-p="${p.plate}" aria-label="Цвет"><i style="background:${RED}" class="${p.color !== 'green' ? 'on' : ''}"></i><i style="background:${GREEN}" class="${p.color === 'green' ? 'on' : ''}"></i></button>
           <button class="icon-btn" data-act="askdel" data-p="${p.plate}" aria-label="Удалить" style="color:var(--dim)">${I.trash}</button>`}
    </div>`;
  }).join('');
  return `<div class="search">${I.search}<input id="q" type="search" placeholder="Поиск номера или заметки" value="${esc(ui.q)}" autocomplete="off"></div>
    <div class="chips">
      <button class="chip ${ui.filter === 'all' ? 'on' : ''}" data-act="filter" data-v="all">Все · ${state.plates.length}</button>
      <button class="chip ${ui.filter === 'red' ? 'on' : ''}" data-act="filter" data-v="red"><i class="d" style="background:${RED}"></i>Искомые · ${red}</button>
      <button class="chip ${ui.filter === 'green' ? 'on' : ''}" data-act="filter" data-v="green"><i class="d" style="background:${GREEN}"></i>Свои · ${state.plates.length - red}</button>
    </div>
    ${state.plates.length ? `<div class="list">${rows || '<div class="empty">Ничего не найдено</div>'}</div>`
      : `<div class="empty"><b>Список пуст</b>Добавьте номер кнопкой «+ Номер» или загрузите файл plates.txt кнопкой «Импорт». Список хранится только на этом телефоне.</div>`}`;
}
function powiatsTab() {
  const q = ui.pq.trim().toLowerCase();
  const list = POWIATS.filter(([code, name, region]) =>
    (!ui.onlyActive || state.prefixes[code]) &&
    (!q || code.toLowerCase().startsWith(q) || name.toLowerCase().includes(q) || region.toLowerCase().includes(q)));
  let html = '', region = null;
  for (const [code, name, reg, svc] of list) {
    if (reg !== region) { region = reg; html += `<div class="group">${esc(reg)}</div>`; }
    const col = state.prefixes[code];
    html += `<button class="pw" data-act="pick" data-c="${code}"><span class="code" style="${col ? `background:${col};color:${lum(col) > 0.6 ? '#000' : '#fff'}` : ''}">${code}</span>
      <span class="nm">${esc(name)}${svc ? `<small>все номера, начинающиеся с ${code}</small>` : ''}</span></button>`;
  }
  const active = Object.entries(state.prefixes).sort();
  return `<div class="search">${I.search}<input id="pq" type="search" placeholder="Код (DW), город или воеводство" value="${esc(ui.pq)}" autocomplete="off"></div>
    ${active.length ? `<div class="active-codes">${active.map(([c, col]) =>
      `<button data-act="unpick" data-c="${c}" style="border-color:${col};background:${hexA(col, 0.2)}">${c} ✕</button>`).join('')}</div>` : ''}
    <div class="chips">
      <button class="chip ${!ui.onlyActive ? 'on' : ''}" data-act="only" data-v="0">Все · ${POWIATS.length}</button>
      <button class="chip ${ui.onlyActive ? 'on' : ''}" data-act="only" data-v="1">Выбранные · ${active.length}</button>
      ${active.length ? '<button class="chip" data-act="resetpw">Сбросить</button>' : ''}
    </div>${html || '<div class="empty">Ничего не найдено</div>'}`;
}

// ---------- журнал
const TYPE = {
  match: ['Найден номер из списка', 'Совпадения', I.bell],
  point: ['Сохранённая точка', 'Точки', I.place],
  photo: ['Фото', 'Фото', I.image],
  video: ['Видео', 'Видео', I.video],
};
function journalSheet() {
  const J = state.journal;
  const shown = J.filter((e) => ui.jfilter === 'all' || e.type === ui.jfilter);
  const colorOf = new Map(state.plates.map((p) => [p.plate, p.color]));
  const cards = shown.map((e) => {
    const accent = e.type === 'match' ? (colorOf.get(e.plates[0]) === 'green' ? GREEN : RED) : e.type === 'point' ? '#3D8BFF' : '#FFCC00';
    const has = e.lat != null;
    const label = encodeURIComponent(e.plates.map(PlateText.pretty).join(', ') || 'Точка');
    return `<div class="card"><div class="card-head">
        <span class="ic" style="background:${hexA(accent, 0.18)};color:${accent}">${TYPE[e.type][2]}</span>
        <span class="tt"><b>${TYPE[e.type][0]}</b><span>${fmtTime(e.time)}</span></span>
        ${ui.confirm === e.id ? `<button class="act" data-act="jdel" data-id="${e.id}" style="color:var(--red)">Удалить</button>`
          : `<button class="icon-btn" data-act="jask" data-id="${e.id}" style="color:var(--dim)" aria-label="Удалить">${I.trash}</button>`}
      </div>
      ${e.plates.length ? `<div class="plates">${e.plates.map((p) => plateHtml(p)).join('')}</div>` : ''}
      <div class="coords">
        <span>${has ? `${e.lat.toFixed(6)}, ${e.lon.toFixed(6)}${e.acc ? ` · ±${Math.round(e.acc)} м` : ''}` : 'без координат'}</span>
        ${has ? `<a class="act" target="_blank" rel="noopener" href="https://maps.apple.com/?ll=${e.lat},${e.lon}&q=${label}">${I.map}Apple</a>
          <a class="act" target="_blank" rel="noopener" href="https://maps.google.com/?q=${e.lat},${e.lon}">${I.map}Google</a>` : ''}
        ${e.media ? `<button class="act" data-act="media" data-id="${e.id}">${I.save}${e.type === 'video' ? 'Видео' : 'Фото'}</button>` : ''}
      </div></div>`;
  }).join('');
  const chips = Object.entries(TYPE).map(([t, v]) => {
    const n = J.filter((e) => e.type === t).length;
    return n ? `<button class="chip ${ui.jfilter === t ? 'on' : ''}" data-act="jfilter" data-v="${t}">${v[1]} · ${n}</button>` : '';
  }).join('');
  return `<div class="sheet">${head('Журнал', J.length ? `<button class="icon-btn" data-act="export" aria-label="Экспорт">${I.download}</button>` : '')}
    <div class="sheet-body">
      ${J.length ? `<div class="chips"><button class="chip ${ui.jfilter === 'all' ? 'on' : ''}" data-act="jfilter" data-v="all">Все · ${J.length}</button>${chips}</div>
        <div class="note">Кнопка ⬇ вверху — экспорт в CSV (Excel) и KML (карты). ${ui.confirm === 'clear'
          ? '<button class="act" data-act="clear" style="color:var(--red)">Точно удалить всё?</button>'
          : '<button class="act" data-act="askclear">Очистить журнал</button>'}</div>
        <div class="list">${cards || '<div class="empty">Нет записей этого типа</div>'}</div>`
      : `<div class="empty"><b>Записей пока нет</b>Сюда попадают найденные номера из списка, точки GPS (кнопка «Точка GPS»), фото и видео — с временем и координатами.</div>`}
    </div></div>`;
}
const fmtTime = (t) => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---------- настройки
const SETTINGS = [
  ['sound', 'Звук при совпадении'],
  ['vibrate', 'Вибрация', 'На iPhone браузер вибрацию не поддерживает'],
  ['fuzzy', 'Допуск ошибки распознавания', 'Находить номер из списка, если камера пропустила символ или спутала похожие (H/N, 7/1…). Помечается ≈'],
  ['showAll', 'Показывать все номера', 'Белые рамки у номеров не из списка'],
  ['autoLog', 'Записывать совпадения в журнал', 'С временем и координатами'],
  ['hiRes', 'Высокое качество', 'Читает номера дальше, но медленнее и сильнее греет телефон'],
  ['videoAudio', 'Звук в видео', 'Попросит доступ к микрофону'],
];
function settingsSheet() {
  return `<div class="sheet">${head('Настройки')}<div class="sheet-body">
    ${SETTINGS.map(([k, t, h]) => `<button class="set" data-act="set" data-k="${k}"><div>${t}${h ? `<small>${h}</small>` : ''}</div><span class="sw ${state.settings[k] ? 'on' : ''}"></span></button>`).join('')}
    <div class="info"><b>Установить как приложение.</b> В Safari нажмите «Поделиться» → «На экран „Домой“». Так приложение открывается без адресной строки, а iPhone не очищает ваш список и журнал.</div>
    <div class="info"><b>Где хранятся данные.</b> Список номеров, коды, журнал, фото и видео — только в памяти этого браузера на телефоне. Никуда не отправляются. Делайте экспорт журнала, если он важен.</div>
    <div class="info">Версия ${VERSION} · распознавание Tesseract.js · потоков: ${workers.length} · средний цикл ${(cycleMs / 1000).toFixed(1)} с</div>
  </div></div>`;
}

// ---------- обработчики
$('#sheets').addEventListener('input', (e) => {
  if (e.target.id === 'q') { ui.q = e.target.value; renderSheet(); }
  if (e.target.id === 'pq') { ui.pq = e.target.value; renderSheet(); }
});
$('#sheets').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const { act } = b.dataset;
  const p = b.dataset.p, id = +b.dataset.id;
  switch (act) {
    case 'close': return closeSheet();
    case 'tab': ui.tab = b.dataset.v; break;
    case 'filter': ui.filter = ui.filter === b.dataset.v ? 'all' : b.dataset.v; break;
    case 'add': return plateDialog(null);
    case 'edit': return plateDialog(state.plates.find((x) => x.plate === p));
    case 'color': { const x = state.plates.find((y) => y.plate === p); x.color = x.color === 'green' ? 'red' : 'green'; savePlates(); break; }
    case 'askdel': ui.confirm = p; break;
    case 'nodel': ui.confirm = null; break;
    case 'del': state.plates = state.plates.filter((x) => x.plate !== p); ui.confirm = null; savePlates(); break;
    case 'import': return importDialog();
    case 'pick': return colorDialog(b.dataset.c);
    case 'unpick': delete state.prefixes[b.dataset.c]; savePrefixes(); break;
    case 'only': ui.onlyActive = b.dataset.v === '1'; break;
    case 'resetpw': state.prefixes = {}; savePrefixes(); break;
    case 'jfilter': ui.jfilter = ui.jfilter === b.dataset.v ? 'all' : b.dataset.v; break;
    case 'jask': ui.confirm = id; break;
    case 'jdel': state.journal = state.journal.filter((x) => x.id !== id); media.del(id).catch(() => {}); ui.confirm = null; saveJournal(); break;
    case 'askclear': ui.confirm = 'clear'; break;
    case 'clear': state.journal = []; media.clear().catch(() => {}); ui.confirm = null; saveJournal(); break;
    case 'media': {
      const blob = await media.get(id).catch(() => null);
      if (!blob) return toast('Файл не найден (возможно, был слишком большим)');
      return offerSave(blob, b.textContent.trim());
    }
    case 'export': return exportJournal();
    case 'set': state.settings[b.dataset.k] = !state.settings[b.dataset.k]; saveSettings(); break;
  }
  renderSheet();
});
$('#btnList').addEventListener('click', () => openSheet('list'));
$('#btnJournal').addEventListener('click', () => openSheet('journal'));
$('#btnSettings').addEventListener('click', () => openSheet('settings'));

// ============================================================ диалоги
function openDialog(html, onClose) {
  const host = $('#dialogs');
  host.innerHTML = `<div class="dialog-bg"><div class="dialog" role="dialog">${html}</div></div>`;
  const close = () => { host.innerHTML = ''; onClose?.(); };
  host.querySelector('.dialog-bg').addEventListener('click', (e) => { if (e.target.classList.contains('dialog-bg') || e.target.closest('[data-close]')) close(); });
  return close;
}

function plateDialog(existing) {
  let color = existing?.color || 'red';
  const close = openDialog(`
    <h3>${existing ? 'Изменить номер' : 'Новый номер'}</h3>
    <label>Номер<input type="text" class="big" id="dPlate" placeholder="WA 12345" autocapitalize="characters" autocomplete="off" value="${existing ? esc(PlateText.pretty(existing.plate)) : ''}"></label>
    <div id="dPreview" class="small"></div>
    <label>Цвет подсветки<div class="seg" id="dColor">
      <button data-c="red"><i style="background:${RED}"></i>Искомый</button>
      <button data-c="green"><i style="background:${GREEN}"></i>Свой</button></div></label>
    <label>Заметка (необязательно)<input type="text" id="dNote" placeholder="например: серый Passat" value="${esc(existing?.note || '')}"></label>
    <div class="btns"><button data-close>Отмена</button><button class="ok" id="dSave">Сохранить</button></div>`);
  const inp = $('#dPlate');
  const paint = () => {
    for (const b of document.querySelectorAll('#dColor button')) {
      const on = b.dataset.c === color, c = on ? (color === 'green' ? GREEN : RED) : 'transparent';
      b.style.borderColor = c; b.style.background = on ? hexA(color === 'green' ? GREEN : RED, 0.22) : '';
    }
    const n = PlateText.normalize(inp.value);
    const pw = powiatMap.get(PlateText.codeOf(n) || '');
    $('#dPreview').innerHTML = n.length >= 3 ? `${plateHtml(n)} ${pw ? esc(pw.name) : ''}` : '';
    $('#dSave').disabled = n.length < 3;
  };
  inp.addEventListener('input', () => { inp.value = inp.value.toUpperCase(); paint(); });
  $('#dColor').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { color = b.dataset.c; paint(); } });
  $('#dSave').onclick = () => {
    const plate = PlateText.normalize(inp.value);
    const note = $('#dNote').value.trim();
    if (existing) state.plates = state.plates.filter((x) => x.plate !== existing.plate);
    state.plates = state.plates.filter((x) => x.plate !== plate);
    state.plates.push({ plate, color, note, addedAt: existing?.addedAt || Date.now() });
    savePlates(); close(); renderSheet();
  };
  paint();
  if (!existing) setTimeout(() => inp.focus(), 50);
}

function importDialog() {
  const close = openDialog(`
    <h3>Импорт номеров</h3>
    <div class="small">Формат как в plates.txt: один номер в строке, после номера можно red/green, после «|» — заметка.</div>
    <textarea id="dText" placeholder="WA 12345&#10;DW 1AB23 green&#10;KR 5XY90 | серый Passat"></textarea>
    <label style="flex-direction:row;align-items:center;gap:10px;color:var(--text)"><input type="checkbox" id="dReplace"> Заменить весь список (иначе — добавить)</label>
    <div class="btns"><button id="dFile">Выбрать файл…</button><button data-close>Отмена</button><button class="ok" id="dImport">Импортировать</button></div>`);
  $('#dFile').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = async (e) => {
    const f = e.target.files[0];
    if (f) $('#dText').value = await f.text();
    e.target.value = '';
  };
  $('#dImport').onclick = () => {
    const rows = $('#dText').value.split(/\r?\n/).map(parsePlateLine).filter(Boolean);
    if (!rows.length) return toast('Не найдено ни одного номера');
    const map = new Map(($('#dReplace').checked ? [] : state.plates).map((p) => [p.plate, p]));
    for (const r of rows) map.set(r.plate, { ...map.get(r.plate), ...r, note: r.note || map.get(r.plate)?.note || '', addedAt: map.get(r.plate)?.addedAt || Date.now() });
    state.plates = [...map.values()];
    savePlates(); close(); renderSheet();
    toast(`Импортировано номеров: ${rows.length}`);
  };
}

function colorDialog(code) {
  const pw = powiatMap.get(code), cur = state.prefixes[code];
  const close = openDialog(`
    <h3>${code} — ${esc(pw.name)}</h3>
    <div class="small">Цвет подсветки номеров этого ${pw.service ? 'кода' : 'повята'}</div>
    <div class="palette">${PREFIX_PALETTE.map((c) => `<button data-c="${c}" class="${c === cur ? 'on' : ''}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div>
    <div class="btns">${cur ? '<button class="danger" id="dOff">Отключить</button>' : ''}<button data-close>Закрыть</button></div>`);
  document.querySelector('.palette').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.prefixes[code] = b.dataset.c; savePrefixes(); close(); renderSheet();
  };
  if (cur) $('#dOff').onclick = () => { delete state.prefixes[code]; savePrefixes(); close(); renderSheet(); };
}

// ============================================================ экспорт журнала
function exportJournal() {
  const J = state.journal.filter((e) => ui.jfilter === 'all' || e.type === ui.jfilter);
  const d = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  const csv = '﻿Дата (UTC);Тип;Номера;Широта;Долгота;Точность (м);Карта\r\n' + J.map((e) => [
    d(e.time), TYPE[e.type][0], e.plates.map(PlateText.pretty).join(' '),
    e.lat?.toFixed(6) ?? '', e.lon?.toFixed(6) ?? '', e.acc ? Math.round(e.acc) : '',
    e.lat != null ? `https://maps.google.com/?q=${e.lat.toFixed(6)},${e.lon.toFixed(6)}` : '',
  ].join(';')).join('\r\n');
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>PlateFinder</name>\n` +
    J.filter((e) => e.lat != null).map((e) => `<Placemark><name>${x(e.plates.map(PlateText.pretty).join(', ') || TYPE[e.type][0])}</name><description>${x(TYPE[e.type][0] + ' · ' + fmtTime(e.time))}</description><TimeStamp><when>${new Date(e.time).toISOString()}</when></TimeStamp><Point><coordinates>${e.lon.toFixed(6)},${e.lat.toFixed(6)},0</coordinates></Point></Placemark>`).join('\n') +
    '\n</Document></kml>\n';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const files = [
    new File([csv], `PlateFinder_${stamp}.csv`, { type: 'text/csv' }),
    new File([kml], `PlateFinder_${stamp}.kml`, { type: 'application/vnd.google-earth.kml+xml' }),
  ];
  if (navigator.canShare?.({ files })) navigator.share({ files }).catch(() => {});
  else files.forEach((f) => shareOrDownload(f));
}

// ============================================================ запуск
$('#btnSettings').innerHTML = I.settings;
$('#btnList .ic').innerHTML = I.list;
$('#btnJournal .ic').innerHTML = I.history;
$('#btnPoint .ic').innerHTML = I.pin;
$('#btnTorch .ic').innerHTML = I.flashOff;
$('#btnTorch').hidden = true;

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && running) keepAwake(); });

$('#btnStart').addEventListener('click', async () => {
  unlockAudio();
  const btn = $('#btnStart');
  btn.disabled = true;
  btn.textContent = 'Запуск камеры…';
  try {
    await startCamera();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Попробовать снова';
    $('#startNote').textContent = location.protocol !== 'https:' && location.hostname !== 'localhost'
      ? 'Камера работает только по https://'
      : 'Нет доступа к камере. Разрешите камеру для Safari: Настройки → Safari → Камера → Разрешить.';
    return;
  }
  btn.textContent = 'Загрузка распознавания…';
  $('#progress').hidden = false;
  try {
    await initOCR((p) => ($('#progress i').style.width = Math.round(p * 100) + '%'));
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Попробовать снова';
    $('#startNote').textContent = 'Не удалось загрузить модель распознавания. Нужен интернет при первом запуске.';
    return;
  }
  $('#start').hidden = true;
  running = true;
  rebuildMatcher();
  keepAwake();
  navigator.storage?.persist?.();
  scanLoop();
  updateStatus();
});

rebuildMatcher();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// отладка на компьютере разработчика (на сайте не включается)
if (location.hostname === 'localhost') {
  window.__pf = {
    handleFrame: (found) => { running = true; handleFrame(found, 1); },
    get tracks() { return tracks; },
    get matcher() { return matcher; },
  };
}
