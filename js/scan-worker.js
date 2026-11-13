// Фоновый поток: поиск табличек и подготовка вырезок, чтобы не блокировать нажатия в интерфейсе.
import { locateRegions, prepareCrop } from './prep.js';

const make = (w = 1, h = 1) => new OffscreenCanvas(w, h);
const cache = {};
let frame, wc, oc;

self.onmessage = ({ data }) => {
  if (data.probe) {
    let ok = false;
    try { ok = typeof OffscreenCanvas !== 'undefined' && !!make(1, 1).getContext('2d'); } catch { ok = false; }
    self.postMessage({ probe: true, ok });
    return;
  }
  const { id, bitmap, maxRegions } = data;
  try {
    frame ||= make();
    frame.width = bitmap.width; frame.height = bitmap.height;
    frame.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const regions = locateRegions(frame, make, maxRegions, cache);
    const crops = [];
    const transfer = [];
    for (const r of regions) {
      const p = prepareCrop(frame, r, (wc ||= make()), (oc ||= make()));
      if (!p) continue;
      const img = oc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, oc.width, oc.height);
      crops.push({ ...p, w: img.width, h: img.height, buf: img.data.buffer });
      transfer.push(img.data.buffer);
    }
    self.postMessage({ id, regions, crops }, transfer);
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
