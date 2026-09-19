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

Pinterest positions pins with JS-computed `transform` and virtualizes the
grid (mounting/unmounting pins based on viewport measurements). Hidden pins
use plain `display: none`. An earlier version also dispatched a synthetic
`resize` event to nudge Pinterest into recomputing layout and closing gaps,
but that repeatedly triggered Pinterest's virtualization logic and caused
pins to intermittently unmount (visible as a white screen or a pin vanishing
on hover). That nudge was removed — hidden pins may occasionally leave a
small gap until the next natural layout pass (e.g. scroll), which is a much
smaller issue than corrupting Pinterest's own rendering.

## Project structure

- `manifest.json` — MV3 manifest
- `content.js` — detection, hiding, hover overlay, lightbox, grid tweaks
- `content.css` — styling for hidden elements, overlay, lightbox
- `background.js` — service worker (handles image downloads)
- `popup.html` / `popup.js` / `popup.css` — settings UI
- `icons/` — extension icons

## License

MIT — see [LICENSE](LICENSE).
