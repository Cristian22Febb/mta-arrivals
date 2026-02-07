# MTA Arrivals

Realtime NYC subway arrivals for any station and route using the official MTA GTFS-Realtime feeds.

## Setup

1. Open a terminal in `backend/` and install dependencies:
   ```
   npm install
   ```
1. Open a terminal in `proxy/` and install the proxy dependencies:
   ```
   pip install -r requirements.txt
   ```
2. Set the MTA API key (required for GTFS-Realtime feeds):
   - PowerShell:
     ```
     $env:MTA_API_KEY="your_api_key_here"
     ```
   - Command Prompt:
     ```
     set MTA_API_KEY=your_api_key_here
     ```
3. Start the backend:
   ```
   node server.js
   ```
   On first run, the backend downloads the GTFS static zip and extracts `stops.txt`, `routes.txt`, `trips.txt`, and `stop_times.txt` into `backend/gtfs/`.
4. Open `http://localhost:3001` in your browser.

### Optional: Use a local proxy instead of an API key

If you run a local proxy like `nyctrains`, you can set:

```
$env:GTFS_PROXY_BASE="http://localhost:8000"
$env:GTFS_PROXY_MODE="nyctrains"
```

Then start the backend and it will pull data from `/subway/{feed}/json` without using `MTA_API_KEY`.

### One command (PowerShell)

If you want a single command that starts the Python proxy and the Node backend:

```
.\start.ps1
```

## Notes

- The frontend calls `http://localhost:3001` for station and arrival data.
- Arrivals auto-refresh every 30 seconds once a station is selected.
- If arrivals fail with a 403 "Missing Authentication Token", the API key is not set.
- If `GTFS_PROXY_BASE` is set, the backend uses the proxy and does not require `MTA_API_KEY`.
