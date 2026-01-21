// Content script for auto-filling approved amounts with claim amounts

let isAutoFillEnabled = true;
let observer = null;

// Load settings from storage
chrome.storage.sync.get(['autoFillEnabled'], (result) => {
  isAutoFillEnabled = result.autoFillEnabled !== false; // Default to true
  if (isAutoFillEnabled) {
    startObserving();
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'toggleAutoFill') {
    isAutoFillEnabled = request.enabled;
    if (isAutoFillEnabled) {
      startObserving();
      fillAllApprovedAmounts();
    } else {
      stopObserving();
    }
    sendResponse({ success: true });
  } else if (request.action === 'fillNow') {
    const count = fillAllApprovedAmounts();
    sendResponse({ success: true, count: count });
  } else if (request.action === 'getStatus') {
    sendResponse({ enabled: isAutoFillEnabled });
  }
  return true;
});

// Function to find claim and approved amount field pairs
function findAmountPairs() {
  const pairs = [];

  // Strategy 1: Find by column headers (most reliable for tabular data)
  const tables = document.querySelectorAll('table');
  console.log(`[Claim Auto-Fill] Found ${tables.length} tables on page`);

  tables.forEach((table, tableIndex) => {
    // Find header row and identify column indices
    const headerRows = table.querySelectorAll('thead tr, tr');
    let claimColumnIndex = -1;
    let approvedColumnIndex = -1;

    console.log(`[Claim Auto-Fill] Table ${tableIndex + 1}: Found ${headerRows.length} potential header rows`);

    // Search for header row with "Claim Amount" and "Approved Amount"
    for (let headerRow of headerRows) {
      const headers = headerRow.querySelectorAll('th, td');
      console.log(`[Claim Auto-Fill] Table ${tableIndex + 1}: Checking row with ${headers.length} headers`);

      headers.forEach((header, index) => {
        const text = header.textContent.toLowerCase().trim();
        // Remove parentheses and their content for easier matching
        const cleanText = text.replace(/\([^)]*\)/g, '').trim();

        console.log(`[Claim Auto-Fill] Header ${index}: "${text}" (clean: "${cleanText}")`);

        // Match "Claim Amount" or similar (with or without Rs., parentheses, etc.)
        if ((text.includes('claim') && text.includes('amount')) ||
            (cleanText.includes('claim') && cleanText.includes('amount')) ||
            text.match(/claim.*amount/i)) {
          claimColumnIndex = index;
          console.log(`[Claim Auto-Fill] ✓ Found Claim column at index ${index}`);
        }

        // Match "Approved Amount" or similar (with or without Rs., parentheses, etc.)
        if ((text.includes('approved') && text.includes('amount')) ||
            (cleanText.includes('approved') && cleanText.includes('amount')) ||
            text.match(/approved.*amount/i) ||
            text.match(/sanctioned.*amount/i)) {
          approvedColumnIndex = index;
          console.log(`[Claim Auto-Fill] ✓ Found Approved column at index ${index}`);
        }
      });

      // If we found both columns, stop searching
      if (claimColumnIndex !== -1 && approvedColumnIndex !== -1) {
        console.log(`[Claim Auto-Fill] ✓ Found both columns - Claim: ${claimColumnIndex}, Approved: ${approvedColumnIndex}`);
        break;
      }
    }

    // If we found column headers, process data rows
    if (claimColumnIndex !== -1 && approvedColumnIndex !== -1) {
      console.log(`[Claim Auto-Fill] Found columns - Claim: ${claimColumnIndex}, Approved: ${approvedColumnIndex}`);
      const dataRows = table.querySelectorAll('tbody tr, tr');
      console.log(`[Claim Auto-Fill] Found ${dataRows.length} data rows to process`);

      dataRows.forEach((row, rowIndex) => {
        const cells = row.querySelectorAll('td, th');
        console.log(`[Claim Auto-Fill] Row ${rowIndex + 1}: Has ${cells.length} cells`);

        // Make sure this row has enough cells
        if (cells.length > Math.max(claimColumnIndex, approvedColumnIndex)) {
          const claimCell = cells[claimColumnIndex];
          const approvedCell = cells[approvedColumnIndex];

          // Find inputs in these cells
          const claimInput = claimCell ? claimCell.querySelector('input[type="text"], input[type="number"], input:not([type])') : null;
          const approvedInput = approvedCell ? approvedCell.querySelector('input[type="text"], input[type="number"], input:not([type])') : null;

          console.log(`[Claim Auto-Fill] Row ${rowIndex + 1}: Claim input=${!!claimInput}, Approved input=${!!approvedInput}`);

          if (claimInput && approvedInput && claimInput !== approvedInput) {
            pairs.push({ claim: claimInput, approved: approvedInput });
            console.log(`[Claim Auto-Fill] ✓ Added pair from row ${rowIndex + 1}`);
          }
        } else {
          console.log(`[Claim Auto-Fill] Row ${rowIndex + 1}: Not enough cells (need > ${Math.max(claimColumnIndex, approvedColumnIndex)})`);
        }
      });
    }
  });

  // Strategy 2: Find by common patterns in name/id attributes (fallback)
  if (pairs.length === 0) {
    const inputs = document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');

    inputs.forEach(input => {
      const name = (input.name || '').toLowerCase();
      const id = (input.id || '').toLowerCase();
      const placeholder = (input.placeholder || '').toLowerCase();

      // Check if this is a claim amount field
      if (name.includes('claim') || id.includes('claim') || placeholder.includes('claim')) {
        // Try to find corresponding approved amount field
        const approvedField = findCorrespondingApprovedField(input);
        if (approvedField) {
          pairs.push({ claim: input, approved: approvedField });
        }
      }
    });
  }

  // Strategy 3: Find by inline table structure (same row)
  if (pairs.length === 0) {
    const tables = document.querySelectorAll('table');
    tables.forEach(table => {
      const rows = table.querySelectorAll('tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td, th');
        let claimInput = null;
        let approvedInput = null;

        cells.forEach(cell => {
          const text = cell.textContent.toLowerCase();
          const input = cell.querySelector('input[type="text"], input[type="number"], input:not([type])');

          if (input) {
            if (text.includes('claim') && !text.includes('approved')) {
              claimInput = input;
            } else if (text.includes('approved') || text.includes('sanctioned')) {
              approvedInput = input;
            }
          }
        });

        if (claimInput && approvedInput) {
          pairs.push({ claim: claimInput, approved: approvedInput });
        }
      });
    });
  }

  return pairs;
}

// Find corresponding approved amount field for a claim field
function findCorrespondingApprovedField(claimInput) {
  const parent = claimInput.closest('tr, div, form, fieldset');
  if (!parent) return null;

  const inputs = parent.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');

  for (let input of inputs) {
    if (input === claimInput) continue;

    const name = (input.name || '').toLowerCase();
    const id = (input.id || '').toLowerCase();
    const placeholder = (input.placeholder || '').toLowerCase();

    if (name.includes('approved') || name.includes('sanctioned') ||
        id.includes('approved') || id.includes('sanctioned') ||
        placeholder.includes('approved') || placeholder.includes('sanctioned')) {
      return input;
    }
  }

  return null;
}

// Fill approved amount with claim amount
function fillApprovedAmount(claimInput, approvedInput) {
  const claimValue = claimInput.value.trim();
  const approvedValue = approvedInput.value.trim();

  // Only fill if claim has a value and approved is empty or "0"
  // Treat "0" as empty since it's often a placeholder
  if (claimValue && (!approvedValue || approvedValue === '0')) {
    approvedInput.value = claimValue;

    // Focus the input first to ensure proper event handling
    approvedInput.focus();

    // Trigger events to ensure the page recognizes the change
    approvedInput.dispatchEvent(new Event('input', { bubbles: true }));
    approvedInput.dispatchEvent(new Event('change', { bubbles: true }));
    approvedInput.dispatchEvent(new Event('keyup', { bubbles: true }));
    approvedInput.dispatchEvent(new Event('blur', { bubbles: true }));

    // Blur to move focus away
    approvedInput.blur();

    return true;
  }

  return false;
}

// Fill all approved amounts on the page
function fillAllApprovedAmounts() {
  if (!isAutoFillEnabled) return 0;

  console.log('[Claim Auto-Fill] Starting auto-fill process...');

  const pairs = findAmountPairs();
  console.log(`[Claim Auto-Fill] Found ${pairs.length} claim/approved field pairs`);

  let count = 0;

  pairs.forEach((pair, index) => {
    const claimValue = pair.claim.value;
    const approvedValue = pair.approved.value;
    console.log(`[Claim Auto-Fill] Pair ${index + 1}: Claim="${claimValue}", Approved="${approvedValue}"`);

    if (fillApprovedAmount(pair.claim, pair.approved)) {
      count++;
      console.log(`[Claim Auto-Fill] ✓ Filled pair ${index + 1} with value: ${claimValue}`);
    }
  });

  if (count > 0) {
    console.log(`[Claim Auto-Fill] ✓ Successfully auto-filled ${count} approved amount(s)`);
  } else if (pairs.length > 0) {
    console.log('[Claim Auto-Fill] No fields were filled (all already have values)');
  } else {
    console.log('[Claim Auto-Fill] No claim/approved field pairs found on this page');
  }

  return count;
}

// Start observing DOM changes
function startObserving() {
  if (observer) return;

  observer = new MutationObserver((mutations) => {
    // Debounce the filling to avoid excessive operations
    clearTimeout(window.autoFillTimeout);
    window.autoFillTimeout = setTimeout(() => {
      fillAllApprovedAmounts();
    }, 500);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Initial fill
  fillAllApprovedAmounts();
}

// Stop observing DOM changes
function stopObserving() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

// Start when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    // Wait a bit for dynamic content to load
    setTimeout(() => {
      if (isAutoFillEnabled) {
        fillAllApprovedAmounts();
      }
    }, 1000);
  });
} else {
  // Page already loaded, wait a bit then fill
  setTimeout(() => {
    if (isAutoFillEnabled) {
      fillAllApprovedAmounts();
    }
  }, 1000);
}
