// Обработка одного кадра: найти таблички → прочитать каждую вырезку Tesseract'ом → классифицировать.
import { findPlateRegions, findWhitePlates, mergeRegions, toGray, otsu } from './detector.js';
import { bestInLine } from './matcher.js';

const small = document.createElement('canvas');
const smallCtx = small.getContext('2d', { willReadFrequently: true });
const crops = [];

const LOCATE_W = 640;   // ширина копии кадра для поиска табличек
const CROP_H = 64;      // высота вырезки для Tesseract (оптимум для его модели ~ 30–40 px на символ)

/** Настройки Tesseract для чтения одной строки номера. */
export const OCR_PARAMS = {
  tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  tessedit_pageseg_mode: '7', // одна строка текста
  user_defined_dpi: '300',    // без этого Tesseract на каждой вырезке оценивает разрешение и пишет предупреждение
};

/**
 * frame: canvas с видимой частью кадра
 * -> {detections: [{hit, box:{x0,y0,x1,y1}}] (координаты frame), regions: [...]}
 */
export async function scanFrame(frame, workers, matcher, maxRegions = 6) {
  const fw = frame.width, fh = frame.height;
  const sw = Math.min(LOCATE_W, fw), sh = Math.round((fh * sw) / fw);
  small.width = sw; small.height = sh;
  smallCtx.drawImage(frame, 0, 0, sw, sh);
  const gray = toGray(smallCtx.getImageData(0, 0, sw, sh).data, sw * sh);
  const k = fw / sw;
  // белые таблички — в приоритете (их немного и они точнее), затем области с плотными контурами
  const white = findWhitePlates(gray, sw, sh, maxRegions);
  const edges = findPlateRegions(gray, sw, sh, maxRegions);
  const regions = mergeRegions([white.map((r) => ({ ...r, score: r.score + 1000 })), edges], maxRegions).map((r) => {
    const px = r.w * 0.1 + 2, py = r.h * 0.35 + 2;
    const x = Math.max(0, (r.x - px) * k), y = Math.max(0, (r.y - py) * k);
    return { x, y, w: Math.min(fw - x, (r.w + 2 * px) * k), h: Math.min(fh - y, (r.h + 2 * py) * k) };
  });

  const detections = [];
  let next = 0;
  await Promise.all(workers.map(async (worker, wi) => {
    const canvas = (crops[wi] ||= document.createElement('canvas'));
    while (next < regions.length) {
      const r = regions[next++];
      try {
        const d = await readRegion(worker, frame, r, canvas, matcher);
        if (d) detections.push(d);
      } catch { /* пропускаем вырезку */ }
    }
  }));
  return { detections, regions };
}

async function readRegion(worker, frame, r, canvas, matcher) {
  let cs = CROP_H / r.h;
  let cw = Math.round(r.w * cs);
  if (cw > 900) { cs = 900 / r.w; cw = 900; }
  const ch = Math.max(16, Math.round(r.h * cs));
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(frame, r.x, r.y, r.w, r.h, 0, 0, cw, ch);

  // ч/б по порогу Оцу; текст должен быть тёмным на светлом
  const img = ctx.getImageData(0, 0, cw, ch);
  const gray = toGray(img.data, cw * ch);
  const th = otsu(gray);
  let dark = 0;
  for (const v of gray) if (v <= th) dark++;
  const invert = dark > gray.length * 0.6;
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    const black = invert ? gray[i] > th : gray[i] <= th;
    const v = black ? 0 : 255;
    img.data[j] = img.data[j + 1] = img.data[j + 2] = v;
  }
  ctx.putImageData(img, 0, 0);

  const { data } = await worker.recognize(canvas);
  const parts = (data.words || []).map((w) => ({
    text: w.text,
    box: { x0: r.x + w.bbox.x0 / cs, y0: r.y + w.bbox.y0 / cs, x1: r.x + w.bbox.x1 / cs, y1: r.y + w.bbox.y1 / cs },
  }));
  if (!parts.length && data.text?.trim()) {
    parts.push({ text: data.text, box: { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h } });
  }
  return bestInLine(parts, matcher);
}
