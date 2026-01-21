# Claim Amount Auto-Fill Chrome Extension

A Chrome extension that automatically fills approved amount fields with corresponding claim amounts, eliminating the need for repetitive copy-pasting.

## Features

- **Automatic Detection**: Intelligently identifies claim amount and approved amount field pairs
- **Auto-Fill**: Automatically fills empty approved amounts with claim amounts
- **Manual Control**: Toggle auto-fill on/off and trigger manual fills
- **Real-time Updates**: Works with dynamically loaded content
- **Smart Matching**: Uses multiple strategies to find field pairs:
  - Name/ID attribute matching
  - Table structure analysis
  - Placeholder text recognition

## Installation

### Method 1: Install from Chrome Web Store (Coming Soon)
Once published, you'll be able to install directly from the Chrome Web Store.

### Method 2: Load as Unpacked Extension (For Development/Testing)

1. **Download the Extension**
   - Download or clone this repository to your computer
   - Make sure all files are in the `claim-autofill-extension` folder

2. **Add Icons (Optional but Recommended)**
   - Add icon files to the `icons` folder:
     - `icon16.png` (16x16 pixels)
     - `icon48.png` (48x48 pixels)
     - `icon128.png` (128x128 pixels)
   - You can use online icon generators or create custom icons
   - The extension will work without custom icons (Chrome will use defaults)

3. **Open Chrome Extensions Page**
   - Open Google Chrome
   - Navigate to `chrome://extensions/`
   - Or click the three-dot menu → More Tools → Extensions

4. **Enable Developer Mode**
   - Toggle the "Developer mode" switch in the top-right corner

5. **Load the Extension**
   - Click "Load unpacked" button
   - Navigate to and select the `claim-autofill-extension` folder
   - Click "Select Folder"

6. **Verify Installation**
   - The extension should now appear in your extensions list
   - Pin the extension to your toolbar for easy access

## Usage

### Basic Usage

1. **Navigate to Your Claim Form**
   - Open any webpage with claim and approved amount fields

2. **Automatic Filling**
   - By default, the extension automatically fills empty approved amounts
   - Works on page load and when new fields appear

3. **Manual Control**
   - Click the extension icon in your toolbar
   - Use the toggle to enable/disable auto-fill
   - Click "Fill Now" to manually trigger filling

### How It Works

The extension looks for field pairs by analyzing:
- Input field names and IDs containing "claim" or "approved"
- Table structures with claim and approved columns
- Placeholder text and labels

When a claim amount field has a value and its corresponding approved amount field is empty, the extension copies the claim amount to the approved field.

## Supported Field Patterns

The extension recognizes fields with these naming patterns:
- Claim fields: `claim_amount`, `claimAmount`, `claim`, etc.
- Approved fields: `approved_amount`, `approvedAmount`, `sanctioned_amount`, etc.

### Examples:
```html
<!-- Pattern 1: Name attributes -->
<input name="claim_amount" value="1000">
<input name="approved_amount" value="">

<!-- Pattern 2: ID attributes -->
<input id="claimAmt" value="2000">
<input id="approvedAmt" value="">

<!-- Pattern 3: Table structure -->
<table>
  <tr>
    <td>Claim Amount: <input type="text" value="1500"></td>
    <td>Approved Amount: <input type="text" value=""></td>
  </tr>
</table>
```

## Troubleshooting

### Extension Not Working?

1. **Refresh the Page**
   - After installing or updating the extension, refresh the webpage
   - Press `Ctrl+R` (Windows/Linux) or `Cmd+R` (Mac)

2. **Check Extension Status**
   - Click the extension icon
   - Verify that "Auto-fill enabled" toggle is ON

3. **Verify Field Names**
   - The extension works best with standard naming conventions
   - Fields should contain keywords like "claim", "approved", "sanctioned"

4. **Manual Fill**
   - Try clicking "Fill Now" button to manually trigger filling
   - Check the status message for results

5. **Console Logs**
   - Open Developer Tools (F12)
   - Check Console tab for any error messages
   - Look for "Auto-filled X approved amount(s)" messages

### Extension Icon Not Showing?

- Pin the extension: Click the puzzle piece icon in Chrome toolbar → Find "Claim Amount Auto-Fill" → Click the pin icon

## Customization

### Modify Field Detection

Edit `content.js` to customize how fields are detected:

```javascript
// Add custom field patterns in findAmountPairs() function
if (name.includes('your_custom_keyword') || id.includes('your_custom_keyword')) {
  // Custom logic here
}
```

### Change Auto-Fill Behavior

Adjust the `fillApprovedAmount()` function to modify filling logic:

```javascript
// Example: Always fill even if approved field has a value
if (claimValue) {  // Remove the check for empty approved field
  approvedInput.value = claimValue;
  return true;
}
```

## Privacy & Security

- **No Data Collection**: This extension does not collect, store, or transmit any data
- **Local Processing**: All operations happen locally in your browser
- **No External Servers**: No communication with external servers
- **Open Source**: Code is fully visible and auditable

## Browser Compatibility

- **Chrome**: Version 88 or higher (Manifest V3 support)
- **Edge**: Version 88 or higher (Chromium-based)
- **Brave**: Latest version
- **Opera**: Latest version

## Development

### File Structure
```
claim-autofill-extension/
├── manifest.json       # Extension configuration
├── content.js         # Main logic for auto-filling
├── popup.html         # Extension popup interface
├── popup.js          # Popup functionality
├── popup.css         # Popup styling
├── icons/            # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md         # This file
```

### Technologies Used
- Manifest V3 (latest Chrome extension format)
- Vanilla JavaScript (no external dependencies)
- Chrome Extension APIs (storage, messaging, tabs)

## Contributing

Contributions are welcome! Feel free to:
- Report bugs
- Suggest new features
- Submit pull requests
- Improve documentation

## License

MIT License - feel free to use and modify as needed.

## Support

If you encounter any issues or have questions:
1. Check the Troubleshooting section above
2. Review the console logs for error messages
3. Open an issue on the project repository

## Version History

### v1.0.0 (Current)
- Initial release
- Automatic claim to approved amount filling
- Toggle on/off functionality
- Manual fill trigger
- Table structure support
- Real-time DOM observation

## Roadmap

Future enhancements:
- [ ] Custom field mapping configuration
- [ ] Multiple page template presets
- [ ] Keyboard shortcuts
- [ ] Fill history/undo functionality
- [ ] Export/import settings
- [ ] Support for more complex form structures
