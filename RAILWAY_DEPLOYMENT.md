# Deploy to Railway.app

## Step 1: Create a GitHub Repository

1. Go to https://github.com and sign in (or create an account)
2. Click the "+" icon → "New repository"
3. Name it: `mta-arrivals`
4. Make it **Private** (to protect your API key)
5. Click "Create repository"

## Step 2: Push Your Code to GitHub

Open a terminal in `c:\Users\HP\Desktop\mta arrivals` and run:

```powershell
git init
git add .
git commit -m "Initial commit - MTA arrivals backend"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/mta-arrivals.git
git push -u origin main
```

(Replace `YOUR_USERNAME` with your GitHub username)

## Step 3: Deploy to Railway

1. Go to https://railway.app
2. Click "Start a New Project"
3. Sign in with GitHub
4. Click "Deploy from GitHub repo"
5. Select your `mta-arrivals` repository
6. Railway will automatically detect and deploy!

## Step 4: Add Environment Variable

1. In Railway dashboard, click on your deployed service
2. Go to the "Variables" tab
3. Click "Add Variable"
4. Add:
   - **Variable**: `MTA_API_KEY`
   - **Value**: Your MTA API key from https://api.mta.info/#/signup

5. Click "Add" - Railway will automatically redeploy

## Step 5: Get Your Railway URL

1. In Railway dashboard, click "Settings" tab
2. Scroll to "Domains"
3. Click "Generate Domain"
4. Copy the URL (e.g., `https://your-app.railway.app`)

## Step 6: Update ESP32 Code

You'll need to update one line in your ESP32 code to use the Railway URL instead of localhost.

**File**: `esp32-crowpanel/src/main.cpp`

Find the line with `kBackendBase` (around line 36) and change it to:

```cpp
const char *kBackendBase = "https://your-app.railway.app";  // Replace with your Railway URL
```

Then re-upload to ESP32!

## Monitoring

- Railway dashboard shows logs, metrics, and usage
- Free $5 trial credits, then ~$5-10/month
- Your app will always be online (no spin-down)

## Troubleshooting

**If deployment fails:**
- Check the build logs in Railway dashboard
- Make sure `MTA_API_KEY` is set in Variables
- Verify your GitHub repo has all the files

**If ESP32 can't connect:**
- Make sure you're using `https://` (not `http://`)
- Check that the Railway domain is correct
- Check Railway logs for errors
