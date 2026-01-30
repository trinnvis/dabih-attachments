import axios from 'axios';
import FormData from 'form-data';
import {createReadStream, mkdtempSync, rmSync, writeFileSync} from 'fs';
import os from 'os';
import path from 'path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:3000';
const apiKey = process.env.E2E_API_KEY || 'e2e-test-key';
const convertUrl = `${baseUrl}/convert`;

function buildHeaders(form: FormData) {
    return {
        headers: {
            ...form.getHeaders(),
            'x-api-key': apiKey
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true
    };
}

function buildForm(filePath: string, fileName: string, contentType: string, originalUrl: string, previewUrl: string) {
    const form = new FormData();
    form.append('file', createReadStream(filePath), {
        filename: fileName,
        contentType
    });
    form.append('originalUrl', originalUrl);
    form.append('previewUrl', previewUrl);
    return form;
}

describe('convert endpoint', () => {
    let tempDir = '';

    beforeAll(
        async () => {
            tempDir = mkdtempSync(path.join(os.tmpdir(), 'dabih-attachments-e2e-'));
        },
        1_000
    );

    afterAll(() => {
        if (tempDir) {
            rmSync(tempDir, {recursive: true, force: true});
        }
    });

    it(
        'uploads the original and generates a preview PDF',
        async () => {
            const fileName = 'test.txt';
            const filePath = path.join(tempDir, fileName);
            const fileContents = 'Hello from dabih-attachments e2e test\n';
            writeFileSync(filePath, fileContents, 'utf8');

            const originalUrl = `/convert/original/${fileName}`;
            const previewUrl = '/convert/preview/test.pdf';

            const form = buildForm(filePath, fileName, 'text/plain', originalUrl, previewUrl);
            const convertResponse = await axios.post(
                convertUrl,
                form,
                {
                    ...(buildHeaders(form))
                }
            );

            expect(convertResponse.status).toBe(200);

            const previewResponse = await axios.get(
                `${baseUrl}${previewUrl}`,
                {responseType: 'arraybuffer', validateStatus: () => true}
            );
            expect(previewResponse.status).toBe(200);
            const previewBuffer = Buffer.from(previewResponse.data);
            const previewPrefix = previewBuffer.subarray(0, 5).toString('utf8');
            expect(previewPrefix).toBe('%PDF-');
            expect(previewBuffer.includes(Buffer.from('Forh\\u00e5ndsvisning ikke tilgjengelig'))).toBe(false);
            expect(previewBuffer.includes(Buffer.from('Denne filtypen kan ikke forh\\u00e5ndsvises.'))).toBe(false);
        },
        1_000
    );

    it(
        'rejects disallowed file type',
        async () => {
            const fileName = 'blocked.exe';
            const filePath = path.join(tempDir, fileName);
            writeFileSync(filePath, 'MZ', 'utf8');

            const originalUrl = `/convert/original/${fileName}`;
            const previewUrl = '/convert/preview/blocked.pdf';

            const form = buildForm(filePath, fileName, 'application/octet-stream', originalUrl, previewUrl);
            const convertResponse = await axios.post(
                convertUrl,
                form,
                {
                    ...(buildHeaders(form))
                }
            );

            expect(convertResponse.status).toBe(400);

            const response = await axios.get(
                `${baseUrl}${originalUrl}`,
                {responseType: 'arraybuffer', validateStatus: () => true}
            );
            await expect(response.status).toBe(404);
        },
        1_000
    );

    it(
        'rejects malicious file of allowed type',
        async () => {
            const fileName = 'eicar.txt';
            const filePath = path.join(tempDir, fileName);
            const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
            writeFileSync(filePath, eicar, 'utf8');

            const originalUrl = `/convert/original/${fileName}`;
            const previewUrl = '/convert/preview/eicar.pdf';

            const form = buildForm(filePath, fileName, 'text/plain', originalUrl, previewUrl);
            const convertResponse = await axios.post(
                convertUrl,
                form,
                {
                    ...(buildHeaders(form))
                }
            );

            expect(convertResponse.status).toBe(403);

            const response = await axios.get(
                `${baseUrl}${originalUrl}`,
                {responseType: 'arraybuffer', validateStatus: () => true}
            );
            await expect(response.status).toBe(404);
        },
        1_000
    );
});
