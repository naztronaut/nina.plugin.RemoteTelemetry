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
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Naztronomy.NINA.RemoteTelemetry.Telemetry {

    public enum LogLevel {
        Trace,
        Debug,
        Info,
        Warning,
        Error,
        Fatal
    }

    public sealed class LogEntry {
        public long Id { get; init; }
        public DateTime Timestamp { get; init; }
        public LogLevel Level { get; init; }
        public string Source { get; init; }
        public string Member { get; init; }
        public string Message { get; set; }
    }

    /// <summary>
    /// Tails NINA's active log file in the background and keeps recent lines plus a separate
    /// errors/warnings buffer in memory, so API requests never touch the disk.
    /// NINA lines look like <c>timestamp|LEVEL|source|member|line|message</c>.
    /// </summary>
    public sealed class LogTracker : IDisposable {
        private const int MaxEntries = 2000;
        private const int MaxIssues = 500;
        private const int MaxMessageLength = 8000;
        private const long InitialBacklogBytes = 2 * 1024 * 1024;
        private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);

        private static readonly Dictionary<string, LogLevel> Levels = new Dictionary<string, LogLevel>(StringComparer.OrdinalIgnoreCase) {
            ["TRACE"] = LogLevel.Trace,
            ["DEBUG"] = LogLevel.Debug,
            ["INFO"] = LogLevel.Info,
            ["WARNING"] = LogLevel.Warning,
            ["ERROR"] = LogLevel.Error,
            ["FATAL"] = LogLevel.Fatal,
        };

        private readonly object sync = new object();
        private readonly LinkedList<LogEntry> entries = new LinkedList<LogEntry>();
        private readonly LinkedList<LogEntry> issues = new LinkedList<LogEntry>();
        private readonly CancellationTokenSource cts = new CancellationTokenSource();
        private string currentFile;
        private long offset;
        private long nextId = 1;
        private int errorCount;
        private int warningCount;

        public string CurrentFile => currentFile;

        public void Start() {
            _ = Task.Run(() => RunAsync(cts.Token));
        }

        private async Task RunAsync(CancellationToken ct) {
            using var timer = new PeriodicTimer(PollInterval);
            do {
                try {
                    Poll();
                } catch (Exception ex) {
                    global::NINA.Core.Utility.Logger.Warning($"Remote Telemetry: log poll failed: {ex.Message}");
                }
            } while (await SafeWait(timer, ct).ConfigureAwait(false));
        }

        private static async Task<bool> SafeWait(PeriodicTimer timer, CancellationToken ct) {
            try {
                return await timer.WaitForNextTickAsync(ct).ConfigureAwait(false);
            } catch (OperationCanceledException) {
                return false;
            }
        }

        private void Poll() {
            var path = FindActiveLogFile();
            if (path == null) {
                return;
            }

            if (!string.Equals(path, currentFile, StringComparison.OrdinalIgnoreCase)) {
                var isFirstFile = currentFile == null;
                currentFile = path;
                offset = 0;
                if (isFirstFile) {
                    // Seed with the tail of this session's log instead of parsing a potentially huge file.
                    try {
                        offset = Math.Max(0, new FileInfo(path).Length - InitialBacklogBytes);
                    } catch {
                    }
                }
            }

            foreach (var line in ReadNewLines(path, ref offset)) {
                Ingest(line);
            }
        }

        private void Ingest(string line) {
            lock (sync) {
                if (!TryParse(line, out var entry)) {
                    // Continuation lines (e.g. stack traces) belong to the previous entry.
                    var last = entries.Last?.Value;
                    if (last != null && last.Message.Length < MaxMessageLength) {
                        last.Message += "\n" + line;
                    }
                    return;
                }

                entries.AddLast(entry);
                if (entries.Count > MaxEntries) {
                    entries.RemoveFirst();
                }

                if (entry.Level >= LogLevel.Warning) {
                    if (entry.Level >= LogLevel.Error) {
                        errorCount++;
                    } else {
                        warningCount++;
                    }
                    issues.AddLast(entry);
                    if (issues.Count > MaxIssues) {
                        issues.RemoveFirst();
                    }
                }
            }
        }

        private bool TryParse(string line, out LogEntry entry) {
            entry = null;
            var parts = line.Split('|', 6);
            if (parts.Length != 6 || !Levels.TryGetValue(parts[1].Trim(), out var level)) {
                return false;
            }

            DateTime.TryParse(parts[0], CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var timestamp);

            entry = new LogEntry {
                Id = nextId++,
                Timestamp = timestamp == default ? DateTime.Now : timestamp,
                Level = level,
                Source = parts[2].Trim(),
                Member = parts[3].Trim(),
                Message = parts[5].Trim(),
            };
            return true;
        }

        /// <summary>Returns up to <paramref name="limit"/> of the newest entries at or above <paramref name="minLevel"/>, oldest first.</summary>
        public IReadOnlyList<object> GetEntries(int limit, LogLevel minLevel, long afterId = 0) {
            lock (sync) {
                return Project(entries.Where(e => e.Level >= minLevel && e.Id > afterId), limit);
            }
        }

        public IReadOnlyList<object> GetIssues(int limit) {
            lock (sync) {
                return Project(issues, limit);
            }
        }

        public object GetSummary(int recent) {
            lock (sync) {
                return new {
                    errors = errorCount,
                    warnings = warningCount,
                    recent = Project(issues, recent),
                };
            }
        }

        private static IReadOnlyList<object> Project(IEnumerable<LogEntry> source, int limit) {
            var list = source.ToList();
            return list.Skip(Math.Max(0, list.Count - limit)).Select(e => (object)new {
                id = e.Id,
                timestamp = e.Timestamp.ToUniversalTime(),
                level = e.Level.ToString(),
                source = e.Source,
                member = e.Member,
                message = e.Message,
            }).ToList();
        }

        private static string FindActiveLogFile() {
            var logsDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NINA", "Logs");
            if (!Directory.Exists(logsDir)) {
                return null;
            }
            return new DirectoryInfo(logsDir).GetFiles("*.log")
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .FirstOrDefault()?.FullName;
        }

        private static List<string> ReadNewLines(string path, ref long offset) {
            var result = new List<string>();
            long length;
            try {
                length = new FileInfo(path).Length;
            } catch {
                return result;
            }

            if (length < offset) {
                offset = 0;
            }
            if (length == offset) {
                return result;
            }

            var count = (int)Math.Min(length - offset, 16 * 1024 * 1024);
            var buffer = new byte[count];
            int read = 0;
            try {
                using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                fs.Seek(offset, SeekOrigin.Begin);
                int n;
                while (read < count && (n = fs.Read(buffer, read, count - read)) > 0) {
                    read += n;
                }
            } catch {
                return result;
            }

            var lastNewline = read > 0 ? Array.LastIndexOf(buffer, (byte)'\n', read - 1, read) : -1;
            if (lastNewline < 0) {
                return result;
            }

            offset += lastNewline + 1;
            foreach (var line in Encoding.UTF8.GetString(buffer, 0, lastNewline + 1).Split('\n')) {
                var trimmed = line.TrimEnd('\r');
                if (trimmed.Length > 0) {
                    result.Add(trimmed);
                }
            }
            return result;
        }

        public void Dispose() {
            cts.Cancel();
            cts.Dispose();
        }
    }
}
