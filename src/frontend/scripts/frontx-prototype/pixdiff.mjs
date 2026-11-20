// Prototype: the share of pixels that differ between same-named PNG files in two folders.
// A pixel differs when its summed RGB distance is above 30. Writes diff-<name>.png.
// Usage: node pixdiff.mjs <dir-a> <dir-b> <out-dir>
import fs from "node:fs";
import path from "node:path";

import { args, chromium } from "./common.mjs";

const [a, b, out] = args(["dir-a", "dir-b", "out-dir"]);
fs.mkdirSync(out, { recursive: true });

const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const name of fs.readdirSync(a).filter((f) => f.endsWith(".png"))) {
  if (!fs.existsSync(path.join(b, name))) continue;
  const result = await page.evaluate(
    async ([left, right]) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = src;
        });
      const [x, y] = await Promise.all([load(left), load(right)]);
      if (x.width !== y.width || x.height !== y.height) return { sizeDiffers: true };

      const pixels = (image) => {
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height);
      };
      const first = pixels(x);
      const second = pixels(y).data;
      let differing = 0;
      for (let i = 0; i < first.data.length; i += 4) {
        const distance =
          Math.abs(first.data[i] - second[i]) + Math.abs(first.data[i + 1] - second[i + 1]) + Math.abs(first.data[i + 2] - second[i + 2]);
        const hit = distance > 30;
        if (hit) differing += 1;
        first.data[i] = hit ? 255 : first.data[i] / 3;
        first.data[i + 1] = hit ? 0 : first.data[i + 1] / 3;
        first.data[i + 2] = hit ? 0 : first.data[i + 2] / 3;
      }
      const canvas = new OffscreenCanvas(x.width, x.height);
      canvas.getContext("2d").putImageData(first, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { share: differing / (x.width * x.height), diff: btoa(binary) };
    },
    [dataUrl(path.join(a, name)), dataUrl(path.join(b, name))]
  );
  if (result.sizeDiffers) {
    console.log(`${name}: size differs`);
    continue;
  }
  fs.writeFileSync(path.join(out, `diff-${name}`), Buffer.from(result.diff, "base64"));
  console.log(`${name}: ${(100 * result.share).toFixed(2)}% pixels differ`);
}
await browser.close();
