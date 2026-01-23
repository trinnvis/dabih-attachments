import axios, { type AxiosResponse } from 'axios';
import FormData from 'form-data';
import { spawnSync, type SpawnSyncOptions } from 'child_process';
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

const repoRootArg = process.argv[2];
if (!repoRootArg) {
  throw new Error('Missing repo root argument. Usage: tsx src/test/e2e/e2e-convert.ts /path/to/repo');
}
const repoRoot = path.resolve(repoRootArg);

const imageTag = 'dabih-attachments-e2e';
const containerName = `dabih-attachments-e2e-${Date.now()}`;
const apiKey = `e2e-${Math.random().toString(36).slice(2)}`;
const host = '127.0.0.1';
const port = 3001;

function run(command: string, args: string[], options: SpawnSyncOptions = {}): void {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
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
    } catch (error) {
      // Ignore and retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for /convert/health');
}

async function waitForClamSocket(container: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = spawnSync(
        'docker',
        ['exec', container, 'test', '-S', '/var/run/clamav/clamd.ctl'],
        { stdio: 'ignore' }
      );
      if (result.status === 0) {
        return;
      }
    } catch (error) {
      // Ignore and retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for ClamAV socket');
}

interface ConvertResponse {
  status: string;
  scanResult: string;
  originalUploaded: boolean;
  previewGenerated: boolean;
  fileCategory: string;
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dabih-attachments-e2e-'));
  const fileName = 'test.txt';
  const filePath = path.join(tempDir, fileName);
  const fileContents = 'Hello from dabih-attachments e2e test\n';
  writeFileSync(filePath, fileContents, 'utf8');

  const originalUrl = `/convert/original/${fileName}`;
  const previewUrl = '/convert/preview/test.pdf';
  let failed = false;

  try {
    run('docker', ['build', '-t', imageTag, '.'], { cwd: repoRoot });
    run(
      'docker',
      [
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
      ],
      { cwd: repoRoot }
    );

    await waitForPort(host, port, 60_000);
    await waitForHealth(`http://${host}:${port}`, 120_000);
    await waitForClamSocket(containerName, 120_000);

    const form = new FormData();
    form.append('file', createReadStream(filePath), {
      filename: fileName,
      contentType: 'text/plain'
    });
    form.append('originalUrl', originalUrl);
    form.append('previewUrl', previewUrl);

    let convertResponse: AxiosResponse<ConvertResponse> | undefined;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        convertResponse = await axios.post(
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
        break;
      } catch (error: unknown) {
        if (attempt === 5) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }

    assert(convertResponse, 'No response from /convert');
    assert(convertResponse.status === 200, `Expected 200, got ${convertResponse.status}`);
    assert(convertResponse.data?.status === 'success', 'Expected status=success');
    assert(convertResponse.data?.scanResult === 'clean', 'Expected scanResult=clean');
    assert(convertResponse.data?.originalUploaded === true, 'Expected originalUploaded=true');
    assert(convertResponse.data?.previewGenerated === true, 'Expected previewGenerated=true');
    assert(convertResponse.data?.fileCategory === 'document', 'Expected fileCategory=document');

    const originalResponse = await axios.get(
      `http://${host}:${port}${originalUrl}`,
      { responseType: 'arraybuffer', validateStatus: () => true }
    );
    assert(
      originalResponse.status === 200,
      `Expected 200 for original, got ${originalResponse.status}`
    );
    assert(
      originalResponse.headers['content-type']?.includes('text/plain'),
      'Expected text/plain content type for original'
    );
    assert(
      Buffer.from(originalResponse.data).toString('utf8') === fileContents,
      'Original content mismatch'
    );

    const previewResponse = await axios.get(
      `http://${host}:${port}${previewUrl}`,
      { responseType: 'arraybuffer', validateStatus: () => true }
    );
    assert(
      previewResponse.status === 200,
      `Expected 200 for preview, got ${previewResponse.status}`
    );
    const previewPrefix = Buffer.from(previewResponse.data).subarray(0, 5).toString('utf8');
    assert(previewPrefix === '%PDF-', 'Preview does not look like a PDF');

    console.log('E2E conversion test passed.');
  } catch (error: unknown) {
    failed = true;
    throw error;
  } finally {
    if (failed) {
      try {
        run('docker', ['logs', containerName]);
      } catch (error: unknown) {}
    }
    try {
      run('docker', ['rm', '-f', containerName]);
    } catch (error: unknown) {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error: unknown) {}
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (process.exitCode && process.exitCode !== 0) {
    // Ensure failure is observable to the caller.
    process.exit(1);
  }
});
