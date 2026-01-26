import axios from 'axios';
import FormData from 'form-data';
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:3000';
const apiKey = process.env.E2E_API_KEY || 'e2e-test-key';

describe('convert endpoint', () => {
  let tempDir = '';

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'dabih-attachments-e2e-'));
  }, 180_000);

  afterAll(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uploads the original and generates a preview PDF', async () => {
    const fileName = 'test.txt';
    const filePath = path.join(tempDir, fileName);
    const fileContents = 'Hello from dabih-attachments e2e test\n';
    writeFileSync(filePath, fileContents, 'utf8');

    const originalUrl = `/convert/original/${fileName}`;
    const previewUrl = '/convert/preview/test.pdf';

    const form = new FormData();
    form.append('file', createReadStream(filePath), {
      filename: fileName,
      contentType: 'text/plain'
    });
    form.append('originalUrl', originalUrl);
    form.append('previewUrl', previewUrl);

    const convertResponse = await axios.post(
      `${baseUrl}/convert`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          'x-api-key': apiKey
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true
      }
    );

    expect(convertResponse.status).toBe(200);

    const previewResponse = await axios.get(
      `${baseUrl}${previewUrl}`,
      { responseType: 'arraybuffer', validateStatus: () => true }
    );
    expect(previewResponse.status).toBe(200);
    const previewBuffer = Buffer.from(previewResponse.data);
    const previewPrefix = previewBuffer.subarray(0, 5).toString('utf8');
    expect(previewPrefix).toBe('%PDF-');
    expect(previewBuffer.includes(Buffer.from('Forh\\u00e5ndsvisning ikke tilgjengelig'))).toBe(false);
    expect(previewBuffer.includes(Buffer.from('Denne filtypen kan ikke forh\\u00e5ndsvises.'))).toBe(false);
  }, 120_000);

  it('rejects blocked executables and does not store originals', async () => {
    const fileName = 'blocked.exe';
    const filePath = path.join(tempDir, fileName);
    writeFileSync(filePath, 'MZ', 'utf8');

    const originalUrl = `/convert/original/${fileName}`;
    const previewUrl = '/convert/preview/blocked.pdf';

    const form = new FormData();
    form.append('file', createReadStream(filePath), {
      filename: fileName,
      contentType: 'application/octet-stream'
    });
    form.append('originalUrl', originalUrl);
    form.append('previewUrl', previewUrl);

    const convertResponse = await axios.post(
      `${baseUrl}/convert`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          'x-api-key': apiKey
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true
      }
    );

    expect(convertResponse.status).toBe(400);

    const originalResponse = await axios.get(
      `${baseUrl}${originalUrl}`,
      { responseType: 'arraybuffer', validateStatus: () => true }
    );
    expect(originalResponse.status).toBe(404);
  }, 60_000);
});
