// Обработка одного кадра: найти таблички → подготовить чистую вырезку → прочитать Tesseract'ом → классифицировать.
import { findPlateRegions, findWhitePlates, findCharLines, mergeRegions, toGray, otsu } from './detector.js';
import { bestInLine } from './matcher.js';

const small = document.createElement('canvas');
const smallCtx = small.getContext('2d', { willReadFrequently: true });
const work = [];
const crops = [];

const LOCATE_W = 640;   // ширина копии кадра для поиска табличек
const WORK_H = 140;     // высота, до которой увеличиваем область для анализа
const CHAR_H = 56;      // высота строки символов в вырезке для Tesseract
const MARGIN = 12;      // белые поля вокруг строки (Tesseract читает лучше с полями)

/** Настройки Tesseract для чтения одной строки номера. */
export const OCR_PARAMS = {
  tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  tessedit_pageseg_mode: '7', // одна строка текста
  user_defined_dpi: '300',
};
/** Параметры, которые задаются только при создании потока: без словаря (номер — не слово). */
export const OCR_INIT = { load_system_dawg: '0', load_freq_dawg: '0' };

/** Для отладки: последние подготовленные вырезки. */
export const debug = { crops: [] };

/**
 * frame: canvas с видимой частью кадра
 * -> {detections: [{hit, box, text}] (координаты frame), regions: [...]}
 */
export async function scanFrame(frame, workers, matcher, maxRegions = 6) {
  const fw = frame.width, fh = frame.height;
  const sw = Math.min(LOCATE_W, fw), sh = Math.round((fh * sw) / fw);
  small.width = sw; small.height = sh;
  smallCtx.drawImage(frame, 0, 0, sw, sh);
  const gray = toGray(smallCtx.getImageData(0, 0, sw, sh).data, sw * sh);
  const k = fw / sw;
  // приоритет: строки символов → белые таблички → области с плотными контурами
  const lines = findCharLines(gray, sw, sh, maxRegions);
  const white = findWhitePlates(gray, sw, sh, maxRegions);
  const edges = findPlateRegions(gray, sw, sh, maxRegions);
  const regions = mergeRegions([
    lines.map((r) => ({ ...r, score: r.score + 2000 })),
    white.map((r) => ({ ...r, score: r.score + 1000 })),
    edges,
  ], maxRegions).map((r) => {
    // с запасом, чтобы в область целиком попало белое поле таблички
    const px = r.w * 0.25 + 3, py = r.h * 0.7 + 3;
    const x = Math.max(0, (r.x - px) * k), y = Math.max(0, (r.y - py) * k);
    return { x, y, w: Math.min(fw - x, (r.w + 2 * px) * k), h: Math.min(fh - y, (r.h + 2 * py) * k) };
  });

  debug.crops = [];
  const detections = [];
  let next = 0;
  await Promise.all(workers.map(async (worker, wi) => {
    const wc = (work[wi] ||= document.createElement('canvas'));
    const oc = (crops[wi] ||= document.createElement('canvas'));
    while (next < regions.length) {
      const r = regions[next++];
      try {
        const prep = prepareCrop(frame, r, wc, oc);
        if (!prep) continue;
        const { data } = await worker.recognize(oc);
        const text = (data.text || '').trim();
        if (debug.enabled) debug.crops.push({ url: oc.toDataURL(), text });
        const parts = (data.words || []).map((w) => ({
          text: w.text,
          box: prep.toFrame(w.bbox),
        }));
        if (!parts.length && text) parts.push({ text, box: prep.plateBox });
        const best = bestInLine(parts, matcher);
        // рамку рисуем по всей табличке — так стабильнее и аккуратнее
        if (best) detections.push({ ...best, box: prep.plateBox, text });
      } catch { /* пропускаем вырезку */ }
    }
  }));
  return { detections, regions };
}

/**
 * Готовит вырезку для Tesseract:
 *  1) находит внутри области белое поле таблички (самая большая светлая область нужной формы);
 *  2) закрашивает синее (полоса ЕС «PL», полосы на кузове);
 *  3) оставляет только строку крупных символов — без рамки дилера и наклеек;
 *  4) увеличивает до удобной для Tesseract высоты, делает чёрно-белой, добавляет поля.
 */
export function prepareCrop(frame, r, wc, oc) {
  const s = WORK_H / r.h;
  const W = Math.max(8, Math.round(r.w * s)), H = WORK_H;
  wc.width = W; wc.height = H;
  const wctx = wc.getContext('2d', { willReadFrequently: true });
  wctx.imageSmoothingQuality = 'high';
  wctx.drawImage(frame, r.x, r.y, r.w, r.h, 0, 0, W, H);
  const img = wctx.getImageData(0, 0, W, H);
  const px = img.data;
  const n = W * H;

  // яркость; синее считаем белым фоном
  const gray = new Uint8Array(n);
  const blue = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const R = px[j], G = px[j + 1], B = px[j + 2];
    blue[i] = B > R + 35 && B > G + 10 ? 1 : 0;
    gray[i] = (R * 77 + G * 150 + B * 29) >> 8;
  }

  // 1. белое поле таблички
  const tW = otsu(gray);
  const plate = largestBright(gray, blue, W, H, tW) || { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };
  const pw = plate.x1 - plate.x0 + 1, ph = plate.y1 - plate.y0 + 1;

  // 2. порог внутри таблички, тёмные пиксели = символы
  const inside = [];
  for (let y = plate.y0; y <= plate.y1; y++) for (let x = plate.x0; x <= plate.x1; x++) {
    const i = y * W + x;
    if (!blue[i]) inside.push(gray[i]);
  }
  const tT = otsu(inside.length ? inside : gray);
  const dark = (x, y) => { const i = y * W + x; return !blue[i] && gray[i] <= tT; };

  // 3. строка символов: самая высокая полоса строк с тёмными пикселями (рамка — слишком сплошная, дилер — ниже и тоньше)
  const rowDark = new Float32Array(ph);
  for (let y = 0; y < ph; y++) {
    let c = 0;
    for (let x = plate.x0; x <= plate.x1; x++) if (dark(x, plate.y0 + y)) c++;
    rowDark[y] = c / pw;
  }
  let best = null, cur = null, gap = 0;
  for (let y = 0; y < ph; y++) {
    const isText = rowDark[y] > 0.06 && rowDark[y] < 0.75;
    if (isText) {
      if (!cur) cur = { y0: y, y1: y };
      cur.y1 = y; gap = 0;
    } else if (cur && ++gap > 2) {
      if (!best || cur.y1 - cur.y0 > best.y1 - best.y0) best = cur;
      cur = null; gap = 0;
    }
  }
  if (cur && (!best || cur.y1 - cur.y0 > best.y1 - best.y0)) best = cur;
  if (!best || best.y1 - best.y0 < ph * 0.25) best = { y0: 0, y1: ph - 1 };
  const by0 = plate.y0 + best.y0, by1 = plate.y0 + best.y1;
  const bh = by1 - by0 + 1;

  // по горизонтали: убираем только пустые края (рамка уже снаружи белого поля;
  // «сплошные» столбцы резать нельзя — это может быть палочка буквы H, I, 1)
  const colDark = (x) => { let c = 0; for (let y = by0; y <= by1; y++) if (dark(x, y)) c++; return c; };
  let bx0 = plate.x0, bx1 = plate.x1;
  while (bx0 < bx1 && colDark(bx0) === 0) bx0++;
  while (bx1 > bx0 && colDark(bx1) === 0) bx1--;
  bx0 = Math.max(plate.x0, bx0 - 2); bx1 = Math.min(plate.x1, bx1 + 2);
  const bw = bx1 - bx0 + 1;
  if (bw < bh * 1.5) return null; // слишком узко для номера

  // 4. итоговая вырезка: ч/б, строка символов высотой CHAR_H, белые поля
  const k = CHAR_H / bh;
  const ow = Math.round(bw * k) + MARGIN * 2, oh = CHAR_H + MARGIN * 2;
  oc.width = ow; oc.height = oh;
  const octx = oc.getContext('2d', { willReadFrequently: true });
  const bin = wctx.createImageData(bw, bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const v = dark(bx0 + x, by0 + y) ? 0 : 255;
    const j = (y * bw + x) * 4;
    bin.data[j] = bin.data[j + 1] = bin.data[j + 2] = v; bin.data[j + 3] = 255;
  }
  wctx.putImageData(bin, 0, 0);
  octx.fillStyle = '#fff'; octx.fillRect(0, 0, ow, oh);
  octx.imageSmoothingEnabled = true;
  octx.drawImage(wc, 0, 0, bw, bh, MARGIN, MARGIN, ow - MARGIN * 2, CHAR_H);

  // перевод координат: вырезка → кадр
  const toFrame = (b) => ({
    x0: r.x + (bx0 + (b.x0 - MARGIN) / k) / s,
    y0: r.y + (by0 + (b.y0 - MARGIN) / k) / s,
    x1: r.x + (bx0 + (b.x1 - MARGIN) / k) / s,
    y1: r.y + (by0 + (b.y1 - MARGIN) / k) / s,
  });
  const plateBox = {
    x0: r.x + plate.x0 / s, y0: r.y + plate.y0 / s,
    x1: r.x + (plate.x1 + 1) / s, y1: r.y + (plate.y1 + 1) / s,
  };
  return { toFrame, plateBox };
}

/** Самая большая светлая область вытянутой формы (белое поле таблички). */
function largestBright(gray, blue, W, H, t) {
  const n = W * H;
  const lab = new Int32Array(n);
  const stack = [];
  let best = null, id = 0;
  for (let i = 0; i < n; i++) {
    if (lab[i] || blue[i] || gray[i] <= t) continue;
    id++;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0;
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p - x) / W;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q >= 0 && !lab[q] && !blue[q] && gray[q] > t) { lab[q] = id; stack.push(q); }
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w < W * 0.3 || h < H * 0.15) continue;
    const aspect = w / h;
    if (aspect < 1.8 || aspect > 9) continue;
    if (!best || area > best.area) best = { x0, y0, x1, y1, area };
  }
  return best;
}
