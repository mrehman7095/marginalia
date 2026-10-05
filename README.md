# Marginalia

A Chrome extension for annotating web application UIs during a work session. At the end
of the day it exports one offline HTML report with screenshots, element borders, drawings
and numbered notes.

Plain JavaScript, Manifest V3, no build step and no dependencies.

## Load unpacked

1. Open `chrome://extensions` and switch on Developer mode.
2. Click **Load unpacked** and select this folder.
3. Pin Marginalia to the toolbar.

On Windows with the repo in WSL, run `./sync-to-windows.sh` and load
`C:\Users\murehman\Downloads\marginalia` instead. Run it again after every change, then
click reload on the extension card.

Pages that were open before the extension loaded need a reload before you can annotate them.

## Use

1. Open the popup and start a session. The name defaults to today's date.
2. **Annotate** (`Alt+Shift+N`): hover to outline an element, click to attach a note, or
   drag to mark a region. Click a numbered pin to edit, resolve or delete its note.
3. **Draw** (`Alt+Shift+D`): pen, highlighter, arrow, rectangle, ellipse, text label and
   redact. `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo. `Esc` saves and exits; Cancel discards.
4. The floating bar at the bottom right lists the notes on the current page (click one to
   scroll to it), hides or shows the pins, and switches modes. `Esc` leaves any mode.
5. **End session** in the popup downloads `marginalia-<session-name>.html`.

Open **history** from the popup to browse, rename, delete, resume or re-export sessions,
and to delete sessions older than N days. Resuming a session makes its pins show again on
live pages.

Change the shortcuts at `chrome://extensions/shortcuts`.

## How it works

- Every saved note or finished drawing captures the visible tab. Marginalia hides its own
  UI for the capture. Notes and drawings on the same URL, scroll position and viewport
  share one snapshot; a new capture replaces its image.
- Element borders and drawings are stored as data and drawn over the screenshot in the
  report. Redactions are the exception: the service worker pixelates them into the stored
  image, so the raw pixels never reach the export.
- Pins re-find their element after scrolls, resizes and single-page-app re-renders: by CSS
  selector, then by text fingerprint, then by DOM path. A note whose element is gone is
  marked orphaned in the list; it is never dropped.
- The content script runs on every page but does nothing until a session is active.

## Privacy

All data stays in this browser, in the extension's IndexedDB. Nothing is sent anywhere.

Caution: screenshots show whatever was on screen. A report that contains snapshots from a
host other than `localhost` or `127.0.0.1` is flagged as non-local and can contain real
member data (names, emails, PII). Do not attach exports to tickets unless every snapshot
comes from a local run with seed data. Use the redact tool before you capture anything
sensitive.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest, permissions and shortcuts |
| `background.js` | Sessions, capture queue, redaction burn-in, export download |
| `db.js` | IndexedDB access for the service worker |
| `content.js` | In-page pins, annotate and draw modes, floating list |
| `renderer.js`, `report.css` | Report renderer shared by the history page and the export |
| `popup.html`, `popup.js` | Toolbar popup |
| `history.html`, `history.js` | Session history and viewer |
| `ui.css` | Styles for the popup and history page |
| `icons/` | Toolbar icons; regenerate with `node dev/make-icons.mjs` |
