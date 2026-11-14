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
using System.Threading.Tasks;
using System.Windows.Media.Imaging;
using NINA.Core.Utility;
using NINA.WPF.Base.Interfaces.Mediator;

namespace Naztronomy.NINA.RemoteTelemetry.Telemetry {

    public sealed class ImageRecord {
        public int Id { get; init; }
        public DateTime TimestampUtc { get; init; }
        public string FileName { get; init; }
        public string ImageType { get; init; }
        public string Target { get; init; }
        public string Ra { get; init; }
        public string Dec { get; init; }
        public string Filter { get; init; }
        public double? ExposureSeconds { get; init; }
        public string Binning { get; init; }
        public int? Width { get; init; }
        public int? Height { get; init; }
        public double? Hfr { get; init; }
        public double? HfrStDev { get; init; }
        public int? Stars { get; init; }
        public double? Mean { get; init; }
        public double? Median { get; init; }
        public double? StDev { get; init; }
        public double? Mad { get; init; }
        public int? Min { get; init; }
        public int? Max { get; init; }
        public double? CameraTemperature { get; init; }
        public int? Gain { get; init; }
        public int? Offset { get; init; }
        public bool HasPreview { get; set; }
    }

    /// <summary>
    /// Listens to NINA's ImageSaved event and keeps a short history of frame metadata plus a JPEG
    /// preview of the most recent frame.
    /// </summary>
    public sealed class ImageTracker : IDisposable {
        private const int MaxHistory = 300;

        private readonly IImageSaveMediator imageSaveMediator;
        private readonly Func<int> previewMaxWidth;
        private readonly object sync = new object();
        private readonly List<ImageRecord> history = new List<ImageRecord>();
        private byte[] previewJpeg;
        private int previewImageId;
        private int nextId = 1;

        public ImageTracker(IImageSaveMediator imageSaveMediator, Func<int> previewMaxWidth) {
            this.imageSaveMediator = imageSaveMediator;
            this.previewMaxWidth = previewMaxWidth;
            imageSaveMediator.ImageSaved += OnImageSaved;
        }

        private void OnImageSaved(object sender, ImageSavedEventArgs e) {
            ImageRecord record;
            try {
                record = BuildRecord(e);
                lock (sync) {
                    history.Add(record);
                    if (history.Count > MaxHistory) {
                        history.RemoveAt(0);
                    }
                }
            } catch (Exception ex) {
                Logger.Error("Remote Telemetry: failed to record saved image", ex);
                return;
            }

            var image = e.Image;
            if (image == null) {
                return;
            }

            var maxWidth = previewMaxWidth();
            if (image.IsFrozen) {
                _ = Task.Run(() => StorePreview(record, image, maxWidth));
            } else if (image.CheckAccess()) {
                StorePreview(record, image, maxWidth);
            } else {
                image.Dispatcher.InvokeAsync(() => StorePreview(record, image, maxWidth));
            }
        }

        private void StorePreview(ImageRecord record, BitmapSource image, int maxWidth) {
            try {
                var jpeg = PreviewEncoder.Encode(image, maxWidth);
                if (jpeg == null) {
                    return;
                }
                lock (sync) {
                    if (record.Id >= previewImageId) {
                        previewJpeg = jpeg;
                        previewImageId = record.Id;
                        record.HasPreview = true;
                    }
                }
            } catch (Exception ex) {
                Logger.Error("Remote Telemetry: failed to encode preview", ex);
            }
        }

        private ImageRecord BuildRecord(ImageSavedEventArgs e) {
            var meta = e.MetaData;
            var stats = e.Statistics;
            var stars = e.StarDetectionAnalysis;
            var start = meta?.Image?.ExposureStart ?? default;
            int id;
            lock (sync) {
                id = nextId++;
            }

            return new ImageRecord {
                Id = id,
                TimestampUtc = start == default ? DateTime.UtcNow : start.ToUniversalTime(),
                FileName = e.PathToImage != null ? Path.GetFileName(e.PathToImage.LocalPath) : null,
                ImageType = meta?.Image?.ImageType,
                Target = string.IsNullOrWhiteSpace(meta?.Target?.Name) ? null : meta.Target.Name,
                Ra = meta?.Target?.Coordinates?.RAString,
                Dec = meta?.Target?.Coordinates?.DecString,
                Filter = string.IsNullOrWhiteSpace(e.Filter) ? null : e.Filter,
                ExposureSeconds = Num.N(e.Duration),
                Binning = meta?.Image?.Binning,
                Width = e.Image?.PixelWidth,
                Height = e.Image?.PixelHeight,
                Hfr = stars != null && stars.DetectedStars > 0 ? Num.N(stars.HFR) : null,
                HfrStDev = stars != null && stars.DetectedStars > 0 ? Num.N(stars.HFRStDev) : null,
                Stars = stars?.DetectedStars,
                Mean = Num.N(stats?.Mean),
                Median = Num.N(stats?.Median),
                StDev = Num.N(stats?.StDev),
                Mad = Num.N(stats?.MedianAbsoluteDeviation),
                Min = stats?.Min,
                Max = stats?.Max,
                CameraTemperature = Num.N(meta?.Camera?.Temperature),
                Gain = meta?.Camera?.Gain is int g && g >= 0 ? g : null,
                Offset = meta?.Camera?.Offset is int o && o >= 0 ? o : null,
            };
        }

        public ImageRecord Latest {
            get {
                lock (sync) {
                    return history.Count > 0 ? history[^1] : null;
                }
            }
        }

        public IReadOnlyList<ImageRecord> GetHistory(int limit) {
            lock (sync) {
                return history.Skip(Math.Max(0, history.Count - limit)).ToList();
            }
        }

        public (byte[] Jpeg, int ImageId) GetPreview() {
            lock (sync) {
                return (previewJpeg, previewImageId);
            }
        }

        public void Dispose() {
            imageSaveMediator.ImageSaved -= OnImageSaved;
        }
    }

    internal static class Num {
        public static double? N(double? v) => v.HasValue && !double.IsNaN(v.Value) && !double.IsInfinity(v.Value) ? Math.Round(v.Value, 4) : null;
    }
}
