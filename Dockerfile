# Multi-stage Dockerfile for dabih-attachments service
# Includes LibreOffice for document conversion and ClamAV for malware scanning

FROM node:22-bookworm AS base

# Install LibreOffice, ClamAV and gosu
RUN apt-get update && apt-get install -y \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-core \
    libreoffice-common \
    clamav \
    clamav-daemon \
    clamav-freshclam \
    gosu \
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

# Configure ClamAV to run as non-root user
RUN mkdir -p /var/run/clamav /var/log/clamav && \
    chown -R clamav:clamav /var/run/clamav /var/log/clamav && \
    sed -i 's/^User .*/User clamav/' /etc/clamav/clamd.conf && \
    sed -i 's/^LocalSocket .*/LocalSocket \/var\/run\/clamav\/clamd.ctl/' /etc/clamav/clamd.conf

# Create non-root user for security
RUN useradd -r -u 1001 -g daemon appuser && \
    chown -R appuser:daemon /app && \
    mkdir -p /tmp/libreoffice && \
    chown -R appuser:daemon /tmp/libreoffice

# Copy and set up entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/convert/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application with entrypoint script
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
