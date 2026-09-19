// AdVanish for Pinterest — content script
// Runs on every Pinterest page. Finds ad/promo/clutter pins using heuristics
// (Pinterest's class names are hashed/obfuscated and change often, so we key
// off relatively stable signals: data-test-id, aria-label, and visible text).

(() => {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    hideAds: true,
    hideSearchSuggestions: true,
    hideVideoPins: false,
    hideShoppablePins: false,
    keywords: [],
    gridEnabled: false,
    gridColumnWidth: 236, // px, matches Pinterest's default small-column width
    gridGap: 16 // px
  };

  let settings = { ...DEFAULTS };
  const HIDDEN_ATTR = 'data-parp-hidden';
  const SCANNED_ATTR = 'data-parp-scanned';

  // ---------- settings ----------

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (stored) => resolve(stored));
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue;
    }
    applyGridStyle();
    rescanAll();
  });

  // ---------- helpers ----------

  // textContent includes hidden/collapsed text (e.g. dropdown menu items
  // like "Why this ad?" that Pinterest apparently includes in EVERY pin's
  // options menu, not just actual ads). That made textContent too noisy for
  // ad-label detection — it false-positived on ordinary pins whose hover
  // menu happened to be in the DOM. Use visible text (innerText) for
  // deciding whether something IS an ad; keyword filtering (a deliberate,
  // user-supplied match) still benefits from the broader textContent.
  function textOf(el) {
    return (el.textContent || '').trim();
  }

  function visibleTextOf(el) {
    return (el.innerText || '').trim();
  }

  // Walk up from a candidate marker element to the ancestor that represents
  // one full grid cell (the masonry item). Pinterest wraps each pin in a
  // container carrying role="listitem" or a data-grid-item style attribute
  // that Pinterest's JS positions absolutely. We hide THAT node, not just the
  // inner card, so the whole cell's footprint disappears.
  // Only climb to an explicit list-item marker, and only a few levels up.
  // The old fallback (any ancestor with inline position:absolute + a
  // transform) was too broad: on pages like the single-pin view, it could
  // match a large wrapper that also contains an unrelated sponsored pin
  // nearby, causing the wrapper — including the real pin — to be hidden as
  // if it were the ad. When no explicit list-item marker is found nearby,
  // stick with the marker itself rather than guessing.
  function findGridCell(el) {
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      if (node.getAttribute && (node.getAttribute('role') === 'listitem' || node.hasAttribute('data-grid-item'))) {
        return node;
      }
      node = node.parentElement;
    }
    return el;
  }

  // Temporary diagnostic flag — logs *why* each cell was hidden to the
  // console so we can see the real cause instead of guessing. Safe to leave
  // on; it only prints, never changes behavior.
  const DEBUG = true;

  function hideCell(cell, reason) {
    if (!cell || cell.hasAttribute(HIDDEN_ATTR)) return;
    if (!isSafeToHide(cell)) {
      if (DEBUG) console.warn('[AdVanish] refused to hide (too large / unsafe):', reason, cell);
      return;
    }
    cell.setAttribute(HIDDEN_ATTR, 'true');
    cell.classList.add('parp-hidden');
    if (DEBUG) {
      console.debug('[AdVanish] hid cell — reason:', reason, '\ntext:', textOf(cell).slice(0, 200), '\nelement:', cell);
    }
  }

  // NOTE: we previously dispatched a synthetic window "resize" event here to
  // nudge Pinterest's masonry into recomputing layout after hiding a cell.
  // Pinterest's grid is virtualized (it mounts/unmounts pins based on
  // viewport measurements), and repeatedly firing fake resize events tricked
  // that virtualization into recalculating constantly — which intermittently
  // unmounted pins that should have stayed visible (seen as a white screen,
  // or a pin vanishing right after a hover-triggered DOM mutation elsewhere
  // on the page retriggered our scan). Removed entirely: display:none alone
  // is enough to hide a cell, and any leftover gap is a much smaller problem
  // than corrupting Pinterest's own rendering.

  function matchesKeyword(cell) {
    if (!settings.keywords || settings.keywords.length === 0) return false;
    const haystack = textOf(cell).toLowerCase();
    const imgAlt = Array.from(cell.querySelectorAll('img'))
      .map((img) => (img.alt || '').toLowerCase())
      .join(' ');
    const combined = haystack + ' ' + imgAlt;
    return settings.keywords.some((kw) => kw && combined.includes(kw.toLowerCase()));
  }

  // Pinterest labels ads "Promoted" in some surfaces and "Sponsored" in
  // others (observed on search-results feeds). Match both, plus the aria
  // label variants.
  const AD_LABEL_RE = /\b(promoted|sponsored)\b/i;

  function isPromoted(cell) {
    // Visible text only — Pinterest renders the "Sponsored"/"Promoted"
    // label as plain visible text under the pin. textContent (which
    // includes hidden text) was matching boilerplate hidden menu items
    // ("Why this ad?") that exist on every pin's options menu, not just
    // actual ads.
    if (AD_LABEL_RE.test(visibleTextOf(cell))) return true;
    // Visible aria-labels (e.g. on a "Promoted by X" badge) — not hidden
    // menu boilerplate, so this one is safe to keep text-content based.
    const ariaCandidates = cell.querySelectorAll('[aria-label]');
    for (const node of ariaCandidates) {
      if (AD_LABEL_RE.test(node.getAttribute('aria-label') || '')) return true;
    }
    // NOTE: previously also checked `[data-test-id*="ad" i]`, which is a
    // plain substring match — "ad" is a substring of "add", so it matched
    // the ordinary Save/"Add to board" button that appears in every pin's
    // hover overlay. That's what made every pin look like an ad on hover.
    // Removed; if we need a data-test-id-based signal later, it must use a
    // word-boundary check, not a bare substring.
    return false;
  }

  function isVideoPin(cell) {
    if (cell.querySelector('video')) return true;
    if (cell.querySelector('[data-test-id*="video" i]')) return true;
    const ariaCandidates = cell.querySelectorAll('[aria-label]');
    for (const node of ariaCandidates) {
      if (/video pin|video/i.test(node.getAttribute('aria-label') || '')) return true;
    }
    return false;
  }

  function isShoppablePin(cell) {
    if (cell.querySelector('[data-test-id*="shopping" i]')) return true;
    if (/\bshop\b/i.test(textOf(cell)) && cell.querySelector('[data-test-id*="price" i]')) return true;
    const ariaCandidates = cell.querySelectorAll('[aria-label]');
    for (const node of ariaCandidates) {
      if (/shoppable|shop the look/i.test(node.getAttribute('aria-label') || '')) return true;
    }
    return false;
  }

  // Only match on the element's OWN data-test-id, never on descendant
  // headings — checking descendants let this match huge ancestor wrappers
  // (e.g. Pinterest's whole app container, if some deeply nested heading
  // happened to contain matching text), which hid the entire page.
  function isSearchSuggestionBlock(el) {
    const testId = el.getAttribute && el.getAttribute('data-test-id');
    return !!(testId && /related|search-guide|suggestion|more-ideas|more-like-this/i.test(testId));
  }

  // Safety net: never hide document root/body, and never hide a container
  // that itself holds a large number of pins — that's a sign a heuristic
  // matched an ancestor wrapper instead of a single pin/block, and hiding
  // it would blank out large parts (or all) of the page.
  const MAX_PINS_IN_HIDDEN_CONTAINER = 12;
  function isSafeToHide(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const pinCount = el.querySelectorAll(
      '[data-test-id="pin"], [data-test-id="pinWrapper"], [data-test-id^="pin-"]'
    ).length;
    return pinCount <= MAX_PINS_IN_HIDDEN_CONTAINER;
  }

  // ---------- scanning ----------

  function scanPinCandidates(root) {
    if (!settings.enabled || !root) return;

    const pinMarkers = root.querySelectorAll(
      '[data-test-id="pin"], [data-test-id="pinWrapper"], [data-test-id^="pin-"]'
    );
    pinMarkers.forEach((marker) => {
      const cell = findGridCell(marker);
      if (cell.hasAttribute(HIDDEN_ATTR)) return;

      if (settings.hideAds && isPromoted(cell)) return hideCell(cell, 'ad/promoted');
      if (settings.hideVideoPins && isVideoPin(cell)) return hideCell(cell, 'video pin');
      if (settings.hideShoppablePins && isShoppablePin(cell)) return hideCell(cell, 'shoppable pin');
      if (matchesKeyword(cell)) return hideCell(cell, 'keyword match');

      cell.setAttribute(SCANNED_ATTR, 'true');
    });

    if (settings.hideSearchSuggestions) {
      const blocks = root.querySelectorAll('[data-test-id]');
      blocks.forEach((el) => {
        if (el.hasAttribute(HIDDEN_ATTR)) return;
        if (isSearchSuggestionBlock(el)) hideCell(el, 'search suggestion block: ' + el.getAttribute('data-test-id'));
      });
    }
  }

  let rescanScheduled = false;
  function rescanAll() {
    if (rescanScheduled) return;
    rescanScheduled = true;
    requestIdleCallback(() => {
      rescanScheduled = false;
      scanPinCandidates(document.body || document.documentElement);
    }, { timeout: 500 });
  }

  // ---------- preview lightbox + download overlay ----------

  function highResUrl(src) {
    if (!src) return src;
    // Pinterest CDN paths embed a size segment, e.g. /236x/, /474x/, /736x/.
    // Swapping it for "originals" requests the highest-resolution asset.
    return src.replace(/\/(\d+x(?:\d+)?|\d+)\//, '/originals/');
  }

  // IMPORTANT: we never insert nodes into Pinterest's own DOM subtree.
  // Pinterest re-renders pin tiles (via React) on hover/scroll, and a
  // foreign child node confuses its reconciliation — this previously caused
  // tiles to vanish on hover. Instead we keep ONE overlay element appended
  // to <body>, and reposition it with position:fixed to track whichever
  // pin's image is currently hovered. This never mutates Pinterest's nodes.

  let floatingOverlay = null;
  let currentHoverImg = null;

  function ensureFloatingOverlay() {
    if (floatingOverlay) return floatingOverlay;
    floatingOverlay = document.createElement('div');
    floatingOverlay.className = 'parp-overlay parp-overlay-floating';

    const previewBtn = document.createElement('button');
    previewBtn.className = 'parp-btn parp-preview-btn';
    previewBtn.title = 'Preview full size';
    previewBtn.textContent = '⤢';
    previewBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentHoverImg) openLightbox(highResUrl(currentHoverImg.src));
    });

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'parp-btn parp-download-btn';
    downloadBtn.title = 'Download high quality image';
    downloadBtn.textContent = '⬇';
    downloadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentHoverImg) {
        chrome.runtime.sendMessage({ type: 'parp-download', url: highResUrl(currentHoverImg.src) });
      }
    });

    floatingOverlay.appendChild(previewBtn);
    floatingOverlay.appendChild(downloadBtn);
    floatingOverlay.style.display = 'none';
    document.body.appendChild(floatingOverlay);

    // Keep the overlay itself hoverable without losing track of the pin.
    floatingOverlay.addEventListener('mouseleave', hideFloatingOverlay);

    return floatingOverlay;
  }

  function showFloatingOverlayFor(img) {
    const overlay = ensureFloatingOverlay();
    currentHoverImg = img;
    const rect = img.getBoundingClientRect();
    overlay.style.display = 'flex';
    overlay.style.top = `${rect.top + 8}px`;
    overlay.style.left = `${rect.right - 8 - 68}px`; // 2 buttons (28px) + gap
  }

  function hideFloatingOverlay() {
    if (floatingOverlay) floatingOverlay.style.display = 'none';
    currentHoverImg = null;
  }

  function initHoverDelegation() {
    document.addEventListener(
      'mouseover',
      (e) => {
        const marker = e.target.closest && e.target.closest('[data-test-id="pin"], [data-test-id="pinWrapper"], [data-test-id^="pin-"]');
        if (!marker) return;
        if (marker.closest('[' + HIDDEN_ATTR + ']')) return;
        const img = marker.querySelector('img');
        if (img) showFloatingOverlayFor(img);
      },
      true
    );

    document.addEventListener(
      'mouseout',
      (e) => {
        const marker = e.target.closest && e.target.closest('[data-test-id="pin"], [data-test-id="pinWrapper"], [data-test-id^="pin-"]');
        if (!marker) return;
        // Only hide if we're not moving onto the floating overlay itself.
        const to = e.relatedTarget;
        if (to && floatingOverlay && floatingOverlay.contains(to)) return;
        hideFloatingOverlay();
      },
      true
    );
  }

  function openLightbox(url) {
    closeLightbox();
    const backdrop = document.createElement('div');
    backdrop.className = 'parp-lightbox-backdrop';
    backdrop.addEventListener('click', closeLightbox);

    const img = document.createElement('img');
    img.className = 'parp-lightbox-img';
    img.src = url;
    img.addEventListener('click', (e) => e.stopPropagation());

    const closeBtn = document.createElement('button');
    closeBtn.className = 'parp-lightbox-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closeLightbox);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'parp-lightbox-save';
    saveBtn.textContent = 'Download';
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'parp-download', url });
    });

    backdrop.appendChild(img);
    backdrop.appendChild(closeBtn);
    backdrop.appendChild(saveBtn);
    document.body.appendChild(backdrop);

    document.addEventListener('keydown', escListener);
  }

  function escListener(e) {
    if (e.key === 'Escape') closeLightbox();
  }

  function closeLightbox() {
    document.removeEventListener('keydown', escListener);
    const existing = document.querySelector('.parp-lightbox-backdrop');
    if (existing) existing.remove();
  }

  // ---------- custom grid spacing/column-width (experimental) ----------
  // Pinterest computes column widths in JS, so this is a best-effort CSS
  // override on the common pin-wrapper width and card image sizing. It may
  // stop working if Pinterest changes its layout markup.

  let gridStyleTag = null;
  function applyGridStyle() {
    if (!gridStyleTag) {
      gridStyleTag = document.createElement('style');
      gridStyleTag.id = 'parp-grid-style';
      document.documentElement.appendChild(gridStyleTag);
    }
    if (!settings.gridEnabled) {
      gridStyleTag.textContent = '';
      return;
    }
    const w = Number(settings.gridColumnWidth) || DEFAULTS.gridColumnWidth;
    const g = Number(settings.gridGap) || DEFAULTS.gridGap;
    gridStyleTag.textContent = `
      [data-test-id="pinWrapper"], [data-test-id="pin"] {
        width: ${w}px !important;
      }
      [data-grid-item] {
        margin: ${Math.round(g / 2)}px !important;
      }
    `;
  }

  // ---------- observer ----------

  function startObserving() {
    const observer = new MutationObserver((mutations) => {
      let hasAdded = false;
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) {
          hasAdded = true;
          break;
        }
      }
      if (hasAdded) rescanAll();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---------- init ----------

  async function init() {
    settings = await loadSettings();
    if (DEBUG) console.debug('[AdVanish] active settings:', settings);
    applyGridStyle();
    rescanAll();
    startObserving();
    initHoverDelegation();

    const bootObserver = new MutationObserver(() => {
      if (document.body) {
        rescanAll();
        bootObserver.disconnect();
      }
    });
    if (!document.body) {
      bootObserver.observe(document.documentElement, { childList: true });
    }
  }

  init();
})();
