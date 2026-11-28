# Changelog

## Unreleased

### Added

- **Target Scheduler**: tonight's plan, project/target progress with per-filter breakdown, imaged time per target and project, and the running target on the Overview.
- **Guiding history** card: hourly RMS for tonight and last night from PHD2's guide logs (`GET /api/v1/guiding/history`).
- **Autofocus** card: latest focus curve, fit, R² and recent focus positions (`GET /api/v1/autofocus`).
- **All-sky** card from a file, folder or URL.
- **HTTPS on your tailnet**: optional Tailscale Serve setup from the plugin options.
- **Hosted dashboard** support (static site for Cloudflare Pages); see the nina-remote-telemetry-web repo.
- **Frame viewer** for the 12 most recent frames, with zoom and pan (`GET /api/v1/images/{id}/preview.jpg`).
- **At a glance** strip: safety, sequence, target, guiding RMS, HFR trend, meridian flip and time to dawn/dark.
- Guide graph hover values, target band and RMS in arcseconds (kept after the guider disconnects).
- Dashboard: collapsible cards, drag-and-drop layout, reset layout, compact mode, card snapshots (JPG/clipboard), and config export/import.
- **Cards per NINA**: choose which cards each NINA shows; hidden cards make no API requests and the choice is exported with the config. Log, Errors & warnings and Guiding history are off by default.
- **Help** (top bar, or press `?`): what each part of the screen and each card shows, keyboard shortcuts and where to get help. Card titles and top-bar buttons have tooltips.

### Changed

- Target Scheduler progress: projects collapse to a single list with Expand all / Collapse all, aligned columns, row hover highlighting and a live indicator for the imaging target.
- Accessibility: keyboard focus outlines, skip link, tab roles and reduced-motion support; device chips announce their status, charts have text descriptions, and the At a glance strip no longer interrupts screen readers on every refresh.

## 1.0.0.0

- Initial release: read-only telemetry HTTP API, multi-device dashboard, last-frame preview, log and errors/warnings feeds.
