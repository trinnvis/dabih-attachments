import axios from 'axios';
import FormData from 'form-data';
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:3000';
const apiKey = process.env.E2E_API_KEY || 'e2e-test-key';

async function waitForHealth(timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await axios.get(`${baseUrl}/convert/health`, {
        validateStatus: () => true
      });
      if (response.status === 200) {
        return;
      }
    } catch {
      // Ignore and retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/convert/health`);
}

describe('convert endpoint', () => {
  let tempDir = '';

  beforeAll(async () => {
    await waitForHealth(120_000);
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
    expect(convertResponse.data?.status).toBe('success');
    expect(convertResponse.data?.scanResult).toBe('clean');
    expect(convertResponse.data?.originalUploaded).toBe(true);
    expect(convertResponse.data?.previewGenerated).toBe(true);
    expect(convertResponse.data?.fileCategory).toBe('document');

    const originalResponse = await axios.get(
      `${baseUrl}${originalUrl}`,
      { responseType: 'arraybuffer', validateStatus: () => true }
    );
    expect(originalResponse.status).toBe(200);
    expect(originalResponse.headers['content-type']).toContain('text/plain');
    expect(Buffer.from(originalResponse.data).toString('utf8')).toBe(fileContents);

    const previewResponse = await axios.get(
      `${baseUrl}${previewUrl}`,
      { responseType: 'arraybuffer', validateStatus: () => true }
    );
    expect(previewResponse.status).toBe(200);
    const previewPrefix = Buffer.from(previewResponse.data).subarray(0, 5).toString('utf8');
    expect(previewPrefix).toBe('%PDF-');
  }, 120_000);
});
