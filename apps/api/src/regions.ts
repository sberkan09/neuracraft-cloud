// The region layer of sketch_to_scene map mode (issue #42). The scribble ControlNet sees lines only and
// cannot tell which side of a line is water; a rough colour picture of the regions, used as the
// img2img start at strength ~0.6, can (docs/reports/sketch-to-scene.md, "Colour hints").
//
// The app paints with six fixed brush colours on a transparent layer. Here each brush becomes a
// realistic colour, the unpainted ground gets the `ground` colour, and the result is blurred: a soft
// colour prior, not a picture.
import { PNG } from "pngjs";

type RGB = [number, number, number];

// The brushes the app paints with (agreed in issue #42) -> the colour the hint uses.
export const BRUSHES: { name: string; brush: RGB; hint: RGB }[] = [
  { name: "water", brush: [0x20, 0x60, 0xa0], hint: [40, 96, 150] },
  { name: "road", brush: [0x8c, 0x6e, 0x48], hint: [140, 110, 72] },
  { name: "forest", brush: [0x28, 0x5c, 0x28], hint: [40, 92, 40] },
  { name: "stone floor", brush: [0x80, 0x80, 0x80], hint: [122, 118, 112] },
  { name: "wall", brush: [0x40, 0x40, 0x40], hint: [62, 60, 58] },
  { name: "sand", brush: [0xd2, 0xb4, 0x78], hint: [200, 178, 128] },
];

export const GROUNDS: Record<string, RGB> = {
  grass: [86, 128, 62],
  stone: [128, 124, 118],
  dirt: [120, 96, 66],
  sand: [200, 178, 128],
  snow: [232, 236, 240],
};

const SIDE = 512;
const BLUR_RADIUS = 4;  // three box blurs: about a Gaussian of sigma 4.5 px

function nearestBrush(r: number, g: number, b: number): RGB {
  let best = BRUSHES[0]!, d = Infinity;
  for (const x of BRUSHES) {
    const e = (x.brush[0] - r) ** 2 + (x.brush[1] - g) ** 2 + (x.brush[2] - b) ** 2;
    if (e < d) (d = e), (best = x);
  }
  return best.hint;
}

function boxBlur(src: Float32Array, dst: Float32Array, r: number, horizontal: boolean) {
  const n = 2 * r + 1;
  for (let line = 0; line < SIDE; line++)
    for (let c = 0; c < 3; c++) {
      const at = (i: number) => {
        const k = Math.min(SIDE - 1, Math.max(0, i));
        return src[((horizontal ? line * SIDE + k : k * SIDE + line) * 3) + c]!;
      };
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += at(i);
      for (let i = 0; i < SIDE; i++) {
        dst[((horizontal ? line * SIDE + i : i * SIDE + line) * 3) + c] = sum / n;
        sum += at(i + r + 1) - at(i - r);
      }
    }
}

// The hint PNG (512 x 512 RGB), or null when nothing is painted (the job then runs as without regions).
export function regionHint(png: Buffer, ground: string): Buffer | null {
  const img = PNG.sync.read(png);  // any PNG colour type; alpha 255 where there is none
  const g = GROUNDS[ground] ?? GROUNDS.grass!;
  const out = new Float32Array(SIDE * SIDE * 3);
  let painted = 0;
  for (let y = 0; y < SIDE; y++)
    for (let x = 0; x < SIDE; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / SIDE));
      const sy = Math.min(img.height - 1, Math.floor((y * img.height) / SIDE));
      const i = (sy * img.width + sx) * 4;
      const a = img.data[i + 3]! / 255;
      const c = a > 0 ? nearestBrush(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!) : g;
      if (a > 0.5) painted++;
      const o = (y * SIDE + x) * 3;
      for (let k = 0; k < 3; k++) out[o + k] = a * c[k]! + (1 - a) * g[k]!;
    }
  if (!painted) return null;
  const tmp = new Float32Array(out.length);
  for (let pass = 0; pass < 3; pass++) {
    boxBlur(out, tmp, BLUR_RADIUS, true);
    boxBlur(tmp, out, BLUR_RADIUS, false);
  }
  const res = new PNG({ width: SIDE, height: SIDE, colorType: 2, inputColorType: 2, inputHasAlpha: false });
  const data = Buffer.alloc(SIDE * SIDE * 3);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(out[i]!);
  res.data = data;
  return PNG.sync.write(res, { colorType: 2, inputColorType: 2, inputHasAlpha: false });
}
