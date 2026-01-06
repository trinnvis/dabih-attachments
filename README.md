# Dabih Attachments Service

PDF conversion and antivirus scanning service for Dabih.

## Overview

This service provides secure document conversion and malware scanning capabilities:

- **Document to PDF conversion** using LibreOffice (supports DOCX, XLSX, PPTX, ODT, etc.)
- **Image to PDF conversion** for JPG, PNG, GIF, BMP, TIFF
- **Antivirus scanning** using ClamAV before storing files
- **Presigned URL-based security** - service writes only to specific S3 objects

## Security Architecture

The service implements a "scan-first, store-clean" approach:

1. API generates presigned S3 URLs for original and preview
2. Client uploads file to attachments service
3. **Antivirus scan executes BEFORE any S3 upload**
4. If infected → file is rejected, nothing stored
5. If clean → original uploaded to S3, preview generated, preview uploaded

**Benefits:**
- S3 contains only virus-scanned files
- No quarantine bucket needed
- Blast radius limited to single job if service compromised
- Presigned URLs prevent unauthorized S3 access

## API Endpoints

### `POST /convert`

Convert and scan a document.

**Request:**
```json
{
  "originalUrl": "https://s3.../presigned-put-url-original",
  "previewUrl": "https://s3.../presigned-put-url-preview.pdf",
  "file": "<multipart file upload>"
}
```

**Response (Success):**
```json
{
  "status": "success",
  "scanResult": "clean",
  "originalUploaded": true,
  "previewGenerated": true
}
```

**Response (Malware Detected):**
```json
{
  "status": "rejected",
  "scanResult": "infected",
  "details": "Malware detected: Win.Test.EICAR_HDB-1"
}
```

### `GET /health`

Health check endpoint.

## Infrastructure

**Deployment:**
- AWS ECS Fargate
- 1 vCPU, 2 GB RAM
- Deployed to `dabih-prod-cluster`
- Exposed at `https://api.trinnvis.io/convert`

**Container:**
- Node.js 18+ runtime
- LibreOffice 7.x for document conversion
- ClamAV with daily signature updates

**IAM Permissions:**
- S3 read/write to `dabihapi-attachments` bucket only
- No database access
- No secrets access (presigned URLs provided by API)

## Local Development

### Prerequisites

- Node.js 18+
- Docker (for LibreOffice and ClamAV)

### Setup

```bash
npm install
```

### Run with Docker

```bash
docker build -t dabih-attachments .
docker run -p 3000:3000 -e S3_BUCKET=test-bucket dabih-attachments
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | 3000 |
| `NODE_ENV` | Environment | production |
| `S3_BUCKET` | S3 bucket name | dabihapi-attachments |
| `AWS_REGION` | AWS region | eu-central-1 |
| `MAX_FILE_SIZE` | Max file size (bytes) | 52428800 (50MB) |

## Supported File Types

**Documents (LibreOffice):**
- Microsoft Office: DOCX, XLSX, PPTX, DOC, XLS, PPT
- OpenDocument: ODT, ODS, ODP
- Other: RTF, TXT, CSV

**Images:**
- JPG, JPEG, PNG, GIF, BMP, TIFF

## Security Considerations

### Input Validation
- File size limit: 50MB
- Extension whitelist
- Magic number verification
- Malware scanning (ClamAV)

### Resource Limits
- Conversion timeout: 120 seconds
- Max 2 concurrent conversions
- LibreOffice runs in headless mode (no macro execution)

### Container Security
- Non-root user
- Read-only root filesystem (except /tmp)
- No privilege escalation
- Minimal attack surface

## Deployment

Deployments are automated via GitHub Actions:

1. Push to `main` branch
2. GitHub Actions builds Docker image
3. Image pushed to ECR (`dabih-prod-attachments`)
4. ECS service updated with new image

**Manual deployment:**
```bash
aws ecs update-service \
  --cluster dabih-prod-cluster \
  --service attachments \
  --force-new-deployment \
  --region eu-central-1
```

## Monitoring

**Logs:** CloudWatch Logs → `/ecs/dabih-prod-cluster/attachments`

**Metrics:**
- Conversion success/failure rate
- Malware detection rate
- Processing time (p50, p95, p99)
- Memory and CPU utilization

## Architecture Decision Records

### Why separate service instead of Lambda?
- Consistent deployment model with other services
- Better cost control
- No cold starts
- Easier local development and testing

### Why presigned URLs instead of direct S3 access?
- Service can only write to specific objects
- Compromised service cannot access/modify other files
- Better security isolation

### Why scan before upload instead of after?
- S3 never contains infected files
- Simpler compliance story
- No quarantine bucket needed
- Failed scans don't pollute storage

## Future Work

- [ ] Add support for additional file formats
- [ ] Implement preview caching
- [ ] Add metrics dashboard
- [ ] Consider sandboxed LibreOffice execution (gVisor/Firecracker)
- [ ] Evaluate alternative AV solutions (commercial scanners)

## License

Proprietary - Trinnvis AS

## Contact

For questions or issues, contact the Dabih team or open an issue in this repository.
