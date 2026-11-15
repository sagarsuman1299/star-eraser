// Star Eraser core: removes the visible Gemini star by reverse alpha blending.
// Pure pixel maths, no AI, no network. Works on RGBA Uint8ClampedArray (canvas ImageData).
import { MAPS } from './maps.js';

const mapCache = {};
function getMap(key, size) {
  const id = key + '@' + size;
  if (mapCache[id]) return mapCache[id];
  const m = MAPS[key];
  let a = Float32Array.from(m.data, v => v / 10000);
  if (m.size !== size) a = resizeArea(a, m.size, size);
  return (mapCache[id] = a);
}

// (logo size, right margin, bottom margin, map key) for every known Gemini layout
const LAYOUTS = [
  [48, 32, 32, 'a48'], [96, 64, 64, 'a96'], [96, 192, 192, 'a96n'], [48, 96, 96, 'a48'],
  [48, 89, 89, 'a48'], [46, 32, 32, 'a48'], [36, 96, 96, 'a36'],
];

function resizeArea(src, n, m) {
  // area-average resample of an n×n map to m×m
  const out = new Float32Array(m * m), r = n / m;
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    const y0 = y * r, y1 = y0 + r, x0 = x * r, x1 = x0 + r;
    let s = 0, w = 0;
    for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
      const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
      for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
        const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
        s += src[sy * n + sx] * wx * wy; w += wx * wy;
      }
    }
    out[y * m + x] = s / w;
  }
  return out;
}

const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function ncc(G, W, x0, y0, t, s) {
  // normalised cross-correlation (TM_CCOEFF_NORMED) of template t at (x0,y0)
  const n = s * s;
  let mt = 0, mi = 0;
  for (let i = 0; i < n; i++) mt += t[i];
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) mi += G[(y0 + y) * W + x0 + x];
  mt /= n; mi /= n;
  let num = 0, dt = 0, di = 0;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const a = t[y * s + x] - mt, b = G[(y0 + y) * W + x0 + x] - mi;
    num += a * b; dt += a * a; di += b * b;
  }
  return dt * di > 0 ? num / Math.sqrt(dt * di) : 0;
}

function detect(G, W, H) {
  const cands = [];
  for (const [s, mr, mb, key] of LAYOUTS) {
    const t = getMap(key, s), x0 = W - mr - s, y0 = H - mb - s, J = 4;
    if (x0 - J < 0 || y0 - J < 0 || x0 + s + J > W || y0 + s + J > H) continue;
    let best = -2, bx = 0, by = 0;
    for (let dy = -J; dy <= J; dy++) for (let dx = -J; dx <= J; dx++) {
      const v = ncc(G, W, x0 + dx, y0 + dy, t, s);
      if (v > best) { best = v; bx = x0 + dx; by = y0 + dy; }
    }
    cands.push({ score: best, x: bx, y: by, s, t });
  }
  return cands.sort((a, b) => b.score - a.score);
}

const refl = (i, n) => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i); // BORDER_REFLECT_101

function sobelMag(g, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (yy, xx) => g[refl(yy, h) * w + refl(xx, w)];
    const gx = p(y - 1, x + 1) + 2 * p(y, x + 1) + p(y + 1, x + 1) - p(y - 1, x - 1) - 2 * p(y, x - 1) - p(y + 1, x - 1);
    const gy = p(y + 1, x - 1) + 2 * p(y + 1, x) + p(y + 1, x + 1) - p(y - 1, x - 1) - 2 * p(y - 1, x) - p(y - 1, x + 1);
    out[y * w + x] = Math.hypot(gx, gy);
  }
  return out;
}

function unblend(patch, ap, k) {
  const out = new Float32Array(patch.length);
  for (let i = 0; i < ap.length; i++) {
    const a = Math.min(Math.max(ap[i] * k, 0), 0.99);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.min(Math.max((patch[i * 3 + c] - a * 255) / (1 - a), 0), 255);
  }
  return out;
}

function edgeEnergy(rgb, w, h, gaW) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = gray(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
  const gr = sobelMag(g, w, h);
  let s = 0;
  for (let i = 0; i < w * h; i++) s += gr[i] * gaW[i];
  return s;
}

function blur3(rgb, w, h) {
  const k = [0.25, 0.5, 0.25], tmp = new Float32Array(rgb.length), out = new Float32Array(rgb.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let v = 0; for (let d = -1; d <= 1; d++) v += k[d + 1] * rgb[(y * w + refl(x + d, w)) * 3 + c];
    tmp[(y * w + x) * 3 + c] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let v = 0; for (let d = -1; d <= 1; d++) v += k[d + 1] * tmp[(refl(y + d, h) * w + x) * 3 + c];
    out[(y * w + x) * 3 + c] = v;
  }
  return out;
}

function morph(mask, w, h, r, dilate) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = y + dy, xx = x + dx;
      const m = yy < 0 || yy >= h || xx < 0 || xx >= w ? (dilate ? 0 : 1) : mask[yy * w + xx];
      if (dilate ? m : !m) { v = dilate ? 1 : 0; break; }
    }
    out[y * w + x] = v;
  }
  return out;
}

function fillRing(rgb, w, h, ring) {
  // fill thin ring pixels from known neighbours, outside-in (simple diffusion inpaint)
  const known = Uint8Array.from(ring, v => (v ? 0 : 1));
  let left = ring.reduce((a, b) => a + b, 0);
  for (let pass = 0; pass < 50 && left > 0; pass++) {
    const upd = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (known[i]) continue;
      let s = [0, 0, 0], n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || yy >= h || xx < 0 || xx >= w || !known[yy * w + xx]) continue;
        const j = yy * w + xx; for (let c = 0; c < 3; c++) s[c] += rgb[j * 3 + c]; n++;
      }
      if (n) upd.push([i, s.map(v => v / n)]);
    }
    for (const [i, v] of upd) { for (let c = 0; c < 3; c++) rgb[i * 3 + c] = v[c]; known[i] = 1; left--; }
  }
}

/**
 * Remove the Gemini star in place.
 * @param {Uint8ClampedArray} px RGBA pixels, @param {number} W width, @param {number} H height
 * @returns {{status:'cleaned'|'skipped', size?, x?, y?, score, strength?, check?}}
 */
export function removeStar(px, W, H, minScore = 0.25) {
  // grayscale only for the bottom-right search region
  const G = new Float32Array(W * H);
  const rx = Math.max(0, W - 360), ry = Math.max(0, H - 360);
  for (let y = ry; y < H; y++) for (let x = rx; x < W; x++) {
    const i = (y * W + x) * 4; G[y * W + x] = gray(px[i], px[i + 1], px[i + 2]);
  }
  let best = 0;
  for (const c of detect(G, W, H)) {
    best = Math.max(best, c.score);
    if (c.score < minScore) break;
    const { x, y, s, t } = c, P = 4;
    const x1 = Math.max(0, x - P), y1 = Math.max(0, y - P), x2 = Math.min(W, x + s + P), y2 = Math.min(H, y + s + P);
    const w = x2 - x1, h = y2 - y1;
    const ap = new Float32Array(w * h), patch = new Float32Array(w * h * 3);
    for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s; xx++) ap[(y - y1 + yy) * w + (x - x1 + xx)] = t[yy * s + xx];
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const i = ((y1 + yy) * W + x1 + xx) * 4, j = (yy * w + xx) * 3;
      patch[j] = px[i]; patch[j + 1] = px[i + 1]; patch[j + 2] = px[i + 2];
    }
    const ga = sobelMag(ap, w, h); const gs = ga.reduce((a, b) => a + b, 0) + 1e-6;
    const gaW = ga.map(v => v / gs);
    // strength with the weakest leftover outline (real stars land near 1.00)
    let bk = 1, be = Infinity;
    for (let k = 0.70; k <= 1.305; k += 0.01) {
      const e = edgeEnergy(unblend(patch, ap, k), w, h, gaW);
      if (e < be) { be = e; bk = k; }
    }
    let res = unblend(patch, ap, bk);
    // verify: real star outline mostly vanishes; on a star-free corner it gets stronger
    if (s !== 36 && be / (edgeEnergy(patch, w, h, gaW) + 1e-6) > 0.6) continue;
    const bl = blur3(res, w, h);
    for (let i = 0; i < w * h; i++) if (ap[i] > 0.002 && ap[i] < 0.06)
      for (let ch = 0; ch < 3; ch++) res[i * 3 + ch] = res[i * 3 + ch] * 0.5 + bl[i * 3 + ch] * 0.5;
    if (s === 36) { // small newer star: approximate map, repair its thin outline
      const ab = Uint8Array.from(ap, v => (v > 0.03 ? 1 : 0));
      const d = morph(ab, w, h, 3, true), e = morph(ab, w, h, 3, false);
      fillRing(res, w, h, d.map((v, i) => v & !e[i]));
    }
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const i = ((y1 + yy) * W + x1 + xx) * 4, j = (yy * w + xx) * 3;
      px[i] = Math.round(res[j]); px[i + 1] = Math.round(res[j + 1]); px[i + 2] = Math.round(res[j + 2]);
    }
    return { status: 'cleaned', size: s, x, y, score: c.score, strength: Math.round(bk * 100) / 100, check: s === 36 };
  }
  return { status: 'skipped', score: best };
}
