# Remote Telemetry for N.I.N.A.

A N.I.N.A. 3.x plugin that runs a small, **read-only** HTTP server inside NINA and publishes live session telemetry as JSON, plus a built-in multi-device dashboard.

- Connected equipment: camera, mount, guider, focuser, filter wheel, rotator, dome, flat panel, switches
- Weather and safety monitor
- Advanced sequence state, current target, running instructions
- Last saved frame: metadata, HFR, star count, statistics and an auto-stretched JPEG preview
- NINA log tail and a separate errors/warnings feed
- Image history (HFR / stars chart)

## Install / build

```powershell
dotnet build -c Release
```

The build copies the DLL to `%LOCALAPPDATA%\NINA\Plugins\3.0.0\Naztronomy.NINA.RemoteTelemetry`. Restart NINA, then open **Options → Plugins → Remote Telemetry**.

To produce a release zip + manifest: `./Package-Plugin.ps1 -InstallerUrl <release-zip-url>`.

## Settings

| Setting           | Default | Notes                                                                                          |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------- |
| Server enabled    | on      |                                                                                                |
| Port              | `8787`  | Windows Firewall may prompt to allow NINA on first start.                                      |
| API key           | empty   | When set, `/api/*` requires `X-Api-Key: <key>`, `Authorization: Bearer <key>` or `?key=<key>`. |
| Allowed origins   | `*`     | CORS. Restrict to e.g. `http://100.101.102.103:8787` if you host the dashboard elsewhere.      |
| Preview max width | `1280`  | Width of the JPEG preview.                                                                     |

The options page lists the URLs this machine is reachable on (LAN, Tailscale `100.x` address, hostname).

## Dashboard

Open `http://<nina-host>:8787/` in a browser. The page served by any NINA instance can add **other** NINA instances (Devices → Add); the device list and layout are stored in the browser's local storage. The chips in the top bar show each device's health (green = OK, amber = unsafe or errors, red = offline, ▶ = sequence running).

- **Full view**: pick a NINA from the view dropdown (or click its chip) to see every card for that instance.
- **My dashboard**: a custom layout where each card has its own source, e.g. _Guiding_ from NINA A and NINA B side by side plus _Last frame_ from NINA A. Use **Edit layout → Add card**, then ◀ ▶ to reorder, ⇔ to change width, ✕ to remove.

Each NINA is polled once no matter how many cards use it.

Because each NINA serves the dashboard over plain HTTP, there are no mixed-content problems. If you host the `Web/` files on an HTTPS site instead, browsers will block calls to `http://` NINA instances; use [Tailscale Serve](https://tailscale.com/kb/1312/serve) to put each NINA behind HTTPS in that case.

## API (v1)

All responses are JSON (camelCase, UTC timestamps, `null` for unavailable values). Only `GET`/`HEAD`/`OPTIONS` are accepted; nothing can control NINA.

| Endpoint                                           | Description                                                                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/openapi.json`                         | OpenAPI 3 spec with every field documented (no API key needed). Import into Postman/Insomnia or any OpenAPI tool. Source: [Api/openapi.json](Naztronomy.NINA.RemoteTelemetry/Api/openapi.json) |
| `GET /api/v1/info`                                 | Plugin/NINA version, machine name, profile, site location, server time                                                                                                                         |
| `GET /api/v1/status`                               | Everything the dashboard needs in one call: info, safety, sequence, devices, last image, issue summary                                                                                         |
| `GET /api/v1/devices`                              | All device snapshots (`connected`, `name`, `driver` + device-specific fields)                                                                                                                  |
| `GET /api/v1/weather`                              | Weather device snapshot                                                                                                                                                                        |
| `GET /api/v1/safety`                               | `{ connected, name, isSafe, state: "safe" \| "unsafe" \| "unknown" }`                                                                                                                          |
| `GET /api/v1/sequence`                             | `isRunning`, `activeTarget`, `runningItems`, `targets`                                                                                                                                         |
| `GET /api/v1/sequence/targets`                     | Advanced Sequencer targets: per-instruction done / total frames, imaged and remaining exposure time                                                                                            |
| `GET /api/v1/images?limit=50`                      | Metadata of recent saved frames (max 300, since NINA start)                                                                                                                                    |
| `GET /api/v1/images/latest`                        | Metadata of the last saved frame                                                                                                                                                               |
| `GET /api/v1/images/latest/preview.jpg`            | JPEG preview of the last saved frame (`X-Image-Id` header)                                                                                                                                     |
| `GET /api/v1/logs?limit=200&level=Info&after=<id>` | Log tail; `after` returns only newer entries                                                                                                                                                   |
| `GET /api/v1/issues?limit=100`                     | Recent warnings/errors/fatals                                                                                                                                                                  |
| `GET /api/v1/guiding?after=<unixMs>&limit=600`     | Guide steps (RA/Dec error in px and ″, correction pulses in ms) and dither times; `after` returns only newer steps                                                                             |
| `GET /api/v1/scheduler`                            | Target Scheduler right now: imaging / waiting / stopped, project, target, filter, exposure, when the target sets                                                                               |
| `GET /api/v1/scheduler/plan`                       | Tonight's plan (Target Scheduler preview), refreshed automatically once an hour                                                                                                                |
| `POST /api/v1/scheduler/plan/refresh`              | Re-run the preview now (15 s cooldown). Changes nothing in NINA                                                                                                                                |
| `GET /api/v1/scheduler/progress`                   | Projects → targets → per-filter desired / acquired / accepted, remaining count and exposure time                                                                                               |
| `GET /api/v1/scheduler/targets/{id}/statistics`    | HFR / FWHM / eccentricity per filter for a target                                                                                                                                              |
| `GET /api/v1/allsky`                               | Latest all-sky image metadata (`imageId`, file name, time, error)                                                                                                                              |
| `POST /api/v1/allsky/refresh`                      | Re-read the all-sky source now                                                                                                                                                                 |
| `GET /api/v1/allsky/image?v=<imageId>&t=<now>`     | The all-sky image (`v`/`t` are cache busters)                                                                                                                                                  |

### Target Scheduler

Enable **API** in Target Scheduler's profile preferences, then check the port (default 8188) under **Target Scheduler** in this plugin's options. Target Scheduler's API has no authentication, so this plugin only calls it on the NINA machine itself and re-serves the data through its own API and key. Leave Target Scheduler's port closed to the network.

Example:

```powershell
Invoke-RestMethod http://astro-pc:8787/api/v1/status -Headers @{ 'X-Api-Key' = '...' }
```

## Security

- Intended for a trusted private network such as Tailscale. **Do not port-forward it to the internet.**
- The API is read-only, but it exposes log content and file names. Set an API key if others share the network.
- Requests are limited to 16 KB headers, 10 s, and 32 concurrent connections. Static files are served only from an embedded allow-list.
-

## Authors

- **Nazmus Nasir** - [Naztronomy](https://www.naztronomy.com)

### Social Media & Support:

- **YouTube** - [YouTube.com/Naztronomy](https://www.youtube.com/naztronomy)
- **Patreon** - [Become a Patron](https://www.patreon.com/c/naztronomy)
- **Buy Me a Coffee** - [Become a Supporter](https://www.buymeacoffee.com/naztronomy)
- **Discord** - [Join our Online community](https://discord.gg/yXKqrawpjr)
- **Bluesky** - [Bluesky/Naztronomy.com](https://bsky.app/profile/naztronomy.com)
- **Instagram** - [IG/Naztronomy](https://instagram.com/naztronomy)

## Support the Project

If these scripts have been useful to you, consider supporting the project — it helps fund continued development and new features:

- **Patreon** — [patreon.com/c/naztronomy](https://www.patreon.com/c/naztronomy)
- **Buy Me a Coffee** — [buymeacoffee.com/naztronomy](https://www.buymeacoffee.com/naztronomy)
- **YouTube Memberships** — [youtube.com/naztronomy/join](https://www.youtube.com/naztronomy/join)
- **GitHub Sponsors** — [github.com/sponsors/naztronomy](https://github.com/sponsors/naztronaut)

## Support & Questions

Have questions? You can reach out through several channels:

- Create an issue in the [issues forum](/../../issues)
- Join our [Discord community](https://discord.gg/yXKqrawpjr)
- Comment on the demo videos on YouTube
- Check the help sections within each script

## Contributing

Pull requests are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for full guidelines. Key points:

- **All pull requests must target the `develop` branch** — do not open PRs against `main` directly
- **New features must be non-breaking** — all existing functionality must continue to work as expected
- Test your changes thoroughly before submitting
- Follow the existing code style and update documentation as needed
- Bug fixes and new features will be reviewed before merging
