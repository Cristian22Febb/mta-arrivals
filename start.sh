#!/bin/bash

# Railway startup script - runs Python proxy and Node backend

export GTFS_PROXY_BASE="http://127.0.0.1:8000"
export GTFS_PROXY_MODE="nyctrains"
export PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION="python"
export PROTOBUF_FORCE_PYTHON="1"
export PYTHONPATH="$(pwd):$PYTHONPATH"
export NYCTRAINS_RESOURCE_DIR="/app/backend/gtfs"

# Add C++ standard library to LD_LIBRARY_PATH for numpy
# Find libstdc++ in nix store and add its directory
LIBSTDCXX_PATH=$(find /nix/store -name "libstdc++.so.6" -type f 2>/dev/null | head -1)
if [ -n "$LIBSTDCXX_PATH" ]; then
    LIBSTDCXX_DIR=$(dirname "$LIBSTDCXX_PATH")
    export LD_LIBRARY_PATH="$LIBSTDCXX_DIR:$LD_LIBRARY_PATH"
    echo "Added C++ lib directory to LD_LIBRARY_PATH: $LIBSTDCXX_DIR"
else
    echo "WARNING: libstdc++.so.6 not found in /nix/store"
fi

echo "===== Activating Python virtual environment ====="
source /tmp/venv/bin/activate

# Ensure sitecustomize.py is in Python's path and will be loaded
# Copy it to the venv's site-packages so Python loads it automatically
cp sitecustomize.py /tmp/venv/lib/python3.11/site-packages/
echo "Copied sitecustomize.py to venv site-packages"

echo "===== Starting Python proxy on http://127.0.0.1:8000 ====="
python proxy/run_proxy.py > /tmp/proxy.log 2>&1 &
PROXY_PID=$!
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
