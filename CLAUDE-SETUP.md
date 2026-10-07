# Marginalia setup for Claude Code

These are instructions for Claude Code. They install Marginalia for the user who cloned
this repo. Run the steps in order. Ask before you overwrite a file or setting.

`<repo>` below is the absolute path of this repository.

## 1. Check Node

Run `node --version`. The mod needs Node 20 or later, because it starts
`claude-mod/bridge/server.mjs` with `node`. If Node is missing or older, stop and tell the
user to install it.

## 2. Register the Claude Code mod

1. Read `~/.claude/settings.json`. If it does not exist, create it with `{}`.
2. Set `env.CLAUDE_CODE_PLUGIN_DIRS` so that it contains `<repo>/claude-mod`.
   - If the key is missing, set it to `<repo>/claude-mod`.
   - If it has a value, append `:<repo>/claude-mod`. Keep the existing entries.
   - If it already contains a path that ends in `/marginalia` or `/claude-mod` from an older
     install, ask the user before you replace it.
3. Change nothing else in the file. Check that the result is valid JSON.

## 3. Prepare the extension folder

Find where Chrome runs:

- **Same OS as Claude Code** (Linux or macOS): Chrome loads `<repo>/extension` directly.
  Nothing to copy.
- **Claude Code in WSL, Chrome on Windows** (`/mnt/c` exists and `uname -r` contains
  `microsoft`): run `<repo>/sync-to-windows.sh`. It copies the extension to
  `C:\Users\<windows-user>\Downloads\marginalia`. Tell the user to run it again after each
  `git pull`.

## 4. Hand over to the user

Claude cannot do these steps. Tell the user, with the exact folder from step 3:

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and select the extension folder.
3. Pin Marginalia to the toolbar.
4. Restart Claude Code so the mod loads.
5. In the new session, run `/marginalia`. In the extension popup, start a session and switch
   on **Live to Claude**. The popup shows that a session is listening.

## Verify

After the restart, `/marginalia` must be an available command. While a session runs
`/marginalia`, `curl -s http://127.0.0.1:47321/ping` must return
`{"ok":true,"app":"marginalia-bridge"}`.

## Troubleshoot

- `/marginalia` is not a command: the mod did not load. Check the path in
  `CLAUDE_CODE_PLUGIN_DIRS` and restart Claude Code.
- The popup says no session is listening: run `/marginalia` again. Check that nothing else
  uses port 47321 (`ss -ltnp | grep 47321` on Linux, `lsof -i :47321` on macOS).
- The extension shows an error after a pull: click reload on its card in
  `chrome://extensions`. On WSL, run `sync-to-windows.sh` first.
