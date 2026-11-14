// Поиск табличек на кадре и подготовка вырезок для Tesseract.
// Не использует DOM: работает и в фоновом потоке (OffscreenCanvas), и в основном (обычный canvas).
import { findPlateRegions, findWhitePlates, findCharLines, mergeRegions, toGray, otsu } from './detector.js';

const LOCATE_W = 800;   // ширина копии кадра для поиска табличек (поиск идёт в фоновом потоке)
const WORK_H = 140;     // высота, до которой увеличиваем область для анализа
const CHAR_H = 56;      // высота строки символов в вырезке для Tesseract
export const MARGIN = 12; // белые поля вокруг строки (Tesseract читает лучше с полями)

/**
 * Находит на кадре области, похожие на номерные знаки.
 * frame — canvas/OffscreenCanvas; makeCanvas(w, h) создаёт холст того же типа.
 */
export function locateRegions(frame, makeCanvas, maxRegions, cache = {}) {
  const fw = frame.width, fh = frame.height;
  // фиксированный масштаб поиска: маленький кадр слегка увеличиваем (не больше чем в 1.5 раза)
  const sw = Math.round(Math.min(LOCATE_W, fw * 1.5)), sh = Math.round((fh * sw) / fw);
  const small = (cache.small ||= makeCanvas(sw, sh));
  small.width = sw; small.height = sh;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(frame, 0, 0, sw, sh);
  const gray = toGray(ctx.getImageData(0, 0, sw, sh).data, sw * sh);
  const k = fw / sw;
  // приоритет: строки символов → белые таблички → области с плотными контурами
  // строки символов при нескольких порогах контраста: чёткие кадры — высокий порог,
  // мутные (сквозь лобовое стекло, дымка) — низкий; одинаковые находки объединяются ниже
  const lines = mergeRegions([12, 7, 4].map((c) => findCharLines(gray, sw, sh, maxRegions, c)), maxRegions * 2);
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
const MAX_W = 1400;
/** Режим вырезки: 'bin' — ч/б по порогу, 'gray' — серая с растянутым контрастом. */
export const PREP = { mode: 'bin' }; // предел ширины рабочей картинки — защита от «зависания» на странных областях

export function prepareCrop(frame, r, wc, oc, depth = 0) {
  // табличка не бывает уже/шире этих пропорций (с запасом на поля и наклон)
  if (!(r.w > 4 && r.h > 4) || r.w / r.h > 10 || r.h / r.w > 2) return null;
  const s = WORK_H / r.h;
  const W0 = Math.max(8, Math.min(MAX_W, Math.round(r.w * s))), H = WORK_H;
  wc.width = W0; wc.height = H;
  const wctx = wc.getContext('2d', { willReadFrequently: true });
  wctx.imageSmoothingQuality = 'high';
  wctx.drawImage(frame, r.x, r.y, r.w, r.h, 0, 0, W0, H);

  // 0. табличка под углом: наклон строки символов, вид наклона, сжатие
  const geo = estimateGeometry(wctx.getImageData(0, 0, W0, H).data, W0, H);

  // 0a. строка символов мелкая относительно области — вырезаем её из кадра плотнее и крупнее
  if (geo && depth === 0 && geo.med < H * 0.22) {
    // запас с учётом наклона: белое поле таблички должно поместиться целиком
    const tilt = Math.abs(Math.tan(geo.angle)) * (geo.x1 - geo.x0);
    const padY = geo.med * 1.4 + tilt * 0.3, padX = geo.med * 1.8;
    const x0 = Math.max(0, geo.x0 - padX), y0 = Math.max(0, geo.y0 - padY);
    const x1 = Math.min(W0, geo.x1 + padX), y1 = Math.min(H, geo.y1 + padY);
    const r2 = { x: r.x + x0 / s, y: r.y + y0 / s, w: (x1 - x0) / s, h: (y1 - y0) / s };
    if (r2.w > 4 && r2.h > 4) {
      const res = prepareCrop(frame, r2, wc, oc, 1);
      if (res) return res;
      // не вышло — продолжаем с исходной областью
      wc.width = W0; wc.height = H;
      wctx.imageSmoothingQuality = 'high';
      wctx.drawImage(frame, r.x, r.y, r.w, r.h, 0, 0, W0, H);
    }
  }

  let W = W0;
  let unwarp = (x, y) => [x, y]; // точка выпрямленной картинки → исходная картинка области
  if (geo && (Math.abs(geo.angle) > 0.035 || geo.stretch > 1.15)) {
    const a = geo.angle, st = Math.min(geo.stretch, MAX_W / W0);
    W = Math.max(8, Math.round(W0 * st));
    wc.width = W; wc.height = H;
    wctx.save();
    wctx.fillStyle = '#fff'; wctx.fillRect(0, 0, W, H);
    wctx.translate(W / 2, H / 2);
    wctx.scale(st, 1);
    if (geo.shear) {
      // съёмка сбоку: палочки букв вертикальны, наклонена только строка → выпрямляем сдвигом
      wctx.transform(1, -Math.tan(a), 0, 1, 0, 0);
    } else {
      // телефон повёрнут: наклонено всё вместе с буквами → поворачиваем
      wctx.rotate(-a);
    }
    wctx.drawImage(frame, r.x, r.y, r.w, r.h, -W0 / 2, -H / 2, W0, H);
    wctx.restore();
    const cos = Math.cos(a), sin = Math.sin(a), tg = Math.tan(a);
    unwarp = geo.shear
      ? (x, y) => { const ux = (x - W / 2) / st, uy = y - H / 2; return [ux + W0 / 2, uy + tg * ux + H / 2]; }
      : (x, y) => { const ux = (x - W / 2) / st, uy = y - H / 2; return [ux * cos - uy * sin + W0 / 2, ux * sin + uy * cos + H / 2]; };
  }
  const px = wctx.getImageData(0, 0, W, H).data;
  const n = W * H;

  // яркость; синее (полоса ЕС, полосы на кузове) и пустые углы после выпрямления — не учитываем
  const gray = new Uint8Array(n);
  const blue = new Uint8Array(n);
  const vivid = new Uint8Array(n);
  const warped = W !== W0 || geo && Math.abs(geo.angle) > 0.035;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const R = px[j], G = px[j + 1], B = px[j + 2];
    blue[i] = B > R + 35 && B > G + 10 ? 1 : 0;
    // насыщенный цвет (жёлтый фургон, красный кузов) — не может быть белым полем таблички;
    // светло-зелёная табличка электромобиля насыщена слабо и проходит
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    vivid[i] = mx > 0 && (mx - mn) / mx > 0.65 ? 1 : 0; // ночью под красным светом табличка ~0.5, жёлтый кузов ~0.8
    gray[i] = (R * 77 + G * 150 + B * 29) >> 8;
  }
  if (warped) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const [ox, oy] = unwarp(x + 0.5, y + 0.5);
      if (ox < 1 || oy < 1 || ox > W0 - 1 || oy > H - 1) blue[y * W + x] = 1;
    }
  }

  // 1. белое поле таблички
  const valid = new Uint8Array(n);
  let nv = 0;
  for (let i = 0; i < n; i++) if (!blue[i]) valid[nv++] = gray[i];
  const notPlate = new Uint8Array(n);
  for (let i = 0; i < n; i++) notPlate[i] = blue[i] || vivid[i];
  const plate = largestBright(gray, notPlate, W, H, otsu(nv ? valid.subarray(0, nv) : gray)) || { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };
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
  let darkInPlate = 0;
  for (let i = 0; i < n; i++) dark[i] = !blue[i] && gray[i] <= tT ? 1 : 0;
  for (let y = plate.y0; y <= plate.y1; y++) for (let x = plate.x0; x <= plate.x1; x++) darkInPlate += dark[y * W + x];

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
  // бледная табличка (сквозь мутное стекло): порог почти ничего не выделил — берём середину таблички
  const pale = darkInPlate < pw * ph * 0.04;
  if (pale) best = { y0: Math.round(ph * 0.12), y1: Math.round(ph * 0.88) };
  if (!best || best.y1 - best.y0 < ph * 0.25) best = { y0: 0, y1: ph - 1 };
  const by0 = plate.y0 + best.y0, by1 = plate.y0 + best.y1;
  const bh = by1 - by0 + 1;

  // по горизонтали: убираем только пустые края (рамка уже снаружи белого поля;
  // «сплошные» столбцы резать нельзя — это может быть палочка буквы H, I, 1)
  const colDark = (x) => { let c = 0; for (let y = by0; y <= by1; y++) c += dark[y * W + x]; return c; };
  let bx0 = plate.x0, bx1 = plate.x1;
  if (!pale) {
    while (bx0 < bx1 && colDark(bx0) === 0) bx0++;
    while (bx1 > bx0 && colDark(bx1) === 0) bx1--;
  }
  bx0 = Math.max(plate.x0, bx0 - 2); bx1 = Math.min(plate.x1, bx1 + 2);
  const bw = bx1 - bx0 + 1;
  if (bw < bh * 1.5) return null; // слишком узко для номера

  // 4. итоговая вырезка: ч/б, строка символов высотой CHAR_H, белые поля
  const k = CHAR_H / bh;
  const ow = Math.round(bw * k) + MARGIN * 2, oh = CHAR_H + MARGIN * 2;
  const bin = wctx.createImageData(bw, bh);
  if (PREP.mode === 'gray' || pale) {
    // серая картинка с растянутым контрастом: на размытом тексте Tesseract бинаризует аккуратнее нас
    const hist = new Uint32Array(256);
    let cnt = 0;
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) { const i = y * W + x; if (!blue[i]) { hist[gray[i]]++; cnt++; } }
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= cnt * 0.03) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= cnt * 0.15) { hi = v; break; } }
    const span = Math.max(12, hi - lo);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const i = (by0 + y) * W + bx0 + x;
      const v = blue[i] ? 255 : Math.max(0, Math.min(255, Math.round(((gray[i] - lo) * 255) / span)));
      const j = (y * bw + x) * 4;
      bin.data[j] = bin.data[j + 1] = bin.data[j + 2] = v; bin.data[j + 3] = 255;
    }
  } else {
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const v = dark[(by0 + y) * W + bx0 + x] ? 0 : 255;
      const j = (y * bw + x) * 4;
      bin.data[j] = bin.data[j + 1] = bin.data[j + 2] = v; bin.data[j + 3] = 255;
    }
  }
  wctx.putImageData(bin, 0, 0);
  oc.width = ow; oc.height = oh;
  const octx = oc.getContext('2d', { willReadFrequently: true });
  octx.fillStyle = '#fff'; octx.fillRect(0, 0, ow, oh);
  octx.imageSmoothingEnabled = true;
  octx.drawImage(wc, 0, 0, bw, bh, MARGIN, MARGIN, ow - MARGIN * 2, CHAR_H);

  // рамка таблички в координатах кадра (с учётом выпрямления — по четырём углам)
  const corners = [[plate.x0, plate.y0], [plate.x1 + 1, plate.y0], [plate.x0, plate.y1 + 1], [plate.x1 + 1, plate.y1 + 1]]
    .map(([x, y]) => unwarp(x, y));
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  return {
    map: { rx: r.x, ry: r.y, s, bx0, by0, k },
    plateBox: {
      x0: r.x + Math.min(...xs) / s, y0: r.y + Math.min(...ys) / s,
      x1: r.x + Math.max(...xs) / s, y1: r.y + Math.max(...ys) / s,
    },
  };
}

/**
 * Наклон строки символов и их сжатие по ширине.
 * Тёмные пятна размером с символ → прямая через их центры (наклон) и средние пропорции (сжатие).
 * -> {angle (радианы), stretch (≥1)} или null, если символов не найдено
 */
function estimateGeometry(px, W, H) {
  const n = W * H;
  const gray = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) gray[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
  const t = otsu(gray);
  const lab = new Int32Array(n);
  const stack = new Int32Array(n);
  const comps = [];
  let id = 0;
  for (let i = 0; i < n; i++) {
    if (lab[i] || gray[i] > t) continue;
    id++;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0, sp = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    stack[sp++] = i; lab[i] = id;
    while (sp) {
      const p = stack[--sp];
      const x = p % W, y = (p - x) / W;
      area++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !lab[p - 1] && gray[p - 1] <= t) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (x < W - 1 && !lab[p + 1] && gray[p + 1] <= t) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && !lab[p - W] && gray[p - W] <= t) { lab[p - W] = id; stack[sp++] = p - W; }
      if (y < H - 1 && !lab[p + W] && gray[p + W] <= t) { lab[p + W] = id; stack[sp++] = p + W; }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (h < H * 0.1 || h > H * 0.7 || w > h * 1.6 || w < 2) continue; // M, W — широкие
    const fill = area / (w * h);
    if (fill < 0.12 || fill > 0.92) continue;
    // наклон самого символа: главная ось распределения его пикселей
    const mx = sx / area, my = sy / area;
    const mu20 = sxx / area - mx * mx, mu02 = syy / area - my * my, mu11 = sxy / area - mx * my;
    const th = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
    const tilt = th > 0 ? th - Math.PI / 2 : th + Math.PI / 2;
    comps.push({ x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w, h, tilt });
  }
  if (comps.length < 3) return null;
  // оставляем пятна близкой высоты (символы номера), отбрасываем мелочь и мусор
  const hs = comps.map((c) => c.h).sort((a, b) => a - b);
  const med = hs[hs.length >> 1];
  const similar = comps.filter((c) => c.h > med * 0.7 && c.h < med * 1.4).sort((p, q) => p.cx - q.cx);
  // только самая длинная цепочка символов в ряд (без подписей, наклеек, букв на кузове)
  let chars = [];
  const used = new Uint8Array(similar.length);
  for (let i = 0; i < similar.length; i++) {
    if (used[i]) continue;
    const chain = [similar[i]];
    used[i] = 1;
    for (let j = i + 1; j < similar.length; j++) {
      if (used[j]) continue;
      const last = chain[chain.length - 1], c = similar[j];
      if (c.x0 - last.x1 > last.h * 1.6) break;
      if (Math.abs(c.cy - last.cy) > last.h * 0.5) continue;
      const hr = c.h / last.h;
      if (hr < 0.75 || hr > 1.33) continue;
      chain.push(c); used[j] = 1;
    }
    if (chain.length > chars.length) chars = chain;
  }
  if (chars.length < 3) return null;
  // наклон строки: метод наименьших квадратов по центрам
  const N = chars.length;
  const mx = chars.reduce((a, c) => a + c.cx, 0) / N, my = chars.reduce((a, c) => a + c.cy, 0) / N;
  let sxy = 0, sxx = 0;
  for (const c of chars) { sxy += (c.cx - mx) * (c.cy - my); sxx += (c.cx - mx) ** 2; }
  if (sxx < 1) return null;
  const angle = Math.atan(sxy / sxx);
  if (Math.abs(angle) > 0.6) return null; // > ~35° — не похоже на строку номера
  // вид наклона: если буквы наклонены так же, как строка — поворот; если стоят прямо — сдвиг (съёмка сбоку)
  const tilts = chars.map((c) => c.tilt).sort((a, b) => a - b);
  const tilt = tilts[tilts.length >> 1];
  const shear = Math.abs(angle) > 0.035 && Math.abs(tilt) < Math.abs(tilt - angle);
  // сжатие: у символов польского номера ширина ≈ 0.55 высоты (у узких I/1 меньше — берём верхнюю часть)
  const asp = chars.map((c) => c.w / c.h).sort((a, b) => a - b);
  const typical = asp[Math.floor(asp.length * 0.7)];
  const stretch = Math.min(1.8, Math.max(1, 0.55 / Math.max(0.2, typical)));
  return {
    angle, stretch, shear, med,
    x0: Math.min(...chars.map((c) => c.x0)), y0: Math.min(...chars.map((c) => c.y0)),
    x1: Math.max(...chars.map((c) => c.x1)), y1: Math.max(...chars.map((c) => c.y1)),
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
