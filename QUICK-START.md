# Quick Start Guide

## Extension Rebuilt with Proper Structure! ✅

Your extension has been reorganized into a professional structure:

```
📁 claim-autofill-extension/
├── 📁 src/          ← Edit files here
│   ├── 📁 content/
│   ├── 📁 popup/
│   ├── 📁 assets/
│   └── manifest.json
├── 📁 dist/         ← Load this in Chrome
└── build.js         ← Build script
```

## Load the Extension

### Step 1: Build (if not done already)
```bash
node build.js
```

### Step 2: Load in Chrome
1. Go to `chrome://extensions/`
2. Remove the old extension (if loaded)
3. Enable "Developer mode" (toggle in top-right)
4. Click "Load unpacked"
5. Navigate to and select: `c:\Users\wgshx\claim-autofill-extension\dist`

### Step 3: Test
Open [test-page.html](test-page.html) or the Rajasthan Government Health website.

## Making Changes

1. Edit files in `src/` folder
2. Run `node build.js` to rebuild
3. Click reload icon on extension in `chrome://extensions/`
4. Refresh your test page

## Current Status

✅ Project restructured
✅ Build system created
✅ Extension built to `dist/`
⏳ Ready for testing

## Known Issue to Fix

The extension detects columns correctly but needs debugging for input field detection.

Check console (F12) for detailed logs showing:
- Tables found
- Columns detected (Claim: 4, Approved: 5)
- Row processing details

## Next Steps

1. Load the rebuilt extension from `dist/` folder
2. Test on test-page.html
3. Check console for detailed debug logs
4. Report any issues for further debugging
