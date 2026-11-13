// Поиск табличек на кадре и подготовка вырезок для Tesseract.
// Не использует DOM: работает и в фоновом потоке (OffscreenCanvas), и в основном (обычный canvas).
import { findPlateRegions, findWhitePlates, findCharLines, mergeRegions, toGray, otsu } from './detector.js';

const LOCATE_W = 640;   // ширина копии кадра для поиска табличек
const WORK_H = 140;     // высота, до которой увеличиваем область для анализа
const CHAR_H = 56;      // высота строки символов в вырезке для Tesseract
export const MARGIN = 12; // белые поля вокруг строки (Tesseract читает лучше с полями)

/**
 * Находит на кадре области, похожие на номерные знаки.
 * frame — canvas/OffscreenCanvas; makeCanvas(w, h) создаёт холст того же типа.
 */
export function locateRegions(frame, makeCanvas, maxRegions, cache = {}) {
  const fw = frame.width, fh = frame.height;
  const sw = Math.min(LOCATE_W, fw), sh = Math.round((fh * sw) / fw);
  const small = (cache.small ||= makeCanvas(sw, sh));
  small.width = sw; small.height = sh;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(frame, 0, 0, sw, sh);
  const gray = toGray(ctx.getImageData(0, 0, sw, sh).data, sw * sh);
  const k = fw / sw;
  // приоритет: строки символов → белые таблички → области с плотными контурами
  const lines = findCharLines(gray, sw, sh, maxRegions);
  const white = findWhitePlates(gray, sw, sh, maxRegions);
  const edges = findPlateRegions(gray, sw, sh, maxRegions);
  return mergeRegions([
    lines.map((r) => ({ ...r, score: r.score + 2000 })),
    white.map((r) => ({ ...r, score: r.score + 1000 })),
    edges,
  ], maxRegions).map((r) => {
    // с запасом, чтобы в область целиком попало белое поле таблички
    const px = r.w * 0.25 + 3, py = r.h * 0.7 + 3;
    const x = Math.max(0, (r.x - px) * k), y = Math.max(0, (r.y - py) * k);
    return { x, y, w: Math.min(fw - x, (r.w + 2 * px) * k), h: Math.min(fh - y, (r.h + 2 * py) * k) };
  });
}

/**
 * Готовит вырезку для Tesseract в холсте oc:
 *  1) находит внутри области белое поле таблички (самая большая светлая область нужной формы);
 *  2) закрашивает синее (полоса ЕС «PL», полосы на кузове);
 *  3) оставляет только строку крупных символов — без рамки дилера и наклеек;
 *  4) увеличивает до удобной для Tesseract высоты, делает чёрно-белой, добавляет поля.
 * Возвращает числа для перевода координат вырезки обратно в кадр (map) и рамку таблички.
 */
export function prepareCrop(frame, r, wc, oc) {
  const s = WORK_H / r.h;
  const W = Math.max(8, Math.round(r.w * s)), H = WORK_H;
  wc.width = W; wc.height = H;
  const wctx = wc.getContext('2d', { willReadFrequently: true });
  wctx.imageSmoothingQuality = 'high';
  wctx.drawImage(frame, r.x, r.y, r.w, r.h, 0, 0, W, H);
  const px = wctx.getImageData(0, 0, W, H).data;
  const n = W * H;

  // яркость; синее считаем фоном
  const gray = new Uint8Array(n);
  const blue = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const R = px[j], G = px[j + 1], B = px[j + 2];
    blue[i] = B > R + 35 && B > G + 10 ? 1 : 0;
    gray[i] = (R * 77 + G * 150 + B * 29) >> 8;
  }

  // 1. белое поле таблички
  const plate = largestBright(gray, blue, W, H, otsu(gray)) || { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };
  const pw = plate.x1 - plate.x0 + 1, ph = plate.y1 - plate.y0 + 1;

  // 2. порог внутри таблички: тёмные пиксели = символы
  const inside = new Uint8Array(pw * ph);
  let m = 0;
  for (let y = plate.y0; y <= plate.y1; y++) for (let x = plate.x0; x <= plate.x1; x++) {
    const i = y * W + x;
    if (!blue[i]) inside[m++] = gray[i];
  }
  const tT = otsu(m ? inside.subarray(0, m) : gray);
  const dark = new Uint8Array(n);
  for (let i = 0; i < n; i++) dark[i] = !blue[i] && gray[i] <= tT ? 1 : 0;

  // 3. строка символов: самая высокая полоса строк с тёмными пикселями
  //    (рамка — слишком сплошная, надпись дилера — ниже и тоньше)
  let best = null, cur = null, gap = 0;
  for (let y = 0; y < ph; y++) {
    let c = 0;
    const row = (plate.y0 + y) * W;
    for (let x = plate.x0; x <= plate.x1; x++) c += dark[row + x];
    const f = c / pw;
    if (f > 0.06 && f < 0.75) {
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
  const colDark = (x) => { let c = 0; for (let y = by0; y <= by1; y++) c += dark[y * W + x]; return c; };
  let bx0 = plate.x0, bx1 = plate.x1;
  while (bx0 < bx1 && colDark(bx0) === 0) bx0++;
  while (bx1 > bx0 && colDark(bx1) === 0) bx1--;
  bx0 = Math.max(plate.x0, bx0 - 2); bx1 = Math.min(plate.x1, bx1 + 2);
  const bw = bx1 - bx0 + 1;
  if (bw < bh * 1.5) return null; // слишком узко для номера

  // 4. итоговая вырезка: ч/б, строка символов высотой CHAR_H, белые поля
  const k = CHAR_H / bh;
  const ow = Math.round(bw * k) + MARGIN * 2, oh = CHAR_H + MARGIN * 2;
  const bin = wctx.createImageData(bw, bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const v = dark[(by0 + y) * W + bx0 + x] ? 0 : 255;
    const j = (y * bw + x) * 4;
    bin.data[j] = bin.data[j + 1] = bin.data[j + 2] = v; bin.data[j + 3] = 255;
  }
  wctx.putImageData(bin, 0, 0);
  oc.width = ow; oc.height = oh;
  const octx = oc.getContext('2d', { willReadFrequently: true });
  octx.fillStyle = '#fff'; octx.fillRect(0, 0, ow, oh);
  octx.imageSmoothingEnabled = true;
  octx.drawImage(wc, 0, 0, bw, bh, MARGIN, MARGIN, ow - MARGIN * 2, CHAR_H);

  return {
    map: { rx: r.x, ry: r.y, s, bx0, by0, k },
    plateBox: {
      x0: r.x + plate.x0 / s, y0: r.y + plate.y0 / s,
      x1: r.x + (plate.x1 + 1) / s, y1: r.y + (plate.y1 + 1) / s,
    },
  };
}

/** Перевод рамки слова из координат вырезки в координаты кадра. */
export function cropToFrame(map, b) {
  const { rx, ry, s, bx0, by0, k } = map;
  return {
    x0: rx + (bx0 + (b.x0 - MARGIN) / k) / s,
    y0: ry + (by0 + (b.y0 - MARGIN) / k) / s,
    x1: rx + (bx0 + (b.x1 - MARGIN) / k) / s,
    y1: ry + (by0 + (b.y1 - MARGIN) / k) / s,
  };
}

/** Самая большая светлая область вытянутой формы (белое поле таблички). */
function largestBright(gray, blue, W, H, t) {
  const n = W * H;
  const lab = new Int32Array(n);
  const stack = new Int32Array(n);
  let best = null, id = 0;
  const ok = (q) => !lab[q] && !blue[q] && gray[q] > t;
  for (let i = 0; i < n; i++) {
    if (!ok(i)) continue;
    id++;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0, sp = 0;
    stack[sp++] = i; lab[i] = id;
    while (sp) {
      const p = stack[--sp];
      const x = p % W, y = (p - x) / W;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && ok(p - 1)) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (x < W - 1 && ok(p + 1)) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && ok(p - W)) { lab[p - W] = id; stack[sp++] = p - W; }
      if (y < H - 1 && ok(p + W)) { lab[p + W] = id; stack[sp++] = p + W; }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w < W * 0.3 || h < H * 0.15) continue;
    const aspect = w / h;
    if (aspect < 1.8 || aspect > 9) continue;
    if (!best || area > best.area) best = { x0, y0, x1, y1, area };
  }
  return best;
}
