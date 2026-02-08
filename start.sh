#!/bin/bash

# Railway startup script - runs Python proxy and Node backend

echo "===== Environment ====="
echo "PYTHONPATH=$PYTHONPATH"
echo "NYCTRAINS_RESOURCE_DIR=$NYCTRAINS_RESOURCE_DIR"
echo "Working directory: $(pwd)"
ls -la backend/gtfs/ || echo "backend/gtfs not found!"

echo "===== Starting Python proxy on http://127.0.0.1:8000 ====="
python proxy/run_proxy.py > /tmp/proxy.log 2>&1 &
PROXY_PID=$!
echo "Proxy PID: $PROXY_PID"

# Wait for proxy to be ready (check port 8000)
echo "===== Waiting for proxy to be ready (max 40 seconds) ====="
for i in {1..20}; do
  if python -c "import socket; s = socket.socket(); s.settimeout(1); s.connect(('127.0.0.1', 8000)); s.close()" 2>/dev/null; then
    echo "✓ Proxy is ready on port 8000!"
    break
  fi
  echo "Waiting for proxy... ($i/20)"
  sleep 2
done

# Show proxy startup logs
echo "===== Proxy startup logs ====="
head -20 /tmp/proxy.log 2>&1 || echo "No logs yet"
echo ""

echo "===== Starting Node backend on port ${PORT:-3001} ====="
# Show both proxy and node logs
tail -f /tmp/proxy.log &
node backend/server.js

# Cleanup
kill $PROXY_PID 2>/dev/null || true
