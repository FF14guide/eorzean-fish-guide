#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app/static/ogp.png を作り直す。

サイト本体は Node だけで完結するが、これだけは画像なので Python + Pillow を使う。
毎ビルドで走らせるものではない。文字や色を変えたくなったときだけ手で回す。

    pip install pillow
    python3 tools/make-ogp.py

出力は 1200x630（OGP の標準比）。色は app/index.html の :root と揃えてある。
"""

from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1200, 630
SS = 3  # スーパーサンプリング倍率。曲線と細線のジャギを消すため
CW, CH = W * SS, H * SS

# ── 色（app/index.html の :root と同じ） ──────────────────────
INK = (0x0C, 0x15, 0x26)
DEEPER = (0x10, 0x1C, 0x33)
EDGE = (0x2E, 0x4A, 0x7D)
FOAM = (0xEF, 0xF4, 0xFD)
MIST = (0x9C, 0xB2, 0xD6)
DIM = (0x63, 0x7B, 0xA6)
GOLD = (0xF5, 0xC5, 0x63)
GOLD_DIM = (0x8A, 0x6B, 0x2A)

FONT_DIR = "/usr/share/fonts/opentype/noto"
BOLD = os.path.join(FONT_DIR, "NotoSansCJK-Bold.ttc")
REG = os.path.join(FONT_DIR, "NotoSansCJK-Regular.ttc")
MED = os.path.join(FONT_DIR, "NotoSansCJK-Medium.ttc")
JP = 0  # ttc の中の日本語フェイス


def font(path, size, index=JP):
    return ImageFont.truetype(path, size * SS, index=index)


def bezier(p0, p1, p2, p3, n=240):
    """三次ベジエを n 分割して点列にする"""
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0]
        y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
        out.append((x, y))
    return out


def logo_points(ox, oy, scale):
    """
    favicon と同じ形。app/index.html の <link rel="icon"> にある SVG パスを
    そのまま点列に落としたもの（viewBox 0 0 32 32）。

      M4 16 c4-5 9-7.5 12.5-7.5 S24.5 11 28 16
            c-3.5 5 -8 7.5 -11.5 7.5 S8 21 4 16 Z
    """
    segs = [
        ((4, 16), (8, 11), (13, 8.5), (16.5, 8.5)),
        ((16.5, 8.5), (20, 8.5), (24.5, 11), (28, 16)),
        ((28, 16), (24.5, 21), (20, 23.5), (16.5, 23.5)),
        ((16.5, 23.5), (13, 23.5), (8, 21), (4, 16)),
    ]
    pts = []
    for s in segs:
        pts.extend(bezier(*s))
    return [(ox + x * scale, oy + y * scale) for x, y in pts]


def stroke_path(draw, pts, width, fill):
    """
    丸ペンでなぞる。PIL の太い折れ線は継ぎ目が角張るので、
    経路上に円を敷き詰めて滑らかな輪郭にする。
    """
    r = width / 2
    draw.line(pts + [pts[0]], fill=fill, width=round(width), joint="curve")
    for x, y in pts:
        draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def spaced(draw, xy, text, fnt, fill, tracking=0):
    """字送りを足しながら1文字ずつ置く。CSS の letter-spacing 相当"""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + tracking * SS
    return x


def build():
    img = Image.new("RGB", (CW, CH), INK)
    d = ImageDraw.Draw(img)

    # ── 背景：上が少し明るい縦グラデーション ────────────────
    for y in range(CH):
        t = y / CH
        c = tuple(round(DEEPER[i] + (INK[i] - DEEPER[i]) * (t ** 0.75)) for i in range(3))
        d.line([(0, y), (CW, y)], fill=c)

    # ── ロゴまわりの淡い光 ──────────────────────────────────
    glow = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gcx, gcy = 175 * SS, 248 * SS
    for r in range(300 * SS, 0, -6 * SS):
        a = int(16 * (1 - r / (300 * SS)) ** 2)
        gd.ellipse([gcx - r, gcy - r, gcx + r, gcy + r], fill=GOLD + (a,))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    d = ImageDraw.Draw(img)

    # ── 外枠 ────────────────────────────────────────────────
    d.rounded_rectangle(
        [20 * SS, 20 * SS, CW - 20 * SS, CH - 20 * SS],
        radius=18 * SS, outline=EDGE, width=2 * SS,
    )

    # ── ロゴ ────────────────────────────────────────────────
    s = 5.0 * SS
    pts = logo_points(90 * SS, 168 * SS, s)
    stroke_path(d, pts, 2.2 * s, GOLD)
    cx, cy, r = 90 * SS + 12.5 * s, 168 * SS + 16 * s, 1.6 * s
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD)

    # ── 見出し ──────────────────────────────────────────────
    tx = 274
    d.text((tx * SS, 196 * SS), "エオルゼア釣り図鑑", font=font(BOLD, 76), fill=FOAM)
    spaced(d, (tx * SS + 4, 292 * SS), "EORZEAN FISH GUIDE", font(MED, 25), GOLD, tracking=5)

    # ── 説明 ────────────────────────────────────────────────
    d.text((110 * SS, 392 * SS),
           "どの釣り場で、いつ、何が、どのエサで釣れるのか。",
           font=font(MED, 35), fill=MIST)
    d.text((110 * SS, 452 * SS),
           "ヌシの次回釣り日時・天候ウィンドウ・ヒットタイム・オーシャンフィッシング運行表",
           font=font(REG, 25), fill=DIM)

    # ── 下段 ────────────────────────────────────────────────
    d.line([(110 * SS, 528 * SS), (1090 * SS, 528 * SS)], fill=GOLD_DIM, width=1 * SS)
    small = font(REG, 22)
    d.text((110 * SS, 552 * SS), "非公式ファンサイト", font=small, fill=DIM)
    tail = "© SQUARE ENIX"
    d.text((1090 * SS - d.textlength(tail, font=small), 552 * SS), tail, font=small, fill=DIM)

    out = img.resize((W, H), Image.LANCZOS)
    dest = os.path.join(os.path.dirname(__file__), "..", "app", "static", "ogp.png")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    out.save(dest, "PNG", optimize=True)
    print(f"書き出し {os.path.normpath(dest)}  {os.path.getsize(dest) / 1024:.0f} KB  {W}x{H}")


if __name__ == "__main__":
    build()
