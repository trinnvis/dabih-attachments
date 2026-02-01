#!/bin/bash
set -e

echo "Waiting for ClamAV daemon to be ready..."
for i in {1..30}; do
    if clamdscan --version > /dev/null 2>&1; then
        echo "ClamAV daemon is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "ERROR: ClamAV daemon failed to start within 30 seconds"
        exit 1
    fi
    sleep 1
done

echo "Starting Node.js application with TypeScript (tsx) as appuser..."
cd /app
exec gosu appuser npx tsx src/index.ts
