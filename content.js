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
    gridColumnCount: 0, // 0 = auto-derive from the pins' own natural width
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
    applyGridMode();
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

  // NOTE: we previously patched Node.prototype.removeChild/insertBefore/
  // replaceChild here as defensive insurance for blankPinCell() removing
  // small <img>/<video> nodes. Removed: content scripts share the actual
  // DOM API objects with the page, so that patch affected EVERY
  // removeChild/insertBefore/replaceChild call on the page, including
  // Pinterest's own internal code for entirely unrelated purposes — not
  // just our own small removals. It was added defensively for a full
  // grid-cell-removal experiment that was already reverted, and its actual
  // necessity for blankPinCell's small leaf-node removals was never
  // confirmed. After a white screen was reported with default settings
  // (custom grid mode off) alongside uncaught errors from Pinterest's own
  // bundle failing to read its own internal data — a plausible sign of
  // this patch interfering with Pinterest's unrelated internal DOM
  // operations — it's removed as the highest-blast-radius, least-justified
  // thing this extension was doing.

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

      // In CSS-columns mode, grid cells are real in-flow content (no more
      // Pinterest inline position:absolute/transform — see applyGridMode
      // below), so a plain display:none actually closes the gap natively,
      // handled entirely by the browser's own column layout. Outside that
      // mode, cells are still absolutely positioned by Pinterest's own JS,
      // so blankPinCell (leave the box, clear its content) is what avoids a
      // gap there.
      const hideFn = settings.gridEnabled ? hideCell : blankPinCell;
      if (settings.hideAds && isPromoted(cell)) return hideFn(cell, 'ad/promoted');
      if (settings.hideVideoPins && isVideoPin(cell)) return hideFn(cell, 'video pin');
      if (settings.hideShoppablePins && isShoppablePin(cell)) return hideFn(cell, 'shoppable pin');
      if (matchesKeyword(cell)) return hideFn(cell, 'keyword match');

      cell.setAttribute(SCANNED_ATTR, 'true');
    });

    if (settings.hideSearchSuggestions) {
      const blocks = root.querySelectorAll('[data-test-id]');
      blocks.forEach((el) => {
        if (el.hasAttribute(HIDDEN_ATTR)) return;
        if (isSearchSuggestionBlock(el)) hideCell(el, 'search suggestion block: ' + el.getAttribute('data-test-id'));
      });
    }

    // Retry finding the grid container in case it wasn't available yet on
    // the first call (e.g. pins still loading in) or was replaced by
    // Pinterest's own client-side navigation. No-op if already applied to
    // the current container or if the feature is off.
    applyGridMode();
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

  // ---------- CSS-columns grid mode (experimental) ----------
  // Pinterest's masonry positions each cell with inline position:absolute +
  // transform, computed once by its own JS and never revisited (see
  // blankPinCell's comment) — that's the actual, structural reason hiding a
  // pin leaves a gap: nothing in that scheme ever reflows automatically.
  //
  // Native CSS multi-column layout (`columns` + `column-gap`) solves this
  // the way it was designed to: browsers reflow column content
  // automatically on any DOM change, for free, no JS involved. The trick is
  // getting Pinterest's cells to participate in that layout as normal
  // in-flow content instead of being absolutely positioned — which we do
  // with a plain CSS override (`position: static !important` etc. in an
  // injected stylesheet). Crucially, this never touches the DOM tree, an
  // element's attributes, or any property React itself set — it only
  // changes which CSS rule wins the cascade. React's own bookkeeping is
  // completely unaware anything changed, which is exactly why this
  // sidesteps every crash class hit earlier this session (all of those
  // came from mutating nodes/attributes React manages, not from CSS).
  //
  // One known risk, not yet resolved: Pinterest's virtualization (mounting/
  // unmounting off-screen pins) decides what to (un)mount based on ITS OWN
  // internal position calculations, which this doesn't change — only the
  // visual result does. If our column fill order diverges enough from
  // Pinterest's own row-based order, pins could flicker or vanish
  // unexpectedly while scrolling, since what's visually on screen may not
  // match what Pinterest's JS believes is on screen. Needs real testing.

  let columnsStyleTag = null;
  let columnsContainer = null;

  function applyGridMode() {
    if (!columnsStyleTag) {
      columnsStyleTag = document.createElement('style');
      columnsStyleTag.id = 'parp-columns-style';
      document.documentElement.appendChild(columnsStyleTag);
    }

    if (!settings.gridEnabled) {
      columnsStyleTag.textContent = '';
      if (columnsContainer) columnsContainer.classList.remove('parp-columns-active');
      columnsContainer = null;
      return;
    }

    // Find the shared parent of Pinterest's grid cells. Re-checked on every
    // call (cheap) since the container may not exist yet at first call, or
    // may have been replaced by Pinterest's own client-side navigation.
    const anyCell = document.querySelector('[data-grid-item="true"], [role="listitem"]');
    const container = anyCell ? anyCell.parentElement : null;
    if (!container) return; // will retry on the next rescan

    if (columnsContainer && columnsContainer !== container) {
      columnsContainer.classList.remove('parp-columns-active');
    }
    columnsContainer = container;
    columnsContainer.classList.add('parp-columns-active');

    const g = Number(settings.gridGap) || DEFAULTS.gridGap;

    // Use column-count (an exact number of columns), not columns:<px> (a
    // target width the browser fits columns around approximately). With
    // column-count, each column's width is computed as an exact
    // 100%/N share of the container — a real percentage, not a fixed px —
    // and width:100% on each cell below resolves against that column box,
    // not the outer container, per the CSS multicol spec.
    //
    // The count itself is derived from the pin's own natural width
    // (Pinterest sets an explicit inline `width` on this exact cell, e.g.
    // "224.2px" — still present in the attribute; we only override the
    // *rendered* result via this stylesheet, never touch that attribute)
    // so the resulting column width lands close to what Pinterest was
    // already showing, unless the user overrides the count explicitly.
    const containerWidth = container.getBoundingClientRect().width || 1000;
    const naturalWidth = parseFloat(anyCell.style.width) || anyCell.getBoundingClientRect().width || 236;
    const columnCount = Number(settings.gridColumnCount) > 0
      ? Math.round(Number(settings.gridColumnCount))
      : Math.max(1, Math.round((containerWidth + g) / (naturalWidth + g)));

    columnsStyleTag.textContent = `
      .parp-columns-active {
        display: block !important;
        column-count: ${columnCount} !important;
        column-gap: ${g}px !important;
      }
      .parp-columns-active > [data-grid-item="true"] {
        position: static !important;
        top: auto !important;
        left: auto !important;
        right: auto !important;
        bottom: auto !important;
        transform: none !important;
        width: 100% !important;
        margin: 0 0 ${g}px !important;
        break-inside: avoid;
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
    settings = await loadSettings();
    if (DEBUG) console.debug('[AdVanish] active settings:', settings);

    whenPageReady(() => {
      applyGridMode();
      rescanAll();
      startObserving();
      initHoverDelegation();
    });
  }

  init();
})();
