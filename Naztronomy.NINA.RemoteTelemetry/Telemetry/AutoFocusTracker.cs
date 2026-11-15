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
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using NINA.Core.Utility;
using NINA.WPF.Base.ViewModel.AutoFocus;

namespace Naztronomy.NINA.RemoteTelemetry.Telemetry {

    /// <summary>Reads the autofocus reports NINA writes as JSON after every successful run.</summary>
    public sealed class AutoFocusTracker {
        private const int RecentCount = 10;
        private const long MaxFileBytes = 4 * 1024 * 1024;
        private static readonly TimeSpan MaxAge = TimeSpan.FromSeconds(10);

        private readonly string directory;
        private readonly object sync = new object();
        private readonly Dictionary<string, (DateTime WriteUtc, JsonElement Report)> cache = new(StringComparer.OrdinalIgnoreCase);
        private object snapshot;
        private DateTime snapshotUtc;

        public AutoFocusTracker() : this(AutoFocusVM.ReportDirectory) {
        }

        public AutoFocusTracker(string directory) {
            this.directory = directory;
        }

        public object Get() {
            lock (sync) {
                if (snapshot == null || DateTime.UtcNow - snapshotUtc >= MaxAge) {
                    snapshot = Build();
                    snapshotUtc = DateTime.UtcNow;
                }
                return snapshot;
            }
        }

        private object Build() {
            List<FileInfo> files;
            try {
                var dir = new DirectoryInfo(directory);
                files = dir.Exists
                    ? dir.EnumerateFiles("*.json").OrderByDescending(f => f.LastWriteTimeUtc).Take(RecentCount).ToList()
                    : new List<FileInfo>();
            } catch (Exception ex) {
                return new { available = false, error = ex.Message, latest = (object)null, recent = Array.Empty<object>() };
            }

            var reports = new List<(FileInfo File, JsonElement Report)>();
            foreach (var file in files) {
                var report = Load(file);
                if (report.HasValue) {
                    reports.Add((file, report.Value));
                }
            }
            foreach (var stale in cache.Keys.Except(files.Select(f => f.FullName), StringComparer.OrdinalIgnoreCase).ToList()) {
                cache.Remove(stale);
            }

            return new {
                available = reports.Count > 0,
                latest = reports.Count > 0 ? Detail(reports[0].File, reports[0].Report) : null,
                recent = reports.Select(r => Summary(r.File, r.Report)).ToList(),
            };
        }

        private JsonElement? Load(FileInfo file) {
            if (cache.TryGetValue(file.FullName, out var hit) && hit.WriteUtc == file.LastWriteTimeUtc) {
                return hit.Report;
            }
            try {
                if (file.Length > MaxFileBytes) {
                    return null;
                }
                using var stream = new FileStream(file.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var doc = JsonDocument.Parse(stream);
                var report = doc.RootElement.Clone();
                cache[file.FullName] = (file.LastWriteTimeUtc, report);
                return report;
            } catch (Exception ex) {
                // NINA may still be writing the newest file; it is picked up on the next read.
                Logger.Debug($"Remote Telemetry: skipping autofocus report {file.Name}: {ex.Message}");
                return null;
            }
        }

        private static object Summary(FileInfo file, JsonElement r) {
            var final = Point(r, "CalculatedFocusPoint");
            return new {
                id = file.Name,
                timestampUtc = Timestamp(r, file),
                filter = Str(r, "Filter"),
                temperature = Num(r, "Temperature"),
                position = final?.Position,
                value = final?.Value,
            };
        }

        private static object Detail(FileInfo file, JsonElement r) {
            var intersections = Child(r, "Intersections");
            var rSquares = Child(r, "RSquares");
            var fittings = Child(r, "Fittings");
            var backlash = Child(r, "BacklashCompensation");
            return new {
                id = file.Name,
                timestampUtc = Timestamp(r, file),
                filter = Str(r, "Filter"),
                autoFocuser = Str(r, "AutoFocuserName"),
                starDetector = Str(r, "StarDetectorName"),
                method = Str(r, "Method"),
                fitting = Str(r, "Fitting"),
                temperature = Num(r, "Temperature"),
                durationSeconds = Duration(r),
                initial = Point(r, "InitialFocusPoint"),
                calculated = Point(r, "CalculatedFocusPoint"),
                previous = Point(r, "PreviousFocusPoint"),
                points = r.TryGetProperty("MeasurePoints", out var mp) && mp.ValueKind == JsonValueKind.Array
                    ? mp.EnumerateArray().Select(ToPoint).Where(p => p != null).OrderBy(p => p.Position).ToList()
                    : new List<FocusPoint>(),
                intersections = intersections == null ? null : new {
                    trendLine = Point(intersections.Value, "TrendLineIntersection"),
                    hyperbolic = Point(intersections.Value, "HyperbolicMinimum"),
                    quadratic = Point(intersections.Value, "QuadraticMinimum"),
                    gaussian = Point(intersections.Value, "GaussianMaximum"),
                },
                rSquares = rSquares == null ? null : new {
                    quadratic = Num(rSquares.Value, "Quadratic"),
                    hyperbolic = Num(rSquares.Value, "Hyperbolic"),
                    leftTrend = Num(rSquares.Value, "LeftTrend"),
                    rightTrend = Num(rSquares.Value, "RightTrend"),
                },
                fittings = fittings == null ? null : new {
                    quadratic = Str(fittings.Value, "Quadratic"),
                    hyperbolic = Str(fittings.Value, "Hyperbolic"),
                    gaussian = Str(fittings.Value, "Gaussian"),
                    leftTrend = Str(fittings.Value, "LeftTrend"),
                    rightTrend = Str(fittings.Value, "RightTrend"),
                },
                backlash = backlash == null ? null : new {
                    model = Str(backlash.Value, "BacklashCompensationModel"),
                    @in = Num(backlash.Value, "BacklashIN"),
                    @out = Num(backlash.Value, "BacklashOUT"),
                },
            };
        }

        public sealed record FocusPoint(double Position, double? Value, double? Error);

        private static FocusPoint Point(JsonElement parent, string name) =>
            parent.TryGetProperty(name, out var p) ? ToPoint(p) : null;

        private static FocusPoint ToPoint(JsonElement p) {
            if (p.ValueKind != JsonValueKind.Object) {
                return null;
            }
            var position = Num(p, "Position");
            var value = Num(p, "Value");
            // NINA writes an all-zero point when a fit or intersection is not used.
            if (position == null || (position == 0 && (value ?? 0) == 0)) {
                return null;
            }
            return new FocusPoint(position.Value, value, Num(p, "Error"));
        }

        private static JsonElement? Child(JsonElement parent, string name) =>
            parent.TryGetProperty(name, out var c) && c.ValueKind == JsonValueKind.Object ? c : null;

        private static string Str(JsonElement parent, string name) =>
            parent.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        private static double? Num(JsonElement parent, string name) {
            if (!parent.TryGetProperty(name, out var v)) {
                return null;
            }
            if (v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) && double.IsFinite(d)) {
                return d;
            }
            if (v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out d) && double.IsFinite(d)) {
                return d;
            }
            return null;
        }

        private static DateTime Timestamp(JsonElement r, FileInfo file) {
            var text = Str(r, "Timestamp");
            if (text != null) {
                if (DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var dto)) {
                    return dto.UtcDateTime;
                }
            }
            return file.LastWriteTimeUtc;
        }

        private static double? Duration(JsonElement r) {
            var text = Str(r, "Duration");
            return text != null && TimeSpan.TryParse(text, CultureInfo.InvariantCulture, out var ts) ? Math.Round(ts.TotalSeconds, 1) : null;
        }
    }
}
