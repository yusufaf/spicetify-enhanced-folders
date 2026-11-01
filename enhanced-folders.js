// NAME: Enhanced Folders
// AUTHOR: yusufaf
// DESCRIPTION: Add custom images and descriptions to Spotify playlist folders.
//
// Enhanced Folders moved to https://github.com/yusufaf/spicetify-extensions/tree/main/extensions/enhanced-folders
// This file only loads it from there, so installs from this repository keep updating.
// Install it from the new location to stop depending on this redirect.

(function () {
  if (window.__enhancedFoldersActive) return;
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/gh/yusufaf/spicetify-extensions@main/extensions/enhanced-folders/enhanced-folders.js';
  script.onerror = () => console.error('[Enhanced Folders] Could not load the extension from https://cdn.jsdelivr.net/gh/yusufaf/spicetify-extensions@main/extensions/enhanced-folders/enhanced-folders.js');
  document.head.appendChild(script);
})();
