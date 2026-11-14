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
using System.Net.Http;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using NINA.Core.Utility;

namespace Naztronomy.NINA.RemoteTelemetry.Telemetry {

    public sealed record AllSkyInfo(
        bool Configured, string SourceType, string ImageId, string FileName, DateTime? ImageTimeUtc,
        DateTime? CheckedUtc, int? SizeBytes, string ContentType, string Error);

    /// <summary>
    /// Serves the latest all-sky camera image. The source is configured in the plugin options and may be
    /// an image file, a folder (newest image wins) or an http(s) URL. Images are only re-read when a
    /// client asks, at most every <see cref="MinReloadInterval"/>, unless the refresh is forced.
    /// </summary>
    public sealed class AllSkyService {
        private const long MaxBytes = 25 * 1024 * 1024;
        private static readonly TimeSpan MinReloadInterval = TimeSpan.FromSeconds(20);
        private static readonly TimeSpan ForcedCooldown = TimeSpan.FromSeconds(3);

        private static readonly Dictionary<string, string> ContentTypes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
            [".jpg"] = "image/jpeg",
            [".jpeg"] = "image/jpeg",
            [".png"] = "image/png",
            [".webp"] = "image/webp",
            [".gif"] = "image/gif",
        };

        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };

        private readonly Func<string> source;
        private readonly SemaphoreSlim gate = new SemaphoreSlim(1, 1);

        private string loadedSource;
        private byte[] bytes;
        private string contentType;
        private string imageId;
        private string fileName;
        private DateTime? imageTimeUtc;
        private DateTime? checkedUtc;
        private string error;
        private (string Path, DateTime Mtime, long Length) lastFile;

        public AllSkyService(Func<string> source) {
            this.source = source;
        }

        public static string[] SupportedExtensions => ContentTypes.Keys.ToArray();

        public async Task<AllSkyInfo> GetInfoAsync(bool force, CancellationToken ct) {
            await EnsureLoadedAsync(force, ct).ConfigureAwait(false);
            var src = (source() ?? string.Empty).Trim();
            return new AllSkyInfo(src.Length > 0, SourceType(src), imageId, fileName, imageTimeUtc, checkedUtc, bytes?.Length, contentType, error);
        }

        public async Task<(byte[] Bytes, string ContentType, string ImageId)> GetImageAsync(CancellationToken ct) {
            await EnsureLoadedAsync(false, ct).ConfigureAwait(false);
            return (bytes, contentType, imageId);
        }

        private static string SourceType(string src) {
            if (src.Length == 0) return "none";
            if (src.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || src.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return "url";
            return Directory.Exists(src) ? "folder" : "file";
        }

        private async Task EnsureLoadedAsync(bool force, CancellationToken ct) {
            var src = (source() ?? string.Empty).Trim();
            var now = DateTime.UtcNow;
            if (src == loadedSource && checkedUtc != null && now - checkedUtc < (force ? ForcedCooldown : MinReloadInterval)) {
                return;
            }

            await gate.WaitAsync(ct).ConfigureAwait(false);
            try {
                if (src == loadedSource && checkedUtc != null && DateTime.UtcNow - checkedUtc < (force ? ForcedCooldown : MinReloadInterval)) {
                    return;
                }
                if (src != loadedSource) {
                    bytes = null;
                    imageId = null;
                    fileName = null;
                    imageTimeUtc = null;
                    contentType = null;
                    lastFile = default;
                    loadedSource = src;
                }

                error = null;
                switch (SourceType(src)) {
                    case "none":
                        break;
                    case "url":
                        await LoadUrlAsync(src, ct).ConfigureAwait(false);
                        break;
                    case "folder":
                        var newest = new DirectoryInfo(src).EnumerateFiles()
                            .Where(f => ContentTypes.ContainsKey(f.Extension))
                            .OrderByDescending(f => f.LastWriteTimeUtc)
                            .FirstOrDefault();
                        if (newest == null) {
                            error = "No .jpg/.png/.webp/.gif images in the folder.";
                        } else {
                            await LoadFileAsync(newest.FullName, ct).ConfigureAwait(false);
                        }
                        break;
                    default:
                        if (!File.Exists(src)) {
                            error = "File not found.";
                        } else if (!ContentTypes.ContainsKey(Path.GetExtension(src))) {
                            error = "Unsupported image type (use .jpg, .png, .webp or .gif).";
                        } else {
                            await LoadFileAsync(src, ct).ConfigureAwait(false);
                        }
                        break;
                }
            } catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is HttpRequestException || (ex is TaskCanceledException && !ct.IsCancellationRequested)) {
                error = ex is TaskCanceledException ? "Timed out." : ex.Message;
                Logger.Warning($"Remote Telemetry: all-sky image load failed: {ex.Message}");
            } finally {
                checkedUtc = DateTime.UtcNow;
                gate.Release();
            }
        }

        private async Task LoadFileAsync(string path, CancellationToken ct) {
            var info = new FileInfo(path);
            if (lastFile.Path == path && lastFile.Mtime == info.LastWriteTimeUtc && lastFile.Length == info.Length && bytes != null) {
                return;
            }
            if (info.Length == 0 || info.Length > MaxBytes) {
                error = info.Length == 0 ? "Image file is empty." : "Image file is larger than 25 MB.";
                return;
            }

            // All-sky software overwrites the file in place; retry once if we catch it half-written.
            for (var attempt = 0; attempt < 2; attempt++) {
                byte[] data;
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
                    data = new byte[fs.Length];
                    var read = 0;
                    while (read < data.Length) {
                        var n = await fs.ReadAsync(data.AsMemory(read), ct).ConfigureAwait(false);
                        if (n == 0) break;
                        read += n;
                    }
                    if (read != data.Length) {
                        data = null;
                    }
                }
                var ext = Path.GetExtension(path);
                if (data != null && LooksComplete(data, ext)) {
                    Accept(data, ContentTypes[ext], Path.GetFileName(path), info.LastWriteTimeUtc);
                    lastFile = (path, info.LastWriteTimeUtc, info.Length);
                    return;
                }
                await Task.Delay(750, ct).ConfigureAwait(false);
                info.Refresh();
            }
            error = "Image looked incomplete (still being written); showing the previous one.";
        }

        private async Task LoadUrlAsync(string url, CancellationToken ct) {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.CacheControl = new System.Net.Http.Headers.CacheControlHeaderValue { NoCache = true, NoStore = true };
            using var res = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            if (!res.IsSuccessStatusCode) {
                error = $"Camera URL returned HTTP {(int)res.StatusCode}.";
                return;
            }
            var type = res.Content.Headers.ContentType?.MediaType ?? string.Empty;
            if (!ContentTypes.ContainsValue(type)) {
                error = $"Camera URL did not return an image (got '{type}').";
                return;
            }
            if (res.Content.Headers.ContentLength > MaxBytes) {
                error = "Image is larger than 25 MB.";
                return;
            }
            var data = await res.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
            if (data.Length == 0 || data.Length > MaxBytes) {
                error = "Camera URL returned an empty or oversized image.";
                return;
            }
            var modified = res.Content.Headers.LastModified?.UtcDateTime;
            Accept(data, type, Path.GetFileName(new Uri(url).AbsolutePath), modified ?? DateTime.UtcNow, onlyIfChanged: true);
        }

        private void Accept(byte[] data, string type, string name, DateTime timeUtc, bool onlyIfChanged = false) {
            var id = Convert.ToHexString(SHA256.HashData(data), 0, 8).ToLowerInvariant();
            if (onlyIfChanged && id == imageId) {
                return;
            }
            bytes = data;
            contentType = type;
            imageId = id;
            fileName = name;
            imageTimeUtc = timeUtc;
        }

        private static bool LooksComplete(byte[] data, string ext) {
            if (data.Length < 4) return false;
            return ext.ToLowerInvariant() switch {
                ".jpg" or ".jpeg" => data[0] == 0xFF && data[1] == 0xD8 && data[^2] == 0xFF && data[^1] == 0xD9,
                ".png" => data[0] == 0x89 && data[1] == (byte)'P',
                _ => true,
            };
        }
    }
}
