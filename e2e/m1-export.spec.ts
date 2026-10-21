import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

import { expect, test } from './fixtures/auth.js';

import type { Download, Page } from '@playwright/test';

/**
 * "Exportar mis datos" (plan §4.1.4): the web downloads `GET /api/me/export` with `fetch` + `blob`
 * and hands the file to the browser, so the test catches it as a Playwright download. The CSV file
 * names are not fixed by the spec, so the checks look at the ZIP as a whole.
 */

const EXPORT_BUTTON = /exportar (mis )?datos|exportar antes/i;

/** Reads the entries of a ZIP (stored or deflated) from its central directory. */
function unzip(zip: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: end of central directory not found');
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(start, start + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function clickAndDownload(page: Page, name: RegExp): Promise<Download> {
  const downloading = page.waitForEvent('download', { timeout: 30_000 });
  await page.getByRole('button', { name }).first().click();
  return downloading;
}

async function zipOf(download: Download): Promise<Map<string, Buffer>> {
  const path = await download.path();
  const bytes = await readFile(path);
  // A ZIP starts with the local file header signature "PK\x03\x04".
  expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
  return unzip(bytes);
}

function allText(files: Map<string, Buffer>): string {
  return [...files.values()].map((b) => b.toString('utf8')).join('\n');
}

test.describe('TASK-165 exportar mis datos', () => {
  test('RF-M1-14 desde el perfil, "Exportar mis datos" descarga un ZIP con los CSV del usuario', async ({
    authedPage,
    testUser,
  }) => {
    await authedPage.goto('/perfil');
    await expect(authedPage).toHaveURL(/\/perfil/);

    const download = await clickAndDownload(authedPage, /exportar (mis )?datos/i);
    const files = await zipOf(download);

    const names = [...files.keys()];
    // Perfil y ajustes, monedas y tasas manuales, cuentas, categorías, movimientos y atajos.
    expect(names.length).toBeGreaterThanOrEqual(6);
    expect(names.every((name) => name.toLowerCase().endsWith('.csv'))).toBe(true);
    expect(allText(files)).toContain(testUser.email);
  });

  test('RF-M1-14 la exportación se genera en el momento y no envía ningún correo', async ({
    authedPage,
    testUser,
    mailbox,
  }) => {
    const before = (await mailbox.inboxOf(testUser.email)).length;
    await authedPage.goto('/perfil');

    const download = await clickAndDownload(authedPage, /exportar (mis )?datos/i);
    const files = await zipOf(download);

    expect(files.size).toBeGreaterThan(0);
    expect((await mailbox.inboxOf(testUser.email)).length).toBe(before);
  });

  test('RF-M1-15 la pantalla de eliminación ofrece "Exportar antes" y descarga el ZIP', async ({
    authedPage,
    testUser,
  }) => {
    await authedPage.goto('/perfil/eliminar');
    await expect(authedPage).toHaveURL(/\/perfil\/eliminar/);

    const exportBefore = authedPage.getByRole('button', { name: /exportar/i }).first();
    await expect(exportBefore).toBeVisible();
    await expect(exportBefore).toHaveAccessibleName(EXPORT_BUTTON);

    const download = await clickAndDownload(authedPage, /exportar/i);
    const files = await zipOf(download);

    expect([...files.keys()].every((name) => name.toLowerCase().endsWith('.csv'))).toBe(true);
    expect(allText(files)).toContain(testUser.email);
    // Exportar no elimina la cuenta: la persona sigue en la pantalla y con sesión.
    await expect(authedPage).toHaveURL(/\/perfil\/eliminar/);
    expect((await authedPage.request.get('/api/me')).status()).toBe(200);
  });
});
