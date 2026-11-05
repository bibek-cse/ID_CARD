---
title: CVPR Lab ID Card Generator
emoji: 🪪
colorFrom: red
colorTo: gray
sdk: gradio
app_file: app.py
pinned: false
---

# CVPR Lab (IIT Patna) — ID Card Generator

Generates the lab's identity card from a **photo, name, roll number, program and signature**.
Cards are **3171 × 2280 px (300 dpi)**, printable as PNG or PDF.

What the generator does:
- **Ghost portrait:** a faded security copy of the photo, regenerated from each person's own photo.
- **Signature:** the ink is extracted onto a transparent background and placed inside the signature frame.
- **Barcode:** Code 128 built from the roll number, `2601CS45` → `IITPCVPR2645` (26 = year, 45 = student number).
- **Template:** HD (AI super-resolution background, vector text, HD logo).

## Quick start
```bash
git clone https://github.com/bibek-cse/ID_CARD.git
cd ID_CARD
pip install -r requirements.txt
python app.py --auth lab:yourpassword      # open http://127.0.0.1:7860
```
- Lab network: `python app.py --host 0.0.0.0 --auth lab:yourpassword`, then share `http://<server-ip>:7860`
- Remote server or cluster: `ssh -L 7860:localhost:7860 user@server`, then open `http://localhost:7860`

## Three ways to use it
| Way | For | Where |
|---|---|---|
| **Web interface** (Gradio): single card + batch tab | lab members filling in their own details | `app.py` |
| **Command line**: `make`, `batch`, `clean`, `layout`, `signature` | admins, scripting | `idcard/idcard.py`, see [idcard/README.md](idcard/README.md) |
| **Google Form → API**: cards emailed automatically | collecting requests by form | `idcard/server/`, `idcard/google_form/SETUP.md`, `idcard/Dockerfile` |

## Deploy on Hugging Face Spaces (free, permanent link)
1. huggingface.co → **New Space** → SDK **Gradio**, visibility **Private**.
2. Space **Settings → Variables and secrets** → add a secret `IDCARD_AUTH` = `lab:yourpassword`.
3. Push this repo to the Space:
   ```bash
   git remote add space https://huggingface.co/spaces/<hf-user>/<space-name>
   git push space main
   ```
The settings block at the top of this README tells Spaces to run `app.py`.

## Repository layout
```
app.py                  launcher for the web interface (used by Spaces)
requirements.txt
idcard/
  idcard.py             card generator (library + command line)
  app.py                Gradio interface
  layout.json           every region's position on the 1057×760 template grid
  template_base.png     HD blank base the cards are drawn on
  template_blank.png    original template (input to `idcard.py clean`)
  template_blank_x3_edsr.png   cached 3× super-resolved background
  logo_hd.png, fonts/   HD logo, Roboto font
  server/, Dockerfile   REST API for the Google Form flow
  google_form/          Apps Script + setup guide
```

## Security
The cards carry the lab's name, so **always run the interface with `--auth`** (or the `IDCARD_AUTH` secret) when other people can reach it, and give the login only to lab members. The API requires an `X-API-Key`.
