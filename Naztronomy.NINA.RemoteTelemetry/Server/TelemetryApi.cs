#region "copyright"

/*
    Copyright (c) 2026 Naztronomy

    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/
*/

#endregion "copyright"

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Naztronomy.NINA.RemoteTelemetry.Telemetry;

namespace Naztronomy.NINA.RemoteTelemetry.Server {

    /// <summary>Routes HTTP requests to telemetry snapshots and the embedded dashboard.</summary>
    public sealed class TelemetryApi {
        private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DictionaryKeyPolicy = JsonNamingPolicy.CamelCase,
            NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
            Converters = { new JsonStringEnumConverter() },
        };

        private static readonly Dictionary<string, (string Resource, string ContentType)> StaticFiles = new(StringComparer.OrdinalIgnoreCase) {
            ["/"] = ("web/index.html", "text/html; charset=utf-8"),
            ["/index.html"] = ("web/index.html", "text/html; charset=utf-8"),
            ["/app.js"] = ("web/app.js", "text/javascript; charset=utf-8"),
            ["/styles.css"] = ("web/styles.css", "text/css; charset=utf-8"),
            ["/favicon.svg"] = ("web/favicon.svg", "image/svg+xml"),
        };

        private const string DashboardCsp =
            "default-src 'self'; connect-src *; img-src 'self' http: https: data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

        private readonly TelemetryCollector collector;
        private readonly ImageTracker images;
        private readonly LogTracker logs;
        private readonly GuideTracker guiding;
        private readonly TargetSchedulerTracker scheduler;
        private readonly AllSkyService allSky;
        private readonly SequenceTracker sequenceTracker;
        private readonly AutoFocusTracker autoFocus;
        private readonly Func<double?> guiderPixelScale;
        private readonly Func<string> apiKey;
        private readonly Func<string> allowedOrigins;

        public TelemetryApi(TelemetryCollector collector, ImageTracker images, LogTracker logs, GuideTracker guiding, TargetSchedulerTracker scheduler, AllSkyService allSky, SequenceTracker sequenceTracker, AutoFocusTracker autoFocus, Func<double?> guiderPixelScale, Func<string> apiKey, Func<string> allowedOrigins) {
            this.collector = collector;
            this.images = images;
            this.logs = logs;
            this.guiding = guiding;
            this.scheduler = scheduler;
            this.allSky = allSky;
            this.sequenceTracker = sequenceTracker;
            this.autoFocus = autoFocus;
            this.guiderPixelScale = guiderPixelScale;
            this.apiKey = apiKey;
            this.allowedOrigins = allowedOrigins;
        }

        public async Task<HttpResponse> HandleAsync(HttpRequest req) {
            var response = await RouteAsync(req).ConfigureAwait(false);
            ApplyCors(req, response);
            return response;
        }

        private async Task<HttpResponse> RouteAsync(HttpRequest req) {
            if (req.Method == "OPTIONS") {
                var preflight = new HttpResponse { Status = 204 };
                if (req.Header("Access-Control-Request-Private-Network") == "true") {
                    preflight.Headers["Access-Control-Allow-Private-Network"] = "true";
                }
                return preflight;
            }

            var path = req.Path.TrimEnd('/');
            if (path.Length == 0) {
                path = "/";
            }

            // The only non-GET calls just re-read data; nothing in NINA changes.
            var isPost = path.Equals("/api/v1/scheduler/plan/refresh", StringComparison.OrdinalIgnoreCase)
                || path.Equals("/api/v1/allsky/refresh", StringComparison.OrdinalIgnoreCase);
            if (isPost ? req.Method != "POST" : req.Method != "GET" && req.Method != "HEAD") {
                return Error(405, isPost ? "Use POST." : "Only GET is supported.");
            }

            if (StaticFiles.TryGetValue(path, out var file)) {
                return Static(file.Resource, file.ContentType);
            }

            if (!path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase)) {
                return Error(404, "Not found.");
            }

            // The spec contains no telemetry, so it is readable without the API key.
            if (path.Equals("/api/v1/openapi.json", StringComparison.OrdinalIgnoreCase)) {
                return Static("api/openapi.json", "application/json; charset=utf-8");
            }

            if (!IsAuthorized(req)) {
                return Error(401, "Missing or invalid API key.");
            }

            switch (path.ToLowerInvariant()) {
                case "/api/v1/info":
                    return Json(collector.GetInfo());

                case "/api/v1/status":
                    return Json(collector.GetStatus());

                case "/api/v1/devices":
                    return Json(collector.GetDevices());

                case "/api/v1/weather":
                    return Json(collector.GetDevices()["weather"]);

                case "/api/v1/safety":
                    return Json(collector.GetSafety());

                case "/api/v1/sequence":
                    return Json(collector.GetSequence());

                case "/api/v1/sequence/targets":
                    using (var cts = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(15))) {
                        return Json(await sequenceTracker.GetAsync(cts.Token).ConfigureAwait(false));
                    }

                case "/api/v1/images":
                    return Json(images.GetHistory(req.QueryInt("limit", 50, 1, 300)));

                case "/api/v1/images/latest":
                    var latest = images.Latest;
                    return latest == null ? Error(404, "No image has been saved since NINA started.") : Json(latest);

                case "/api/v1/images/latest/preview.jpg":
                    var (jpeg, imageId) = images.GetPreview();
                    if (jpeg == null) {
                        return Error(404, "No preview available yet.");
                    }
                    var img = new HttpResponse { ContentType = "image/jpeg", Body = jpeg };
                    img.Headers["Cache-Control"] = "no-store";
                    img.Headers["X-Image-Id"] = imageId.ToString();
                    return img;

                case "/api/v1/logs":
                    var minLevel = Enum.TryParse<LogLevel>(req.QueryValue("level"), true, out var lvl) ? lvl : LogLevel.Info;
                    long.TryParse(req.QueryValue("after"), out var after);
                    return Json(new {
                        file = Path.GetFileName(logs.CurrentFile ?? string.Empty),
                        entries = logs.GetEntries(req.QueryInt("limit", 200, 1, 5000), minLevel, after),
                    });

                case "/api/v1/issues":
                    return Json(logs.GetIssues(req.QueryInt("limit", 100, 1, 500)));

                case "/api/v1/guiding":
                    long.TryParse(req.QueryValue("after"), out var afterMs);
                    return Json(guiding.Get(afterMs, req.QueryInt("limit", 600, 1, 1200), guiderPixelScale()));

                case "/api/v1/scheduler":
                    return Json(scheduler.GetNow());

                case "/api/v1/scheduler/plan":
                    return Json(scheduler.GetPlan());

                case "/api/v1/scheduler/plan/refresh":
                    using (var cts = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(90))) {
                        return Json(await scheduler.RefreshPlanAsync(cts.Token, manual: true).ConfigureAwait(false));
                    }

                case "/api/v1/scheduler/progress":
                    return Json(scheduler.GetProgress());

                case "/api/v1/autofocus":
                    return Json(autoFocus.Get());

                case "/api/v1/allsky":
                case "/api/v1/allsky/refresh":
                    using (var cts = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(30))) {
                        return Json(await allSky.GetInfoAsync(force: req.Method == "POST", cts.Token).ConfigureAwait(false));
                    }

                case "/api/v1/allsky/image":
                    using (var cts = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(30))) {
                        var (skyBytes, skyType, skyId) = await allSky.GetImageAsync(cts.Token).ConfigureAwait(false);
                        if (skyBytes == null) {
                            return Error(404, "No all-sky image available.");
                        }
                        var sky = new HttpResponse { ContentType = skyType, Body = skyBytes };
                        sky.Headers["Cache-Control"] = "no-store";
                        sky.Headers["X-Image-Id"] = skyId;
                        return sky;
                    }
            }

            const string statsPrefix = "/api/v1/scheduler/targets/";
            if (path.StartsWith(statsPrefix, StringComparison.OrdinalIgnoreCase) && path.EndsWith("/statistics", StringComparison.OrdinalIgnoreCase)) {
                // Only a parsed GUID is ever forwarded to the TS API.
                var idText = path.Substring(statsPrefix.Length, path.Length - statsPrefix.Length - "/statistics".Length);
                if (!Guid.TryParse(idText, out var targetId)) {
                    return Error(400, "Target id must be a GUID.");
                }
                try {
                    using var cts = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(30));
                    return Json(await scheduler.GetStatisticsAsync(targetId, cts.Token).ConfigureAwait(false));
                } catch (Exception ex) when (ex is System.Net.Http.HttpRequestException || ex is InvalidOperationException || ex is TaskCanceledException || ex is JsonException) {
                    return Error(503, $"Target Scheduler API not available: {ex.Message}");
                }
            }

            return Error(404, "Unknown endpoint.");
        }

        private bool IsAuthorized(HttpRequest req) {
            var expected = apiKey();
            if (string.IsNullOrEmpty(expected)) {
                return true;
            }

            var provided = req.Header("X-Api-Key");
            var auth = req.Header("Authorization");
            if (provided == null && auth != null && auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) {
                provided = auth.Substring(7).Trim();
            }
            // Query string fallback so <img src> can load the preview.
            provided ??= req.QueryValue("key");
            if (provided == null) {
                return false;
            }

            return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(provided), Encoding.UTF8.GetBytes(expected));
        }

        private void ApplyCors(HttpRequest req, HttpResponse res) {
            var origin = req.Header("Origin");
            var allowed = (allowedOrigins() ?? string.Empty).Trim();

            if (allowed == "*" || allowed.Length == 0) {
                res.Headers["Access-Control-Allow-Origin"] = "*";
            } else if (origin != null) {
                var list = allowed.Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (list.Any(o => string.Equals(o.TrimEnd('/'), origin, StringComparison.OrdinalIgnoreCase))) {
                    res.Headers["Access-Control-Allow-Origin"] = origin;
                }
                res.Headers["Vary"] = "Origin";
            }

            res.Headers["Access-Control-Allow-Methods"] = "GET, HEAD, POST, OPTIONS";
            res.Headers["Access-Control-Allow-Headers"] = "X-Api-Key, Authorization";
            res.Headers["Access-Control-Expose-Headers"] = "X-Image-Id";
            res.Headers["Access-Control-Max-Age"] = "600";
        }

        private static HttpResponse Json(object value) {
            var res = new HttpResponse { Body = JsonSerializer.SerializeToUtf8Bytes(value, value?.GetType() ?? typeof(object), JsonOptions) };
            res.Headers["Cache-Control"] = "no-store";
            return res;
        }

        private static HttpResponse Error(int status, string message) {
            var res = new HttpResponse { Status = status, Body = JsonSerializer.SerializeToUtf8Bytes(new { error = message }, JsonOptions) };
            res.Headers["Cache-Control"] = "no-store";
            return res;
        }

        private static HttpResponse Static(string resource, string contentType) {
            using var stream = typeof(TelemetryApi).Assembly.GetManifestResourceStream(resource);
            if (stream == null) {
                return Error(404, "Not found.");
            }
            using var ms = new MemoryStream();
            stream.CopyTo(ms);
            var res = new HttpResponse { ContentType = contentType, Body = ms.ToArray() };
            res.Headers["Cache-Control"] = "no-cache";
            res.Headers["Content-Security-Policy"] = DashboardCsp;
            res.Headers["Referrer-Policy"] = "no-referrer";
            return res;
        }
    }
}
