// Тестовый стенд распознавания на реальных фото из test-assets/ (папка не публикуется).
// Запуск из консоли страницы на localhost:
//   const h = await import('./tools/harness.js'); await h.runAll();  → window.__H
import { locateRegions, prepareCrop } from '../js/prep.js';
import { OCR_INIT, OCR_PARAMS } from '../js/pipeline.js';
import { Matcher, bestInLine } from '../js/matcher.js';
import { POWIATS } from '../js/powiats.js';

const powiats = new Map(POWIATS.map(([code, name, region, s]) => [code, { code, name, region, service: !!s }]));
const mk = (a = 1, b = 1) => Object.assign(document.createElement('canvas'), { width: a, height: b });
const load = (src) => new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = bad; im.src = src; });

/** Набор: файл, правильный номер, как кадрировать (crop: доля сверху/высота — для записей экрана). */
export const CASES = [
  { f: 'street_db1', plate: 'DB5712L' },
  { f: 'street_db2', plate: 'DB5712L' },
  { f: 'street_db3', plate: 'DB5712L' },
  { f: 'street_opr_night', plate: 'OPR06M5' },
  { f: 'dash_dw9j630', plate: 'DW9J630' },
  { f: 'dash_nol0096e_a', plate: 'NOL0096E' },
  { f: 'dash_nol0096e_b', plate: 'NOL0096E' },
  { f: 'dash_dw3hk49_green', plate: 'DW3HK49' },
  ...['vid_25', 'vid_45', 'vid_65', 'vid_85', 'vid_105', 'vid_125'].map((f) => ({ f, plate: 'HPZB294', crop: [0.09, 0.69] })),
];

/**
 * Прогоняет один кадр так же, как приложение: поиск областей → вырезки → Tesseract → сравнение.
 * locateFrame — кадр, на котором ищем таблички; readFrame — кадр, из которого вырезаем (полное разрешение).
 */
async function scan(worker, locateFrame, readFrame, matcher) {
  const k = readFrame.width / locateFrame.width;
  const regs = locateRegions(locateFrame, mk, 8, {}).map((r) => ({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k }));
  const reads = [];
  let hit = null;
  for (const r of regs) {
    const oc = mk();
    if (!prepareCrop(readFrame, r, mk(), oc)) continue;
    const { data } = await worker.recognize(oc);
    const t = (data.text || '').replace(/\s/g, '');
    if (t.length > 3) reads.push(t);
    const b = bestInLine((data.words || []).map((x) => ({ text: x.text, box: x.bbox })), matcher);
    if (b && b.hit.kind === 'list' && (!hit || !b.hit.fuzzy)) hit = b.hit;
    if (hit && !hit.fuzzy) break;
  }
  return { hit, reads, regions: regs.length };
}

/** mode: 'app1280' — как сейчас (уменьшенный кадр для всего); 'fullres' — поиск на уменьшенном, чтение из полного. */
export async function runAll({ mode = 'fullres', cases = CASES } = {}) {
  window.__H = null;
  const worker = await Tesseract.createWorker('eng', 1, {}, OCR_INIT);
  await worker.setParameters(OCR_PARAMS);
  const rows = [];
  let exact = 0, near = 0;
  const t0 = performance.now();
  for (const c of cases) {
    let img;
    try { img = await load(`test-assets/${c.f}.jpg`); } catch { rows.push(`${c.f}: нет файла`); continue; }
    const top = c.crop ? Math.round(img.height * c.crop[0]) : 0;
    const h = c.crop ? Math.round(img.height * c.crop[1]) : img.height;
    const full = mk(img.width, h);
    full.getContext('2d').drawImage(img, 0, top, img.width, h, 0, 0, img.width, h);
    const s = Math.min(1, 1280 / Math.max(full.width, full.height));
    const small = mk(Math.round(full.width * s), Math.round(full.height * s));
    small.getContext('2d').drawImage(full, 0, 0, small.width, small.height);
    const list = [{ plate: c.plate, color: 'red', note: '' }];
    const m = new Matcher(list, {}, powiats, true);
    const r = mode === 'fullres' ? await scan(worker, small, full, m) : await scan(worker, small, small, m);
    if (r.hit && !r.hit.fuzzy) exact++; else if (r.hit) near++;
    rows.push(`${c.f}: ${r.hit ? (r.hit.fuzzy ? '≈' : 'ТОЧНО') : 'нет'} [${r.regions}] ${r.reads.slice(0, 3).join('|')}`);
  }
  await worker.terminate();
  window.__H = { mode, exact, near, total: cases.length, sec: Math.round((performance.now() - t0) / 100) / 10, rows };
  return window.__H;
}
