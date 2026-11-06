#!/usr/bin/env python3
"""
Web interface for the CVPR Lab ID-card generator.

    pip install gradio pillow opencv-contrib-python numpy python-barcode
    python app.py                      # http://127.0.0.1:7860
    python app.py --host 0.0.0.0       # reachable from other machines on the network
    python app.py --share              # temporary public gradio.live link

Requires template_base.png (run `python idcard.py clean --template template_blank.png` once).
"""
import argparse
import csv
import io
import os
import re
import shutil
import tempfile
import zipfile
from datetime import datetime

import gradio as gr
import numpy as np
from PIL import Image

import idcard

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, "template_base.png")
LAYOUT = idcard.load_layout(os.path.join(HERE, "layout.json"))
OUT_ROOT = os.path.join(tempfile.gettempdir(), "cvpr_idcards")
os.makedirs(OUT_ROOT, exist_ok=True)

PROGRAMS = ["B.Tech", "M.Tech", "MS (Research)", "Ph.D.", "M.Sc.", "Dual Degree",
            "Research Intern", "Project Staff"]
ROLL_RE = re.compile(r"^\d{2}\d*[A-Z]+\d+$")


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def norm_roll(roll):
    return re.sub(r"[^A-Za-z0-9]", "", roll or "").upper()


def preview_codes(roll, id_number):
    r = norm_roll(roll)
    if not r:
        return "Enter the roll number to see the ID number and barcode."
    if not ROLL_RE.match(r):
        return "⚠️ The roll number should look like **2601CS45** (year, program code, department, student number)."
    idn = (id_number or "").strip() or idcard.default_id_number(r)
    return f"**ID number:** `{idn}`  &nbsp;&nbsp; **Barcode:** `{idcard.barcode_from_roll(r)}`"


def sketch_to_file(sketch, folder):
    """Save a drawn signature (gr.Sketchpad value) to a PNG; None if empty."""
    if sketch is None:
        return None
    comp = sketch.get("composite") if isinstance(sketch, dict) else sketch
    if comp is None:
        return None
    arr = np.asarray(comp)
    if arr.ndim == 3 and arr.shape[2] == 4:
        if arr[..., 3].max() == 0:
            return None
        # strokes on a transparent canvas -> keep alpha
        if arr[..., 3].min() < 250:
            p = os.path.join(folder, "signature_drawn.png")
            Image.fromarray(arr.astype(np.uint8), "RGBA").save(p)
            return p
        arr = arr[..., :3]
    if arr.min() > 245:              # blank white canvas
        return None
    p = os.path.join(folder, "signature_drawn.png")
    Image.fromarray(arr.astype(np.uint8)).save(p)
    return p


def validate_date(s):
    try:
        datetime.strptime(s.strip(), "%d-%m-%Y")
        return s.strip()
    except ValueError:
        raise gr.Error("Valid till must be a date in DD-MM-YYYY form, e.g. 31-12-2026.")


# --------------------------------------------------------------------------- #
# single card
# --------------------------------------------------------------------------- #
def generate(photo, sig_upload, sig_drawn, name, roll, program, valid_till, id_number,
             ink, ghost, progress=gr.Progress()):
    if not os.path.exists(BASE):
        raise gr.Error("template_base.png is missing. Run: python idcard.py clean --template template_blank.png")
    if not photo:
        raise gr.Error("Please upload a photo.")
    name = (name or "").strip()
    if not name:
        raise gr.Error("Please enter the name.")
    r = norm_roll(roll)
    if not ROLL_RE.match(r):
        raise gr.Error("The roll number should look like 2601CS45.")
    program = (program or "").strip()
    if not program:
        raise gr.Error("Please choose or type the program.")
    valid_till = validate_date(valid_till or "")

    job = tempfile.mkdtemp(dir=OUT_ROOT)
    signature = sig_upload or sketch_to_file(sig_drawn, job)
    if not signature:
        raise gr.Error("Please upload a signature image or draw one in the 'Draw' tab.")

    inks = {"Keep original colour": None, "Blue": (25, 40, 150), "Black": (20, 20, 25)}
    progress(0.2, desc="Building card…")
    idn = (id_number or "").strip() or idcard.default_id_number(r)
    png = os.path.join(job, f"{r}_idcard.png")
    try:
        idcard.make_card(BASE, LAYOUT, photo, signature, name, r, program, valid_till, idn,
                         png, sig_color=inks.get(ink), ghost=ghost)
    except ValueError as e:
        raise gr.Error(str(e))
    progress(0.8, desc="Saving PDF…")
    pdf = os.path.join(job, f"{r}_idcard.pdf")
    Image.open(png).convert("RGB").save(pdf, resolution=300)
    sig_clean = os.path.join(job, f"{r}_signature.png")
    idcard.extract_signature(signature, inks.get(ink)).save(sig_clean)

    preview = Image.open(png).convert("RGB")
    preview.thumbnail((1600, 1600), Image.LANCZOS)
    return preview, [png, pdf, sig_clean], f"✅ Card ready for **{name.upper()}** — ID `{idn}`, barcode `{idcard.barcode_from_roll(r)}`"


# --------------------------------------------------------------------------- #
# batch
# --------------------------------------------------------------------------- #
def generate_batch(csv_file, zip_file, progress=gr.Progress()):
    if not csv_file or not zip_file:
        raise gr.Error("Upload both the CSV file and a ZIP with the photos and signatures.")
    job = tempfile.mkdtemp(dir=OUT_ROOT)
    media = os.path.join(job, "media")
    with zipfile.ZipFile(zip_file) as z:
        for m in z.infolist():                      # safe extract (no path traversal)
            if m.is_dir():
                continue
            target = os.path.normpath(os.path.join(media, m.filename))
            if not target.startswith(os.path.abspath(media)):
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(m) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
    by_name = {}
    for root, _, files in os.walk(media):
        for f in files:
            by_name[f.lower()] = os.path.join(root, f)

    def find(pth):
        p = os.path.join(media, pth)
        return p if os.path.exists(p) else by_name.get(os.path.basename(pth).lower())

    with open(csv_file, newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    out_dir = os.path.join(job, "cards"); os.makedirs(out_dir)
    log, done = [], []
    for i, row in enumerate(progress.tqdm(rows, desc="Generating")):
        try:
            r = norm_roll(row.get("roll", ""))
            ph, sg = find(row.get("photo", "")), find(row.get("signature", ""))
            if not ph or not sg:
                raise ValueError("photo or signature file not found in ZIP")
            out = os.path.join(out_dir, f"{r}.png")
            idcard.make_card(BASE, LAYOUT, ph, sg, row["name"].strip(), r, row["program"].strip(),
                             (row.get("valid_till") or "31-12-2026").strip(),
                             (row.get("id_number") or "").strip() or idcard.default_id_number(r),
                             out, barcode_text=(row.get("barcode") or "").strip() or None)
            done.append(out); log.append(f"✅ row {i + 2}: {r}")
        except Exception as e:
            log.append(f"❌ row {i + 2}: {e}")
    zpath = os.path.join(job, "id_cards.zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in done:
            z.write(f, os.path.basename(f))
    gallery = []
    for f in done[:12]:
        im = Image.open(f); im.thumbnail((800, 800)); gallery.append(im)
    return gallery, zpath, "\n".join(log)


# --------------------------------------------------------------------------- #
# UI
# --------------------------------------------------------------------------- #
CSS = """
#title {text-align:center; margin-bottom:0}
#subtitle {text-align:center; color:#6b5b5e; margin-top:4px}
.gen-btn {background:#3a0e10 !important; color:white !important}
"""


def build_ui():
    theme = gr.themes.Soft(primary_hue="rose", neutral_hue="stone")
    with gr.Blocks(title="CVPR Lab ID Card Generator") as demo:
        gr.Markdown("# CVPR Lab — ID Card Generator", elem_id="title")
        gr.Markdown("Fill in your details, add a photo and signature, and download your ID card.",
                    elem_id="subtitle")
        with gr.Tabs():
            with gr.Tab("Single card"):
                with gr.Row():
                    with gr.Column(scale=5):
                        photo = gr.Image(label="Photo (front-facing, plain light background)",
                                         type="filepath", sources=["upload", "webcam"], height=300)
                        with gr.Tabs():
                            with gr.Tab("Upload signature"):
                                sig_upload = gr.Image(label="Signature (dark pen on white paper, or transparent PNG)",
                                                      type="filepath", sources=["upload"], height=160)
                            with gr.Tab("Draw signature"):
                                sig_draw = gr.Sketchpad(label="Sign here", type="numpy", image_mode="RGBA",
                                                        canvas_size=(800, 260),
                                                        brush=gr.Brush(colors=["#1a2a96", "#111111"],
                                                                       default_size=5))
                        name = gr.Textbox(label="Full name", placeholder="Akash Rathor")
                        with gr.Row():
                            roll = gr.Textbox(label="Roll number", placeholder="2601CS45")
                            program = gr.Dropdown(PROGRAMS, value="B.Tech", label="Program",
                                                  allow_custom_value=True)
                        with gr.Row():
                            valid_till = gr.Textbox(label="Valid till (DD-MM-YYYY)", value="31-12-2026")
                            id_number = gr.Textbox(label="ID number (optional)",
                                                   placeholder="optional record number (not printed on the card)")
                        codes = gr.Markdown(preview_codes("", ""))
                        with gr.Accordion("Options", open=False):
                            ink = gr.Radio(["Keep original colour", "Blue", "Black"],
                                           value="Keep original colour", label="Signature ink")
                            ghost = gr.Checkbox(value=True, label="Ghost portrait (security image)")
                        btn = gr.Button("Generate ID card", variant="primary", elem_classes="gen-btn")
                    with gr.Column(scale=6):
                        status = gr.Markdown()
                        out_img = gr.Image(label="ID card preview", type="pil", interactive=False,
                                           height=560)
                        files = gr.File(label="Downloads: PNG (3171×2280, 300 dpi) · PDF · transparent signature",
                                        file_count="multiple")
                for comp in (roll, id_number):
                    comp.change(preview_codes, [roll, id_number], codes)
                btn.click(generate, [photo, sig_upload, sig_draw, name, roll, program, valid_till,
                                     id_number, ink, ghost], [out_img, files, status])

            with gr.Tab("Batch (many cards)"):
                gr.Markdown(
                    "Upload a **CSV** with columns `photo,signature,name,roll,program` "
                    "(optional: `valid_till,id_number,barcode`) and a **ZIP** containing the photo and "
                    "signature files named in the CSV.")
                with gr.Row():
                    csv_in = gr.File(label="members.csv", file_types=[".csv"], type="filepath")
                    zip_in = gr.File(label="photos + signatures .zip", file_types=[".zip"], type="filepath")
                bbtn = gr.Button("Generate all cards", variant="primary", elem_classes="gen-btn")
                gal = gr.Gallery(label="Preview (first 12)", columns=3, height=420)
                bzip = gr.File(label="All cards (.zip)")
                blog = gr.Textbox(label="Log", lines=8)
                bbtn.click(generate_batch, [csv_in, zip_in], [gal, bzip, blog])
    return demo, theme


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("GRADIO_SERVER_NAME", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("GRADIO_SERVER_PORT", 7860)))
    ap.add_argument("--share", action="store_true")
    ap.add_argument("--auth", default=os.environ.get("IDCARD_AUTH"),
                    help='login(s) "user:pass" or "u1:p1,u2:p2" (or env IDCARD_AUTH)')
    a = ap.parse_args()
    auth = [tuple(x.split(":", 1)) for x in a.auth.split(",")] if a.auth else None
    if not os.path.exists(BASE) and os.path.exists(os.path.join(HERE, "template_blank.png")):
        print("template_base.png not found - building it (about 10 s)...")
        idcard.build_clean_base(os.path.join(HERE, "template_blank.png"), LAYOUT, BASE, 3,
                                os.path.join(HERE, "models", "EDSR_x3.pb"),
                                os.path.join(HERE, "template_blank_x3_edsr.png"))
    demo, theme = build_ui()
    demo.queue(default_concurrency_limit=2).launch(
        server_name=a.host, server_port=a.port, share=a.share, auth=auth,
        allowed_paths=[OUT_ROOT], theme=theme, css=CSS)
