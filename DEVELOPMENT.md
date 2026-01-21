# Development Guide

## Project Structure

```
claim-autofill-extension/
├── dist/                      # Build output (load this in Chrome)
├── src/                       # Source code
│   ├── assets/               # Static assets
│   │   └── icons/           # Extension icons (16x16, 48x48, 128x128)
│   ├── content/             # Content scripts (injected into web pages)
│   │   └── autofill.js     # Main autofill logic
│   ├── popup/              # Browser action popup
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   ├── utils/              # Shared utility functions (future use)
│   └── manifest.json       # Extension configuration
├── build.js                # Build script
├── package.json            # Project metadata
└── test-page.html         # Test page for development
```

## Development Workflow

### 1. Make changes in the `src/` directory

All source files are in the `src/` folder:
- Edit `src/content/autofill.js` for autofill logic
- Edit `src/popup/` files for popup UI
- Edit `src/manifest.json` for extension configuration

### 2. Build the extension

```bash
npm run build
```

This copies all files from `src/` to `dist/`.

### 3. Load the extension in Chrome

1. Open `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `dist/` folder

### 4. Test your changes

- After making changes, run `npm run build` again
- Click the reload button on the extension in `chrome://extensions/`
- Refresh the test page or target website

### 5. Watch mode (optional)

For automatic rebuilding on file changes:

```bash
# First install dependencies
npm install

# Then run watch mode
npm run watch
```

This will automatically rebuild whenever you save changes to files in `src/`.

## Testing

### Test Page

Open `test-page.html` in your browser to test the extension with sample data.

### Real Website

Test on the Rajasthan Government Health website or any page with:
- Tables containing "Claim Amount" and "Approved Amount" columns
- Input fields for claim and approved amounts

### Debug Logging

Open the browser console (F12) to see detailed debug messages:
- Table detection
- Column identification
- Row processing
- Input field matching

## Building for Distribution

When ready to distribute:

1. Run `npm run build`
2. The `dist/` folder contains the complete extension
3. Zip the `dist/` folder for upload to Chrome Web Store

## File Descriptions

### src/content/autofill.js
- Main content script injected into web pages
- Detects claim/approved field pairs
- Automatically fills approved amounts with claim amounts
- Three detection strategies:
  1. Table column headers
  2. Name/ID attributes
  3. Inline table structure

### src/popup/
- Popup UI shown when clicking the extension icon
- Toggle auto-fill on/off
- Manual "Fill Now" button
- Status messages

### build.js
- Simple Node.js script that copies `src/` to `dist/`
- No bundling or transpilation needed for this extension
