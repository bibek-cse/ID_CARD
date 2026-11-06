/* CVPR Lab ID card engine (browser port of idcard.py).
 * Draws the card on a <canvas>: photo, ghost portrait, transparent signature,
 * text values and a Code 128 barcode on top of assets/template_base.png.      */
"use strict";
const C128 = ["11011001100", "11001101100", "11001100110", "10010011000", "10010001100", "10001001100", "10011001000", "10011000100", "10001100100", "11001001000", "11001000100", "11000100100", "10110011100", "10011011100", "10011001110", "10111001100", "10011101100", "10011100110", "11001110010", "11001011100", "11001001110", "11011100100", "11001110100", "11101101110", "11101001100", "11100101100", "11100100110", "11101100100", "11100110100", "11100110010", "11011011000", "11011000110", "11000110110", "10100011000", "10001011000", "10001000110", "10110001000", "10001101000", "10001100010", "11010001000", "11000101000", "11000100010", "10110111000", "10110001110", "10001101110", "10111011000", "10111000110", "10001110110", "11101110110", "11010001110", "11000101110", "11011101000", "11011100010", "11011101110", "11101011000", "11101000110", "11100010110", "11101101000", "11101100010", "11100011010", "11101111010", "11001000010", "11110001010", "10100110000", "10100001100", "10010110000", "10010000110", "10000101100", "10000100110", "10110010000", "10110000100", "10011010000", "10011000010", "10000110100", "10000110010", "11000010010", "11001010000", "11110111010", "11000010100", "10001111010", "10100111100", "10010111100", "10010011110", "10111100100", "10011110100", "10011110010", "11110100100", "11110010100", "11110010010", "11011011110", "11011110110", "11110110110", "10101111000", "10100011110", "10001011110", "10111101000", "10111100010", "11110101000", "11110100010", "10111011110", "10111101110", "11101011110", "11110101110", "11010000100", "11010010000", "11010011100"];
const C128_STOP = "11000111010";

const CardEngine = (() => {
  let BASE = null, L1 = null, S = 3, ready = null;
  const FONT = "IDRoboto";

  /* ---------------------------------------------------------------- init */
  function init(assets = "assets/") {
    if (ready) return ready;
    ready = (async () => {
      const [img, lay] = await Promise.all([
        loadImage(assets + "template_base.png"),
        fetch(assets + "layout.json").then(r => r.json()),
      ]);
      const ff = new FontFace(FONT, `url(${assets}Roboto-VF.ttf)`, { weight: "100 900" });
      document.fonts.add(await ff.load());
      await document.fonts.load(`700 40px ${FONT}`);
      BASE = img; L1 = lay; S = img.naturalWidth / L1.canvas_size[0];
    })();
    return ready;
  }

  function loadImage(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("Could not load image " + (src.length > 80 ? "(upload)" : src)));
      im.src = src;
    });
  }
  function fileToImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      loadImage(url).then(im => { res(im); }).catch(() => rej(new Error("That file is not an image the browser can read (use JPG or PNG).")));
    });
  }

  /* ------------------------------------------------------------ helpers */
  const sc = v => v * S;
  const box = b => b.map(v => Math.round(v * S));
  function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  function coverFit(img, w, h, yBias = 0.35) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const s = Math.max(w / iw, h / ih);
    const sw = w / s, sh = h / s;
    const sx = (iw - sw) / 2, sy = (ih - sh) * yBias;
    const c = canvas(w, h), x = c.getContext("2d");
    x.imageSmoothingQuality = "high";
    x.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    return c;
  }

  // separable box blur on Float32Array (edge-clamped), repeated `passes` times
  function boxBlur(a, w, h, r, passes = 3) {
    if (r < 1) return a;
    let src = a, tmp = new Float32Array(a.length), out = new Float32Array(a.length);
    const n = 2 * r + 1;
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < h; y++) {           // horizontal
        const o = y * w; let acc = 0;
        for (let i = -r; i <= r; i++) acc += src[o + clamp(i, 0, w - 1)];
        for (let x = 0; x < w; x++) {
          tmp[o + x] = acc / n;
          acc += src[o + clamp(x + r + 1, 0, w - 1)] - src[o + clamp(x - r, 0, w - 1)];
        }
      }
      for (let x = 0; x < w; x++) {           // vertical
        let acc = 0;
        for (let i = -r; i <= r; i++) acc += tmp[clamp(i, 0, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          out[y * w + x] = acc / n;
          acc += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
        }
      }
      if (p === 0 && src === a) { src = out; out = new Float32Array(a.length); }
      else { const t = src; src = out; out = t; }
    }
    return src;
  }
  const gaussLike = (a, w, h, sigma) => boxBlur(a, w, h, Math.max(1, Math.round(Math.sqrt(4 * sigma * sigma + 1) / 2)), 3);

  // 1-D sliding max/min (monotonic deque), separable 2-D
  function slide(a, w, h, r, isMax) {
    const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
    const better = isMax ? (p, q) => p >= q : (p, q) => p <= q;
    const pass = (get, set, len, count) => {
      const dq = new Int32Array(len + 2 * r + 2);
      for (let k = 0; k < count; k++) {
        let head = 0, tail = 0;
        for (let i = -r; i < len + r; i++) {
          const j = clamp(i, 0, len - 1), v = get(k, j);
          while (tail > head && better(v, get(k, clamp(dq[tail - 1], 0, len - 1)))) tail--;
          dq[tail++] = i;
          const c = i - r;
          if (c >= 0) { while (dq[head] < c - r) head++; set(k, c, get(k, clamp(dq[head], 0, len - 1))); }
        }
      }
    };
    pass((y, x) => a[y * w + x], (y, x, v) => { tmp[y * w + x] = v; }, w, h);
    pass((x, y) => tmp[y * w + x], (x, y, v) => { out[y * w + x] = v; }, h, w);
    return out;
  }
  const morph = (m, w, h, r, op) => slide(m, w, h, r, op === "dilate");

  function median(arr) { const s = Float32Array.from(arr).sort(); return s[s.length >> 1]; }
  function percentile(arr, p) { const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; }

  // sRGB -> OpenCV-style 8-bit Lab
  function lab8(r, g, b) {
    const lin = v => (v /= 255) <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    const R = lin(r), G = lin(g), B = lin(b);
    let X = (0.412453 * R + 0.357580 * G + 0.180423 * B) / 0.950456;
    let Y = 0.212671 * R + 0.715160 * G + 0.072169 * B;
    let Z = (0.019334 * R + 0.119193 * G + 0.950227 * B) / 1.088754;
    const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const L = Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
    return [L * 2.55, 500 * (f(X) - f(Y)) + 128, 200 * (f(Y) - f(Z)) + 128];
  }

  /* ---------------------------------------------------- person mask */
  function personMask(c) {
    const w = c.width, h = c.height, d = c.getContext("2d").getImageData(0, 0, w, h).data, n = w * h;
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = lab8(d[4 * i], d[4 * i + 1], d[4 * i + 2]); L[i] = v[0]; A[i] = v[1]; B[i] = v[2]; }
    const ph = Math.max(4, Math.floor(h * 0.12)), pw = Math.max(4, Math.floor(w * 0.12)), idx = [];
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) { idx.push(y * w + x, y * w + (w - 1 - x)); }
    const bg = [median(idx.map(i => L[i])), median(idx.map(i => A[i])), median(idx.map(i => B[i]))];
    const dist = i => Math.hypot(L[i] - bg[0], A[i] - bg[1], B[i] - bg[2]);
    const spread = percentile(idx.map(dist), 95), thr = Math.max(18, spread * 2.5);
    let m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = dist(i) > thr ? 1 : 0;
    const k = Math.max(1, Math.floor((Math.max(3, Math.floor(7 * S) | 1)) / 2));
    m = morph(morph(m, w, h, k, "dilate"), w, h, k, "erode");          // close
    m = morph(morph(m, w, h, 1, "erode"), w, h, 1, "dilate");          // open
    // keep regions touching the bottom edge (head + shoulders), 8-connected
    const keep = new Uint8Array(n), st = [];
    for (let x = 0; x < w; x++) { const i = (h - 1) * w + x; if (m[i] > 0.5) { keep[i] = 1; st.push(i); } }
    if (st.length) {
      while (st.length) {
        const i = st.pop(), x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx; if (!keep[j] && m[j] > 0.5) { keep[j] = 1; st.push(j); }
        }
      }
      for (let i = 0; i < n; i++) m[i] = keep[i];
    }
    // fill holes: background = zeros reachable from ANY border pixel
    {
      const reach = new Uint8Array(n), q = [];
      const seed = i => { if (!reach[i] && m[i] < 0.5) { reach[i] = 1; q.push(i); } };
      for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
      while (q.length) {
        const i = q.pop(), x = i % w, y = (i / w) | 0;
        if (x > 0) seed(i - 1); if (x < w - 1) seed(i + 1); if (y > 0) seed(i - w); if (y < h - 1) seed(i + w);
      }
      for (let i = 0; i < n; i++) if (!reach[i]) m[i] = 1;
    }
    let cov = 0; for (let i = 0; i < n; i++) cov += m[i]; cov /= n;
    if (cov < 0.15 || cov > 0.97) m.fill(1);
    return gaussLike(m, w, h, 2 * S);
  }

  /* -------------------------------------------------------- ghost */
  function makeGhost(photoCanvas) {
    const [gx0, gy0, gx1, gy1] = box(L1.ghost_box), gw = gx1 - gx0, gh = gy1 - gy0;
    const ph = coverFit(photoCanvas, gw, gh, 0.3);
    const m = personMask(ph);
    const d = ph.getContext("2d").getImageData(0, 0, gw, gh).data, n = gw * gh;
    const g = new Float32Array(n); let lo = 1e9, hi = -1e9;
    for (let i = 0; i < n; i++) { const v = (0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]) / 255; g[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
    const out = new ImageData(gw, gh), o = out.data, tint = L1.ghost_tint, op = L1.ghost_opacity;
    const cx = gw * 0.5, cy = gh * 0.40, alpha = new Float32Array(n);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x, dark = clamp(1 - (g[i] - lo) / Math.max(1e-6, hi - lo), 0, 1);   // clamp: pow(-0.0..,1.1) = NaN
      const r = Math.hypot(x - cx, y - cy);
      const screen = 0.5 + 0.5 * Math.sin(2 * Math.PI * r / (2.4 * S));
      const hl = 0.5 + 0.5 * Math.sin(2 * Math.PI * y / (3.0 * S));
      const ink = Math.pow(dark, 1.1) * (0.55 + 0.45 * (0.6 * screen + 0.4 * hl)) + 0.12;
      let fade = clamp((gh - y) / (gh * 0.12), 0, 1) * clamp(Math.min(x, gw - 1 - x) / (gw * 0.10), 0, 1);
      alpha[i] = clamp(ink * m[i] * fade * op, 0, 1);
    }
    const a2 = boxBlur(alpha, gw, gh, 1, 1);
    for (let i = 0; i < n; i++) { o[4 * i] = tint[0]; o[4 * i + 1] = tint[1]; o[4 * i + 2] = tint[2]; o[4 * i + 3] = Math.round(a2[i] * 255); }
    const c = canvas(gw, gh); c.getContext("2d").putImageData(out, 0, 0);
    return [c, gx0, gy0];
  }

  /* ---------------------------------------------------- signature */
  // returns a transparent, tightly cropped canvas with the ink only
  function extractSignature(img, inkColor = null) {
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const lim = 1400, f = Math.min(1, lim / Math.max(w, h));
    w = Math.max(1, Math.round(w * f)); h = Math.max(1, Math.round(h * f));
    const c0 = canvas(w, h), x0 = c0.getContext("2d");
    x0.drawImage(img, 0, 0, w, h);
    const d = x0.getImageData(0, 0, w, h).data, n = w * h;
    let minA = 255; for (let i = 0; i < n; i++) if (d[4 * i + 3] < minA) minA = d[4 * i + 3];
    const alpha = new Float32Array(n);
    if (minA < 250) {                                   // transparent PNG: use its alpha
      for (let i = 0; i < n; i++) alpha[i] = d[4 * i + 3] / 255;
    } else {                                            // paper: estimate lighting, subtract
      const gray = new Float32Array(n);
      for (let i = 0; i < n; i++) gray[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
      const r = Math.max(12, Math.floor(Math.max(w, h) / 12));
      const bg = boxBlur(slide(gray, w, h, r, true), w, h, r, 1);
      const diff = new Float32Array(n);
      for (let i = 0; i < n; i++) diff[i] = Math.max(0, bg[i] - gray[i]);
      const thr = Math.max(18, percentile(diff, 99.5) * 0.25);
      for (let i = 0; i < n; i++) alpha[i] = clamp((diff[i] - thr * 0.5) / thr, 0, 1);
    }
    let X0 = w, Y0 = h, X1 = -1, Y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] > 0.15) {
      if (x < X0) X0 = x; if (x > X1) X1 = x; if (y < Y0) Y0 = y; if (y > Y1) Y1 = y;
    }
    if (X1 < 0) throw new Error("No ink found in the signature image. Use dark pen on white paper.");
    const p = 4; X0 = Math.max(0, X0 - p); Y0 = Math.max(0, Y0 - p); X1 = Math.min(w - 1, X1 + p); Y1 = Math.min(h - 1, Y1 + p);
    let ink = inkColor;
    if (!ink) {
      const rs = [], gs = [], bs = [];
      for (let i = 0; i < n; i++) if (alpha[i] > 0.6) { rs.push(d[4 * i]); gs.push(d[4 * i + 1]); bs.push(d[4 * i + 2]); }
      ink = rs.length ? [median(rs), median(gs), median(bs)] : [25, 40, 150];
      if (Math.max(...ink) - Math.min(...ink) < 25) ink = [25, 40, 150];
    }
    const cw = X1 - X0 + 1, ch = Y1 - Y0 + 1, out = new ImageData(cw, ch), o = out.data;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4;
      o[i] = ink[0]; o[i + 1] = ink[1]; o[i + 2] = ink[2];
      o[i + 3] = Math.round(alpha[(y + Y0) * w + x + X0] * 255);
    }
    const c = canvas(cw, ch); c.getContext("2d").putImageData(out, 0, 0);
    return c;
  }

  /* ------------------------------------------------------- barcode */
  function code128(text) {
    const vals = []; let i = 0;
    const digitsRun = j => { let k = j; while (k < text.length && /\d/.test(text[k])) k++; return k - j; };
    let set = digitsRun(0) >= 4 && digitsRun(0) === text.length ? "C" : "B";
    vals.push(set === "C" ? 105 : 104);
    while (i < text.length) {
      const run = digitsRun(i);
      if (set === "B" && run >= 4 && i + run === text.length && run % 2 === 0) { vals.push(99); set = "C"; }
      if (set === "C") { vals.push(parseInt(text.substr(i, 2), 10)); i += 2; }
      else {
        const code = text.charCodeAt(i) - 32;
        if (code < 0 || code > 95) throw new Error("Barcode text contains an unsupported character.");
        vals.push(code); i += 1;
      }
    }
    let sum = vals[0]; for (let k = 1; k < vals.length; k++) sum += k * vals[k];
    vals.push(sum % 103);
    return vals.map(v => C128[v]).join("") + C128_STOP + "11";   // stop + termination bar
  }

  /* ------------------------------------------------------- rules */
  const normRoll = r => (r || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const ROLL_RE = /^(\d{2})\d*[A-Z]+(\d+)$/;
  function barcodeFromRoll(roll) {
    const m = normRoll(roll).match(ROLL_RE);
    if (!m) throw new Error("The roll number should look like 2601CS45.");
    return "CVPR" + m[1] + m[2].padStart(2, "0");
  }

  /* ------------------------------------------------------- text */
  function capFont(cap, weight = 700) {
    const t = canvas(10, 10).getContext("2d");
    t.font = `${weight} 200px ${FONT}`;
    const hgt = t.measureText("H").actualBoundingBoxAscent;
    return `${weight} ${(cap * 200 / hgt).toFixed(2)}px ${FONT}`;
  }

  function drawFields(ctx, values) {
    ctx.fillStyle = `rgb(${L1.text_color.join(",")})`;
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    for (const [key, spec] of Object.entries(L1.fields)) {
      const text = String(spec.fixed_value || values[key] || "").toUpperCase();   // fixed_value: same on every card
      if (!text) continue;
      const x = Math.round(sc(spec.label_box[2] + L1.value_gap_after_label));
      const maxW = sc(spec.max_x) - x;
      let cap = sc(L1.value_cap_height), w;
      for (;;) {
        ctx.font = capFont(cap); w = ctx.measureText(text).width;
        if (w * 0.78 <= maxW || cap <= sc(18)) break;
        cap -= Math.max(1, S * 0.5);
      }
      const sx = Math.min(1, maxW / w);
      ctx.save(); ctx.translate(x, sc(spec.baseline)); ctx.scale(sx, 1); ctx.fillText(text, 0, 0); ctx.restore();
    }
  }

  function drawBarcode(ctx, payload) {
    const mods = code128(payload);
    const [bx0, by0, bx1, by1] = box(L1.barcode_bars_box);
    const mw = Math.max(1, Math.floor((bx1 - bx0) / mods.length));
    let x = bx0 + Math.floor(((bx1 - bx0) - mw * mods.length) / 2);
    ctx.fillStyle = "#000";
    for (const b of mods) { if (b === "1") ctx.fillRect(x, by0, mw, by1 - by0 + 1); x += mw; }
    ctx.fillStyle = "rgb(20,20,20)";
    ctx.font = `400 ${Math.round(sc(L1.barcode_text_size))}px ${FONT}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const [cx, cy] = L1.barcode_text_center.map(sc);
    ctx.fillText(payload, cx, cy);
  }

  /* ------------------------------------------------------- render */
  // opts: {photo: HTMLImageElement, signature: canvas from extractSignature,
  //        name, roll, program, validTill, idNumber, barcode?, ghost=true, watermark?}
  async function render(opts) {
    await init();
    const c = canvas(BASE.naturalWidth, BASE.naturalHeight), ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(BASE, 0, 0);
    const [px0, py0, px1, py1] = box(L1.photo_box);
    const ph = coverFit(opts.photo, px1 - px0, py1 - py0);
    ctx.drawImage(ph, px0, py0);
    if (opts.ghost !== false) { const [g, gx, gy] = makeGhost(ph); ctx.drawImage(g, gx, gy); }
    if (opts.signature) {
      const [bx0, by0, bx1, by1] = box(L1.signature_box), bw = bx1 - bx0, bh = by1 - by0;
      const s = Math.min(bw / opts.signature.width, bh / opts.signature.height);
      const w = opts.signature.width * s, h = opts.signature.height * s;
      ctx.drawImage(opts.signature, bx0 + (bw - w) / 2, by0 + (bh - h) / 2, w, h);
    }
    const roll = normRoll(opts.roll);
    drawFields(ctx, { name: opts.name, roll_no: roll, program: opts.program,
                      valid_till: opts.validTill, id_number: opts.idNumber });
    drawBarcode(ctx, opts.barcode || barcodeFromRoll(roll));
    if (opts.watermark) {
      ctx.save(); ctx.translate(c.width / 2, c.height / 2); ctx.rotate(-0.38);
      ctx.font = `900 ${sc(120)}px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(200,0,0,0.22)"; ctx.fillText(opts.watermark, 0, 0); ctx.restore();
    }
    return c;
  }

  return { init, render, extractSignature, fileToImage, loadImage, barcodeFromRoll, normRoll,
           ROLL_RE, code128, get layout() { return L1; } };
})();
