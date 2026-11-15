import { removeStar } from './src/core.js';

const $ = id => document.getElementById(id);
const drop = $('drop'), input = $('file'), list = $('list'), bar = $('bar');
const results = []; // { name, blob }
let queue = Promise.resolve(), counts = { cleaned: 0, skipped: 0, failed: 0 };

input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || e.target === drop) drop.classList.remove('over'); }));
document.addEventListener('drop', e => addFiles(e.dataTransfer.files));
document.addEventListener('paste', e => addFiles([...e.clipboardData.items].filter(i => i.kind === 'file').map(i => i.getAsFile())));

$('clear').onclick = () => { list.innerHTML = ''; results.length = 0; counts = { cleaned: 0, skipped: 0, failed: 0 }; bar.hidden = true; };
$('all').onclick = async () => {
  for (const r of results) { save(r); await new Promise(res => setTimeout(res, 250)); }
};

function addFiles(files) {
  const imgs = [...files].filter(f => f && /^image\/(png|jpeg|webp)$/.test(f.type));
  for (const f of imgs) {
    const row = makeRow(f.name);
    queue = queue.then(() => processFile(f, row)).catch(err => { console.error(err); });
  }
}

function makeRow(name) {
  const li = document.createElement('li');
  li.className = 'item';
  li.innerHTML = `<div><canvas width="96" height="96"></canvas><div class="cap">before</div></div>
    <div><canvas width="96" height="96"></canvas><div class="cap">after</div></div>
    <div><div class="name"></div><div class="status busy">Waiting…</div></div>
    <button disabled>Download</button>`;
  li.querySelector('.name').textContent = name;
  list.prepend(li);
  bar.hidden = false;
  return li;
}

function thumb(canvas, src, W, H, cx, cy, size) {
  // draw a square crop of the image around (cx, cy) into the 96px preview canvas
  const s = Math.round(Math.min(size, W, H)), x = Math.max(0, Math.min(W - s, Math.round(cx - s / 2))), y = Math.max(0, Math.min(H - s, Math.round(cy - s / 2)));
  const crop = new ImageData(s, s);
  for (let r = 0; r < s; r++) crop.data.set(src.subarray(((y + r) * W + x) * 4, ((y + r) * W + x + s) * 4), r * s * 4);
  const tmp = new OffscreenCanvas(s, s); tmp.getContext('2d').putImageData(crop, 0, 0);
  const ctx = canvas.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(tmp, 0, 0, 96, 96);
}

async function processFile(file, row) {
  const status = row.querySelector('.status'), [cBefore, cAfter] = row.querySelectorAll('canvas'), btn = row.querySelector('button');
  status.textContent = 'Working…';
  try {
    // decode without colour conversion so pixels stay exactly as Gemini made them
    const bmp = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const W = bmp.width, H = bmp.height, cv = new OffscreenCanvas(W, H), ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0); bmp.close();
    const data = ctx.getImageData(0, 0, W, H), before = new Uint8ClampedArray(data.data);
    const r = removeStar(data.data, W, H);
    const cx = r.status === 'cleaned' ? r.x + r.size / 2 : W - 112, cy = r.status === 'cleaned' ? r.y + r.size / 2 : H - 112;
    const zoom = r.status === 'cleaned' ? r.size * 2.2 : 224;
    thumb(cBefore, before, W, H, cx, cy, zoom);
    if (r.status === 'skipped') {
      thumb(cAfter, before, W, H, cx, cy, zoom);
      status.className = 'status skip'; status.textContent = 'No star found — left unchanged.'; btn.hidden = true;
      counts.skipped++; return summary();
    }
    ctx.putImageData(data, 0, 0);
    thumb(cAfter, data.data, W, H, cx, cy, zoom);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : file.type === 'image/webp' ? 'image/webp' : 'image/png';
    const blob = await cv.convertToBlob({ type, quality: 0.97 });
    const dot = file.name.lastIndexOf('.'), name = (dot > 0 ? file.name.slice(0, dot) : file.name) + '_clean' + (dot > 0 ? file.name.slice(dot) : '.png');
    const res = { name, blob }; results.push(res);
    btn.disabled = false; btn.onclick = () => save(res);
    status.className = r.check ? 'status warn' : 'status ok';
    status.textContent = r.check ? 'Cleaned — small star version, zoom in to check the edge.' : 'Cleaned.';
    counts.cleaned++; summary();
  } catch (e) {
    console.error(e); btn.hidden = true; status.className = 'status skip'; status.textContent = 'Could not read this image.'; counts.failed++; summary();
  }
}

function summary() {
  const p = [`${counts.cleaned} cleaned`]; if (counts.skipped) p.push(`${counts.skipped} without a star`); if (counts.failed) p.push(`${counts.failed} unreadable`);
  $('summary').textContent = p.join(' · '); $('all').disabled = results.length === 0;
}

function save({ name, blob }) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
