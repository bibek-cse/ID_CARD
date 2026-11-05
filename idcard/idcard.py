#!/usr/bin/env python3
"""
CVPR Lab (IIT Patna) ID-card generator  -  high-resolution version.

Sub-commands
------------
  clean      build the HD base template (default 3x = 3171x2280):
             EDSR super-resolution of the background, every static text redrawn
             as sharp vector text, photo/signature frames redrawn, HD logo,
             sample photo / ghost / barcode removed
  layout     draw every editable region on the base (for checking positions)
  signature  save a signature as a clean transparent PNG
  make       render one card
  batch      render many cards from a CSV file

Examples
--------
  python idcard.py clean  --template template_blank.png            # once (~5 min on CPU)
  python idcard.py make --photo me.jpg --signature sign.png \
        --name "Akash Rathor" --roll 2601CS45 --program "B.Tech" \
        --id-number IITP-CVPR-1645 -o card.png
  python idcard.py batch --csv members.csv --out-dir cards/
"""
import argparse
import copy
import csv
import json
import os
import re
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = {
    "sans": ["/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
             "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf",
             "C:/Windows/Fonts/arialbd.ttf", "/Library/Fonts/Arial Bold.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    "sans_regular": ["/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
                     "C:/Windows/Fonts/arial.ttf", "/Library/Fonts/Arial.ttf",
                     "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
    "serif": ["/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
              "C:/Windows/Fonts/timesbd.ttf", "/Library/Fonts/Times New Roman Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"],
}
# keys whose numbers are NOT pixel coordinates (never scaled)
NO_SCALE = {"text_color", "ghost_tint", "ghost_opacity", "outer_c", "band", "inner",
            "fill_white_alpha", "color", "color_bottom", "canvas_size", "file",
            "src_center", "src_ring_radius", "text", "font", "erase"}


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def load_layout(path=None):
    with open(path or os.path.join(HERE, "layout.json")) as f:
        return json.load(f)


def scaled_layout(L, s):
    """Copy of the layout with every pixel coordinate multiplied by s."""
    def walk(v, key=None):
        if key in NO_SCALE or (key == "outer" and isinstance(v, list) and len(v) == 3):
            return v
        if isinstance(v, dict):
            return {k: walk(x, k) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x, key) for x in v]
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return v * s
        return v
    out = walk(copy.deepcopy(L))
    out["_s"] = s
    return out


def ib(b):
    return [int(round(v)) for v in b]


ROBOTO = os.path.join(HERE, "fonts", "Roboto-VF.ttf")   # variable font: Weight 100-900, Width 75-100
VARIANTS = {"sans": (700, 100), "sans_regular": (400, 100), "header": (700, 96)}
_USER_FONT = {}


def find_font(kind="sans", user_font=None):
    """Return a font *spec*: (path, (weight, width) or None)."""
    if user_font:
        return (user_font, None)
    if kind in VARIANTS and os.path.exists(ROBOTO):
        return (ROBOTO, VARIANTS[kind])
    for p in FONTS["sans" if kind == "header" else kind]:
        if os.path.exists(p):
            return (p, None)
    sys.exit(f"No {kind} font found; pass --font /path/to/font.ttf")


def get_font(spec, size):
    path, axes = spec if isinstance(spec, tuple) else (spec, None)
    f = ImageFont.truetype(path, max(4, int(round(size))))
    if axes:
        try:
            f.set_variation_by_axes(list(axes))
        except Exception:
            pass
    return f


def font_for_cap_height(spec, cap_h):
    """Font whose capital 'H' is ~cap_h px tall."""
    ref = get_font(spec, 200)
    y0, y1 = ref.getbbox("H")[1], ref.getbbox("H")[3]
    return get_font(spec, cap_h * 200 / (y1 - y0))


def cover_fit(img, w, h, y_bias=0.35):
    iw, ih = img.size
    s = max(w / iw, h / ih)
    nw, nh = max(w, int(round(iw * s))), max(h, int(round(ih * s)))
    img = img.resize((nw, nh), Image.LANCZOS)
    left, top = (nw - w) // 2, int((nh - h) * y_bias)
    return img.crop((left, top, left + w, top + h))


def contain_fit(img, w, h):
    iw, ih = img.size
    s = min(w / iw, h / ih)
    return img.resize((max(1, int(iw * s)), max(1, int(ih * s))), Image.LANCZOS)


# --------------------------------------------------------------------------- #
# 1. HD base template
# --------------------------------------------------------------------------- #
def upscale_background(template_path, s, sr_model, cache):
    if cache and os.path.exists(cache):
        im = Image.open(cache).convert("RGB")
        if im.size == (int(round(1057 * s)), int(round(760 * s))):
            print("  using cached upscale", cache)
            return im
    src = cv2.imread(template_path, cv2.IMREAD_COLOR)
    h, w = src.shape[:2]
    if sr_model and os.path.exists(sr_model) and s == 3 and hasattr(cv2, "dnn_superres"):
        print("  EDSR x3 super-resolution (tiled, a few minutes on CPU)...")
        sr = cv2.dnn_superres.DnnSuperResImpl_create()
        sr.readModel(sr_model); sr.setModel("edsr", 3)
        out = np.zeros((h * 3, w * 3, 3), np.uint8); T, P = 200, 12
        for y in range(0, h, T):
            for x in range(0, w, T):
                y0, x0, y1, x1 = max(0, y - P), max(0, x - P), min(h, y + T + P), min(w, x + T + P)
                up = sr.upsample(src[y0:y1, x0:x1])
                oy, ox = (y - y0) * 3, (x - x0) * 3
                th, tw = (min(y + T, h) - y) * 3, (min(x + T, w) - x) * 3
                out[y * 3:y * 3 + th, x * 3:x * 3 + tw] = up[oy:oy + th, ox:ox + tw]
        im = Image.fromarray(out[..., ::-1])
    else:
        print("  Lanczos upscale (no EDSR model)")
        im = Image.open(template_path).convert("RGB").resize(
            (int(round(w * s)), int(round(h * s))), Image.LANCZOS)
    im = im.filter(ImageFilter.UnsharpMask(radius=1.2, percent=40, threshold=2))
    if cache:
        im.save(cache)
    return im


def text_mask_1x(t1, box, mode, pad=3):
    """Mask of the original glyph pixels inside box (on the 1x template)."""
    x0, y0, x1, y1 = box
    x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    reg = t1[y0:y1, x0:x1].astype(np.float32)
    lum = reg.mean(2)
    bg = np.median(np.concatenate([lum[:2].ravel(), lum[-2:].ravel(),
                                   lum[:, :2].ravel(), lum[:, -2:].ravel()]))
    m = (lum > bg + 35) if mode == "light" else (lum < bg - 35)
    m = cv2.dilate(m.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=2)
    full = np.zeros(t1.shape[:2], np.uint8)
    full[y0:y1, x0:x1] = m
    return full


def render_text_into_box(img, text, box, font_path, color, color_bottom=None, ss=2):
    """Render text so its INK bbox exactly fills box (keeps the template's exact
    position/size), with an optional vertical colour gradient."""
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    f = get_font(font_path, max(8, int(bh * 1.6 * ss)))
    l, t, r, b = f.getbbox(text)
    mask = Image.new("L", (r - l + 4, b - t + 4), 0)
    ImageDraw.Draw(mask).text((2 - l, 2 - t), text, font=f, fill=255)
    bbox = mask.getbbox()
    mask = mask.crop(bbox).resize((int(round(bw)), int(round(bh))), Image.LANCZOS)
    c0 = np.array(color, np.float32)
    c1 = np.array(color_bottom or color, np.float32)
    ramp = np.linspace(0, 1, mask.height)[:, None, None]
    rgb = (c0 * (1 - ramp) + c1 * ramp) * np.ones((1, mask.width, 1))
    layer = Image.fromarray(np.dstack([rgb, np.array(mask)]).astype(np.uint8), "RGBA")
    img.alpha_composite(layer, (int(round(x0)), int(round(y0))))


def draw_photo_frame(img, outer, s):
    """Vector redraw of the photo frame (same layer structure as the original):
    dark-brown edge, copper band, thin line, pink line, maroon inner edge."""
    x0, y0, x1, y1 = outer
    layers = [  # (inset in 1x px, colour) - outermost first
        (0.0, (120, 72, 52)),     # dark brown edge
        (1.3, (204, 150, 116)),   # copper band (highlight)
        (2.6, (186, 128, 100)),   # copper band (shade)
        (4.6, (150, 94, 84)),     # thin divider
        (5.6, (226, 190, 186)),   # pale rose line
        (8.0, (96, 32, 44)),      # maroon inner edge
        (10.8, (214, 196, 200)),  # soft inner bevel
        (11.8, (255, 255, 255)),  # photo window
    ]
    ss = 4
    W, H = int(round((x1 - x0) * ss)), int(round((y1 - y0) * ss))
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    for inset, col in layers:
        i = inset * s * ss
        d.rectangle([i, i, W - 1 - i, H - 1 - i], fill=col + (255,))
    # copper band gradient sheen
    lay = lay.resize((int(round(x1 - x0)), int(round(y1 - y0))), Image.LANCZOS)
    img.alpha_composite(lay, (int(round(x0)), int(round(y0))))


def draw_signature_frame(base, fr, s, ss=4):
    x0, y0, x1, y1 = ib(fr["box"])
    w, h = x1 - x0, y1 - y0
    W, H, r = w * ss, h * ss, fr["radius"] * ss
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    def rr(inset, **kw):
        i = inset * ss * s
        d.rounded_rectangle([i, i, W - 1 - i, H - 1 - i], radius=max(1, r - i), **kw)
    rr(0, fill=tuple(fr["outer"]) + (255,))
    rr(1, fill=tuple(fr["band"]) + (255,))
    rr(4, fill=tuple(fr["inner"]) + (255,))
    rr(6, fill=(0, 0, 0, 0))
    layer = layer.resize((w, h), Image.LANCZOS)
    region = base.crop((x0, y0, x1, y1)).convert("RGBA")
    inner = Image.new("L", (W, H), 0)
    i6 = 6 * ss * s
    ImageDraw.Draw(inner).rounded_rectangle([i6, i6, W - 1 - i6, H - 1 - i6],
                                            radius=max(1, r - i6), fill=int(255 * fr["fill_white_alpha"]))
    inner = inner.resize((w, h), Image.LANCZOS)
    region = Image.composite(Image.new("RGBA", (w, h), (255, 255, 255, 255)), region, inner)
    region.alpha_composite(layer)
    base.paste(region, (x0, y0))


def paste_logo(base, logo_path, lg, ss=2):
    src = Image.open(logo_path).convert("RGBA")
    src = Image.alpha_composite(Image.new("RGBA", src.size, (255, 255, 255, 255)), src)
    scale = lg["ring_radius"] / lg["src_ring_radius"]
    R_src = lg["disc_radius"] / scale
    scx, scy = lg["src_center"]
    pad = int(R_src) + 2
    canvas = Image.new("RGB", (2 * pad, 2 * pad), (255, 255, 255))
    canvas.paste(src.convert("RGB"), (int(round(pad - scx)), int(round(pad - scy))))
    out_d = int(round(2 * lg["disc_radius"]))
    D = out_d * ss
    big = canvas.resize((D, D), Image.LANCZOS)
    mask = Image.new("L", (D, D), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, D - 1, D - 1], fill=255)
    logo = big.resize((out_d, out_d), Image.LANCZOS).filter(
        ImageFilter.UnsharpMask(radius=0.8, percent=50, threshold=2))
    mask = mask.resize((out_d, out_d), Image.LANCZOS)
    cx, cy = lg["center"]
    base.paste(logo, (int(round(cx - out_d / 2)), int(round(cy - out_d / 2))), mask)


def build_clean_base(template_path, L1, out_path, s=3, sr_model=None, cache=None):
    L = scaled_layout(L1, s)
    t1 = np.array(Image.open(template_path).convert("RGB"))
    img = upscale_background(template_path, s, sr_model, cache)
    W, H = img.size

    # (a) erase every static text with inpainting, using the 1x glyph masks
    print("  erasing old text ...")
    m1 = np.zeros(t1.shape[:2], np.uint8)
    for st in L1["static_text"]:
        m1 |= text_mask_1x(t1, st["box"], st["erase"])
    # old photo-frame ring (outside the new vector frame) is erased too
    if "erase_box" in L1["photo_frame"]:
        ex0, ey0, ex1, ey1 = L1["photo_frame"]["erase_box"]
        ox0, oy0, ox1, oy1 = L1["photo_frame"]["outer"]
        m1[ey0:ey1, ex0:ex1] = 1          # whole old frame; only the outside feeds the fill
    m = cv2.resize(m1 * 255, (W, H), interpolation=cv2.INTER_NEAREST)
    m = cv2.dilate(m, np.ones((3, 3), np.uint8), iterations=int(s))
    arr = cv2.inpaint(np.array(img)[..., ::-1], m, int(3 * s), cv2.INPAINT_TELEA)[..., ::-1]
    arr = arr.astype(np.float32)

    # (b) photo window -> white (frame redrawn below)
    fx0, fy0, fx1, fy1 = ib(L["photo_frame"]["outer"])
    arr[fy0:fy1, fx0:fx1] = 255.0

    # (c) ghost face -> mirrored background strip from its left, feathered
    gx0, gy0, gx1, gy1 = ib(L["ghost_clean_box"])
    w = gx1 - gx0
    src = arr[gy0:gy1, gx0 - w:gx0][:, ::-1].copy()
    right = arr[gy0:gy1, gx1:min(gx1 + int(20 * s), W)]
    if right.shape[1] > 0:
        lm = src[:, -int(10 * s):].mean(axis=1, keepdims=True)
        rm = right.mean(axis=1, keepdims=True)
        src = src + np.linspace(0, 1, w)[None, :, None] * (rm - lm)
    fm = np.zeros((gy1 - gy0, w), np.float32)
    e = int(8 * s); fm[e:-e, e:-e] = 1
    fm = cv2.GaussianBlur(fm, (0, 0), 4 * s)[..., None]
    arr[gy0:gy1, gx0:gx1] = fm * src + (1 - fm) * arr[gy0:gy1, gx0:gx1]

    # (d) barcode box -> white
    bx0, by0, bx1, by1 = ib(L["barcode_white_box"])
    arr[by0:by1, bx0 + int(2 * s):bx1 - int(1 * s)] = 255.0

    base = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).convert("RGBA")

    # (e) vector elements
    print("  drawing vector text, frames, logo ...")
    for st in L["static_text"]:
        render_text_into_box(base, st["text"], st["box"], find_font(st["font"]),
                             st["color"], st.get("color_bottom"))
    draw_photo_frame(base, L["photo_frame"]["outer"], s)
    draw_signature_frame(base, L["signature_frame"], s)
    lg = L.get("logo")
    if lg and os.path.exists(os.path.join(HERE, lg["file"])):
        paste_logo(base, os.path.join(HERE, lg["file"]), lg)

    base.convert("RGB").save(out_path)
    return out_path


# --------------------------------------------------------------------------- #
# 2. photo + ghost
# --------------------------------------------------------------------------- #
def paste_photo(card, photo_path, L):
    x0, y0, x1, y1 = ib(L["photo_box"])
    ph = cover_fit(Image.open(photo_path).convert("RGB"), x1 - x0, y1 - y0)
    card.paste(ph, (x0, y0))
    return ph


def person_mask(rgb, s=1):
    a = np.array(rgb).astype(np.float32)
    h, w = a.shape[:2]
    lab = cv2.cvtColor(a.astype(np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32)
    ph_, pw_ = max(4, int(h * 0.12)), max(4, int(w * 0.12))
    samp = np.concatenate([lab[:ph_, :pw_].reshape(-1, 3), lab[:ph_, -pw_:].reshape(-1, 3)])
    bg = np.median(samp, axis=0)
    spread = np.percentile(np.linalg.norm(samp - bg, axis=1), 95)
    m = (np.linalg.norm(lab - bg, axis=2) > max(18.0, spread * 2.5)).astype(np.uint8)
    k = max(3, int(7 * s) | 1)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lbl = cv2.connectedComponents(m)
    keep = set(np.unique(lbl[-1])) - {0}
    if keep:
        m = np.isin(lbl, list(keep)).astype(np.uint8)
    # holes = background pixels NOT connected to any border pixel
    n_bg, lbl_bg = cv2.connectedComponents((1 - m).astype(np.uint8), connectivity=4)
    border = set(np.unique(np.concatenate([lbl_bg[0], lbl_bg[-1], lbl_bg[:, 0], lbl_bg[:, -1]])))
    m = np.where(np.isin(lbl_bg, list(border)) & (m == 0), 0, 1).astype(np.uint8)
    if m.mean() < 0.15 or m.mean() > 0.97:
        m = np.ones_like(m)
    return cv2.GaussianBlur(m.astype(np.float32), (0, 0), 2 * s)


def make_ghost(photo_rgb, L):
    s = L["_s"]
    gx0, gy0, gx1, gy1 = ib(L["ghost_box"])
    gw, gh = gx1 - gx0, gy1 - gy0
    ph = cover_fit(photo_rgb, gw, gh, y_bias=0.3)
    m = person_mask(ph, s)
    gray = np.array(ph.convert("L")).astype(np.float32) / 255.0
    gray = cv2.normalize(gray, None, 0, 1, cv2.NORM_MINMAX)
    darkness = 1.0 - gray
    yy, xx = np.mgrid[0:gh, 0:gw].astype(np.float32)
    cx, cy = gw * 0.5, gh * 0.40
    r = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    screen = 0.5 + 0.5 * np.sin(2 * np.pi * r / (2.4 * s))
    hlines = 0.5 + 0.5 * np.sin(2 * np.pi * yy / (3.0 * s))
    tex = 0.6 * screen + 0.4 * hlines
    ink = (darkness ** 1.1) * (0.55 + 0.45 * tex) + 0.12
    fade = np.clip((gh - yy) / (gh * 0.12), 0, 1)
    fade *= np.clip(np.minimum(xx, gw - 1 - xx) / (gw * 0.10), 0, 1)
    alpha = ink * m * fade * L["ghost_opacity"]
    rgba = np.zeros((gh, gw, 4), np.uint8)
    rgba[..., :3] = np.array(L["ghost_tint"], np.uint8)
    rgba[..., 3] = np.clip(alpha * 255, 0, 255).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA").filter(ImageFilter.GaussianBlur(0.4 * s)), (gx0, gy0)


# --------------------------------------------------------------------------- #
# 3. signature (transparent, inside the frame)
# --------------------------------------------------------------------------- #
def extract_signature(sig_path, ink_color=None):
    sig = Image.open(sig_path)
    if sig.mode == "RGBA" and np.array(sig)[..., 3].min() < 250:
        rgba = np.array(sig).astype(np.float32)
        alpha, rgb = rgba[..., 3] / 255.0, rgba[..., :3]
    else:
        rgb = np.array(sig.convert("RGB")).astype(np.float32)
        gray = cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32)
        k = min(255, max(51, (max(gray.shape) // 3) | 1))
        bg = cv2.medianBlur(gray.astype(np.uint8), k).astype(np.float32)
        diff = np.clip(bg - gray, 0, 255)
        thr = max(18.0, np.percentile(diff, 99.5) * 0.25)
        alpha = np.clip((diff - thr * 0.5) / thr, 0, 1)
    ys, xs = np.where(alpha > 0.15)
    if len(xs) == 0:
        raise ValueError(f"No ink found in signature image {sig_path}")
    pad = 4
    y0, y1 = max(0, ys.min() - pad), min(alpha.shape[0], ys.max() + pad + 1)
    x0, x1 = max(0, xs.min() - pad), min(alpha.shape[1], xs.max() + pad + 1)
    alpha, rgb = alpha[y0:y1, x0:x1], rgb[y0:y1, x0:x1]
    if ink_color is None:
        w = alpha > 0.6
        ink = np.median(rgb[w], axis=0) if w.any() else np.array([25, 40, 150])
        if ink.max() - ink.min() < 25:
            ink = np.array([25, 40, 150])
    else:
        ink = np.array(ink_color, np.float32)
    out = np.zeros(alpha.shape + (4,), np.uint8)
    out[..., :3] = ink.astype(np.uint8)
    out[..., 3] = (alpha * 255).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def signature_layer(sig_path, L, ink_color=None):
    layer = extract_signature(sig_path, ink_color)
    bx0, by0, bx1, by1 = ib(L["signature_box"])
    layer = contain_fit(layer, bx1 - bx0, by1 - by0)
    return layer, (bx0 + (bx1 - bx0 - layer.width) // 2, by0 + (by1 - by0 - layer.height) // 2)


# --------------------------------------------------------------------------- #
# 4. text values + barcode
# --------------------------------------------------------------------------- #
def draw_fields(card, values, L, font_path, min_condense=0.78):
    s = L["_s"]
    color = tuple(L["text_color"]) + (255,)
    for key, spec in L["fields"].items():
        text = str(values.get(key, "") or "").upper()
        if not text:
            continue
        x = int(round(spec["label_box"][2] + L["value_gap_after_label"]))
        max_w = spec["max_x"] - x
        cap = L["value_cap_height"]
        while True:
            f = font_for_cap_height(font_path, cap)
            w = f.getlength(text)
            if w * min_condense <= max_w or cap <= 18 * s:
                break
            cap -= max(1, s * 0.5)
        sx = min(1.0, max_w / w)
        asc, desc = f.getmetrics()
        layer = Image.new("RGBA", (int(w) + 4, asc + desc), (0, 0, 0, 0))
        ImageDraw.Draw(layer).text((0, asc), text, font=f, fill=color, anchor="ls")
        if sx < 1.0:
            layer = layer.resize((max(1, int(layer.width * sx)), layer.height), Image.LANCZOS)
        card.alpha_composite(layer, (x, int(round(spec["baseline"] - asc))))


def draw_barcode(card, payload, L):
    try:
        from barcode import Code128
    except ImportError:
        sys.exit("pip install python-barcode")
    modules = Code128(payload).build()[0]
    bx0, by0, bx1, by1 = ib(L["barcode_bars_box"])
    mw = max(1, (bx1 - bx0) // len(modules))
    x = bx0 + ((bx1 - bx0) - mw * len(modules)) // 2
    d = ImageDraw.Draw(card)
    for bit in modules:
        if bit == "1":
            d.rectangle([x, by0, x + mw - 1, by1], fill=(0, 0, 0))
        x += mw
    f = get_font(find_font("sans_regular"), L["barcode_text_size"])
    d.text(tuple(ib(L["barcode_text_center"])), payload, font=f, fill=(20, 20, 20), anchor="mm")


def barcode_from_roll(roll):
    """Roll 2601CS45 -> IITPCVPR2645 (26 = admission year, 45 = student no. in dept batch)."""
    r = re.sub(r"[^A-Za-z0-9]", "", roll).upper()
    m = re.match(r"^(\d{2})\d*[A-Z]+(\d+)$", r)
    if not m:
        raise ValueError(f"Roll number '{roll}' is not in the YYPPDDNN form (e.g. 2601CS45); pass --barcode")
    return f"IITPCVPR{m.group(1)}{m.group(2).zfill(2)}"


def default_id_number(roll):
    return f"IITP-CVPR-{(re.sub(r'[^0-9]', '', roll)[-4:] or '0000')}"


# --------------------------------------------------------------------------- #
# compose
# --------------------------------------------------------------------------- #
def make_card(base_path, L1, photo, signature, name, roll, program, valid_till,
              id_number, out, font=None, sig_color=None, ghost=True, barcode_text=None, dpi=300):
    card = Image.open(base_path).convert("RGBA")
    L = scaled_layout(L1, card.width / L1["canvas_size"][0])
    font_path = find_font("sans", font)

    ph = paste_photo(card, photo, L)
    if ghost:
        g, pos = make_ghost(ph, L)
        card.alpha_composite(g, pos)
    if signature:
        sl, pos = signature_layer(signature, L, sig_color)
        card.alpha_composite(sl, pos)
    draw_fields(card, dict(name=name, roll_no=roll, program=program,
                           valid_till=valid_till, id_number=id_number), L, font_path)
    draw_barcode(card, barcode_text or barcode_from_roll(roll), L)

    card = card.convert("RGB")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    card.save(out, dpi=(dpi, dpi), **({"resolution": dpi} if out.lower().endswith(".pdf") else {}))
    return out


def draw_layout(base_path, L1, out):
    im = Image.open(base_path).convert("RGB")
    L = scaled_layout(L1, im.width / L1["canvas_size"][0])
    s = L["_s"]
    d = ImageDraw.Draw(im)
    f = get_font(find_font(), 14 * s)
    lw = max(2, int(3 * s))

    def box(b, c, label=""):
        d.rectangle(ib(b), outline=c, width=lw)
        if label:
            d.text((b[0] + 4 * s, b[1] + 3 * s), label, font=f, fill=c)
    box(L["photo_box"], (255, 0, 0), "PHOTO %s" % L1["photo_box"])
    box(L["ghost_box"], (255, 120, 0), "GHOST %s" % L1["ghost_box"])
    box(L["signature_frame"]["box"], (0, 200, 255))
    box(L["signature_box"], (0, 90, 255), "SIGNATURE %s" % L1["signature_box"])
    box(L["barcode_bars_box"], (160, 0, 200), "BARCODE %s" % L1["barcode_bars_box"])
    for k, spec in L["fields"].items():
        x = spec["label_box"][2] + L["value_gap_after_label"]
        box([x, spec["baseline"] - L["value_cap_height"] - 2 * s, spec["max_x"], spec["baseline"] + 6 * s],
            (0, 160, 0), k.upper())
    im.save(out)
    return out


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--layout", default=os.path.join(HERE, "layout.json"))
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("clean"); c.add_argument("--template", required=True)
    c.add_argument("-o", "--out", default=os.path.join(HERE, "template_base.png"))
    c.add_argument("--scale", type=float, default=3)
    c.add_argument("--sr-model", default=os.path.join(HERE, "models", "EDSR_x3.pb"))
    c.add_argument("--cache", default=os.path.join(HERE, "template_blank_x3_edsr.png"))

    l = sub.add_parser("layout")
    l.add_argument("--base", default=os.path.join(HERE, "template_base.png"))
    l.add_argument("-o", "--out", default="layout_debug.png")

    e = sub.add_parser("signature", help="save the cleaned, transparent signature PNG")
    e.add_argument("--signature", required=True); e.add_argument("-o", "--out", default="signature_clean.png")
    e.add_argument("--sig-color", default=None)

    def common(sp):
        sp.add_argument("--base", default=os.path.join(HERE, "template_base.png"))
        sp.add_argument("--font", default=None)
        sp.add_argument("--sig-color", default=None, help="e.g. 25,40,150")
        sp.add_argument("--no-ghost", action="store_true")
        sp.add_argument("--dpi", type=int, default=300)

    m = sub.add_parser("make"); common(m)
    m.add_argument("--photo", required=True)
    m.add_argument("--signature", required=True)
    m.add_argument("--name", required=True)
    m.add_argument("--roll", required=True)
    m.add_argument("--program", required=True)
    m.add_argument("--valid-till", default="31-12-2026")
    m.add_argument("--id-number", default=None, help="default: IITP-CVPR-<last 4 digits of roll>")
    m.add_argument("--barcode", default=None, help="default: IITPCVPR<YY><NN> from roll, e.g. 2601CS45 -> IITPCVPR2645")
    m.add_argument("-o", "--out", default="id_card.png")

    b = sub.add_parser("batch"); common(b)
    b.add_argument("--csv", required=True,
                   help="columns: photo,signature,name,roll,program[,valid_till,id_number,barcode]")
    b.add_argument("--out-dir", default="cards")
    b.add_argument("--format", default="png", choices=["png", "jpg", "pdf"])

    a = p.parse_args()
    L = load_layout(a.layout)
    sc = tuple(int(v) for v in a.sig_color.split(",")) if getattr(a, "sig_color", None) else None

    if a.cmd == "clean":
        print("HD base ->", build_clean_base(a.template, L, a.out, a.scale, a.sr_model, a.cache))
    elif a.cmd == "layout":
        print("layout ->", draw_layout(a.base, L, a.out))
    elif a.cmd == "signature":
        layer = extract_signature(a.signature, sc)
        layer.save(a.out); print("transparent signature ->", a.out, layer.size)
    elif a.cmd == "make":
        out = make_card(a.base, L, a.photo, a.signature, a.name, a.roll, a.program, a.valid_till,
                        a.id_number or default_id_number(a.roll), a.out, a.font, sc,
                        not a.no_ghost, a.barcode, a.dpi)
        print("card ->", out)
    elif a.cmd == "batch":
        base_dir = os.path.dirname(os.path.abspath(a.csv))
        rel = lambda pth: pth if os.path.isabs(pth) else os.path.join(base_dir, pth)
        with open(a.csv, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                roll = row["roll"].strip()
                out = os.path.join(a.out_dir, f"{roll}.{a.format}")
                make_card(a.base, L, rel(row["photo"]), rel(row["signature"]), row["name"], roll,
                          row["program"], row.get("valid_till") or "31-12-2026",
                          row.get("id_number") or default_id_number(roll), out, a.font, sc,
                          not a.no_ghost, row.get("barcode") or None, a.dpi)
                print("card ->", out)


if __name__ == "__main__":
    main()
