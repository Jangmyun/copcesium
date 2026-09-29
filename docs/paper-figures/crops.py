# Generates the grayscale "broadcast video" frame and per-device warped crops for Fig. 6.
import json, math, sys
from PIL import Image, ImageDraw, ImageFilter

W, H = 1600, 900
img = Image.new("L", (W, H))
d = ImageDraw.Draw(img)
for y in range(H):  # sky gradient
    d.line([(0, y), (W, y)], fill=int(235 - 70 * y / H))
d.ellipse([1020, 120, 1260, 360], fill=250, outline=40, width=6)  # sun
d.polygon([(0, 700), (260, 380), (470, 600), (760, 250), (1060, 640), (1260, 460), (1600, 720), (1600, 900), (0, 900)], fill=110)
d.polygon([(0, 800), (380, 600), (720, 760), (1100, 560), (1600, 780), (1600, 900), (0, 900)], fill=60)
d.polygon([(760, 250), (700, 330), (740, 320), (790, 350), (830, 330)], fill=230)  # snow cap
for x in range(0, W, 200):  # faint grid so crops are easy to relate
    d.line([(x, 0), (x, H)], fill=0, width=1)
for y in range(0, H, 200):
    d.line([(0, y), (W, y)], fill=0, width=1)
img = img.filter(ImageFilter.SMOOTH)
img.save("frame.png")

devs = json.load(open("devices.json"))
for dv in devs:
    q = dv["quad"]  # TL,TR,BR,BL in normalized (u~, v~) with v up
    px = [(u * W, (1 - v) * H) for u, v in q]
    TL, TR, BR, BL = px
    ow = 60 * dv["w"]
    oh = 60 * dv["h"]
    out = img.transform((int(ow), int(oh)), Image.QUAD,
                        data=(*TL, *BL, *BR, *TR), resample=Image.BICUBIC)
    out.save(f"crop{dv['id']}.png")
print("ok")
