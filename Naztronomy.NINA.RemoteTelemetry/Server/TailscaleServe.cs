#region "copyright"

/*
    Copyright (c) 2026 Naztronomy

    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/
*/

#endregion "copyright"

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using NINA.Core.Utility;

namespace Naztronomy.NINA.RemoteTelemetry.Server {

    /// <summary>
    /// Publishes the dashboard over HTTPS on the tailnet with "tailscale serve" (never Funnel).
    /// Only the HTTPS port rule that points at this plugin is ever added or removed.
    /// </summary>
    public sealed class TailscaleServe {
        private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(25);
        private readonly SemaphoreSlim gate = new SemaphoreSlim(1, 1);

        public sealed record State(bool Active, string Url, string Message);

        /// <summary>Adds or removes the rule so it matches <paramref name="enabled"/>, then reports the result.</summary>
        public async Task<State> ApplyAsync(bool enabled, int httpsPort, int localPort) {
            await gate.WaitAsync().ConfigureAwait(false);
            try {
                var exe = FindExe();
                if (exe == null) {
                    return new State(false, null, enabled ? "Tailscale is not installed on this PC." : "Off");
                }

                var (host, certsEnabled, error) = await ReadStatusAsync(exe).ConfigureAwait(false);
                if (error != null) {
                    return new State(false, null, error);
                }

                var (rule, otherTarget) = await FindRuleAsync(exe, host, httpsPort, localPort).ConfigureAwait(false);
                var url = $"https://{host}:{httpsPort}/";

                if (!enabled) {
                    if (rule) {
                        var off = await RunAsync(exe, $"serve --yes --https={httpsPort} off").ConfigureAwait(false);
                        if (off.ExitCode != 0) {
                            return new State(true, url, $"Could not turn off: {Clean(off.Output)}");
                        }
                        Logger.Info($"Remote Telemetry: removed Tailscale Serve rule on port {httpsPort}");
                    }
                    return new State(false, null, "Off");
                }

                if (rule) {
                    return new State(true, url, $"Active: {url}");
                }
                if (otherTarget != null) {
                    return new State(false, null, $"HTTPS port {httpsPort} is already used by another Serve rule ({otherTarget}). Pick a different port.");
                }
                if (!certsEnabled) {
                    return new State(false, null, "HTTPS certificates are not enabled for your tailnet. Turn on MagicDNS and HTTPS Certificates in the Tailscale admin console (DNS page), then click Check.");
                }

                var on = await RunAsync(exe, $"serve --bg --yes --https={httpsPort} http://127.0.0.1:{localPort}").ConfigureAwait(false);
                if (on.ExitCode != 0) {
                    var output = Clean(on.Output);
                    var hint = output.Contains("access denied", StringComparison.OrdinalIgnoreCase) || output.Contains("permission", StringComparison.OrdinalIgnoreCase)
                        ? $" Run this once in an administrator terminal instead: tailscale serve --bg --https={httpsPort} http://127.0.0.1:{localPort}"
                        : string.Empty;
                    return new State(false, null, $"Could not enable: {output}{hint}");
                }
                Logger.Info($"Remote Telemetry: Tailscale Serve rule added: {url} -> 127.0.0.1:{localPort}");
                return new State(true, url, $"Active: {url}");
            } catch (Exception ex) {
                Logger.Warning($"Remote Telemetry: Tailscale Serve failed: {ex.Message}");
                return new State(false, null, $"Problem: {ex.Message}");
            } finally {
                gate.Release();
            }
        }

        private static string FindExe() {
            var candidates = new[] {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Tailscale", "tailscale.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Tailscale", "tailscale.exe"),
            }.Concat((Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Select(dir => Path.Combine(dir.Trim(), "tailscale.exe")));
            return candidates.FirstOrDefault(File.Exists);
        }

        private static async Task<(string Host, bool CertsEnabled, string Error)> ReadStatusAsync(string exe) {
            var res = await RunAsync(exe, "status --json").ConfigureAwait(false);
            if (res.ExitCode != 0) {
                return (null, false, $"Tailscale is not running or not logged in ({Clean(res.Output)}).");
            }
            using var doc = JsonDocument.Parse(res.Output);
            var root = doc.RootElement;
            var backend = root.TryGetProperty("BackendState", out var b) ? b.GetString() : null;
            if (backend != "Running") {
                return (null, false, $"Tailscale is not connected (state: {backend ?? "unknown"}).");
            }
            var host = root.TryGetProperty("Self", out var self) && self.TryGetProperty("DNSName", out var dns)
                ? dns.GetString()?.TrimEnd('.')
                : null;
            if (string.IsNullOrEmpty(host)) {
                return (null, false, "MagicDNS is off for your tailnet. Turn it on in the Tailscale admin console (DNS page).");
            }
            var certs = root.TryGetProperty("CertDomains", out var cd) && cd.ValueKind == JsonValueKind.Array && cd.GetArrayLength() > 0;
            return (host, certs, null);
        }

        // Returns whether our rule exists, or what another rule on the same port points to.
        private static async Task<(bool Ours, string OtherTarget)> FindRuleAsync(string exe, string host, int httpsPort, int localPort) {
            var res = await RunAsync(exe, "serve status --json").ConfigureAwait(false);
            if (res.ExitCode != 0 || string.IsNullOrWhiteSpace(res.Output)) {
                return (false, null);
            }
            using var doc = JsonDocument.Parse(res.Output);
            if (!doc.RootElement.TryGetProperty("Web", out var web) || web.ValueKind != JsonValueKind.Object) {
                return (false, null);
            }
            foreach (var site in web.EnumerateObject()) {
                if (!site.Name.EndsWith($":{httpsPort}", StringComparison.Ordinal)) {
                    continue;
                }
                var target = site.Value.TryGetProperty("Handlers", out var handlers) && handlers.TryGetProperty("/", out var rootHandler) && rootHandler.TryGetProperty("Proxy", out var proxy)
                    ? proxy.GetString()
                    : "a custom handler";
                var ours = target != null && Regex.IsMatch(target, $@"^(https?://)?(127\.0\.0\.1|localhost):{localPort}/?$", RegexOptions.IgnoreCase);
                return ours ? (true, null) : (false, target);
            }
            return (false, null);
        }

        private static async Task<(int ExitCode, string Output)> RunAsync(string exe, string args) {
            var psi = new ProcessStartInfo(exe, args) {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
            };
            using var p = Process.Start(psi) ?? throw new InvalidOperationException("Could not start tailscale.exe");
            // Close stdin so an unexpected interactive prompt fails instead of hanging.
            p.StandardInput.Close();
            var stdout = p.StandardOutput.ReadToEndAsync();
            var stderr = p.StandardError.ReadToEndAsync();
            using var cts = new CancellationTokenSource(CommandTimeout);
            try {
                await p.WaitForExitAsync(cts.Token).ConfigureAwait(false);
            } catch (OperationCanceledException) {
                try { p.Kill(entireProcessTree: true); } catch { }
                return (-1, "tailscale did not respond in time.");
            }
            var output = (await stdout.ConfigureAwait(false)) + (await stderr.ConfigureAwait(false));
            return (p.ExitCode, output);
        }

        private static string Clean(string output) {
            var text = Regex.Replace(output ?? string.Empty, @"\s+", " ").Trim();
            return text.Length > 300 ? text[..300] + "…" : text;
        }
    }
}
