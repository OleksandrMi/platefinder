// Логика польских номеров — порт PlateMatcher.kt из Android-версии (те же правила и тесты).

export const PlateText = {
  /** "wa 123-45" -> "WA12345" */
  normalize(raw) {
    return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  },

  /** Код повята: 2 буквы, если третий символ — цифра, иначе 3. */
  codeOf(n) {
    if (n.length < 3) return null;
    const L = (c) => c >= 'A' && c <= 'Z';
    const D = (c) => c >= '0' && c <= '9';
    if (!L(n[0]) || !L(n[1])) return null;
    if (D(n[2])) return n.slice(0, 2);
    if (L(n[2])) return n.slice(0, 3);
    return null;
  },

  isPolishFormat(n) {
    if (n.length < 6 || n.length > 8) return false;
    if (/^[A-Z]{2}[0-9][A-Z0-9]{3,4}$/.test(n)) return true;
    if (/^[A-Z]{3}[A-Z0-9]{3,5}$/.test(n)) return /[0-9]/.test(n.slice(3));
    return false;
  },

  pretty(n) {
    const code = PlateText.codeOf(n);
    if (!code || n.length <= code.length) return n;
    return code + ' ' + n.slice(code.length);
  },

  /** Свёртка символов, которые OCR путает. */
  looseKey(n) {
    const map = { O: '0', Q: '0', D: '0', I: '1', L: '1', B: '8', S: '5', Z: '2', G: '6' };
    let out = '';
    for (const c of n) out += map[c] || c;
    return out;
  },

  /** Пропущен/лишний один символ или одна замена на похожий (H↔N, 7↔1…). */
  nearMatch(a, b) {
    if (a === b) return true;
    if (a.length === b.length) {
      let diff = -1;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          if (diff >= 0) return false;
          diff = i;
        }
      }
      return diff >= 0 && CONFUSABLE.has(a[diff] + b[diff]);
    }
    if (Math.abs(a.length - b.length) !== 1) return false;
    const [s, l] = a.length < b.length ? [a, b] : [b, a];
    let i = 0, j = 0, skipped = false;
    while (i < s.length && j < l.length) {
      if (s[i] === l[j]) { i++; j++; }
      else {
        if (skipped) return false;
        skipped = true;
        j++;
      }
    }
    return true;
  },
};

const CONFUSABLE = new Set(
  ['HN', 'MN', 'UV', 'KX', '71', '4A', 'EF', 'PR', 'C6', 'YV', 'WV', 'T1', 'J1', 'R8']
    .flatMap((p) => [p, p[1] + p[0]])
);

export const RED = '#FF3B30';
export const GREEN = '#30D158';

/**
 * Правила: список номеров + выбранные коды повятов.
 * plates: [{plate, color:'red'|'green', note}]
 * prefixes: {code: '#rrggbb'}
 * powiats: Map code -> {code, name, region, service}
 */
export class Matcher {
  constructor(plates, prefixes, powiats, fuzzy) {
    this.prefixes = prefixes;
    this.powiats = powiats;
    this.fuzzy = fuzzy;
    this.watch = plates.map((p) => [p, PlateText.looseKey(p.plate)]);
    this.exact = new Map(this.watch.map((w) => [w[1], w]));
    this.byLength = new Map();
    for (const w of this.watch) {
      if (w[1].length < 6) continue;
      const arr = this.byLength.get(w[1].length) || [];
      arr.push(w);
      this.byLength.set(w[1].length, arr);
    }
    this.serviceRules = Object.entries(prefixes).filter(([c]) => powiats.get(c)?.service);
  }

  static colorOf(p) {
    return p.color === 'green' ? GREEN : RED;
  }

  /** -> {plate, kind:'list'|'prefix'|'plate', color, watch?, fuzzy?, powiat?, score} | null */
  classify(n) {
    if (n.length < 4) return null;
    const key = PlateText.looseKey(n);
    const hit = (o) => ({ ...o, score: SCORE[o.kind] - (o.fuzzy ? 10 : 0) + o.plate.length });

    const ex = this.exact.get(key);
    if (ex) return hit({ plate: n, kind: 'list', color: Matcher.colorOf(ex[0]), watch: ex[0] });
    if (key.length > 6) {
      for (const [p, k] of this.watch) {
        if (k.length >= 5 && key.length > k.length && key.includes(k)) {
          return hit({ plate: p.plate, kind: 'list', color: Matcher.colorOf(p), watch: p });
        }
      }
    }
    const polish = PlateText.isPolishFormat(n);
    if (this.fuzzy && n.length >= 5) {
      for (let len = key.length - 1; len <= key.length + 1; len++) {
        for (const [p, k] of this.byLength.get(len) || []) {
          if (PlateText.nearMatch(key, k)) {
            return hit({ plate: n, kind: 'list', color: Matcher.colorOf(p), watch: p, fuzzy: true });
          }
        }
      }
    }
    if (!polish) return null;

    const code = PlateText.codeOf(n);
    if (code && this.prefixes[code]) {
      return hit({ plate: n, kind: 'prefix', color: this.prefixes[code], powiat: this.powiats.get(code) });
    }
    for (const [svc, color] of this.serviceRules) {
      if (n.startsWith(svc)) return hit({ plate: n, kind: 'prefix', color, powiat: this.powiats.get(svc) });
    }
    const pw = code ? this.powiats.get(code) : null;
    const h = hit({ plate: n, kind: 'plate', color: '#FFFFFF', powiat: pw });
    if (pw) h.score += 5; // существующий код повята — вероятнее настоящий номер
    return h;
  }
}

const SCORE = { list: 100, prefix: 50, plate: 30 };

/**
 * Голосование по нескольким прочтениям одной таблички:
 * берём самую частую длину и по каждой позиции — самый частый символ.
 * ['RPZE254','HPZB294','HPZB294','HPZ8294'] -> 'HPZB294'
 */
export function consensus(reads) {
  if (!reads.length) return '';
  const byLen = new Map();
  for (const r of reads) byLen.set(r.length, (byLen.get(r.length) || 0) + 1);
  const L = [...byLen].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  const same = reads.filter((r) => r.length === L);
  let out = '';
  for (let i = 0; i < L; i++) {
    const cnt = new Map();
    for (const r of same) cnt.set(r[i], (cnt.get(r[i]) || 0) + 1);
    let best = '', n = 0;
    // при равенстве — символ из последнего прочтения (самого свежего)
    for (const r of [...same].reverse()) if (cnt.get(r[i]) > n) { n = cnt.get(r[i]); best = r[i]; }
    out += best;
  }
  return out;
}

/** Парсинг строки файла plates.txt: "WA 12345 green | заметка" */
export function parsePlateLine(line) {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const main = t.split('|')[0].trim();
  const note = t.includes('|') ? t.slice(t.indexOf('|') + 1).trim() : '';
  let tokens = main.split(/[\s;,\t]+/).filter(Boolean);
  if (!tokens.length) return null;
  let color = 'red';
  const last = tokens[tokens.length - 1].toLowerCase();
  const colors = {
    red: 'red', r: 'red', czerwony: 'red', 'красный': 'red', 'червоний': 'red',
    green: 'green', g: 'green', zielony: 'green', 'зелёный': 'green', 'зеленый': 'green', 'зелений': 'green',
  };
  if (colors[last]) {
    color = colors[last];
    tokens = tokens.slice(0, -1);
  }
  const plate = PlateText.normalize(tokens.join(''));
  if (plate.length < 3) return null;
  return { plate, color, note };
}

/**
 * Выбор лучшего номера среди соседних слов строки (до 4 подряд).
 * parts: [{text, box:{x0,y0,x1,y1}}]
 */
export function bestInLine(parts, matcher) {
  let best = null;
  for (let i = 0; i < parts.length; i++) {
    let s = '';
    let box = null;
    for (let j = i; j < Math.min(parts.length, i + 4); j++) {
      s += parts[j].text;
      const b = parts[j].box;
      box = box
        ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) }
        : { ...b };
      const n = PlateText.normalize(s);
      if (n.length > 11) break;
      // Синяя полоса ЕС «PL» часто читается как лишний символ (A, 8, 1…) или как «PL» в начале
      const variants = [n];
      if (n.length >= 7) variants.push(n.slice(1));
      if (n.startsWith('PL') && n.length >= 8) variants.push(n.slice(2));
      for (const v of variants) {
        const hit = matcher.classify(v);
        if (hit && (!best || hit.score > best.hit.score)) best = { hit, box: { ...box } };
      }
      // Круглая наклейка между кодом повята и номером (HPZ ● B294) часто читается как лишний символ.
      // Пробуем убрать один символ на её месте — засчитываем только точное совпадение со списком.
      if (n.length >= 7 && n.length <= 9) {
        for (let k = 2; k <= 4; k++) {
          const hit = matcher.classify(n.slice(0, k) + n.slice(k + 1));
          if (hit && hit.kind === 'list' && !hit.fuzzy && (!best || hit.score - 1 > best.hit.score)) {
            best = { hit: { ...hit, score: hit.score - 1 }, box: { ...box } };
          }
        }
      }
    }
  }
  return best;
}
