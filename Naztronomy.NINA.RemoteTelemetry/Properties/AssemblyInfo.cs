#region "copyright"

/*
    Copyright (c) 2026 Naztronomy

    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/
*/

#endregion "copyright"

using System.Reflection;
using System.Runtime.InteropServices;

// [MANDATORY] The unique identifier of the plugin. Keep this value stable for the lifetime of the plugin.
[assembly: Guid("6d2b8f3e-41c7-4a9e-b5d2-9c7e1f04a3b8")]

// [MANDATORY] The assembly versioning. Increment for each new release build of the plugin.
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

// [MANDATORY] The name of the plugin as shown in NINA.
[assembly: AssemblyTitle("Remote Telemetry")]
// [MANDATORY] A short description of the plugin.
[assembly: AssemblyDescription("Exposes a read-only JSON web API and dashboard with live NINA telemetry: devices, weather, safety, sequence, last image preview, logs and errors.")]

[assembly: AssemblyCompany("Naztronomy")]
[assembly: AssemblyProduct("Remote Telemetry")]
[assembly: AssemblyCopyright("Copyright © 2026 Naztronomy")]

// [MANDATORY] The minimum version of N.I.N.A. that this plugin is compatible with.
[assembly: AssemblyMetadata("MinimumApplicationVersion", "3.2.0.9001")]

[assembly: AssemblyMetadata("License", "MPL-2.0")]
[assembly: AssemblyMetadata("LicenseURL", "https://www.mozilla.org/en-US/MPL/2.0/")]
[assembly: AssemblyMetadata("Repository", "https://github.com/Naztronaut/NINA-Remote-Telemetry")]
[assembly: AssemblyMetadata("Homepage", "https://www.naztronomy.com/")]
[assembly: AssemblyMetadata("Tags", "Telemetry,Remote,Dashboard,API,Monitoring")]
[assembly: AssemblyMetadata("ChangelogURL", "https://github.com/Naztronaut/NINA-Remote-Telemetry/blob/main/CHANGELOG.md")]
[assembly: AssemblyMetadata("FeaturedImageURL", "")]
[assembly: AssemblyMetadata("ScreenshotURL", "")]
[assembly: AssemblyMetadata("AltScreenshotURL", "")]
[assembly: AssemblyMetadata("LongDescription", @"Remote Telemetry runs a small, read-only HTTP server inside N.I.N.A. that publishes live session telemetry as JSON:

* Connected equipment (camera, mount, focuser, filter wheel, rotator, guider, dome, flat panel, switches)
* Weather and safety monitor status
* Advanced sequence state and current target
* The last saved image: metadata, HFR, star count, statistics and a JPEG preview
* Recent log lines plus a dedicated errors/warnings feed

A built-in dashboard is served at http://<nina-host>:<port>/ . Add several NINA machines as devices in the dashboard and switch between them. Designed for use over a private network such as Tailscale; an optional API key can be required.")]

[assembly: ComVisible(false)]
