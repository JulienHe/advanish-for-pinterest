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
- Experimental grid column-width / spacing customization

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

## Project structure

- `manifest.json` — MV3 manifest
- `content.js` — detection, hiding, hover overlay, lightbox, grid tweaks
- `content.css` — styling for hidden elements, overlay, lightbox
- `background.js` — service worker (handles image downloads)
- `popup.html` / `popup.js` / `popup.css` — settings UI
- `icons/` — extension icons

## License

MIT — see [LICENSE](LICENSE).
