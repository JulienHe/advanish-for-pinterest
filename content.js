// AdVanish for Pinterest — content script
// Step 1: masonry fix. Turn Pinterest's absolutely-positioned grid items
// into normal in-flow content inside a native CSS multi-column list, via a
// pure CSS override (no DOM/attribute mutation — this is what makes it
// safe: React's own bookkeeping never sees anything change).
//
// Step 2: scroll-anchor compensation. Our container has no fixed height
// (it must keep growing for infinite scroll), so column-fill stays at its
// default "balance" — the browser rebalances ALL columns whenever content
// changes, which can visually shift already-placed pins when new ones load.
// Rather than try to prevent that reflow (would need a fixed height we
// can't have), we compensate for it the way a real competing extension
// does it (researched from its own installed files, reimplemented here
// independently — see commit message for detail): track a pin near the
// bottom of the viewport as an "anchor", and after new content loads,
// re-locate that same pin and adjust scroll position so it lands back
// exactly where it was. The shift becomes imperceptible even though pins
// actually moved underneath.

(() => {
  'use strict';

  function applyMasonryFix() {
    const style = document.createElement('style');
    style.id = 'parp-masonry-style';
    style.textContent = `
      [role="list"]:has([data-grid-item="true"]) {
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

  // ---------- scroll-anchor compensation ----------

  const GRID_ITEM_SELECTOR = '[role="listitem"][data-grid-item="true"]';
  const PIN_ID_SELECTOR = '[data-test-pin-id]';

  function getPinId(gridItem) {
    const marker = gridItem.querySelector(PIN_ID_SELECTOR);
    return marker ? marker.getAttribute('data-test-pin-id') : null;
  }

  let scrollAnchor = null;

  // Finds whichever visible grid item's bottom edge is closest to (but
  // still within) the viewport bottom, and records how far above the
  // viewport bottom it sits. That distance is what we'll restore later.
  function captureScrollAnchor() {
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

  let scrollCaptureScheduled = false;
  function scheduleScrollCapture() {
    if (scrollCaptureScheduled) return;
    scrollCaptureScheduled = true;
    requestAnimationFrame(() => {
      scrollCaptureScheduled = false;
      captureScrollAnchor();
    });
  }

  let restoreScheduled = false;
  function scheduleScrollRestore() {
    if (restoreScheduled) return;
    restoreScheduled = true;
    // Wait a frame for the browser to actually finish the column reflow
    // triggered by the new content before we measure anything — otherwise
    // we'd read stale (pre-reflow) positions.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        restoreScheduled = false;
        restoreScrollAnchor();
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

    captureScrollAnchor();
    window.addEventListener('scroll', scheduleScrollCapture, { passive: true });

    const observer = new MutationObserver((mutations) => {
      const addedGridItem = mutations.some((m) =>
        Array.from(m.addedNodes).some(
          (node) => node.nodeType === 1 && (node.matches?.(GRID_ITEM_SELECTOR) || node.querySelector?.(GRID_ITEM_SELECTOR))
        )
      );
      if (addedGridItem) scheduleScrollRestore();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  applyMasonryFix();
  startAnchorTracking();
})();
