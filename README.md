# AdVanish for Pinterest

A Chrome extension (Manifest V3) that hides ads, promoted pins, and feed
clutter on Pinterest, while keeping the masonry grid tidy.

## Features

- Hide ads & promoted pins
- Hide search-suggestion / "related" / "more like this" blocks
- Hide video pins (optional)
- Hide shoppable pins (optional)
- Custom keyword filter
- Hover overlay for previewing a pin at full size or downloading the
  original-resolution image
- Experimental CSS-columns grid mode for genuinely gap-free hiding (see
  below)

## Install (unpacked, for development)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder

## How detection works

Pinterest's CSS class names are hashed and change frequently, so ad/clutter
detection is heuristic, based on more stable signals:

- `data-test-id` attributes on pin wrappers and known UI blocks
- `aria-label` text on badges/links
- Visible **and accessibility-hidden** text (e.g. "Promoted by X") — matched
  via `textContent`, not `innerText`, since Pinterest often marks ad labels
  as visually hidden for screen readers

Because Pinterest's markup changes over time, some ads may occasionally slip
through. If you find one, right-click it → Inspect → copy the outerHTML of
the ad element and open an issue with it so the selectors can be tuned.

## Masonry gap handling

Pinterest's grid is built on their open-source Gestalt design system's
`Masonry` component. It measures each item's height once at initial render
and — per Gestalt's own documentation — never re-measures it afterward:
"Item heights cannot change after their initial render... Masonry will
never know about the updated item height and remeasure that item, leading
to overlaps or gaps in the grid." That's an acknowledged limitation of the
component itself, not something Pinterest added to resist ad blockers.

Earlier approaches tried to work around this by making Pinterest itself
recompute layout (a synthetic `resize` event) or by removing the grid cell
outright — both interact with Pinterest's own virtualized/React-managed
tree and caused real instability (an intermittent white screen; pins
vanishing on hover-triggered rescans).

The default-mode fix (validated against a real third-party Pinterest ad
remover, [LiveMethod/pinterest-adblock](https://github.com/LiveMethod/pinterest-adblock)'s
`detox.js`): never touch the grid cell's own box. For individual pins
(ads/video/shoppable/keyword matches), only the `<img>`/`<video>` inside the
cell is removed — the cell's measured height, set once by Masonry, never
changes, so there's structurally nothing to reflow. The result is a blank
card instead of a gap. Whole-section clutter (e.g. the "related pins"
module) isn't part of the masonry grid, so those are simply hidden with
`display: none` as before.

(An earlier attempt patched `Node.prototype.removeChild`/`insertBefore`/
`replaceChild` defensively for a full-cell-removal experiment. That patch
affects every such call on the page — including Pinterest's own internal
code for unrelated purposes, since content scripts share the actual DOM API
objects with the page — and was removed after a white screen appeared
alongside uncaught errors from Pinterest's own bundle failing to read its
own internal data, a plausible sign of interference. The current default
mode doesn't need it.)

### CSS-columns grid mode (experimental, opt-in)

The "Zero-gap custom grid" setting takes a different, structurally simpler
approach: instead of fighting Pinterest's JS-computed absolute positioning,
override it with CSS so Pinterest's grid cells become normal in-flow
content inside a native CSS multi-column layout
(`column-count: N; column-gap: <gap>;`). Browsers reflow column content
automatically on any DOM change — no JS masonry math needed on our side at
all. With cells back in normal flow, a plain `display: none` on a hidden
pin genuinely closes the gap, handled entirely by the browser's own layout
engine.

`column-count` (an exact number of columns) is used rather than
`columns: <px>` (a target width the browser fits columns around
approximately), so each column gets a true `100% / N` share of the
container width — a real percentage, not a fixed px — via
`width: 100%` on each cell, which the CSS multicol spec resolves against
the column box, not the outer container. The column count itself is
auto-derived from the pin's own natural width (still present in Pinterest's
own inline `style="width: ..."` on that exact cell — never modified,
only visually overridden), so the resulting column width lands close to
what Pinterest was already showing rather than an arbitrary typed-in value.
It can be overridden explicitly in the popup.

This is done as a pure CSS override (an injected stylesheet with
`!important` rules beating Pinterest's plain inline styles) — it never
mutates the DOM tree, an element's attributes, or any property React itself
set. React's own bookkeeping is completely unaware anything changed, which
is why this sidesteps every DOM-mutation-related crash class hit earlier
this session.

Known open risk: Pinterest's virtualization (mounting/unmounting
off-screen pins) decides what to (un)mount based on its own internal
position calculations, which this doesn't change — only the visual result
does. If the column fill order diverges enough from Pinterest's own
row-based order, pins could flicker or vanish unexpectedly while scrolling.
An earlier, much larger approach (a full custom grid renderer mirroring
non-ad pins into a separate overlay, matching how a real competing
extension solves this) was tried and reverted for being too unreliable in
practice (inconsistent columns, ads slipping through) — see git history if
reviving that direction.

## Project structure

- `manifest.json` — MV3 manifest
- `content.js` — detection, hiding, hover overlay, lightbox, grid tweaks
- `content.css` — styling for hidden elements, overlay, lightbox
- `background.js` — service worker (handles image downloads)
- `popup.html` / `popup.js` / `popup.css` — settings UI
- `icons/` — extension icons

## License

MIT — see [LICENSE](LICENSE).
