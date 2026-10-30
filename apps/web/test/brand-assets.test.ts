import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// TASK-269: the brand files the browser asks for and the tags of index.html that point to them
// (RF-M2-14).

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const INDEX_HTML = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const MAX_SVG_BYTES = 10 * 1024;

function publicFile(name: string): Buffer {
  return readFileSync(`${PUBLIC_DIR}${name}`);
}

/** The width and height of a PNG, read from its IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** The sizes of the images of an ICO directory (0 in a byte means 256). */
function icoSizes(ico: Buffer): number[] {
  expect(ico.readUInt16LE(2)).toBe(1);
  const count = ico.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => ico.readUInt8(6 + i * 16) || 256);
}

describe('TASK-269 archivos de la marca', () => {
  it('RF-M2-14 index.html enlaza el ícono SVG, el ICO y el apple-touch-icon', () => {
    expect(INDEX_HTML).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(INDEX_HTML).toContain('<link rel="icon" href="/favicon.ico" sizes="any" />');
    expect(INDEX_HTML).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(INDEX_HTML).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}" \/>/);
    for (const name of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'logo.svg']) {
      expect(existsSync(`${PUBLIC_DIR}${name}`), name).toBe(true);
    }
  });

  it('el título de la página sigue siendo "Finanzas"', () => {
    expect(INDEX_HTML).toContain('<title>Finanzas</title>');
  });

  it('apple-touch-icon.png es un PNG de 180×180', () => {
    expect(pngSize(publicFile('apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
  });

  it('favicon.ico incluye 16, 32 y 48 px', () => {
    expect(icoSizes(publicFile('favicon.ico'))).toEqual(expect.arrayContaining([16, 32, 48]));
  });

  it.each(['logo.svg', 'favicon.svg'])(
    '%s es un SVG seguro con viewBox y de 10 KB o menos',
    (name) => {
      const file = publicFile(name);
      const svg = file.toString('utf8');
      expect(file.byteLength).toBeLessThanOrEqual(MAX_SVG_BYTES);
      expect(svg).toMatch(/^<svg\b[^>]*\bviewBox="[\d.\s]+"/);
      expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
      expect(svg).not.toMatch(/<script|<foreignObject/i);
      expect(svg).not.toMatch(/\b(?:xlink:)?href=|url\(|@import/i);
    },
  );
});
