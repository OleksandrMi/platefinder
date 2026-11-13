// Обработка одного кадра: найти таблички → подготовить чистые вырезки → прочитать Tesseract'ом → классифицировать.
// Поиск и вырезки выполняются в фоновом потоке (scan-worker.js), чтобы интерфейс не «замирал».
// Если браузер не умеет рисовать в фоновом потоке (старые iOS) — то же самое в основном, с паузами.
import { locateRegions, prepareCrop, cropToFrame } from './prep.js';
import { bestInLine } from './matcher.js';

/** Настройки Tesseract для чтения одной строки номера. */
export const OCR_PARAMS = {
  tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  tessedit_pageseg_mode: '7', // одна строка текста
  user_defined_dpi: '300',
};
/** Параметры, которые задаются только при создании потока: без словаря (номер — не слово). */
export const OCR_INIT = { load_system_dawg: '0', load_freq_dawg: '0' };

/** Для отладки: последние вырезки и режим работы. */
export const debug = { crops: [], mode: '' };

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

// ---------- фоновый поток
let bg = null;          // Promise<Worker|null>
let seq = 0;
const pending = new Map();

function backgroundWorker() {
  if (bg) return bg;
  bg = new Promise((resolve) => {
    let w;
    try { w = new Worker(new URL('./scan-worker.js', import.meta.url), { type: 'module' }); }
    catch { resolve(null); return; }
    const timer = setTimeout(() => { w.terminate(); resolve(null); }, 4000);
    w.onmessage = ({ data }) => {
      if (data.probe) {
        clearTimeout(timer);
        if (!data.ok) { w.terminate(); resolve(null); return; }
        w.onmessage = ({ data: d }) => {
          const p = pending.get(d.id);
          if (!p) return;
          pending.delete(d.id);
          d.error ? p.reject(new Error(d.error)) : p.resolve(d);
        };
        resolve(w);
      }
    };
    w.onerror = () => { clearTimeout(timer); resolve(null); };
    w.postMessage({ probe: true });
  });
  return bg;
}

async function prepareInBackground(w, frame, maxRegions) {
  const bitmap = await createImageBitmap(frame);
  const id = ++seq;
  const res = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, bitmap, maxRegions }, [bitmap]);
  });
  return {
    regions: res.regions,
    crops: res.crops.map((c) => ({ ...c, img: new ImageData(new Uint8ClampedArray(c.buf), c.w, c.h) })),
  };
}

// ---------- запасной вариант: основной поток с паузами
const mainCache = {};
const mainCanvases = {};
const domCanvas = (w = 1, h = 1) => Object.assign(document.createElement('canvas'), { width: w, height: h });

async function prepareOnMain(frame, maxRegions) {
  const regions = locateRegions(frame, domCanvas, maxRegions, mainCache);
  const crops = [];
  for (const r of regions) {
    await yieldToUI(); // даём браузеру обработать нажатия между вырезками
    const wc = (mainCanvases.wc ||= domCanvas()), oc = (mainCanvases.oc ||= domCanvas());
    const p = prepareCrop(frame, r, wc, oc);
    if (!p) continue;
    crops.push({ ...p, img: oc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, oc.width, oc.height) });
  }
  return { regions, crops };
}

// ---------- кадр целиком
const ocrCanvases = [];

/**
 * frame: canvas с видимой частью кадра
 * -> {detections: [{hit, box, text}] (координаты frame), regions: [...]}
 */
export async function scanFrame(frame, workers, matcher, maxRegions = 6) {
  const w = await backgroundWorker();
  let prepared;
  if (w) {
    debug.mode = 'фоновый поток';
    prepared = await prepareInBackground(w, frame, maxRegions);
  } else {
    debug.mode = 'основной поток';
    prepared = await prepareOnMain(frame, maxRegions);
  }

  const { regions, crops } = prepared;
  debug.crops = [];
  const detections = [];
  let next = 0;
  await Promise.all(workers.map(async (worker, wi) => {
    const canvas = (ocrCanvases[wi] ||= document.createElement('canvas'));
    while (next < crops.length) {
      const c = crops[next++];
      try {
        canvas.width = c.img.width; canvas.height = c.img.height;
        canvas.getContext('2d').putImageData(c.img, 0, 0);
        const { data } = await worker.recognize(canvas);
        const text = (data.text || '').trim();
        if (debug.enabled) debug.crops.push({ url: canvas.toDataURL(), text });
        const parts = (data.words || []).map((wd) => ({ text: wd.text, box: cropToFrame(c.map, wd.bbox) }));
        if (!parts.length && text) parts.push({ text, box: c.plateBox });
        const best = bestInLine(parts, matcher);
        // рамку рисуем по всей табличке — так стабильнее и аккуратнее
        if (best) detections.push({ ...best, box: c.plateBox, text });
      } catch { /* пропускаем вырезку */ }
    }
  }));
  return { detections, regions };
}
