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
echo "Proxy PID: $PROXY_PID"

# Give proxy time to start
sleep 3

# Check if proxy process is still running
if ! ps -p $PROXY_PID > /dev/null 2>&1; then
    echo "ERROR: Proxy process died immediately!"
    echo "===== Proxy logs ====="
    cat /tmp/proxy.log || echo "No logs available"
    exit 1
fi

echo "===== Waiting for proxy to be ready (checking port 8000) ====="
PROXY_READY=false
for i in {1..15}; do
  # Use python to check if port is open
  if python -c "import socket; s = socket.socket(); s.settimeout(1); s.connect(('127.0.0.1', 8000)); s.close()" 2>/dev/null; then
    echo "✓ Proxy is ready on port 8000!"
    PROXY_READY=true
    break
  fi
  
  # Check if process is still alive
  if ! ps -p $PROXY_PID > /dev/null 2>&1; then
    echo "WARNING: Proxy process died during startup!"
    echo "===== Proxy logs ====="
    cat /tmp/proxy.log || echo "No logs available"
    echo "Starting backend anyway (arrivals will fail until proxy is fixed)..."
    break
  fi
  
  echo "Waiting for proxy... ($i/15)"
  sleep 2
done

if [ "$PROXY_READY" = false ]; then
    echo "WARNING: Proxy not ready after 30 seconds, but starting backend anyway"
    echo "===== Proxy logs so far ====="
    cat /tmp/proxy.log || echo "No logs available"
    echo "Arrivals endpoints will return errors until proxy is ready"
fi

echo "===== Starting Node backend on port ${PORT:-3001} ====="
# Show both proxy and node logs
tail -f /tmp/proxy.log &
node backend/server.js

# Cleanup
kill $PROXY_PID 2>/dev/null || true
