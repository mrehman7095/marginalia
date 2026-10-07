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

## Export for agent

**Export for agent** (popup, or next to Export in history) downloads a folder
`marginalia-<session-name>/` with `notes.md` and one PNG per snapshot (`01-<page>.png`, ...).
The PNGs have the borders, numbered badges and drawings painted in; the numbers match the
notes in `notes.md`, which also lists each note's selector, text fingerprint, DOM path and
box. It does not end the session. To hand it to Claude Code:

```
Read ~/Downloads/marginalia-2026-10-05/notes.md and the PNGs it links, then fix the notes.
```

From WSL the folder is under `/mnt/c/Users/<you>/Downloads/`. The same privacy caution applies.

## How it works

- Every saved note or finished drawing captures the visible tab. Marginalia hides its own
  UI for the capture. Notes and drawings on the same URL (including `#/` hash routes),
  scroll position, viewport and pixel ratio share one snapshot; a new capture replaces
  its image. The capture is refused with a message when the tab is not in front, the
  page moved since the save, or pinch zoom is active.
- Element borders and drawings are stored as data and drawn over the screenshot in the
  report. Redactions are the exception: the service worker paints them as solid boxes
  into the stored image, so the raw pixels never reach the export. A snapshot with a
  redaction is never captured again; a later save in the same state starts a new
  snapshot, which needs its own redaction. If a capture fails, the redaction is painted
  into the stored image, or the image is dropped.
- The export is built as a Blob in an offscreen document and downloaded from a `blob:`
  URL. The session is marked ended only after the download starts.
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

## Known limitations

- Pages that handle keys or clicks in their own capture phase can still see some input
  while annotate mode is on.
- Clicks inside iframes are not intercepted, and iframes are not annotated.
- Two notes saved at the same moment from different tabs can get the same number.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest, permissions and shortcuts |
| `background.js` | Sessions, capture queue, redaction burn-in, export download |
| `db.js` | IndexedDB access for the service worker and offscreen document |
| `content.js` | In-page pins, annotate and draw modes, floating list |
| `renderer.js`, `report.css` | Report renderer shared by the history page and the export |
| `popup.html`, `popup.js` | Toolbar popup |
| `history.html`, `history.js` | Session history and viewer |
| `offscreen.html`, `offscreen.js` | Builds the HTML export and the agent export as Blobs |
| `ui.css` | Styles for the popup and history page |
| `icons/` | Toolbar icons; regenerate with `node dev/make-icons.mjs` |

## Live to Claude

Notes can go straight to one Claude Code session while you work.

1. In the Claude Code session that should get the notes, run `/marginalia`. That session
   starts a receiver on `127.0.0.1:47321`. No other session gets notes. Running
   `/marginalia` in another session moves the receiver there; `/marginalia stop` ends it.
2. In the popup, switch on **Live to Claude**. The popup says whether a session is listening.
3. Each saved note (new or edited) and each drawing is sent with its annotated screenshot.
   By default Claude starts on its own 8 seconds after your last note and replies with the
   cause and a proposed fix for each. `/marginalia quiet` makes notes wait for your next
   prompt instead; `/marginalia auto` switches back.
4. A note saved while no session listens waits in the extension and is sent when one does.
5. When Claude fixes a note it marks it resolved; the pin turns resolved within about 30
   seconds, and its tooltip shows Claude's one-line comment.

The receiver is the `marginalia` Claude Code mod (`~/.claude/mods/marginalia`). It accepts
requests only from a `chrome-extension://` origin.
