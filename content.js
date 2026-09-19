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
  // container carrying role="listitem" and data-grid-item="true" that
  // Pinterest's JS positions absolutely (inline transform: translate(...)).
  // We hide THAT node, not just the inner card, so the whole cell's
  // footprint is what gets hidden.
  //
  // We only match on this explicit, unambiguous marker — never on a vague
  // heuristic like "has inline position:absolute + a transform", which
  // previously matched an unrelated oversized wrapper on the single-pin
  // page. The climb depth was earlier capped at 4 to contain that risk, but
  // that's too shallow: on a normal feed pin, the real data-grid-item
  // wrapper sits 5-6 levels above the `pin` marker, so we were hiding an
  // inner div instead of the actual absolutely-positioned cell — which
  // still kept its full box, leaving a gap. Climbing further is safe now
  // that isSafeToHide() independently guards against hiding anything
  // structurally too large, regardless of how it was found.
  function findGridCell(el) {
    let node = el;
    for (let i = 0; i < 12 && node; i++) {
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

  // Content scripts share the actual DOM API objects with the page (only JS
  // *variables* are isolated, not built-in browser interfaces), so patching
  // Node.prototype here also affects Pinterest's own code. This makes
  // removeChild/insertBefore/replaceChild fail gracefully instead of
  // throwing when React reaches for a node we already removed — cheap
  // insurance for blankPinCell() below, which does remove real nodes
  // (img/video), just small leaf ones rather than a whole grid cell.
  let removalSafetyPatched = false;
  function patchNodeRemovalSafety() {
    if (removalSafetyPatched) return;
    removalSafetyPatched = true;

    const proto = Node.prototype;

    const originalRemoveChild = proto.removeChild;
    proto.removeChild = function (child) {
      if (child.parentNode !== this) return child;
      return originalRemoveChild.call(this, child);
    };

    const originalInsertBefore = proto.insertBefore;
    proto.insertBefore = function (newNode, referenceNode) {
      if (referenceNode && referenceNode.parentNode !== this) {
        return originalInsertBefore.call(this, newNode, null);
      }
      return originalInsertBefore.call(this, newNode, referenceNode);
    };

    const originalReplaceChild = proto.replaceChild;
    proto.replaceChild = function (newChild, oldChild) {
      if (oldChild.parentNode !== this) {
        this.appendChild(newChild);
        return oldChild;
      }
      return originalReplaceChild.call(this, newChild, oldChild);
    };
  }

  // Used for whole-section matches (e.g. the "related pins" module) that
  // aren't individual masonry grid items — plain display:none is fine here
  // since these aren't interleaved in the masonry grid, so there's no gap
  // to worry about.
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

  // Used for individual pin matches (ad/video/shoppable/keyword). Pinterest's
  // Masonry component measures each item's height once at initial render and
  // documents that it never re-measures after that — so display:none/removal
  // on the grid cell itself always leaves a gap, because nothing tells
  // Masonry the cell's footprint should change. The fix (validated against a
  // real working Pinterest ad-remover, LiveMethod/pinterest-adblock's
  // detox.js): never touch the grid cell's own box at all. Only remove the
  // <img>/<video> inside it. Its measured height stays exactly what Masonry
  // originally computed, so there is structurally nothing to reflow — the
  // cell just renders as a blank card instead of a gap.
  function blankPinCell(cell, reason) {
    if (!cell || cell.hasAttribute(HIDDEN_ATTR)) return;
    if (!isSafeToHide(cell)) {
      if (DEBUG) console.warn('[AdVanish] refused to blank (too large / unsafe):', reason, cell);
      return;
    }
    cell.setAttribute(HIDDEN_ATTR, 'true');
    if (DEBUG) {
      console.debug('[AdVanish] blanking pin — reason:', reason, '\ntext:', textOf(cell).slice(0, 200), '\nelement:', cell);
    }
    cell.querySelectorAll('img, video').forEach((el) => el.remove());
    // Also clear the title/attribution/"Sponsored" label footer — otherwise
    // the blanked card still visibly reads as an ad even with no image.
    // Pinterest's pin footer carries a data-test-id containing "footer"
    // (e.g. pinrep-footer); matched with a word-ish substring rather than
    // an exact value since it's consistently named that way across pins.
    cell.querySelectorAll('[data-test-id*="footer" i]').forEach((el) => el.remove());
  }

  // NOTE: we previously dispatched a synthetic window "resize" event here to
  // nudge Pinterest's masonry into recomputing layout after hiding a cell.
  // Pinterest's grid is virtualized (it mounts/unmounts pins based on
  // viewport measurements), and repeatedly firing fake resize events tricked
  // that virtualization into recalculating constantly — which intermittently
  // unmounted pins that should have stayed visible (seen as a white screen,
  // or a pin vanishing right after a hover-triggered DOM mutation elsewhere
  // on the page retriggered our scan). Removed entirely — see blankPinCell()
  // above for how gaps are now actually avoided, without needing this.

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
  // A container we mistakenly matched as "related pins" on the pin detail
  // page turned out to also hold that page's core layout (it contained a
  // <style> tag with rules for [data-test-id="closeup-body-style"] and
  // [data-test-id="closeup-media-container"] — the main pin's own layout
  // containers). It had few enough `pin` markers to pass the pin-count
  // check, but hiding it blanked the whole page. Rather than keep guessing
  // Pinterest's naming conventions one exception at a time, guard on actual
  // subtree size instead: a real small "related content" block won't have
  // hundreds of descendant elements.
  //
  // (An earlier version of this guard also refused anything containing a
  // <style> tag, meant to catch that oversized wrapper. That was too broad:
  // Pinterest embeds a small <style> tag with video::cue caption rules
  // inside every video pin, ad or not, so it ended up blocking every video
  // pin from ever being hidden — including actual video ads. Removed; the
  // descendant-count check alone catches the oversized-wrapper case, since
  // that wrapper held the entire page's layout and was far larger than any
  // single pin card.)
  const MAX_DESCENDANTS_IN_HIDDEN_CONTAINER = 250;
  function isSafeToHide(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const pinCount = el.querySelectorAll(
      '[data-test-id="pin"], [data-test-id="pinWrapper"], [data-test-id^="pin-"]'
    ).length;
    if (pinCount > MAX_PINS_IN_HIDDEN_CONTAINER) return false;
    if (el.querySelectorAll('*').length > MAX_DESCENDANTS_IN_HIDDEN_CONTAINER) return false;
    return true;
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

      if (settings.hideAds && isPromoted(cell)) return blankPinCell(cell, 'ad/promoted');
      if (settings.hideVideoPins && isVideoPin(cell)) return blankPinCell(cell, 'video pin');
      if (settings.hideShoppablePins && isShoppablePin(cell)) return blankPinCell(cell, 'shoppable pin');
      if (matchesKeyword(cell)) return blankPinCell(cell, 'keyword match');

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

  // Wait for the page to fully finish loading before touching the DOM at
  // all. On a hard refresh, React hydrates the whole page from scratch —
  // thousands of DOM mutations in quick succession. Our MutationObserver
  // reacting to those and mutating attributes mid-hydration could trigger a
  // React hydration mismatch, which can make React abandon rendering
  // (the white screen seen specifically on hard refresh, not on in-app
  // navigation, which doesn't re-hydrate).
  function whenPageReady(cb) {
    if (document.readyState === 'complete') {
      cb();
    } else {
      window.addEventListener('load', cb, { once: true });
    }
  }

  async function init() {
    // Patch as early as possible (before React starts hydrating), not
    // gated behind whenPageReady — it's a no-op until blankPinCell()
    // actually removes a node.
    patchNodeRemovalSafety();

    settings = await loadSettings();
    if (DEBUG) console.debug('[AdVanish] active settings:', settings);

    whenPageReady(() => {
      applyGridStyle();
      rescanAll();
      startObserving();
      initHoverDelegation();
    });
  }

  init();
})();
