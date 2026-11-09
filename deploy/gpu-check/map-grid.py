"""Variants of the map workflow (issue #42) and their contact sheets; see map-grid.sh."""
import base64, io, json, os, sys

SKETCHES = {
    # name: (prompt body as the current template / LLM would write it, body with map priors)
    "nehir-orman": ("a wooden bridge over a river, a dense forest to the north",
                    "a wooden plank bridge over a blue river, round green tree canopies of a dense forest seen from above, grassy river banks, a dirt path"),
    "orman-yolu": ("a dirt road through a dense forest, a wooden wagon on the road, rocks, daylight",
                   "a dirt road through a forest, round green tree canopies seen from above, a wooden wagon seen from above, grass, rocks"),
    "zindan": ("narrow stone dungeon corridor turning a corner, a pit trap in the floor, wooden door in the wall, torch light",
               "a narrow stone dungeon corridor turning a corner seen from above, grey stone floor tiles, thick stone walls, a dark pit trap, a wooden door"),
}
OLD = ("top-down fantasy battle map, {}, tabletop RPG map, detailed painted texture",
       "perspective view, horizon, sky, people, creatures, text, letters, grid numbers, blurry, frame, blurry, text, watermark, frame, people")
NEW = ("top-down tabletop RPG battle map, bird's eye view from directly above, orthographic, flat even daylight, {}, clear readable terrain, detailed painted texture",
       "perspective, isometric, side view, horizon, sky, dark, night, vignette, heavy shadows, people, creatures, text, letters, grid, frame, border, blurry")
# label, prompt style, control_scale, steps, guidance, tiny VAE
VARIANTS = [
    ("1 now: old 0.9", OLD, 0.9, 4, 1.5, True),
    ("2 old 0.6", OLD, 0.6, 4, 1.5, True),
    ("3 new 0.9", NEW, 0.9, 4, 1.5, True),
    ("4 new 0.65", NEW, 0.65, 4, 1.5, True),
    ("5 new 0.5", NEW, 0.5, 4, 1.5, True),
    ("6 new 0.65 6st g2", NEW, 0.65, 6, 2.0, True),
    ("7 new 0.65 fullVAE", NEW, 0.65, 4, 1.5, False),
    ("8 new 0.65 6st g2 fullVAE", NEW, 0.65, 6, 2.0, False),
]

def write(path, out):
    os.makedirs(out, exist_ok=True)
    steps = []
    for name, (old_body, new_body) in SKETCHES.items():
        steps += [{"op": "load", "path": f"/cloud/tests/assets/sketches/{name}.png", "out": f"{name}_s"},
                  {"op": "resize", "in": f"{name}_s", "width": 512, "height": 512, "out": f"{name}_r"},
                  {"op": "scribble", "in": f"{name}_r", "thickness": 2, "out": f"{name}_l"}]
        for i, (label, style, cs, st, g, tiny) in enumerate(VARIANTS):
            body = old_body if style is OLD else new_body
            d = {"op": "txt2img", "model": "/models/dreamshaper-8", "prompt": style[0].format(body), "negative": style[1], "seed": 1234,
                 "width": 512, "height": 512, "controlnet": "/models/controlnet-scribble", "control": f"{name}_l", "control_scale": cs,
                 "steps": st, "sampler": "lcm", "guidance": g, "lora": ["/models/loras/lcm-lora-sdv1-5.safetensors:1"], "out": f"{name}_{i}"}
            if tiny:
                d["tiny_vae"] = "/models/taesd"
            steps += [d, {"op": "save", "in": f"{name}_{i}", "path": f"{out}/{name}_{i}.png"}]
    json.dump({"steps": steps}, open(path, "w"))

def sheets(out):
    from PIL import Image, ImageDraw
    cell = 192
    for name in SKETCHES:
        sheet = Image.new("RGB", (cell * 3, cell * 3), "white")
        draw = ImageDraw.Draw(sheet)
        tiles = [("sketch", Image.open(f"/cloud/tests/assets/sketches/{name}.png").convert("RGB"))]
        tiles += [(v[0], Image.open(f"{out}/{name}_{i}.png").convert("RGB")) for i, v in enumerate(VARIANTS)]
        for k, (label, im) in enumerate(tiles):
            x, y = (k % 3) * cell, (k // 3) * cell
            sheet.paste(im.resize((cell, cell)), (x, y))
            draw.rectangle([x, y, x + 7 * len(label) + 4, y + 12], fill="black")
            draw.text((x + 2, y + 1), label, fill="white")
        buf = io.BytesIO()
        sheet.save(buf, "JPEG", quality=60)
        b = base64.b64encode(buf.getvalue()).decode()
        print(f"SHEET {name} BEGIN {len(b)}")
        for i in range(0, len(b), 4000):
            print(b[i:i + 4000])
        print(f"SHEET {name} END", flush=True)

if __name__ == "__main__":
    write(sys.argv[2], sys.argv[3]) if sys.argv[1] == "write" else sheets(sys.argv[2])
