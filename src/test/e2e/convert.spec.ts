import axios from 'axios';
import FormData from 'form-data';
import { spawnSync } from 'child_process';
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const imageTag = 'dabih-attachments-e2e';
const containerName = `dabih-attachments-e2e-${Date.now()}`;
const apiKey = `e2e-${Math.random().toString(36).slice(2)}`;
const host = '127.0.0.1';
const port = 3001;

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

async function waitForPort(hostname: string, portNumber: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: hostname, port: portNumber }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => {
        resolve(false);
      });
    });
    if (connected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${hostname}:${portNumber}`);
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
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
  throw new Error('Timed out waiting for /convert/health');
}

async function waitForClamSocket(container: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = spawnSync(
      'docker',
      ['exec', container, 'test', '-S', '/var/run/clamav/clamd.ctl'],
      { stdio: 'ignore', cwd: repoRoot }
    );
    if (result.status === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for ClamAV socket');
}

describe('convert endpoint', () => {
  let tempDir = '';

  beforeAll(async () => {
    run('docker', ['build', '-t', imageTag, '.']);
    run('docker', [
      'run',
      '--rm',
      '-d',
      '--name',
      containerName,
      '-p',
      `${port}:3000`,
      '-e',
      `ATTACHMENTS_CONVERT_API_KEY=${apiKey}`,
      imageTag
    ]);

    await waitForPort(host, port, 60_000);
    await waitForHealth(`http://${host}:${port}`, 120_000);
    await waitForClamSocket(containerName, 120_000);

    tempDir = mkdtempSync(path.join(os.tmpdir(), 'dabih-attachments-e2e-'));
  }, 180_000);

  afterAll(() => {
    try {
      run('docker', ['rm', '-f', containerName]);
    } catch {
      // Best-effort cleanup.
    }
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
      `http://${host}:${port}/convert`,
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
      `http://${host}:${port}${originalUrl}`,
      { responseType: 'arraybuffer', validateStatus: () => true }
    );
    expect(originalResponse.status).toBe(200);
    expect(originalResponse.headers['content-type']).toContain('text/plain');
    expect(Buffer.from(originalResponse.data).toString('utf8')).toBe(fileContents);

    const previewResponse = await axios.get(
      `http://${host}:${port}${previewUrl}`,
      { responseType: 'arraybuffer', validateStatus: () => true }
    );
    expect(previewResponse.status).toBe(200);
    const previewPrefix = Buffer.from(previewResponse.data).subarray(0, 5).toString('utf8');
    expect(previewPrefix).toBe('%PDF-');
  }, 120_000);
});
