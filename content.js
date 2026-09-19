// AdVanish for Pinterest — content script
// Step 1: masonry fix. Turn Pinterest's absolutely-positioned grid items
// into normal in-flow content inside a native CSS multi-column list, via a
// pure CSS override (no DOM/attribute mutation — this is what makes it
// safe: React's own bookkeeping never sees anything change).

(() => {
  'use strict';

  function applyMasonryFix() {
    const style = document.createElement('style');
    style.id = 'parp-masonry-style';
    style.textContent = `
      [role="list"] {
        column-count: 4;
        column-gap: 16px;
      }

      [role="listitem"][data-grid-item="true"] {
        position: relative !important;
        top: inherit !important;
        left: inherit !important;
        transform: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  applyMasonryFix();
})();
