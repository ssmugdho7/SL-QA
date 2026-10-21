import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright';

/**
 * Test files for upload steps, made on the fly: real images drawn in the browser (canvas → PNG/JPEG/WEBP),
 * padded to an exact size when a step asks for one ("an image of exactly 4MB"), plus a GIF, a PDF and
 * a fake ".jpg" that is really an .exe. Nothing is downloaded.
 */

export interface TestFile { name: string; path: string; bytes: number; kind: string }

const MB = 1024 * 1024;

async function draw(page: Page, type: 'image/png' | 'image/jpeg' | 'image/webp', w: number, h: number, seed: number): Promise<Buffer> {
  const dataUrl = await page.evaluate(({ type, w, h, seed }) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    g.fillStyle = `hsl(${(seed * 67) % 360} 70% 55%)`;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.font = `bold ${Math.round(Math.min(w, h) / 5)}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`BTB ${seed}`, w / 2, h / 2);
    return c.toDataURL(type, 0.92);
  }, { type, w, h, seed });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

/** Pads a JPEG with a comment segment so it stays a valid image at exactly `bytes`. */
function padJpeg(jpeg: Buffer, bytes: number): Buffer {
  const extra = bytes - jpeg.length;
  if (extra <= 4) return jpeg;
  const parts: Buffer[] = [jpeg.subarray(0, 2)];
  let left = extra;
  while (left > 0) {
    const chunk = Math.min(left, 65533 + 4);
    const body = Math.max(0, chunk - 4);
    const seg = Buffer.alloc(4 + body, 0x20);
    seg[0] = 0xff;
    seg[1] = 0xfe;
    seg.writeUInt16BE(body + 2, 2);
    parts.push(seg);
    left -= seg.length;
  }
  parts.push(jpeg.subarray(2));
  return Buffer.concat(parts).subarray(0, Math.max(bytes, jpeg.length));
}

const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(510, 0x90)]);

export async function makeFile(page: Page, dir: string, spec: string, seed = 1): Promise<TestFile> {
  fs.mkdirSync(dir, { recursive: true });
  const s = spec.toLowerCase();
  let name: string;
  let data: Buffer;
  let kind: string;
  if (/\.exe|renamed|fake/.test(s)) [name, data, kind] = [`btb-fake-${seed}.jpg`, EXE, 'an .exe renamed to .jpg'];
  else if (/pdf/.test(s)) [name, data, kind] = [`btb-${seed}.pdf`, PDF, 'a PDF'];
  else if (/gif/.test(s)) [name, data, kind] = [`btb-${seed}.gif`, GIF, 'a GIF'];
  else if (/webp/.test(s)) [name, data, kind] = [`btb-${seed}.webp`, await draw(page, 'image/webp', 800, 800, seed), 'a WEBP image'];
  else {
    const wide = /16:9|wide/.test(s);
    const mb = Number(s.match(/(\d+(?:\.\d+)?)\s*mb/)?.[1] ?? 0);
    const png = /png/.test(s) && !mb;
    const img = await draw(page, png ? 'image/png' : 'image/jpeg', wide ? 1600 : 800, wide ? 900 : 800, seed);
    data = mb ? padJpeg(img, Math.round(mb * MB)) : img;
    name = `btb-${seed}${wide ? '-wide' : ''}${mb ? `-${mb}mb` : ''}.${png ? 'png' : 'jpg'}`;
    kind = `${mb ? `a ${mb}MB ` : 'a '}${wide ? '16:9 ' : 'square '}${png ? 'PNG' : 'JPG'}`;
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return { name, path: file, bytes: data.length, kind };
}
