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
- Experimental zero-gap custom grid (opt-in — see below)

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

The actual fix (validated against a real third-party Pinterest ad remover,
[LiveMethod/pinterest-adblock](https://github.com/LiveMethod/pinterest-adblock)'s
`detox.js`): never touch the grid cell's own box. For individual pins
(ads/video/shoppable/keyword matches), only the `<img>`/`<video>` inside the
cell is removed — the cell's measured height, set once by Masonry, never
changes, so there's structurally nothing to reflow. The result is a blank
card instead of a gap. Whole-section clutter (e.g. the "related pins"
module) isn't part of the masonry grid, so those are simply hidden with
`display: none` as before.

A `Node.prototype.removeChild`/`insertBefore`/`replaceChild` patch is
applied defensively (content scripts share the actual DOM API objects with
the page, so this affects Pinterest's own code too), making those methods
fail gracefully instead of throwing if Pinterest's React code ever reaches
for one of the small removed media nodes — cheap insurance against a crash
class we hit while testing full-cell removal.

### Going further: the zero-gap custom grid (opt-in)

Blanking a pin's content avoids a *layout* gap, but the blanked card is
still visibly present. Getting a genuinely gap-free grid (ads simply never
existing, visually) requires not depending on Pinterest's Masonry component
at all — which is exactly what a real competing extension does: reverse
engineering its packaged `.crx` showed it ships its own full custom grid
renderer, enabled by default, that completely replaces Pinterest's native
masonry. In that renderer's own native-mode fallback path, it hides ads
with plain `display: none` — same technique and same limitation as
everyone else. The gap-free experience only exists because its custom grid
is what most users actually see.

This extension's "Zero-gap custom grid" setting (off by default, in the
popup) is a first pass at the same idea:

- Pinterest's native grid container is never moved, wrapped, or
  restructured — earlier attempts at DOM restructuring caused real crashes
  this session. It's made invisible via `visibility: hidden` (not
  `display: none`), which only hides pixels — its layout, scroll position,
  and infinite-scroll triggering are completely unaffected.
- A separate `<div>` is appended to `<body>` (the same pattern already used
  for the hover-preview overlay), position-synced on scroll/resize to sit
  exactly over the native grid's on-screen location.
- Non-ad pins are mirrored into it as plain `<a href>` cards, packed with a
  simple shortest-column masonry algorithm, using the column width/gap
  already configurable in the popup.

Known v1 limitations: column count is computed once when the grid is set
up, not live-responsive to window resizing; and it targets whichever
`role="listitem"` grid it finds first on the page, which may be a smaller
"related pins" carousel rather than the main feed on some pages.

## Project structure

- `manifest.json` — MV3 manifest
- `content.js` — detection, hiding, hover overlay, lightbox, grid tweaks
- `content.css` — styling for hidden elements, overlay, lightbox
- `background.js` — service worker (handles image downloads)
- `popup.html` / `popup.js` / `popup.css` — settings UI
- `icons/` — extension icons

## License

MIT — see [LICENSE](LICENSE).
