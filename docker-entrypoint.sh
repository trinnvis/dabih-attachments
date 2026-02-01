#!/bin/bash
set -e

echo "Starting services with supervisor..."

# Ensure ClamAV directories exist with correct permissions
mkdir -p /var/run/clamav /var/log/clamav
chown -R clamav:clamav /var/run/clamav /var/log/clamav
chmod 775 /var/run/clamav /var/log/clamav

echo "ClamAV config:"
grep -E '^(User|LocalSocket|LocalSocketMode)' /etc/clamav/clamd.conf || true
echo "ClamAV runtime dir:"
ls -ld /var/run/clamav /var/log/clamav || true

# Start supervisord (will manage clamd, freshclam, and app)
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
