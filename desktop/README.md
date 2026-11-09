# MoonBridge Activity for Windows

This Tauri 2 desktop client pairs a Windows computer to an open MoonBridge shift. The React window shows pairing and status; the Rust process samples Windows input, owns the pairing token, queues intervals, and retries uploads. Closing the window leaves the tray process running. The tray menu has an explicit Quit action.

## Run

Install Node.js, Rust, and the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows). In this folder:

```powershell
npm.cmd install
npm.cmd run tauri dev
```

The app asks for a server origin on first launch. Enter a staging HTTPS origin with the desktop API enabled. HTTP is accepted only for `localhost` or `127.0.0.1`. No server is preconfigured.

The application title, Windows metadata, publisher, installer name, favicon, tray icon, and window header use MoonBridge branding. The window uses the MoonBridge logo and its navy, blue, and gold palette.

An installed app registers `moonbridge://open`. The web app may use that link for an **Open desktop app** button; the link only opens the window and carries no credentials.

## Expected server contract

- `POST /api/desktop/pair/start`: accepts `deviceId`; returns `code` and `expiresInSeconds`.
- `POST /api/desktop/pair/complete`: accepts `code` and `deviceId`; returns `token`, `pairingId`, `userId`, `shiftId`, and optionally `workerName` for display.
- `GET /api/desktop/context`: bearer token; returns `onBreak` and optional `lastBreakEndAt`.
- `POST /api/desktop/activity/batch`: bearer token; accepts stable-ID `active` or `idle` intervals.
- `POST /api/desktop/signout`: bearer token; revokes the pairing.

Pairing approval belongs in the authenticated MoonBridge web app. The server must derive worker, shift, site, and client from that web session, enforce one active pairing per device, validate intervals, and expose the timecard report. These server and web changes are separate from this client.

## Data and handoff

The app stores its state in the Windows application data folder, protected with Windows DPAPI for the current Windows account. A shared Windows account means DPAPI does not distinguish workers; the app does not expose prior tokens in the UI. The server remains authoritative for worker identity and revocation.

Change worker clears local attribution immediately, retains unsent intervals for review, and retries server signout. The next worker must pair online. If the app is closed from the tray or Windows is asleep, the resulting gap is unverified. No screenshots, typed content, or application contents are collected.

## Current scope

This client is ready for integration with the authenticated staging API. An unsigned NSIS installer can be built with `npm.cmd run tauri build -- --bundles nsis`. A complete end-to-end staging run and code signing have not yet been verified. The idle threshold is currently five minutes.
