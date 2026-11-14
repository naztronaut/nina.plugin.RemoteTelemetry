#region "copyright"

/*
    Copyright (c) 2026 Naztronomy

    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/
*/

#endregion "copyright"

using System;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Naztronomy.NINA.RemoteTelemetry.Telemetry {

    /// <summary>
    /// Turns the BitmapSource NINA hands out on ImageSaved into a downscaled JPEG.
    /// 16-bit mono data is auto-stretched so linear frames are still visible.
    /// </summary>
    public static class PreviewEncoder {

        public static byte[] Encode(BitmapSource source, int maxWidth, int quality = 80) {
            if (source == null || source.PixelWidth <= 0) {
                return null;
            }

            BitmapSource encodable;
            if (source.Format == PixelFormats.Gray16) {
                // WPF scaling drops 16-bit precision, so bin manually before stretching.
                encodable = StretchGray16(BinGray16(source, maxWidth, out var w, out var h), w, h);
            } else {
                BitmapSource scaled = source;
                if (maxWidth > 0 && source.PixelWidth > maxWidth) {
                    var scale = (double)maxWidth / source.PixelWidth;
                    scaled = new TransformedBitmap(source, new ScaleTransform(scale, scale));
                }
                encodable = scaled.Format == PixelFormats.Gray8 || scaled.Format == PixelFormats.Bgr24
                    ? scaled
                    : new FormatConvertedBitmap(scaled, PixelFormats.Bgr24, null, 0);
            }

            var encoder = new JpegBitmapEncoder { QualityLevel = quality };
            encoder.Frames.Add(BitmapFrame.Create(encodable));
            using var ms = new MemoryStream();
            encoder.Save(ms);
            return ms.ToArray();
        }

        private static ushort[] BinGray16(BitmapSource src, int maxWidth, out int outW, out int outH) {
            int w = src.PixelWidth, h = src.PixelHeight;
            int factor = maxWidth > 0 ? Math.Max(1, (int)Math.Ceiling((double)w / maxWidth)) : 1;
            outW = w / factor;
            outH = h / factor;
            var output = new ushort[outW * outH];
            var strip = new ushort[w * factor];

            // Read one strip of 'factor' rows at a time to keep memory low on large sensors.
            for (int oy = 0; oy < outH; oy++) {
                src.CopyPixels(new Int32Rect(0, oy * factor, w, factor), strip, w * 2, 0);
                for (int ox = 0; ox < outW; ox++) {
                    long sum = 0;
                    for (int y = 0; y < factor; y++) {
                        int row = y * w + ox * factor;
                        for (int x = 0; x < factor; x++) {
                            sum += strip[row + x];
                        }
                    }
                    output[oy * outW + ox] = (ushort)(sum / (factor * factor));
                }
            }
            return output;
        }

        private static BitmapSource StretchGray16(ushort[] pixels, int w, int h) {
            var histogram = new int[65536];
            foreach (var p in pixels) {
                histogram[p]++;
            }
            var median = Percentile(histogram, pixels.Length / 2);

            var deviations = new int[65536];
            foreach (var p in pixels) {
                deviations[Math.Abs(p - median)]++;
            }
            var mad = Percentile(deviations, pixels.Length / 2);

            // PixInsight-style screen transfer function: clip shadows at median - 2.8 sigma, target background 0.25.
            double med = median / 65535.0;
            double sigma = Math.Max(mad / 65535.0 * 1.4826, 1e-6);
            double shadows = Math.Max(0, med - 2.8 * sigma);
            double midtone = Mtf(0.25, med - shadows);

            var lut = new byte[65536];
            for (int i = 0; i < lut.Length; i++) {
                double x = (i / 65535.0 - shadows) / (1 - shadows);
                x = x <= 0 ? 0 : x >= 1 ? 1 : Mtf(midtone, x);
                lut[i] = (byte)Math.Round(x * 255);
            }

            var output = new byte[w * h];
            for (int i = 0; i < pixels.Length; i++) {
                output[i] = lut[pixels[i]];
            }

            var bmp = BitmapSource.Create(w, h, 96, 96, PixelFormats.Gray8, null, output, w);
            bmp.Freeze();
            return bmp;
        }

        private static int Percentile(int[] histogram, int rank) {
            long seen = 0;
            for (int i = 0; i < histogram.Length; i++) {
                seen += histogram[i];
                if (seen > rank) {
                    return i;
                }
            }
            return histogram.Length - 1;
        }

        private static double Mtf(double m, double x) {
            if (x <= 0) return 0;
            if (x >= 1) return 1;
            return (m - 1) * x / ((2 * m - 1) * x - m);
        }
    }
}
