import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, copyFileSync, createReadStream, createWriteStream } from 'fs';
import libre from 'libreoffice-convert';
import { promisify } from 'util';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import { pipeline } from 'stream/promises';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import path from 'path';

const libreConvertAsync = promisify(libre.convert);

// File type categorization
const FILE_TYPES = {
  // Images - supported by Sharp
  image: new Set([
    'jpg', 'jpeg', 'png', 'webp', 'gif', 'tiff', 'tif',
    'avif', 'heic', 'heif', 'svg'
  ]),

  // Documents - supported by LibreOffice
  document: new Set([
    'doc', 'docx', 'odt', 'rtf', 'txt',
    'xls', 'xlsx', 'ods', 'csv',
    'ppt', 'pptx', 'odp'
  ]),

  // Video/Audio - not convertible, will get placeholder
  video: new Set(['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv', 'm4v']),
  audio: new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma']),

  // Archives - not convertible, will get placeholder
  archive: new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2']),

  // Blocked - dangerous file types
  blocked: new Set([
    'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'pif',
    'vbs', 'js', 'jar', 'app', 'deb', 'rpm', 'msi',
    'sh', 'bash', 'ps1'
  ])
};

function getFileCategory(filename: string): 'image' | 'document' | 'video' | 'audio' | 'archive' | 'blocked' | 'unsupported' {
  const ext = path.extname(filename).slice(1).toLowerCase();

  if (FILE_TYPES.blocked.has(ext)) return 'blocked';
  if (FILE_TYPES.image.has(ext)) return 'image';
  if (FILE_TYPES.document.has(ext)) return 'document';
  if (FILE_TYPES.video.has(ext)) return 'video';
  if (FILE_TYPES.audio.has(ext)) return 'audio';
  if (FILE_TYPES.archive.has(ext)) return 'archive';

  return 'unsupported';
}

const app = express();
const upload = multer({
  dest: '/tmp/uploads/',
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800') // 50MB default
  }
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ATTACHMENTS_CONVERT_API_KEY;

app.use(express.json());

// API Key validation middleware for POST requests
function validateApiKey(req: Request, res: Response, next: NextFunction) {
  const providedKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!API_KEY) {
    console.error('SECURITY WARNING: ATTACHMENTS_CONVERT_API_KEY environment variable not set');
    return res.status(500).json({
      status: 'error',
      message: 'Service configuration error'
    });
  }

  if (!providedKey || providedKey !== API_KEY) {
    console.warn('Unauthorized access attempt');
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized - Invalid or missing API key'
    });
  }

  next();
}

// Health check endpoint
app.get('/convert/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    service: 'dabih-attachments',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

interface LocalFileInfo {
  path: string;
  contentType: string;
  expiresAt: number;
}

// In-memory store for local test files (with 5 minute expiry)
const localFiles = new Map<string, LocalFileInfo>();

// Get local test files (original and preview)
app.get('/convert/:type/:filename', (req: Request, res: Response) => {
  const { type, filename } = req.params;

  // Validate type
  if (type !== 'original' && type !== 'preview') {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid type. Must be "original" or "preview"'
    });
  }

  // Check if file exists in memory store
  const fileInfo = localFiles.get(filename);

  if (!fileInfo) {
    return res.status(404).json({
      status: 'error',
      message: 'File not found or expired (files expire after 5 minutes)'
    });
  }

  // Check if expired
  if (Date.now() > fileInfo.expiresAt) {
    // Cleanup
    try {
      unlinkSync(fileInfo.path);
      localFiles.delete(filename);
    } catch (e) {}

    return res.status(404).json({
      status: 'error',
      message: 'File expired (files expire after 5 minutes)'
    });
  }

  // Serve file
  try {
    res.setHeader('Content-Type', fileInfo.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

    const fileStream = createReadStream(fileInfo.path);
    fileStream.pipe(res);
  } catch (error) {
    console.error('Error serving file:', error);
    res.status(500).json({
      status: 'error',
      message: 'Error reading file'
    });
  }
});

interface ScanResult {
  clean: boolean;
  result: string;
}

// Antivirus scanning function
async function scanFile(filePath: string): Promise<ScanResult> {
  try {
    console.log(`Scanning file: ${filePath}`);

    // Run ClamAV scan
    const result = execSync(`clamdscan --no-summary ${filePath}`, {
      encoding: 'utf8',
      timeout: 30000 // 30 second timeout
    });

    console.log('ClamAV scan result:', result);

    return {
      clean: true,
      result: result.trim()
    };
  } catch (error: any) {
    // clamdscan returns exit code 1 if virus found
    if (error.status === 1) {
      console.error('Malware detected:', error.stdout);
      return {
        clean: false,
        result: error.stdout || error.message
      };
    }

    // Other errors (scan failure, timeout, etc.)
    console.error('Scan error:', error);
    throw new Error(`Antivirus scan failed: ${error.message}`);
  }
}

// Generate placeholder PDF for unsupported file types
async function generatePlaceholderPDF(fileName: string, fileSize: number, category: string): Promise<string> {
  const tempname = (0 | Math.random() * 9e6).toString(36);
  const destinationFile = `/tmp/libreoffice/${tempname}.pdf`;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = createWriteStream(destinationFile);

    doc.pipe(stream);

    // Title
    doc.fontSize(24)
       .fillColor('#333')
       .text('Forhåndsvisning ikke tilgjengelig', { align: 'center' });

    doc.moveDown(2);

    // Icon/Box
    doc.fontSize(48)
       .fillColor('#999')
       .text('📄', { align: 'center' });

    doc.moveDown(2);

    // File info
    doc.fontSize(14)
       .fillColor('#666')
       .text('Filnavn:', { continued: false })
       .fillColor('#333')
       .text(fileName, { align: 'center' });

    doc.moveDown(0.5);

    doc.fontSize(14)
       .fillColor('#666')
       .text('Filtype:', { continued: false })
       .fillColor('#333')
       .text(category.toUpperCase(), { align: 'center' });

    doc.moveDown(0.5);

    doc.fontSize(14)
       .fillColor('#666')
       .text('Størrelse:', { continued: false })
       .fillColor('#333')
       .text(`${(fileSize / 1024 / 1024).toFixed(2)} MB`, { align: 'center' });

    doc.moveDown(3);

    // Message
    doc.fontSize(12)
       .fillColor('#666')
       .text('Denne filtypen kan ikke forhåndsvises.', { align: 'center' })
       .text('Last ned originalfilen for å se innholdet.', { align: 'center' });

    doc.end();

    stream.on('finish', () => resolve(destinationFile));
    stream.on('error', reject);
  });
}

// Convert file to PDF
async function convertFileToPDF(sourceFile: string, fileName: string, fileSize: number): Promise<string> {
  const tempname = (0 | Math.random() * 9e6).toString(36);
  const destinationFile = `/tmp/libreoffice/${tempname}.pdf`;
  const category = getFileCategory(fileName);

  // Check if file type is blocked
  if (category === 'blocked') {
    throw new Error(`File type not allowed: ${path.extname(fileName)}`);
  }

  // Handle based on category
  if (category === 'image') {
    console.log('Converting image to PDF with Sharp');

    try {
      // Convert image to JPEG buffer first (normalized format)
      const imageBuffer = await sharp(sourceFile)
        .jpeg({ quality: 90 })
        .toBuffer();

      // Get image metadata for sizing
      const metadata = await sharp(imageBuffer).metadata();
      const width = metadata.width || 595;
      const height = metadata.height || 842;

      // Create PDF with image
      const doc = new PDFDocument({
        size: [width, height],
        margins: { top: 0, bottom: 0, left: 0, right: 0 }
      });

      const stream = createWriteStream(destinationFile);
      doc.pipe(stream);
      doc.image(imageBuffer, 0, 0, { width, height });
      doc.end();

      await new Promise<void>((resolve, reject) => {
        stream.on('finish', () => resolve());
        stream.on('error', reject);
      });
    } catch (error) {
      console.warn(`Sharp conversion failed for ${fileName}, creating placeholder:`, error);
      return generatePlaceholderPDF(fileName, fileSize, 'image (conversion failed)');
    }

  } else if (category === 'document') {
    console.log('Converting document to PDF with LibreOffice');

    try {
      const docBuffer = readFileSync(sourceFile);
      const pdfBuffer = await libreConvertAsync(docBuffer, '.pdf', undefined);
      writeFileSync(destinationFile, pdfBuffer as Buffer);
    } catch (error) {
      console.warn(`LibreOffice conversion failed for ${fileName}, creating placeholder:`, error);
      return generatePlaceholderPDF(fileName, fileSize, 'document (conversion failed)');
    }

  } else {
    // Video, audio, archive, or unsupported - create placeholder
    console.log(`Creating placeholder PDF for ${category} file: ${fileName}`);
    return generatePlaceholderPDF(fileName, fileSize, category);
  }

  return destinationFile;
}

interface UploadResult {
  success: boolean;
  local?: boolean;
  statusCode?: number;
}

// Handle file upload - supports both presigned URLs and local test URLs
async function handleFileUpload(url: string, filePath: string, contentType = 'application/octet-stream'): Promise<UploadResult> {
  // Check if this is a local test URL (starts with /convert/)
  if (url.startsWith('/convert/')) {
    console.log(`Storing file locally for test URL: ${url}`);

    // Extract filename from URL (e.g., /convert/original/uuid.xxx -> uuid.xxx)
    const filename = url.split('/').pop()!;
    const localPath = `/tmp/convert-test/${filename}`;

    // Ensure directory exists
    const dir = '/tmp/convert-test';
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Copy file to local storage
    copyFileSync(filePath, localPath);

    // Store metadata with expiry (5 minutes)
    const expiryTime = Date.now() + (5 * 60 * 1000);
    localFiles.set(filename, {
      path: localPath,
      contentType: contentType,
      expiresAt: expiryTime
    });

    // Schedule cleanup
    setTimeout(() => {
      if (localFiles.has(filename)) {
        try {
          unlinkSync(localPath);
          localFiles.delete(filename);
          console.log(`Cleaned up expired test file: ${filename}`);
        } catch (e: any) {
          console.error(`Error cleaning up file ${filename}:`, e.message);
        }
      }
    }, 5 * 60 * 1000);

    return { success: true, local: true };
  }

  // Otherwise, treat as presigned URL
  return uploadWithPresignedUrl(url, filePath, contentType);
}

// Upload file using presigned URL (S3)
async function uploadWithPresignedUrl(presignedUrl: string, filePath: string, contentType = 'application/octet-stream'): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const fileContent = readFileSync(filePath);
    const url = new URL(presignedUrl);

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: {
        'Content-Length': fileContent.length,
        'Content-Type': contentType
      }
    };

    const protocol = url.protocol === 'https:' ? https : http;

    const req = protocol.request(options, (res) => {
      if (res.statusCode! >= 200 && res.statusCode! < 300) {
        console.log(`Upload successful: ${res.statusCode}`);
        resolve({ success: true, statusCode: res.statusCode });
      } else {
        reject(new Error(`Upload failed with status ${res.statusCode}`));
      }
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(fileContent);
    req.end();
  });
}

// Main conversion endpoint (with API key validation)
app.post('/convert', validateApiKey, upload.single('file'), async (req: Request, res: Response) => {
  const startTime = Date.now();
  let scanResult: ScanResult | null = null;
  let tempFiles: string[] = [];

  try {
    // Validate request
    if (!req.file) {
      console.error('No file uploaded to /convert', {
        bodyKeys: Object.keys(req.body || {}),
        contentType: req.headers['content-type']
      });
      return res.status(400).json({
        status: 'error',
        message: 'No file uploaded'
      });
    }

    const { originalUrl, previewUrl } = req.body;

    if (!originalUrl || !previewUrl) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing presigned URLs (originalUrl, previewUrl)'
      });
    }

    const uploadedFile = req.file;
    tempFiles.push(uploadedFile.path);

    console.log(`Processing file: ${uploadedFile.originalname} (${uploadedFile.size} bytes)`);

    // Check file type
    const fileCategory = getFileCategory(uploadedFile.originalname);
    if (fileCategory === 'blocked') {
      // Clean up immediately
      tempFiles.forEach(file => {
        try { unlinkSync(file); } catch (e) {}
      });

      return res.status(400).json({
        status: 'error',
        message: `File type not allowed: ${path.extname(uploadedFile.originalname)}`,
        fileType: fileCategory
      });
    }

    // STEP 1: ANTIVIRUS SCAN (BEFORE any S3 upload)
    console.log('Step 1: Scanning for malware...');
    scanResult = await scanFile(uploadedFile.path);

    if (!scanResult.clean) {
      console.error('MALWARE DETECTED - File rejected');

      // Clean up immediately
      tempFiles.forEach(file => {
        try { unlinkSync(file); } catch (e) {}
      });

      return res.status(403).json({
        status: 'rejected',
        scanResult: 'infected',
        details: scanResult.result,
        message: 'File rejected due to malware detection'
      });
    }

    console.log('Scan result: CLEAN');

    // STEP 2: Upload original file
    console.log('Step 2: Uploading original file...');
    await handleFileUpload(
      originalUrl,
      uploadedFile.path,
      uploadedFile.mimetype
    );
    console.log('Original file uploaded successfully');

    // STEP 3: Convert to PDF
    console.log('Step 3: Converting to PDF...');
    const pdfFile = await convertFileToPDF(uploadedFile.path, uploadedFile.originalname, uploadedFile.size);
    tempFiles.push(pdfFile);
    console.log(`PDF generated: ${pdfFile}`);

    // STEP 4: Upload preview PDF
    console.log('Step 4: Uploading preview PDF...');
    await handleFileUpload(
      previewUrl,
      pdfFile,
      'application/pdf'
    );
    console.log('Preview PDF uploaded successfully');

    // Clean up temp files
    tempFiles.forEach(file => {
      try { unlinkSync(file); } catch (e) {}
    });

    const duration = Date.now() - startTime;
    console.log(`Processing completed in ${duration}ms`);

    res.status(200).json({
      status: 'success',
      scanResult: 'clean',
      originalUploaded: true,
      previewGenerated: true,
      fileCategory: fileCategory,
      processingTime: duration,
      message: 'File processed successfully'
    });

  } catch (error: any) {
    console.error('Error processing file:', error);

    // Clean up temp files
    tempFiles.forEach(file => {
      try { unlinkSync(file); } catch (e) {}
    });

    res.status(500).json({
      status: 'error',
      message: error.message,
      scanResult: scanResult ? (scanResult.clean ? 'clean' : 'infected') : 'not_scanned'
    });
  }
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        status: 'error',
        message: `File too large. Maximum size: ${process.env.MAX_FILE_SIZE || '50MB'}`
      });
    }
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    status: 'error',
    message: 'Internal server error'
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`dabih-attachments service listening on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`Max file size: ${process.env.MAX_FILE_SIZE || '52428800'} bytes`);

  // Verify LibreOffice
  try {
    const version = execSync('libreoffice --version', { encoding: 'utf8' });
    console.log(`LibreOffice: ${version.trim()}`);
  } catch (e) {
    console.error('WARNING: LibreOffice not available');
  }

  // Verify ClamAV
  try {
    const version = execSync('clamdscan --version', { encoding: 'utf8' });
    console.log(`ClamAV: ${version.trim()}`);
  } catch (e) {
    console.error('WARNING: ClamAV not available');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
