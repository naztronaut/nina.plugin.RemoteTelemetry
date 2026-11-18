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
using System.Linq;
using System.Threading.Tasks;
using NINA.Core.Interfaces;
using NINA.Equipment.Interfaces.Mediator;

namespace Naztronomy.NINA.RemoteTelemetry.Telemetry {

    /// <summary>
    /// Records guide steps and dithers from NINA's guider mediator so clients can draw a guide graph.
    /// </summary>
    public sealed class GuideTracker : IDisposable {
        private const int MaxSteps = 1200;
        private const int MaxDithers = 200;

        private sealed record Step(long Time, double Ra, double Dec, double RaPulse, double DecPulse, double? Scale);

        private readonly IGuiderMediator guider;
        private readonly object sync = new object();
        private readonly Queue<Step> steps = new Queue<Step>();
        private readonly Queue<long> dithers = new Queue<long>();
        private bool isGuiding;
        // Kept after the guider disconnects so the stored history can still be shown in arcseconds.
        private double? lastScale;

        public GuideTracker(IGuiderMediator guider) {
            this.guider = guider;
            guider.GuideEvent += OnGuideStep;
            guider.GuidingStarted += OnGuidingStarted;
            guider.GuidingStopped += OnGuidingStopped;
            guider.AfterDither += OnAfterDither;
        }

        private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        private void OnGuideStep(object sender, IGuideStep step) {
            if (step == null) {
                return;
            }
            var scale = CurrentScale();
            var s = new Step(Now(), step.RADistanceRaw, step.DECDistanceRaw, step.RADuration, step.DECDuration, scale);
            lock (sync) {
                isGuiding = true;
                if (scale.HasValue) {
                    lastScale = scale;
                }
                steps.Enqueue(s);
                while (steps.Count > MaxSteps) {
                    steps.Dequeue();
                }
            }
        }

        private Task OnGuidingStarted(object sender, EventArgs e) {
            lock (sync) {
                isGuiding = true;
            }
            return Task.CompletedTask;
        }

        private Task OnGuidingStopped(object sender, EventArgs e) {
            lock (sync) {
                isGuiding = false;
            }
            return Task.CompletedTask;
        }

        private Task OnAfterDither(object sender, EventArgs e) {
            lock (sync) {
                dithers.Enqueue(Now());
                while (dithers.Count > MaxDithers) {
                    dithers.Dequeue();
                }
            }
            return Task.CompletedTask;
        }

        private double? CurrentScale() {
            try {
                var ps = guider.GetInfo()?.PixelScale;
                return ps is double v && v > 0 && double.IsFinite(v) ? v : null;
            } catch {
                return null;
            }
        }

        /// <summary>Guide steps newer than <paramref name="afterMs"/> (unix ms). Distances in pixels and, when known, arcseconds.</summary>
        public object Get(long afterMs, int limit, double? pixelScale) {
            lock (sync) {
                var scale = pixelScale is double ps && ps > 0 ? ps : lastScale;
                var newer = steps.Where(s => s.Time > afterMs).ToList();
                return new {
                    isGuiding,
                    pixelScale = scale,
                    steps = newer.Skip(Math.Max(0, newer.Count - limit)).Select(s => {
                        var k = s.Scale ?? scale;
                        return new {
                            time = s.Time,
                            raPx = Math.Round(s.Ra, 4),
                            decPx = Math.Round(s.Dec, 4),
                            ra = k.HasValue ? Math.Round(s.Ra * k.Value, 3) : (double?)null,
                            dec = k.HasValue ? Math.Round(s.Dec * k.Value, 3) : (double?)null,
                            raPulseMs = Math.Round(s.RaPulse),
                            decPulseMs = Math.Round(s.DecPulse),
                        };
                    }).ToList(),
                    dithers = dithers.Where(d => d > afterMs).ToList(),
                };
            }
        }

        public void Dispose() {
            guider.GuideEvent -= OnGuideStep;
            guider.GuidingStarted -= OnGuidingStarted;
            guider.GuidingStopped -= OnGuidingStopped;
            guider.AfterDither -= OnAfterDither;
        }
    }
}
