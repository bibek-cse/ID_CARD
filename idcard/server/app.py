"""
ID-card API - wraps idcard.py so the Google Form (Apps Script) can request cards.

POST /generate   (multipart/form-data, header  X-API-Key: <API_KEY>)
    photo       file   (jpg/png)
    signature   file   (jpg/png)
    name, roll, program            text, required
    valid_till, id_number, barcode text, optional
  -> 200 image/png  (the ID card)     |  4xx/5xx JSON {"error": ...}

GET /health -> {"ok": true}

Environment variables
    API_KEY            shared secret; the Apps Script sends the same value   (required)
    ALLOWED_ROLLS      optional path to a text/CSV file of valid roll numbers (one per line
                       or first column). When set, only those rolls get a card.
    DEFAULT_VALID_TILL default "31-12-2026"
    OUTPUT_FORMAT      png (default) or jpg
    MAX_UPLOAD_MB      default 15
"""
import hmac
import io
import os
import re
import sys
import tempfile

from flask import Flask, jsonify, request, send_file
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import idcard  # noqa: E402

API_KEY = os.environ.get("API_KEY", "")
DEFAULT_VALID_TILL = os.environ.get("DEFAULT_VALID_TILL", "31-12-2026")
OUTPUT_FORMAT = os.environ.get("OUTPUT_FORMAT", "png").lower()
BASE = os.path.join(ROOT, "template_base.png")
LAYOUT = idcard.load_layout(os.path.join(ROOT, "layout.json"))
ROLL_RE = re.compile(r"^\d{4}[A-Z]{2,3}\d{2,3}$")          # e.g. 2601CS45
DATE_RE = re.compile(r"^\d{2}-\d{2}-\d{4}$")


def load_allowed():
    p = os.environ.get("ALLOWED_ROLLS")
    if not p:
        return None
    with open(p, encoding="utf-8") as f:
        return {ln.split(",")[0].strip().upper() for ln in f if ln.strip()}


ALLOWED = load_allowed()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("MAX_UPLOAD_MB", "15")) * 1024 * 1024


def err(msg, code=400):
    return jsonify(error=msg), code


def save_upload(fs, folder, stem):
    """Save an uploaded image after checking it really is an image."""
    data = fs.read()
    try:
        im = Image.open(io.BytesIO(data))
        im.verify()
    except Exception:
        raise ValueError(f"{stem} is not a valid image")
    im = Image.open(io.BytesIO(data))
    path = os.path.join(folder, f"{stem}.png")
    (im.convert("RGBA") if im.mode in ("RGBA", "LA", "P") else im.convert("RGB")).save(path)
    return path


@app.get("/health")
def health():
    return jsonify(ok=True, base_exists=os.path.exists(BASE))


@app.post("/generate")
def generate():
    if not API_KEY or not hmac.compare_digest(request.headers.get("X-API-Key", ""), API_KEY):
        return err("unauthorized", 401)

    f = request.form
    name = (f.get("name") or "").strip()
    roll = re.sub(r"\s+", "", (f.get("roll") or "")).upper()
    program = (f.get("program") or "").strip()
    valid_till = (f.get("valid_till") or DEFAULT_VALID_TILL).strip()
    id_number = (f.get("id_number") or "").strip() or idcard.default_id_number(roll)
    barcode = (f.get("barcode") or "").strip() or None

    if not name or len(name) > 60:
        return err("name is required (max 60 characters)")
    if not ROLL_RE.match(roll):
        return err("roll number must look like 2601CS45")
    if not program or len(program) > 30:
        return err("program is required (max 30 characters)")
    if not DATE_RE.match(valid_till):
        return err("valid_till must be DD-MM-YYYY")
    if ALLOWED is not None and roll not in ALLOWED:
        return err("roll number is not on the lab's member list", 403)
    if "photo" not in request.files or "signature" not in request.files:
        return err("photo and signature files are required")

    with tempfile.TemporaryDirectory() as tmp:
        try:
            photo = save_upload(request.files["photo"], tmp, "photo")
            sig = save_upload(request.files["signature"], tmp, "signature")
            out = os.path.join(tmp, f"{roll}.{OUTPUT_FORMAT}")
            idcard.make_card(BASE, LAYOUT, photo, sig, name, roll, program,
                             valid_till, id_number, out, barcode_text=barcode)
        except ValueError as e:
            return err(str(e))
        except Exception as e:  # keep the service alive, report the reason
            app.logger.exception("card generation failed")
            return err(f"card generation failed: {e}", 500)
        with open(out, "rb") as fh:
            data = fh.read()

    mime = "image/png" if OUTPUT_FORMAT == "png" else "image/jpeg"
    return send_file(io.BytesIO(data), mimetype=mime, as_attachment=True,
                     download_name=f"{roll}_IDCard.{OUTPUT_FORMAT}")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
