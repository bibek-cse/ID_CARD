# CVPR Lab ID-card generator (HD)

Turns the blank template into a personalised ID card from a **photo, name, roll number, program and signature**.
Output is **3171 × 2280 px (3× the original template), tagged 300 dpi**.

## Setup
```bash
pip install pillow opencv-contrib-python numpy python-barcode
python idcard.py clean --template template_blank.png   # builds template_base.png (HD)
python idcard.py layout -o layout_debug.png            # shows every editable region
```
`clean` reuses `template_blank_x3_edsr.png` (the included 3× super-resolved background), so it takes about 10 s.
To redo the super-resolution from scratch, delete that file and put the EDSR model in `models/`:
`https://raw.githubusercontent.com/Saafke/EDSR_Tensorflow/master/models/EDSR_x3.pb` (about 5 min on CPU).
Without the model or the cached file, it falls back to Lanczos upscaling.

## What `clean` does to the template
1. **Background:** EDSR ×3 deep-learning super-resolution, plus mild sharpening.
2. **All static text redrawn as vector text** at exactly the original positions and sizes: header (Roboto Bold with a light vertical gradient), IDENTITY CARD (serif bold), the five labels, SIGNATURE, and the footer. The old blurry text is removed by inpainting first.
3. **Photo frame redrawn as vectors:** brown edge, copper band, rose line, maroon inner edge.
4. **Signature frame** drawn in the same style.
5. **HD logo** (`logo_hd.png`) fitted exactly onto the original logo's ring.
6. **Removed:** the sample photo, the ghost face and the barcode remnants.

## Web interface
```bash
pip install -r requirements.txt
python app.py                  # open http://127.0.0.1:7860
python app.py --host 0.0.0.0   # let others on the lab network use it (http://<server-ip>:7860)
```
- **Single card:** upload a photo (or take one with the webcam), upload a signature or draw one, then fill in name, roll number, program, valid till and an optional ID number. The ID number and barcode update as you type. Downloads: HD PNG, PDF and the transparent signature.
- **Batch:** upload a CSV plus a ZIP of the photos and signatures and get back a ZIP of all the cards, with a per-row log.
- Inputs are checked (roll format, DD-MM-YYYY date, missing files) and errors are shown in the page.
- On Param Rudra or a remote server, use SSH port-forwarding: `ssh -L 7860:localhost:7860 user5@<server>`, then open `http://localhost:7860` locally.

## One card (command line)
```bash
python idcard.py make --photo photo.jpg --signature sign.jpg \
  --name "Akash Rathor" --roll 2601CS45 --program "B.Tech" \
  --valid-till 31-12-2026 --id-number IITP-CVPR-1645 -o card.png    # .png / .jpg / .pdf
```
- `--valid-till` defaults to `31-12-2026`; `--id-number` defaults to `IITP-CVPR-<last 4 digits of roll>`.
- Barcode: `IITPCVPR<YY><NN>` from the roll number (`2601CS45` → `IITPCVPR2645`: 26 = year, 45 = student no.). Override with `--barcode`.
- `--dpi` sets the dpi tag (default 300).

## Many cards
```bash
python idcard.py batch --csv members.csv --out-dir cards/ --format png
```
CSV columns: `photo,signature,name,roll,program,valid_till,id_number,barcode` (the last three are optional; paths are relative to the CSV).

## Transparent signature only
```bash
python idcard.py signature --signature sign.jpg -o sign_clean.png
```

## Region map
All coordinates in `layout.json` are on the **original 1057×760 grid** and are scaled automatically to the base image size.

| Region | Box `[x0, y0, x1, y1]` (1× grid) | Behaviour |
|---|---|---|
| Photo | `[36, 237, 310, 565]` | photo is cropped to fill the window (keeps more of the top) |
| Ghost portrait | `[864, 311, 1017, 486]` | regenerated from each person's photo: backdrop removed, fine engraving texture, maroon tint, faded edges |
| Signature | frame `[32, 585, 321, 679]`, box `[44, 596, 309, 667]` | ink extracted onto a transparent layer and centred inside the frame |
| NAME value | from x=501, baseline 293, up to x=1040 | long values are condensed to 78% first, then shrunk |
| ROLL / PROGRAM / VALID TILL | baselines 362 / 431 / 498, up to x=852 | kept clear of the ghost |
| ID NUMBER | baseline 566, up to x=1040 | |
| Barcode | bars `[663, 624, 1041, 686]` | Code 128, human-readable text below |

## Input tips
- Photo: front-facing, plain light backdrop, ideally at least 900 px tall (the photo window is 822×984 px at HD).
- Signature: dark pen on white paper, or a transparent PNG. Black or grey ink is recoloured to blue; use `--sig-color R,G,B` to force a colour.

Fonts: Roboto (Apache 2.0) is in `fonts/`; Liberation fonts are used as a fallback.
