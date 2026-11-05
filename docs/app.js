/* Form logic: preview, validation, Apps Script (Google Drive) submission. */
"use strict";
(() => {
  const CFG = window.IDCARD_CONFIG || {};
  const API = (CFG.APPS_SCRIPT_URL || "").trim();
  const $ = id => document.getElementById(id);
  const state = { photo: null, sigImg: null, sig: null, final: null, server: null, busy: false };
  const DATE_RE = /^(0[1-9]|[12]\d|3[01])-(0[1-9]|1[0-2])-(\d{4})$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /* ---------------------------------------------------- setup */
  (CFG.PROGRAMS || ["B.Tech", "M.Tech", "Ph.D."]).concat(["Other…"]).forEach(p => {
    const o = document.createElement("option"); o.textContent = p; $("program").appendChild(o);
  });
  $("validTill").value = CFG.VALID_TILL || "31-12-2026";
  $("idWrap").hidden = true;                   // card shows "LAB NAME: IITP-CVPR" (fixed in layout.json)

  function banner(html) { $("modeBanner").innerHTML = html; $("modeBanner").hidden = !html; }
  if (!API) {
    banner("<b>Offline mode:</b> no Google Drive link is set in <code>config.js</code>, so cards are only downloaded here and the ID number is typed by hand.");
    $("emailWrap").hidden = true;
  } else {
    fetch(API).then(r => r.json()).then(info => {
      state.server = info;
      if (info.requireCode) $("codeWrap").hidden = false;
      if (info.validTill) { $("validTill").value = info.validTill; $("validTill").readOnly = true; }
      if (info.open === false) { banner("ID card registration is currently closed."); $("submit").disabled = true; }
    }).catch(() => banner("Could not reach the lab's Google Drive service. Please try again later."));
  }

  const program = () => $("program").value === "Other…" ? $("programOther").value.trim() : $("program").value;
  $("program").addEventListener("change", () => { $("programOtherWrap").hidden = $("program").value !== "Other…"; schedule(); });

  /* ---------------------------------------------------- photo */
  function wireDrop(dropEl, inputEl, onFile) {
    ["dragenter", "dragover"].forEach(e => dropEl.addEventListener(e, ev => { ev.preventDefault(); dropEl.classList.add("over"); }));
    ["dragleave", "drop"].forEach(e => dropEl.addEventListener(e, () => dropEl.classList.remove("over")));
    dropEl.addEventListener("drop", ev => { ev.preventDefault(); if (ev.dataTransfer.files[0]) onFile(ev.dataTransfer.files[0]); });
    inputEl.addEventListener("change", () => inputEl.files[0] && onFile(inputEl.files[0]));
  }
  wireDrop($("photoDrop"), $("photo"), async f => {
    try {
      state.photo = await CardEngine.fileToImage(f);
      $("photoThumb").src = state.photo.src; $("photoThumb").hidden = false;
      const h = state.photo.naturalHeight;
      $("photoHint").innerHTML = h < 600 ? `<small>⚠️ This photo is only ${h} px tall; it will look soft on the card.</small>` : "";
      schedule();
    } catch (e) { setStatus(e.message, "err"); }
  });

  /* ---------------------------------------------------- signature */
  function showSig() {
    const pc = $("sigPreview"), x = pc.getContext("2d");
    x.clearRect(0, 0, pc.width, pc.height);
    if (!state.sig) return;
    const s = Math.min((pc.width - 20) / state.sig.width, (pc.height - 20) / state.sig.height);
    const w = state.sig.width * s, h = state.sig.height * s;
    x.drawImage(state.sig, (pc.width - w) / 2, (pc.height - h) / 2, w, h);
  }
  function setSigSource(img) {
    try { state.sig = img ? CardEngine.extractSignature(img) : null; setStatus(""); }
    catch (e) { state.sig = null; setStatus(e.message, "err"); }
    showSig(); schedule();
  }
  wireDrop($("sigDrop"), $("sigFile"), async f => {
    try { state.sigImg = await CardEngine.fileToImage(f); $("sigHint").textContent = f.name; setSigSource(state.sigImg); }
    catch (e) { setStatus(e.message, "err"); }
  });
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b === t));
    $("pane-upload").hidden = t.dataset.tab !== "upload";
    $("pane-draw").hidden = t.dataset.tab !== "draw";
    setSigSource(t.dataset.tab === "draw" ? (padDirty ? $("pad") : null) : state.sigImg);
  }));

  // drawing pad (transparent canvas -> extractSignature uses its alpha)
  const pad = $("pad"), pctx = pad.getContext("2d");
  let drawing = false, last = null, padDirty = false;
  pctx.lineCap = "round"; pctx.lineJoin = "round"; pctx.strokeStyle = "#1a2a96";
  const pt = e => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height, e.pressure || 0.5]; };
  pad.addEventListener("pointerdown", e => { drawing = true; last = pt(e); pad.setPointerCapture(e.pointerId); });
  pad.addEventListener("pointermove", e => {
    if (!drawing) return;
    const p = pt(e); pctx.lineWidth = 3 + 4 * (e.pointerType === "pen" ? p[2] : 0.5);
    pctx.beginPath(); pctx.moveTo(last[0], last[1]); pctx.lineTo(p[0], p[1]); pctx.stroke(); last = p; padDirty = true;
  });
  const endDraw = () => { if (drawing) { drawing = false; if (padDirty) setSigSource(pad); } };
  pad.addEventListener("pointerup", endDraw); pad.addEventListener("pointerleave", endDraw);
  $("padClear").addEventListener("click", () => { pctx.clearRect(0, 0, pad.width, pad.height); padDirty = false; setSigSource(null); });

  /* ---------------------------------------------------- preview */
  function values() {
    return {
      name: $("name").value.trim().replace(/\s+/g, " "),
      roll: CardEngine.normRoll($("roll").value),
      program: program(),
      validTill: $("validTill").value.trim(),
      idNumber: $("idNumber").value.trim().toUpperCase(),
      email: $("email").value.trim(),
      code: $("code").value.trim(),
    };
  }
  function showCodes() {
    const v = values();
    if (!v.roll) { $("codes").textContent = ""; return; }
    if (!CardEngine.ROLL_RE.test(v.roll)) { $("codes").textContent = "⚠️ Roll number should look like 2601CS45."; return; }
    $("codes").textContent = `Barcode: ${CardEngine.barcodeFromRoll(v.roll)}`;
  }
  let timer = null, seq = 0;
  function schedule() { showCodes(); clearTimeout(timer); timer = setTimeout(preview, 350); }
  ["name", "roll", "programOther", "validTill", "idNumber"].forEach(id => $(id).addEventListener("input", () => { state.final = null; $("downloads").hidden = true; $("previewTitle").textContent = "Preview"; schedule(); }));

  async function preview() {
    if (!state.photo || state.busy) return;
    const v = values(), my = ++seq;
    try {
      const c = await CardEngine.render({
        photo: state.photo, signature: state.sig, name: v.name || "YOUR NAME",
        roll: CardEngine.ROLL_RE.test(v.roll) ? v.roll : "2601CS00", program: v.program || "PROGRAM",
        validTill: v.validTill, idNumber: "",
        watermark: API ? "PREVIEW" : null,
      });
      if (my !== seq) return;
      paint(c);
      if (!API && validate(v, true)) { state.final = c; $("downloads").hidden = false; }
    } catch (e) { setStatus(e.message, "err"); }
  }
  function paint(c) {
    const dst = $("card"); dst.width = c.width; dst.height = c.height;
    dst.getContext("2d").drawImage(c, 0, 0); $("empty").hidden = true;
  }

  /* ---------------------------------------------------- validation */
  function validate(v, quiet = false) {
    const errs = [];
    const mark = (id, bad) => $(id).classList.toggle("bad", !!bad && !quiet);
    mark("name", !v.name); if (!v.name) errs.push("name");
    mark("roll", !CardEngine.ROLL_RE.test(v.roll)); if (!CardEngine.ROLL_RE.test(v.roll)) errs.push("roll number like 2601CS45");
    if (!v.program) errs.push("program");
    const dm = v.validTill.match(DATE_RE); mark("validTill", !dm); if (!dm) errs.push("valid till as DD-MM-YYYY");
    if (API && v.email && !EMAIL_RE.test(v.email)) { mark("email", true); errs.push("a valid email"); } else mark("email", false);
    if (API && state.server && state.server.requireCode && !v.code) { mark("code", true); errs.push("the lab access code"); } else mark("code", false);
    if (!state.photo) errs.push("a photo");
    if (!state.sig) errs.push("a signature");
    if (errs.length && !quiet) setStatus("Please add: " + errs.join(", ") + ".", "err");
    return errs.length === 0;
  }

  /* ---------------------------------------------------- submit */
  function setStatus(msg, kind = "") { $("status").textContent = msg; $("status").className = "status " + kind; }
  function jpeg(img, maxSide = 1400) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, f = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w * f); c.height = Math.round(h * f);
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.92);
  }
  async function post(payload) {
    const r = await fetch(API, { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "text/plain;charset=utf-8" } });
    let j; try { j = await r.json(); } catch { throw new Error("The lab's Google service sent an unexpected reply. Please try again."); }
    if (!j.ok) throw new Error(j.error || "Request failed.");
    return j;
  }

  $("form").addEventListener("submit", async ev => {
    ev.preventDefault();
    if (state.busy) return;
    const v = values();
    if (!validate(v)) return;
    if (!API) { await preview(); setStatus("Card ready — use the download buttons.", "ok"); return; }
    state.busy = true; $("submit").disabled = true;
    clearTimeout(timer); seq++;                      // drop any preview still being drawn
    try {
      setStatus("Registering with the lab…");
      const reg = await post({ action: "register", name: v.name, roll: v.roll, program: v.program, validTill: v.validTill,
        email: v.email, code: v.code, photo: jpeg(state.photo), signature: state.sig.toDataURL("image/png") });
      setStatus("Building your card…");
      const card = await CardEngine.render({ photo: state.photo, signature: state.sig, name: v.name, roll: v.roll,
        program: v.program, validTill: reg.validTill || v.validTill, idNumber: reg.idNumber, barcode: reg.barcode });
      paint(card); state.final = card;
      setStatus("Saving your card to the lab's Google Drive…");
      const up = await post({ action: "card", roll: v.roll, token: reg.token, card: card.toDataURL("image/png") });
      $("previewTitle").textContent = "Your ID card";
      $("downloads").hidden = false;
      $("driveNote").textContent = "Download your card now — it is also saved with the lab.";
      setStatus(reg.existing ? "Updated: your earlier card was replaced with this one." : "Done! Your card is saved with the lab.", "ok");
    } catch (e) {
      setStatus(e.message, "err");
    } finally { state.busy = false; $("submit").disabled = false; }
  });

  /* ---------------------------------------------------- downloads */
  const fname = ext => `${values().roll || "idcard"}_IDCard.${ext}`;
  $("dlPng").addEventListener("click", () => state.final && state.final.toBlob(b => {
    const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = fname("png"); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, "image/png"));
  $("dlPdf").addEventListener("click", () => {
    if (!state.final) return;
    if (!window.jspdf) { setStatus("PDF library didn't load; use Download PNG.", "err"); return; }
    const c = state.final, wmm = c.width / 300 * 25.4, hmm = c.height / 300 * 25.4;
    const pdf = new window.jspdf.jsPDF({ orientation: "landscape", unit: "mm", format: [wmm, hmm] });
    pdf.addImage(c.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, wmm, hmm);
    pdf.save(fname("pdf"));
  });

  CardEngine.init().catch(e => setStatus("Could not load the card template: " + e.message, "err"));
})();
