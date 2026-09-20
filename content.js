// AdVanish for Pinterest — content script
//
// Rebuild #2 of the masonry piece. CSS multi-column layout (column-fill:
// balance or auto) hands placement decisions to the browser's own
// algorithm, and neither mode has "never move a pin that's already placed"
// as a rule — that's why pins kept visibly reshuffling no matter how much
// we compensated around it (scroll-anchor tracking, a tracked/growing
// column height). That limitation is structural, not something CSS config
// can fix.
//
// This version computes placement ourselves: real append-only masonry.
// Each pin is placed into whichever column is currently shortest, exactly
// once, and never repositioned again — a new pin can only ever affect
// where FUTURE pins go, never pins already on screen. That's the same
// first principle a real competing extension's JS-computed grid uses
// (researched from its own installed files to understand the approach,
// reimplemented independently here — see commit history), just applied to
// the same real Pinterest DOM nodes directly instead of mirroring pins
// into a separate overlay (which is what made an earlier attempt at this
// unreliable — mirroring is synchronization surface that doesn't need to
// exist).
//
// Placement values are written to CSS custom properties (--parp-x/-y/-w),
// read by an !important stylesheet rule — not directly as top/left/width.
// If Pinterest's own code ever re-touches that element's style (e.g. on
// its own resize recalculation), it won't touch our custom properties, so
// our placement survives regardless.

(() => {
  'use strict';

  const COLUMN_COUNT = 4;
  const GAP = 16;
  const GRID_ITEM_SELECTOR = '[role="listitem"][data-grid-item="true"]';
  const GRID_CONTAINER_SELECTOR = '[role="list"]:has([data-grid-item="true"])';

  function applyMasonryStyles() {
    const style = document.createElement('style');
    style.id = 'parp-masonry-style';
    style.textContent = `
      ${GRID_CONTAINER_SELECTOR} {
        position: relative !important;
        height: var(--parp-container-height, auto) !important;
      }

      ${GRID_ITEM_SELECTOR} {
        position: absolute !important;
        top: var(--parp-y, 0px) !important;
        left: var(--parp-x, 0px) !important;
        width: var(--parp-w, auto) !important;
        transform: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  let columnHeights = null;
  let columnWidth = 0;
  let container = null;
  const placed = new WeakSet();

  function initColumns() {
    container = document.querySelector(GRID_CONTAINER_SELECTOR);
    if (!container) return false;

    const containerWidth = container.getBoundingClientRect().width;
    if (!containerWidth) return false;

    columnWidth = (containerWidth - GAP * (COLUMN_COUNT - 1)) / COLUMN_COUNT;
    columnHeights = new Array(COLUMN_COUNT).fill(0);
    return true;
  }

  // Pinterest computes and sets each pin's final height itself, from pin
  // metadata (aspect ratio), before the image finishes loading — it's
  // already present as an inline style as soon as the item exists in the
  // DOM, not something that changes later as the image loads in. Reading
  // it directly means we place each pin correctly on the first pass, with
  // no need to re-measure or adjust after the fact.
  function getItemHeight(item) {
    return parseFloat(item.style.height) || item.getBoundingClientRect().height || 300;
  }

  function placeItem(item) {
    if (placed.has(item)) return;
    placed.add(item);

    const height = getItemHeight(item);

    let shortestCol = 0;
    for (let i = 1; i < columnHeights.length; i++) {
      if (columnHeights[i] < columnHeights[shortestCol]) shortestCol = i;
    }

    const x = shortestCol * (columnWidth + GAP);
    const y = columnHeights[shortestCol];

    item.style.setProperty('--parp-x', `${x}px`);
    item.style.setProperty('--parp-y', `${y}px`);
    item.style.setProperty('--parp-w', `${columnWidth}px`);

    columnHeights[shortestCol] += height + GAP;
  }

  function placeAllUnplaced() {
    if (!container && !initColumns()) return;

    const items = container.querySelectorAll(GRID_ITEM_SELECTOR);
    items.forEach(placeItem);

    if (columnHeights) {
      container.style.setProperty('--parp-container-height', `${Math.max(...columnHeights)}px`);
    }
  }

  function startMasonry() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', startMasonry, { once: true });
      return;
    }

    placeAllUnplaced();

    const observer = new MutationObserver((mutations) => {
      const addedGridItem = mutations.some((m) =>
        Array.from(m.addedNodes).some(
          (node) => node.nodeType === 1 && (node.matches?.(GRID_ITEM_SELECTOR) || node.querySelector?.(GRID_ITEM_SELECTOR))
        )
      );
      if (addedGridItem) placeAllUnplaced();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  applyMasonryStyles();
  startMasonry();
})();
