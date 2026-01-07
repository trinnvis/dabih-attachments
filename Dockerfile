# Multi-stage Dockerfile for dabih-attachments service
# Includes LibreOffice for document conversion and ClamAV for malware scanning

FROM node:22-bookworm AS base

# Install LibreOffice and ClamAV
RUN apt-get update && apt-get install -y \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-core \
    libreoffice-common \
    clamav \
    clamav-daemon \
    clamav-freshclam \
    && rm -rf /var/lib/apt/lists/*

# Update ClamAV virus definitions
# Note: This will be updated daily by freshclam daemon in production
RUN freshclam || echo "ClamAV update failed, continuing with existing signatures"

# Verify LibreOffice installation
RUN libreoffice --version

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY src ./src

# Create non-root user for security
RUN useradd -r -u 1001 -g daemon appuser && \
    chown -R appuser:daemon /app && \
    mkdir -p /tmp/libreoffice && \
    chown -R appuser:daemon /tmp/libreoffice

# Expose port
EXPOSE 3000

# Switch to non-root user
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["node", "src/index.js"]
