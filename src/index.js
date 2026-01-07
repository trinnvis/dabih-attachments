const express = require('express');
const multer = require('multer');
const { execSync } = require('child_process');
const { writeFileSync, readFileSync, unlinkSync } = require('fs');
const libre = require('libreoffice-convert');
const { promisify } = require('util');
const libreConvertAsync = promisify(libre.convert);
const isImage = require('is-image');
const imgToPDF = require('image-to-pdf');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = express();
const upload = multer({
  dest: '/tmp/uploads/',
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800') // 50MB default
  }
});

const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check endpoint
app.get('/convert/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'dabih-attachments',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Get local test files (original and preview)
app.get('/convert/:type/:filename', (req, res) => {
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
      fs.unlinkSync(fileInfo.path);
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

    const fileStream = fs.createReadStream(fileInfo.path);
    fileStream.pipe(res);
  } catch (error) {
    console.error('Error serving file:', error);
    res.status(500).json({
      status: 'error',
      message: 'Error reading file'
    });
  }
});

// Antivirus scanning function
async function scanFile(filePath) {
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
  } catch (error) {
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

// Convert file to PDF
async function convertFileToPDF(sourceFile, fileName) {
  const tempname = (0 | Math.random() * 9e6).toString(36);
  const destinationFile = `/tmp/libreoffice/${tempname}.pdf`;

  if (isImage(fileName)) {
    console.log('Converting image to PDF');
    await pipeline(
      imgToPDF([sourceFile], imgToPDF.sizes.A4),
      fs.createWriteStream(destinationFile)
    );
  } else {
    console.log('Converting document to PDF with LibreOffice');

    // Read source file
    const docBuffer = readFileSync(sourceFile);

    // Convert to PDF
    const pdfBuffer = await libreConvertAsync(docBuffer, '.pdf', undefined);

    // Write PDF to destination
    writeFileSync(destinationFile, pdfBuffer);
  }

  return destinationFile;
}

// In-memory store for local test files (with 5 minute expiry)
const localFiles = new Map();

// Handle file upload - supports both presigned URLs and local test URLs
async function handleFileUpload(url, filePath, contentType = 'application/octet-stream') {
  // Check if this is a local test URL (starts with /convert/)
  if (url.startsWith('/convert/')) {
    console.log(`Storing file locally for test URL: ${url}`);

    // Extract filename from URL (e.g., /convert/original/uuid.xxx -> uuid.xxx)
    const filename = url.split('/').pop();
    const localPath = `/tmp/convert-test/${filename}`;

    // Ensure directory exists
    const dir = '/tmp/convert-test';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Copy file to local storage
    fs.copyFileSync(filePath, localPath);

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
          fs.unlinkSync(localPath);
          localFiles.delete(filename);
          console.log(`Cleaned up expired test file: ${filename}`);
        } catch (e) {
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
async function uploadWithPresignedUrl(presignedUrl, filePath, contentType = 'application/octet-stream') {
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
      if (res.statusCode >= 200 && res.statusCode < 300) {
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

// Main conversion endpoint
app.post('/convert', upload.single('file'), async (req, res) => {
  const startTime = Date.now();
  let scanResult = null;
  let tempFiles = [];

  try {
    // Validate request
    if (!req.file) {
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
    const pdfFile = await convertFileToPDF(uploadedFile.path, uploadedFile.originalname);
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
      processingTime: duration,
      message: 'File processed successfully'
    });

  } catch (error) {
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
app.use((err, req, res, next) => {
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
app.listen(PORT, () => {
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
