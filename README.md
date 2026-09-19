# AdVanish for Pinterest

A Chrome extension (Manifest V3) for hiding ads and feed clutter on
Pinterest.

**Status: blank slate.** The extension currently does nothing — it's a
minimal, verifiably-working shell (manifest, empty content script, empty
popup) that we're rebuilding feature by feature, one step at a time, each
one tested before moving to the next.

Earlier attempts at ad-detection, masonry-gap handling, and a custom grid
mode ran into repeated instability (white screens, React reconciliation
crashes) from trying to fight Pinterest's own rendering. That history is
preserved in git log if useful context when rebuilding, but nothing from it
carries over automatically.

## Install (unpacked, for development)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder

## Project structure

- `manifest.json` — MV3 manifest
- `content.js` — currently blank
- `content.css` — currently blank
- `popup.html` / `popup.js` / `popup.css` — currently blank
- `icons/` — extension icons

## License

MIT — see [LICENSE](LICENSE).
