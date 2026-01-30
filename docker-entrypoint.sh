#!/bin/bash
set -e

echo "Starting ClamAV services..."

# Ensure ClamAV directories exist with correct permissions
mkdir -p /var/run/clamav /var/log/clamav
chown -R clamav:clamav /var/run/clamav /var/log/clamav
chmod 775 /var/run/clamav /var/log/clamav

echo "ClamAV config:"
grep -E '^(User|LocalSocket|LocalSocketMode)' /etc/clamav/clamd.conf || true
echo "ClamAV runtime dir:"
ls -ld /var/run/clamav /var/log/clamav || true

# Start freshclam daemon for automatic updates
echo "Starting freshclam daemon..."
freshclam -d &

# Start ClamAV daemon in background
echo "Starting clamd..."
clamd &
CLAMD_PID=$!

# Wait for ClamAV to be ready
echo "Waiting for ClamAV daemon to start..."
for i in {1..30}; do
    if [ -S /var/run/clamav/clamd.ctl ]; then
        echo "ClamAV daemon is ready (PID: $CLAMD_PID)"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "WARNING: ClamAV daemon failed to start within 30 seconds"
        exit 1
    fi
    sleep 1
done

if [ ! -S /var/run/clamav/clamd.ctl ]; then
    echo "ClamAV socket missing after startup: /var/run/clamav/clamd.ctl"
    ls -l /var/run/clamav || true
fi

echo "Starting Node.js application with TypeScript (tsx) as appuser..."
cd /app
exec gosu appuser npx tsx src/index.ts
