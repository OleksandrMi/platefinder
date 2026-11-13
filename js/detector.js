// Поиск участков кадра, похожих на номерной знак (классический подход ANPR):
// у таблички много вертикальных контуров (буквы, цифры), собранных в горизонтальную полосу.
// Работает на уменьшенной копии кадра (~10 мс), дальше Tesseract читает только найденные вырезки.

/**
 * gray: Uint8Array w*h (яркость 0..255)
 * -> [{x, y, w, h, score}] в координатах этого маленького изображения
 */
export function findPlateRegions(gray, w, h, maxCount = 6) {
  // 1. вертикальные контуры: |dI/dx|
  const edge = new Uint8Array(w * h);
  let sum = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const d = Math.abs(gray[row + x + 1] - gray[row + x - 1]);
      edge[row + x] = d;
      sum += d;
    }
  }
  const mean = sum / (w * h);
  const T = Math.max(28, mean * 2.6);
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) bin[i] = edge[i] > T ? 1 : 0;

  // 2. склеиваем контуры букв в горизонтальную полосу: закрытие по горизонтали
  const k = Math.max(3, Math.round(w / 90));
  const closed = closeHorizontal(bin, w, h, k);
  // небольшое расширение по вертикали — соединяет верх и низ символов
  const mask = dilateVertical(closed, w, h, 1);

  // 3. связные области
  const labels = new Int32Array(w * h);
  const regions = [];
  const stack = [];
  let next = 1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0, edges = 0;
    stack.push(i);
    labels[i] = next;
    while (stack.length) {
      const p = stack.pop();
      const px = p % w, py = (p - px) / w;
      area++;
      edges += bin[p];
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack.push(p - 1); }
      if (px < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack.push(p + 1); }
      if (py > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = next; stack.push(p - w); }
      if (py < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = next; stack.push(p + w); }
    }
    next++;
    const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
    // 4. фильтр по форме: табличка вытянута по горизонтали
    if (rw < 14 || rh < 4 || rh > h * 0.25 || rw > w * 0.9) continue;
    const aspect = rw / rh;
    if (aspect < 1.6 || aspect > 9) continue;
    const fill = area / (rw * rh);
    const density = edges / (rw * rh);
    if (fill < 0.35 || density < 0.08) continue;
    regions.push({ x: x0, y: y0, w: rw, h: rh, score: density * Math.sqrt(rw * rh) * Math.min(1, aspect / 3) });
  }
  regions.sort((a, b) => b.score - a.score);

  // убираем вложенные / сильно перекрывающиеся
  const out = [];
  for (const r of regions) {
    if (out.some((o) => overlapRatio(o, r) > 0.5)) continue;
    out.push(r);
    if (out.length >= maxCount) break;
  }
  return out;
}

/**
 * Второй признак: польская табличка — белый прямоугольник ~4.5:1 с тёмными символами внутри.
 * Ищем светлые связные области нужной формы, внутри которых есть «дырки» от букв.
 */
export function findWhitePlates(gray, w, h, maxCount = 6) {
  // порог «белого»: верхняя часть гистограммы, но не ниже 120
  const hist = new Uint32Array(256);
  for (const v of gray) hist[v]++;
  let acc = 0, p85 = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= gray.length * 0.85) { p85 = v; break; } }
  const T = Math.max(120, Math.min(200, p85));
  const bright = new Uint8Array(w * h);
  for (let i = 0; i < bright.length; i++) bright[i] = gray[i] >= T ? 1 : 0;

  const labels = new Int32Array(w * h);
  const stack = [];
  const out = [];
  let next = 1;
  for (let i = 0; i < bright.length; i++) {
    if (!bright[i] || labels[i]) continue;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
    stack.push(i); labels[i] = next;
    while (stack.length) {
      const p = stack.pop();
      const px = p % w, py = (p - px) / w;
      area++;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && bright[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack.push(p - 1); }
      if (px < w - 1 && bright[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack.push(p + 1); }
      if (py > 0 && bright[p - w] && !labels[p - w]) { labels[p - w] = next; stack.push(p - w); }
      if (py < h - 1 && bright[p + w] && !labels[p + w]) { labels[p + w] = next; stack.push(p + w); }
    }
    next++;
    const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
    if (rw < 16 || rh < 5 || rw > w * 0.8 || rh > h * 0.2) continue;
    const aspect = rw / rh;
    if (aspect < 2.2 || aspect > 7) continue;
    const fill = area / (rw * rh);
    if (fill < 0.4 || fill > 0.93) continue; // сплошной белый прямоугольник без символов — не номер
    // внутри должны быть тёмные символы, разбросанные по ширине
    let dark = 0, cols = 0;
    for (let x = x0; x <= x1; x++) {
      let colDark = 0;
      for (let y = y0 + Math.floor(rh * 0.2); y < y1 - Math.floor(rh * 0.2); y++) if (gray[y * w + x] < T - 40) colDark++;
      if (colDark) cols++;
      dark += colDark;
    }
    const darkRatio = dark / (rw * rh * 0.6);
    if (darkRatio < 0.06 || cols < rw * 0.3) continue;
    out.push({ x: x0, y: y0, w: rw, h: rh, score: 2 + darkRatio * Math.sqrt(rw * rh) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, maxCount);
}

/**
 * Третий признак (самый надёжный): строка символов — 4+ тёмных пятна одинаковой высоты,
 * стоящих в ряд. Не зависит от цвета машины и фона.
 */
export function findCharLines(gray, w, h, maxCount = 6) {
  // адаптивный порог: темнее среднего по окрестности (интегральное изображение)
  const R = Math.max(6, Math.round(w / 60));
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
    }
  }
  const dark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(h, y + R + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(w, x + R + 1);
      const s = ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
      const mean = s / ((x1 - x0) * (y1 - y0));
      dark[y * w + x] = gray[y * w + x] < mean - 12 ? 1 : 0;
    }
  }

  // связные тёмные пятна размером с символ
  const lab = new Int32Array(w * h);
  const stack = [];
  const chars = [];
  let id = 0;
  for (let i = 0; i < dark.length; i++) {
    if (!dark[i] || lab[i]) continue;
    id++;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p - x) / w;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && dark[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && dark[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && dark[p - w] && !lab[p - w]) { lab[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && dark[p + w] && !lab[p + w]) { lab[p + w] = id; stack.push(p + w); }
    }
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    if (ch < 7 || ch > h * 0.15 || cw < 1 || cw > ch * 1.1) continue;
    const fill = area / (cw * ch);
    if (fill < 0.12 || fill > 0.9) continue;
    chars.push({ x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, h: ch });
  }
  chars.sort((a, b) => a.x0 - b.x0);

  // цепочки: похожая высота, на одной линии, небольшие промежутки
  const used = new Uint8Array(chars.length);
  const lines = [];
  for (let i = 0; i < chars.length; i++) {
    if (used[i]) continue;
    const chain = [chars[i]];
    used[i] = 1;
    let last = chars[i];
    for (let j = i + 1; j < chars.length; j++) {
      if (used[j]) continue;
      const c = chars[j];
      if (c.x0 - last.x1 > last.h * 1.6) {
        if (c.x0 - last.x1 > last.h * 4) break;
        continue;
      }
      const hr = c.h / last.h;
      if (hr < 0.75 || hr > 1.33) continue;
      if (Math.abs(c.cy - last.cy) > last.h * 0.35) continue;
      chain.push(c); used[j] = 1; last = c;
    }
    if (chain.length < 4 || chain.length > 12) continue;
    const x0 = Math.min(...chain.map((c) => c.x0)), x1 = Math.max(...chain.map((c) => c.x1));
    const y0 = Math.min(...chain.map((c) => c.y0)), y1 = Math.max(...chain.map((c) => c.y1));
    const lw = x1 - x0 + 1, lh = y1 - y0 + 1;
    if (lw / lh < 2 || lw / lh > 12) continue;
    // ближе к 7 символам номера — выше рейтинг
    const score = 3 + Math.sqrt(lw * lh) * (1 - Math.abs(chain.length - 7) / 10);
    lines.push({ x: x0, y: y0, w: lw, h: lh, score });
  }
  lines.sort((a, b) => b.score - a.score);
  return lines.slice(0, maxCount);
}

/** Объединяет кандидатов нескольких детекторов без дублей. */
export function mergeRegions(lists, maxCount) {
  const all = lists.flat().sort((a, b) => b.score - a.score);
  const out = [];
  for (const r of all) {
    if (out.some((o) => overlapRatio(o, r) > 0.5)) continue;
    out.push(r);
    if (out.length >= maxCount) break;
  }
  return out;
}

function closeHorizontal(bin, w, h, k) {
  // dilate, затем erode по строкам (скользящее окно через префиксные суммы)
  const dil = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const pre = new Int32Array(w + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    pre[0] = 0;
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + bin[row + x];
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - k), b = Math.min(w, x + k + 1);
      dil[row + x] = pre[b] - pre[a] > 0 ? 1 : 0;
    }
    pre[0] = 0;
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + dil[row + x];
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - k), b = Math.min(w, x + k + 1);
      out[row + x] = pre[b] - pre[a] === b - a ? 1 : 0;
    }
  }
  return out;
}

function dilateVertical(m, w, h, k) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -k; d <= k && !v; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < h && m[yy * w + x]) v = 1;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function overlapRatio(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.min(a.w * a.h, b.w * b.h);
}

/** Яркость из RGBA (ImageData). */
export function toGray(rgba, n) {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return g;
}

/** Порог Оцу — для перевода вырезки номера в чёрно-белую (Tesseract так читает надёжнее). */
export function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; th = t; }
  }
  return th;
}
