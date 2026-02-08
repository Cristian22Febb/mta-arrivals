# Use official Python image with all system libraries
FROM python:3.11-slim

# Install Node.js
RUN apt-get update && apt-get install -y \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy everything
COPY . .

# Install dependencies
RUN npm install
RUN pip install -r proxy/requirements.txt

# Set environment variables
ENV GTFS_PROXY_BASE="http://127.0.0.1:8000"
ENV GTFS_PROXY_MODE="nyctrains"
ENV PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION="python"
ENV PROTOBUF_FORCE_PYTHON="1"
ENV PYTHONPATH="/app"
ENV NYCTRAINS_RESOURCE_DIR="/app/backend/gtfs"

# Copy sitecustomize to Python's site-packages
RUN cp sitecustomize.py $(python -c "import site; print(site.getsitepackages()[0])")/

# Start script
CMD ["bash", "start.sh"]
