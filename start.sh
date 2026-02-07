#!/bin/bash

# Railway startup script - runs Python proxy and Node backend

set -e

export GTFS_PROXY_BASE="http://127.0.0.1:8000"
export GTFS_PROXY_MODE="nyctrains"
export PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION="python"
export PROTOBUF_FORCE_PYTHON="1"
export PYTHONPATH="$(pwd):$PYTHONPATH"

echo "Installing Python dependencies..."
pip install -r proxy/requirements.txt

echo "Starting Python proxy on http://127.0.0.1:8000 in background..."
cd "$(pwd)"
python proxy/run_proxy.py &
PROXY_PID=$!

echo "Waiting for proxy to be ready..."
for i in {1..30}; do
  if curl -s http://127.0.0.1:8000/subway/bdfm/json > /dev/null 2>&1; then
    echo "Proxy is ready!"
    break
  fi
  echo "Waiting for proxy... ($i/30)"
  sleep 1
done

echo "Starting Node backend on port ${PORT:-3001}..."
node backend/server.js

# Cleanup proxy on exit
kill $PROXY_PID 2>/dev/null || true
