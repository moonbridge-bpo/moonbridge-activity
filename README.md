# MoonBridge Activity

MoonBridge Activity pairs a Windows desktop companion with a web timecard. The Tauri app records active and idle keyboard/mouse **intervals**, queues them during connection loss, and binds each interval to the worker and shift approved by the web app. It does not capture screenshots, typed text, or app content.

## Repository

- [`desktop/`](desktop/) — Tauri 2 Windows companion, tray process, pairing, activity sampling, local queue, and shared-computer handoff.
- [`local-web/`](local-web/) — local-only test web app with synthetic workers, a SQLite-backed desktop API, timecard controls, and an activity report.
- [`WEB-APP-INTEGRATION-BUILD-INSTRUCTIONS.md`](WEB-APP-INTEGRATION-BUILD-INSTRUCTIONS.md) — instructions for integrating the desktop API and pairing flow into the existing MoonBridge web solution.

The test web app is for local validation. Production web authentication, site permissions, deployment, and code signing still require integration work.

## Download

- [MoonBridge Activity download page](https://moonbridge-bpo.github.io/moonbridge-activity-downloads/)
- [Windows v0.1.0 team test release](https://github.com/moonbridge-bpo/moonbridge-activity/releases/tag/v0.1.0)

The download page is hosted in a separate public [MoonBridge repository](https://github.com/moonbridge-bpo/moonbridge-activity-downloads) because GitHub Pages is unavailable for this private source repository on the organization's current plan. The installer release remains private and requires GitHub access. The installer is currently unsigned.

## Build and test

See [`desktop/README.md`](desktop/README.md) for Windows prerequisites and Tauri commands. In `desktop/`, run `npm install`, then `npm run build` for the frontend or `npm run tauri build -- --bundles nsis` for the Windows installer.

See [`local-web/README.md`](local-web/README.md) to run the local test web app. In `local-web/`, run `npm test` for the integration tests.
