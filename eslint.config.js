'use strict';

const js = require('@eslint/js');

const browserGlobals = {
  chrome: 'readonly',
  window: 'readonly',
  document: 'readonly',
  location: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  URL: 'readonly',
  Blob: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  MutationObserver: 'readonly',
  Node: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLTextAreaElement: 'readonly',
  sessionStorage: 'readonly',
  navigator: 'readonly',
  crypto: 'readonly',
  fetch: 'readonly',
  FormData: 'readonly',
  URLSearchParams: 'readonly',
  importScripts: 'readonly'
};

const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  crypto: 'readonly'
};

module.exports = [
  {
    // Generated data and build output are not linted.
    ignores: [
      'audit-rules.js',
      'dist/**',
      'hosting-build/**',
      'node_modules/**',
      '.tools/**',
      'privacy-site/**',
      'functions/node_modules/**'
    ]
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs'
    },
    rules: {
      // Correctness only - no style bikeshedding; hooks/CI keep this fast.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart']
    }
  },
  {
    files: [
      'content.js', 'popup.js', 'options.js', 'background.js',
      'floating-widget.js', 'claim-core.js', 'audit-core.js', 'auth-core.js', 'review-core.js',
      'scripts/live-browser-smoke.js', 'hosting/**/*.js'
    ],
    languageOptions: { globals: browserGlobals }
  },
  {
    files: [
      'build.js',
      'tools/check-no-secrets.js',
      'tools/bootstrap-production-admin.js',
      'scripts/release.js',
      'scripts/hosting-smoke.js',
      'tests/**/*.js',
      'functions/**/*.js',
      'eslint.config.js'
    ],
    languageOptions: { globals: nodeGlobals }
  }
];
