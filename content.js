// AdVanish for Pinterest — content script
// Step 1: masonry fix. Turn Pinterest's absolutely-positioned grid items
// into normal in-flow content inside a native CSS multi-column list, via a
// pure CSS override (no DOM/attribute mutation — this is what makes it
// safe: React's own bookkeeping never sees anything change).
//
// Step 2: append-only column filling. column-fill defaults to "balance",
// which doesn't just append new pins to whichever column is shortest — it
// recomputes which column EVERY pin belongs to, each time content changes,
// to keep all columns equal height. That reshuffles pins that were already
// placed, not just the new ones, which is what caused pins to visibly jump
// between columns on every scroll-load. column-fill:auto fills columns
// strictly in DOM order instead (append-only — a new pin can only ever
// affect the end of the last column), but it only works with an explicit
// height on the container, which we compute and keep growing ourselves as
// content loads (see updateColumnHeight below).
//
// Step 3: scroll-anchor compensation, for whatever residual shift remains
// (e.g. right at a column boundary when the tracked height grows). Track a
// pin near the bottom of the viewport as an "anchor" (researched from a
// real competing extension's installed files to understand the technique,
// reimplemented here independently — see commit history), and after
// content/height changes, re-locate that same pin and adjust scroll
// position so it lands back exactly where it was.

(() => {
  'use strict';

  const COLUMN_COUNT = 4;
  const COLUMN_GAP = 16;

  function applyMasonryFix() {
    const style = document.createElement('style');
    style.id = 'parp-masonry-style';
    style.textContent = `
      [role="list"]:has([data-grid-item="true"]) {
        column-count: ${COLUMN_COUNT};
        column-gap: ${COLUMN_GAP}px;
        column-fill: auto;
        height: var(--parp-col-height, auto);
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

  // column-fill:auto needs an explicit height to know where to break into
  // the next column — without one it just dumps everything in column 1.
  // We approximate "how tall would this be as one column" by summing every
  // item's own height (regardless of which column it's currently
  // rendered in — that doesn't matter for this sum) and dividing by the
  // column count.
  //
  // Only ever grows, never shrinks: this feed only adds content, never
  // removes it, and shrinking the height would force column-fill:auto to
  // reassign items backwards into earlier columns — exactly the kind of
  // reshuffle we're trying to eliminate.
  function updateColumnHeight() {
    const container = document.querySelector(GRID_CONTAINER_SELECTOR);
    if (!container) return;

    const items = container.querySelectorAll(GRID_ITEM_SELECTOR);
    if (!items.length) return;

    let totalHeight = 0;
    items.forEach((item) => {
      totalHeight += item.getBoundingClientRect().height + COLUMN_GAP;
    });

    const targetHeight = Math.ceil(totalHeight / COLUMN_COUNT) + COLUMN_GAP;
    const current = parseFloat(container.style.getPropertyValue('--parp-col-height')) || 0;

    if (targetHeight > current) {
      container.style.setProperty('--parp-col-height', `${targetHeight}px`);
    }
  }

  // ---------- scroll-anchor compensation ----------

  const GRID_ITEM_SELECTOR = '[role="listitem"][data-grid-item="true"]';
  const PIN_ID_SELECTOR = '[data-test-pin-id]';
  const GRID_CONTAINER_SELECTOR = '[role="list"]:has([data-grid-item="true"])';

  function getPinId(gridItem) {
    const marker = gridItem.querySelector(PIN_ID_SELECTOR);
    return marker ? marker.getAttribute('data-test-pin-id') : null;
  }

  let scrollAnchor = null;
  // Paused while a restore is in flight, so the continuous capture below
  // doesn't overwrite the anchor with a transitional (mid-reflow) position.
  let restorePending = false;

  // Finds whichever visible grid item's bottom edge is closest to (but
  // still within) the viewport bottom, and records how far above the
  // viewport bottom it sits. That distance is what we'll restore later.
  function captureScrollAnchor() {
    if (restorePending) return;

    const items = document.querySelectorAll(GRID_ITEM_SELECTOR);
    let best = null;

    items.forEach((item) => {
      const rect = item.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) return; // not visible

      const id = getPinId(item);
      if (!id) return;

      if (!best || rect.bottom > best.rect.bottom) {
        best = { rect, id };
      }
    });

    if (best) {
      scrollAnchor = {
        id: best.id,
        viewportBottomOffset: window.innerHeight - best.rect.bottom
      };
    }
  }

  function restoreScrollAnchor() {
    if (!scrollAnchor) return;

    const items = document.querySelectorAll(GRID_ITEM_SELECTOR);
    for (const item of items) {
      if (getPinId(item) !== scrollAnchor.id) continue;

      const rect = item.getBoundingClientRect();
      const targetScrollY = window.scrollY + rect.bottom + scrollAnchor.viewportBottomOffset - window.innerHeight;
      window.scrollTo(0, Math.max(0, targetScrollY));
      break;
    }
  }

  let restoreScheduled = false;
  function scheduleScrollRestore() {
    if (restoreScheduled) return;
    restoreScheduled = true;
    restorePending = true;

    // Grow the tracked column height immediately (synchronously) so its
    // own reflow happens together with whatever content change triggered
    // this, rather than as a separate, later shift.
    updateColumnHeight();

    // Wait a couple of frames for the browser to actually finish reflow
    // before measuring anything — otherwise we'd read a transitional
    // (mid-reflow) position.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        restoreScrollAnchor();
        restoreScheduled = false;
        restorePending = false;
      });
    });
  }

  function startAnchorTracking() {
    // run_at is document_start, so document.body doesn't exist yet when
    // this script first runs — MutationObserver.observe() throws if given
    // a null target. Wait for it.
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', startAnchorTracking, { once: true });
      return;
    }

    // Keep the anchor continuously fresh on an independent timer, NOT tied
    // to scroll events. New content usually loads *because* the user is
    // scrolling, so a scroll-triggered capture can race with the very
    // reflow it's meant to compensate for, sometimes capturing the
    // already-shifted position. An independent interval sidesteps that.
    captureScrollAnchor();
    updateColumnHeight();
    setInterval(captureScrollAnchor, 250);

    let resizeObserver = null;
    let observedContainer = null;

    // Existing pins changing size (e.g. a lazy-loaded image swapping in at
    // its real aspect ratio) also rebalances columns, with no new nodes
    // added — a MutationObserver watching for added nodes alone misses
    // this entirely. ResizeObserver on the grid container catches it.
    function ensureResizeObserverAttached() {
      const container = document.querySelector(GRID_CONTAINER_SELECTOR);
      if (!container || container === observedContainer) return;
      if (!resizeObserver) {
        resizeObserver = new ResizeObserver(() => scheduleScrollRestore());
      }
      if (observedContainer) resizeObserver.unobserve(observedContainer);
      resizeObserver.observe(container);
      observedContainer = container;
    }

    const mutationObserver = new MutationObserver((mutations) => {
      const addedGridItem = mutations.some((m) =>
        Array.from(m.addedNodes).some(
          (node) => node.nodeType === 1 && (node.matches?.(GRID_ITEM_SELECTOR) || node.querySelector?.(GRID_ITEM_SELECTOR))
        )
      );
      if (addedGridItem) {
        scheduleScrollRestore();
        ensureResizeObserverAttached();
      }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    ensureResizeObserverAttached();
  }

  applyMasonryFix();
  startAnchorTracking();
})();
