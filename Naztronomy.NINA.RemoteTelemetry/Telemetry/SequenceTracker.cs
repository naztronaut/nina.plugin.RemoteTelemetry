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
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using NINA.Core.Utility;
using NINA.Sequencer.Conditions;
using NINA.Sequencer.Container;
using NINA.Sequencer.Interfaces;
using NINA.Sequencer.Interfaces.Mediator;
using NINA.Sequencer.SequenceItem;
using NINA.Sequencer.SequenceItem.FilterWheel;
using NINA.Sequencer.SequenceItem.Imaging;

namespace Naztronomy.NINA.RemoteTelemetry.Telemetry {

    /// <summary>
    /// Snapshot of the targets in the Advanced Sequencer with exposure progress and time estimates.
    /// The sequence tree belongs to NINA's UI thread, so it is read there and cached.
    /// </summary>
    public sealed class SequenceTracker {
        private static readonly TimeSpan MaxAge = TimeSpan.FromSeconds(20);
        private static readonly TimeSpan UiTimeout = TimeSpan.FromSeconds(5);

        private readonly ISequenceMediator sequence;
        private readonly SemaphoreSlim gate = new SemaphoreSlim(1, 1);
        private object snapshot;
        private DateTime snapshotUtc;

        public SequenceTracker(ISequenceMediator sequence) {
            this.sequence = sequence;
        }

        public async Task<object> GetAsync(CancellationToken ct) {
            if (snapshot != null && DateTime.UtcNow - snapshotUtc < MaxAge) {
                return snapshot;
            }
            await gate.WaitAsync(ct).ConfigureAwait(false);
            try {
                if (snapshot == null || DateTime.UtcNow - snapshotUtc >= MaxAge) {
                    snapshot = await ReadOnUiThreadAsync().ConfigureAwait(false);
                    snapshotUtc = DateTime.UtcNow;
                }
                return snapshot;
            } finally {
                gate.Release();
            }
        }

        private async Task<object> ReadOnUiThreadAsync() {
            var dispatcher = Application.Current?.Dispatcher;
            if (dispatcher == null || dispatcher.CheckAccess()) {
                return Build();
            }
            var op = dispatcher.InvokeAsync(Build);
            var done = await Task.WhenAny(op.Task, Task.Delay(UiTimeout)).ConfigureAwait(false);
            if (done != op.Task) {
                op.Abort();
                return snapshot ?? new { updatedUtc = DateTime.UtcNow, error = "NINA's UI was busy; try again shortly.", targets = Array.Empty<object>() };
            }
            return op.Task.Result;
        }

        private sealed class Block {
            public string Name;
            public string Status;
            public string Filter;
            public string ImageType;
            public double ExposureSeconds;
            public int Done;
            public int? Total;
            public string Condition;
        }

        private object Build() {
            bool running;
            IList<IDeepSkyObjectContainer> containers;
            try {
                running = sequence.IsAdvancedSequenceRunning();
                containers = sequence.GetAllTargetsInAdvancedSequence() ?? new List<IDeepSkyObjectContainer>();
            } catch (Exception ex) {
                Logger.Warning($"Remote Telemetry: reading the sequence failed: {ex.Message}");
                return new { updatedUtc = DateTime.UtcNow, error = ex.Message, targets = Array.Empty<object>() };
            }

            var targets = new List<object>();
            double totalImaged = 0, totalLeft = 0;
            var anyOpenEnded = false;

            foreach (var container in containers) {
                try {
                    if (IsTargetScheduler(container)) {
                        targets.Add(new {
                            name = container.Name,
                            status = container.Status.ToString(),
                            scheduler = true,
                        });
                        continue;
                    }

                    var blocks = new List<Block>();
                    Walk(container, null, blocks, 0);

                    var imaged = blocks.Sum(b => b.Done * b.ExposureSeconds);
                    var left = blocks.Where(b => b.Total.HasValue).Sum(b => Math.Max(0, b.Total.Value - b.Done) * b.ExposureSeconds);
                    var openEnded = blocks.Any(b => !b.Total.HasValue && b.Status != "FINISHED");
                    var status = container.Status.ToString();
                    if (status != "DISABLED" && status != "SKIPPED") {
                        totalImaged += imaged;
                        totalLeft += status == "FINISHED" ? 0 : left;
                        anyOpenEnded |= openEnded && status != "FINISHED";
                    }

                    var coords = container.Target?.InputCoordinates?.Coordinates;
                    targets.Add(new {
                        name = string.IsNullOrWhiteSpace(container.Target?.TargetName) ? container.Name : container.Target.TargetName,
                        status,
                        ra = coords?.RAString,
                        dec = coords?.DecString,
                        conditions = ConditionsText(container as SequenceContainer),
                        imagedSeconds = Math.Round(imaged),
                        remainingSeconds = status == "FINISHED" ? 0 : Math.Round(left),
                        openEnded,
                        blocks = blocks.Select(b => new {
                            name = b.Name,
                            status = b.Status,
                            filter = b.Filter,
                            imageType = b.ImageType,
                            exposureSeconds = b.ExposureSeconds,
                            done = b.Done,
                            total = b.Total,
                            condition = b.Condition,
                            imagedSeconds = Math.Round(b.Done * b.ExposureSeconds),
                            remainingSeconds = b.Total.HasValue ? Math.Round(Math.Max(0, b.Total.Value - b.Done) * b.ExposureSeconds) : (double?)null,
                        }).ToList(),
                        captured = (container as DeepSkyObjectContainer)?.ExposureInfoList?.Select(e => new {
                            filter = e.Filter,
                            count = e.Count,
                            exposureSeconds = e.ExposureTime,
                            imageType = e.ImageType,
                        }).ToList(),
                    });
                } catch (Exception ex) {
                    targets.Add(new { name = container?.Name, status = "UNKNOWN", error = ex.Message });
                }
            }

            return new {
                updatedUtc = DateTime.UtcNow,
                isRunning = running,
                imagedSeconds = Math.Round(totalImaged),
                remainingSeconds = Math.Round(totalLeft),
                openEnded = anyOpenEnded,
                targets,
            };
        }

        // Collects exposure blocks (Take Many Exposures, Smart Exposure, or a loop container around Take Exposure).
        private static void Walk(ISequenceContainer container, string inheritedFilter, List<Block> blocks, int depth) {
            if (depth > 12 || container?.Items == null) {
                return;
            }
            var filter = inheritedFilter;
            foreach (var item in container.Items.ToList()) {
                switch (item) {
                    case SwitchFilter sf:
                        filter = sf.Filter?.Name ?? filter;
                        break;
                    case TakeManyExposures or SmartExposure:
                        var c = (SequenceContainer)item;
                        var exposure = c.Items.OfType<IExposureItem>().FirstOrDefault();
                        if (exposure == null) break;
                        var ownFilter = c.Items.OfType<SwitchFilter>().FirstOrDefault()?.Filter?.Name;
                        var loop = c.Conditions?.OfType<LoopCondition>().FirstOrDefault();
                        blocks.Add(new Block {
                            Name = NameOf(item),
                            Status = item.Status.ToString(),
                            Filter = ownFilter ?? filter,
                            ImageType = exposure.ImageType,
                            ExposureSeconds = exposure.ExposureTime,
                            Done = loop?.CompletedIterations ?? (exposure as TakeExposure)?.ExposureCount ?? 0,
                            Total = loop?.Iterations,
                            Condition = loop == null ? ConditionsText(c) : null,
                        });
                        break;
                    case TakeExposure single:
                        // A bare Take Exposure counts its own frames; the parent's loop (if any) gives the total.
                        var parentLoop = (container as SequenceContainer)?.Conditions?.OfType<LoopCondition>().FirstOrDefault();
                        blocks.Add(new Block {
                            Name = NameOf(item),
                            Status = item.Status.ToString(),
                            Filter = filter,
                            ImageType = single.ImageType,
                            ExposureSeconds = single.ExposureTime,
                            Done = single.ExposureCount,
                            Total = parentLoop?.Iterations,
                            Condition = parentLoop == null ? ConditionsText(container as SequenceContainer) : null,
                        });
                        break;
                    case ISequenceContainer nested:
                        Walk(nested, filter, blocks, depth + 1);
                        break;
                }
            }
        }

        // Target Scheduler picks targets and exposures at run time, so its container has no static plan to read.
        private static bool IsTargetScheduler(object container) {
            var type = container?.GetType();
            return type != null && ((type.FullName ?? "").Contains("TargetScheduler") || type.Name == "TargetSchedulerContainer");
        }

        private static string NameOf(ISequenceItem item) => !string.IsNullOrWhiteSpace(item.Name) ? item.Name : item switch {
            TakeManyExposures => "Take Many Exposures",
            SmartExposure => "Smart Exposure",
            TakeExposure => "Take Exposure",
            _ => item.GetType().Name,
        };

        private static string ConditionsText(SequenceContainer c) {
            var conditions = c?.Conditions;
            if (conditions == null || conditions.Count == 0) {
                return null;
            }
            var parts = conditions.Select(cond => cond switch {
                LoopCondition l => $"{l.CompletedIterations}/{l.Iterations} iterations",
                TimeCondition t => $"until {t.Hours:00}:{t.Minutes:00}",
                _ => cond.Name,
            });
            return string.Join(", ", parts);
        }
    }
}
