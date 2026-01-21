#!/usr/bin/env node

/**
 * Build script for Claim Auto-Fill Extension
 * Copies files from src/ to dist/ for distribution
 */

const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const distDir = path.join(__dirname, 'dist');

// Clean dist directory
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
  console.log('✓ Cleaned dist directory');
}

// Create dist directory
fs.mkdirSync(distDir, { recursive: true });

// Copy directory recursively
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Copy all files from src to dist
console.log('Building extension...');
copyDir(srcDir, distDir);

console.log('✓ Build complete!');
console.log(`✓ Extension ready in: ${distDir}`);
console.log('\nTo load the extension:');
console.log('1. Open chrome://extensions/');
console.log('2. Enable "Developer mode"');
console.log('3. Click "Load unpacked"');
console.log('4. Select the "dist" folder');
