# Force Chrome to Reload Extension

Chrome is caching the old JavaScript file. Follow these steps:

## Method 1: Hard Reload
1. Go to `chrome://extensions/`
2. Find "Claim Amount Auto-Fill"
3. Click the **REMOVE** button
4. Click "Load unpacked"
5. Select `c:\Users\wgshx\claim-autofill-extension\dist`
6. Go to the government page
7. Press **Ctrl+Shift+R** (hard reload) to clear page cache
8. Check console

## Method 2: Disable Cache
1. On the government page, open DevTools (F12)
2. Go to **Network** tab
3. Check "**Disable cache**" checkbox
4. Keep DevTools OPEN
5. Refresh the page
6. Check console

## Method 3: Clear All Cache
1. Press Ctrl+Shift+Delete
2. Select "Cached images and files"
3. Click "Clear data"
4. Go to `chrome://extensions/`
5. Click reload on the extension
6. Refresh government page

## What You Should See

After properly reloading, console should show:
```
[Claim Auto-Fill] Strategy 2: Found 32 total input fields on page
[Claim Auto-Fill] All input fields:
  1. name="", id="validationrequired", value="1"
  2. name="", id="", value="AASTHA HOSPITAL"
  ... (all 32 inputs)
[Claim Auto-Fill] Strategy 4: Trying packageAmount/packageFinalAmount pattern
[Claim Auto-Fill] Found claim input: packageAmount_X
[Claim Auto-Fill] Found approved input: packageFinalAmount_X
```

If you DON'T see "Strategy 4", Chrome is still using cached files.
