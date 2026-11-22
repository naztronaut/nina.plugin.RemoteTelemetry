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
using System.Text.RegularExpressions;
using NINA.Core.Utility;

namespace Naztronomy.NINA.RemoteTelemetry.Telemetry {

    /// <summary>
    /// Summarises PHD2 guide logs into hourly RMS for tonight and last night (nights run noon to noon, PC local time).
    /// </summary>
    public sealed class GuideHistoryTracker {
        private const long MaxFileBytes = 200L * 1024 * 1024;
        private static readonly TimeSpan MaxAge = TimeSpan.FromSeconds(60);
        private static readonly Regex ScaleRegex = new(@"Pixel scale = ([0-9.,]+) arc-sec/px", RegexOptions.Compiled);

        private readonly string directory;
        private readonly object sync = new object();
        private readonly Dictionary<string, (long Length, DateTime WriteUtc, Dictionary<DateTime, Accum> Hours)> cache = new(StringComparer.OrdinalIgnoreCase);
        private object snapshot;
        private DateTime snapshotUtc;

        public GuideHistoryTracker() : this(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "PHD2")) {
        }

        public GuideHistoryTracker(string directory) {
            this.directory = directory;
        }

        private sealed class Accum {
            public long Frames;
            public long Dropped;
            public double SumRa, SumRa2, SumDec, SumDec2;

            public void Add(double ra, double dec) {
                Frames++;
                SumRa += ra;
                SumRa2 += ra * ra;
                SumDec += dec;
                SumDec2 += dec * dec;
            }

            public void Merge(Accum o) {
                Frames += o.Frames;
                Dropped += o.Dropped;
                SumRa += o.SumRa;
                SumRa2 += o.SumRa2;
                SumDec += o.SumDec;
                SumDec2 += o.SumDec2;
            }

            // PHD2 reports RMS as the standard deviation about the mean.
            private static double Sd(double sum, double sum2, long n) =>
                n == 0 ? 0 : Math.Sqrt(Math.Max(0, sum2 / n - (sum / n) * (sum / n)));

            public object ToJson(DateTime? hourLocal) {
                var ra = Sd(SumRa, SumRa2, Frames);
                var dec = Sd(SumDec, SumDec2, Frames);
                return new {
                    startUtc = hourLocal.HasValue ? ToUtc(hourLocal.Value) : (DateTime?)null,
                    frames = Frames,
                    dropped = Dropped,
                    ra = Frames > 0 ? Math.Round(ra, 3) : (double?)null,
                    dec = Frames > 0 ? Math.Round(dec, 3) : (double?)null,
                    total = Frames > 0 ? Math.Round(Math.Sqrt(ra * ra + dec * dec), 3) : (double?)null,
                };
            }
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

        private static DateTime ToUtc(DateTime local) =>
            TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), TimeZoneInfo.Local);

        private object Build() {
            var now = DateTime.Now;
            var tonight = now.Date.AddHours(now.Hour >= 12 ? 12 : -12);
            var lastNight = tonight.AddDays(-1);

            List<FileInfo> files;
            try {
                var dir = new DirectoryInfo(directory);
                if (!dir.Exists) {
                    return new { available = false, folder = directory, error = (string)null, nights = Array.Empty<object>() };
                }
                files = dir.EnumerateFiles("PHD2_GuideLog*.txt")
                    .Where(f => f.LastWriteTime >= lastNight && f.Length <= MaxFileBytes)
                    .ToList();
            } catch (Exception ex) {
                return new { available = false, folder = directory, error = ex.Message, nights = Array.Empty<object>() };
            }

            var hours = new Dictionary<DateTime, Accum>();
            foreach (var file in files) {
                var parsed = Load(file);
                if (parsed == null) {
                    continue;
                }
                foreach (var (hour, acc) in parsed) {
                    if (hour < lastNight) {
                        continue;
                    }
                    if (!hours.TryGetValue(hour, out var total)) {
                        hours[hour] = total = new Accum();
                    }
                    total.Merge(acc);
                }
            }
            foreach (var stale in cache.Keys.Except(files.Select(f => f.FullName), StringComparer.OrdinalIgnoreCase).ToList()) {
                cache.Remove(stale);
            }

            object Night(string label, DateTime start) {
                var end = start.AddDays(1);
                var inNight = hours.Where(h => h.Key >= start && h.Key < end).OrderBy(h => h.Key).ToList();
                var overall = new Accum();
                foreach (var h in inNight) {
                    overall.Merge(h.Value);
                }
                return new {
                    label,
                    startUtc = ToUtc(start),
                    endUtc = ToUtc(end),
                    overall = overall.ToJson(null),
                    hours = inNight.Select(h => h.Value.ToJson(h.Key)).ToList(),
                };
            }

            return new {
                available = true,
                folder = directory,
                error = (string)null,
                nights = new[] { Night("Tonight", tonight), Night("Last night", lastNight) },
            };
        }

        private Dictionary<DateTime, Accum> Load(FileInfo file) {
            if (cache.TryGetValue(file.FullName, out var hit) && hit.Length == file.Length && hit.WriteUtc == file.LastWriteTimeUtc) {
                return hit.Hours;
            }
            try {
                var hours = Parse(file.FullName);
                cache[file.FullName] = (file.Length, file.LastWriteTimeUtc, hours);
                return hours;
            } catch (Exception ex) {
                Logger.Debug($"Remote Telemetry: skipping PHD2 log {file.Name}: {ex.Message}");
                return null;
            }
        }

        private static Dictionary<DateTime, Accum> Parse(string path) {
            var hours = new Dictionary<DateTime, Accum>();
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream);

            DateTime? guideStart = null;
            double? scale = null;
            var settling = false;
            string line;
            while ((line = reader.ReadLine()) != null) {
                if (line.Length == 0) {
                    continue;
                }
                if (char.IsDigit(line[0])) {
                    if (guideStart == null || settling) {
                        continue;
                    }
                    var f = line.Split(',');
                    if (f.Length < 7 || !double.TryParse(f[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var t)) {
                        continue;
                    }
                    var hour = guideStart.Value.AddSeconds(t);
                    hour = hour.Date.AddHours(hour.Hour);
                    if (!hours.TryGetValue(hour, out var acc)) {
                        hours[hour] = acc = new Accum();
                    }
                    if (f[2] == "\"DROP\"") {
                        acc.Dropped++;
                    } else if (scale.HasValue
                        && double.TryParse(f[5], NumberStyles.Float, CultureInfo.InvariantCulture, out var ra)
                        && double.TryParse(f[6], NumberStyles.Float, CultureInfo.InvariantCulture, out var dec)) {
                        acc.Add(ra * scale.Value, dec * scale.Value);
                    }
                } else if (line.StartsWith("Guiding Begins at ", StringComparison.Ordinal)) {
                    guideStart = DateTime.TryParseExact(line.Substring(18).Trim(), "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.None, out var s) ? s : null;
                    scale = null;
                    settling = false;
                } else if (line.StartsWith("Guiding Ends", StringComparison.Ordinal) || line.StartsWith("Calibration Begins", StringComparison.Ordinal)) {
                    guideStart = null;
                } else if (line.StartsWith("INFO: SETTLING STATE CHANGE", StringComparison.Ordinal)) {
                    // Frames while settling after a dither would inflate the RMS, as in PHD2's own log viewer.
                    settling = line.Contains("Settling started", StringComparison.OrdinalIgnoreCase);
                } else if (guideStart != null && scale == null && line.Contains("Pixel scale = ", StringComparison.Ordinal)) {
                    var m = ScaleRegex.Match(line);
                    if (m.Success && double.TryParse(m.Groups[1].Value.Replace(',', '.').TrimEnd('.'), NumberStyles.Float, CultureInfo.InvariantCulture, out var ps) && ps > 0) {
                        scale = ps;
                    }
                }
            }
            return hours;
        }
    }
}
