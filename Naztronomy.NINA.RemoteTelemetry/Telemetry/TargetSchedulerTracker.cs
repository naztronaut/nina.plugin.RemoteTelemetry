#region "copyright"

/*
    Copyright (c) 2026 Naztronomy

    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/
*/

#endregion "copyright"

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using NINA.Astrometry;
using NINA.Core.Utility;
using NINA.Plugin.Interfaces;
using NINA.Profile.Interfaces;
using NINA.WPF.Base.Interfaces.Mediator;

namespace Naztronomy.NINA.RemoteTelemetry.Telemetry {

    /// <summary>
    /// Integrates the Target Scheduler plugin: live state from its plugin messages, plus a cached
    /// copy of its local HTTP API (plan preview, project progress, target statistics).
    /// The TS API has no authentication, so it is only ever called on localhost and re-served
    /// through this plugin's own API.
    /// </summary>
    public sealed class TargetSchedulerTracker : ISubscriber, IDisposable {
        private static readonly Guid TsSenderId = Guid.Parse("B4541BA9-7B07-4D71-B8E1-6C73D4933EA0");
        private static readonly string[] Topics = {
            "TargetScheduler-WaitStart",
            "TargetScheduler-NewTargetStart",
            "TargetScheduler-TargetStart",
            "TargetScheduler-TargetComplete",
            "TargetScheduler-ContainerStopped",
        };

        private static readonly TimeSpan PlanInterval = TimeSpan.FromHours(1);
        private static readonly TimeSpan ManualRefreshCooldown = TimeSpan.FromSeconds(15);
        private static readonly TimeSpan ProgressInterval = TimeSpan.FromMinutes(2);
        private static readonly TimeSpan ProgressAfterImageDelay = TimeSpan.FromSeconds(15);
        private static readonly TimeSpan StatisticsTtl = TimeSpan.FromMinutes(5);
        private static readonly TimeSpan LoopInterval = TimeSpan.FromSeconds(10);

        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
        private static readonly JsonSerializerOptions TsJson = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

        private readonly IMessageBroker broker;
        private readonly IProfileService profileService;
        private readonly IImageSaveMediator imageSaveMediator;
        private readonly Func<bool> enabled;
        private readonly Func<int> port;
        private readonly CancellationTokenSource cts = new CancellationTokenSource();
        private readonly SemaphoreSlim planLock = new SemaphoreSlim(1, 1);
        private readonly SemaphoreSlim progressLock = new SemaphoreSlim(1, 1);
        private readonly ConcurrentDictionary<Guid, (DateTime At, object Data)> statsCache = new ConcurrentDictionary<Guid, (DateTime, object)>();
        private readonly object sync = new object();

        private NowState now = new NowState();
        private object plan;
        private DateTime? planUpdatedUtc;
        private object progress;
        private DateTime? progressUpdatedUtc;
        private DateTime? progressDueUtc;
        private Dictionary<string, string> projectByTarget = new Dictionary<string, string>();
        private string version;
        private string apiError;

        public event EventHandler StatusChanged;

        public TargetSchedulerTracker(IMessageBroker broker, IProfileService profileService, IImageSaveMediator imageSaveMediator, Func<bool> enabled, Func<int> port) {
            this.broker = broker;
            this.profileService = profileService;
            this.imageSaveMediator = imageSaveMediator;
            this.enabled = enabled;
            this.port = port;

            foreach (var topic in Topics) {
                broker.Subscribe(topic, this);
            }
            imageSaveMediator.ImageSaved += OnImageSaved;
            profileService.ProfileChanged += OnProfileChanged;
        }

        public void Start() {
            _ = Task.Run(() => RunAsync(cts.Token));
        }

        public string StatusText {
            get {
                if (!enabled()) return "Disabled";
                if (apiError != null) return $"API not reachable on port {port()}: {apiError}";
                if (version != null) return $"Connected to Target Scheduler {version} on port {port()}";
                return "Waiting for first contact…";
            }
        }

        // ---------- live state from TS plugin messages ----------

        private sealed class NowState {
            public string State = "unknown";
            public string Project;
            public string Target;
            public string Ra;
            public string Dec;
            public double? Rotation;
            public string Filter;
            public double? ExposureSeconds;
            public string Gain;
            public string Offset;
            public string Binning;
            public DateTime? SinceUtc;
            public DateTime? TargetEndsUtc;
            public DateTime? WaitUntilUtc;
            public DateTime? StoppedAtUtc;
            public string LastCompletedTarget;
            public string LastCompletedProject;
            public DateTime? LastCompletedUtc;
        }

        public Task OnMessageReceived(IMessage message) {
            if (message == null || (message.SenderId != TsSenderId && message.Sender != "Target Scheduler")) {
                return Task.CompletedTask;
            }

            try {
                var h = message.CustomHeaders ?? new Dictionary<string, object>();
                var sent = message.SentAt.UtcDateTime;
                lock (sync) {
                    var n = new NowState {
                        LastCompletedTarget = now.LastCompletedTarget,
                        LastCompletedProject = now.LastCompletedProject,
                        LastCompletedUtc = now.LastCompletedUtc,
                    };

                    switch (message.Topic) {
                        case "TargetScheduler-WaitStart":
                            n.State = "waiting";
                            n.SinceUtc = sent;
                            n.WaitUntilUtc = message.Content is DateTime until ? ToUtc(until) : message.Expiration?.UtcDateTime;
                            n.Target = Header<string>(h, "TargetName");
                            n.Project = Header<string>(h, "ProjectName");
                            SetCoordinates(n, h);
                            now = n;
                            break;

                        case "TargetScheduler-NewTargetStart":
                        case "TargetScheduler-TargetStart":
                            n.State = "imaging";
                            n.SinceUtc = message.Topic == "TargetScheduler-TargetStart" && now.State == "imaging" && now.Target == message.Content as string
                                ? now.SinceUtc
                                : sent;
                            n.Target = message.Content as string;
                            n.Project = Header<string>(h, "ProjectName");
                            n.Filter = Header<string>(h, "ExposureFilterName");
                            n.ExposureSeconds = h.TryGetValue("ExposureLength", out var len) && len is double d ? d : null;
                            n.Gain = Header<string>(h, "ExposureGain");
                            n.Offset = Header<string>(h, "ExposureOffset");
                            n.Binning = Header<string>(h, "ExposureBinning");
                            n.TargetEndsUtc = message.Expiration?.UtcDateTime;
                            SetCoordinates(n, h);
                            now = n;
                            break;

                        case "TargetScheduler-TargetComplete":
                            now.LastCompletedTarget = message.Content as string;
                            now.LastCompletedProject = Header<string>(h, "ProjectName");
                            now.LastCompletedUtc = sent;
                            progressDueUtc = DateTime.UtcNow;
                            break;

                        case "TargetScheduler-ContainerStopped":
                            n.State = "stopped";
                            n.StoppedAtUtc = h.TryGetValue("StoppedAt", out var at) && at is DateTime stopped ? ToUtc(stopped) : sent;
                            n.Target = now.Target;
                            n.Project = now.Project;
                            now = n;
                            break;
                    }
                }
            } catch (Exception ex) {
                Logger.Warning($"Remote Telemetry: failed to read Target Scheduler message {message.Topic}: {ex.Message}");
            }
            return Task.CompletedTask;
        }

        private static T Header<T>(IDictionary<string, object> h, string key) where T : class =>
            h.TryGetValue(key, out var v) ? v as T : null;

        private static void SetCoordinates(NowState n, IDictionary<string, object> h) {
            if (h.TryGetValue("Coordinates", out var c) && c is Coordinates coords) {
                n.Ra = coords.RAString;
                n.Dec = coords.DecString;
            }
            if (h.TryGetValue("Rotation", out var r) && r is double rot) {
                n.Rotation = rot;
            }
        }

        private static DateTime ToUtc(DateTime dt) => dt.Kind == DateTimeKind.Utc ? dt : dt.ToUniversalTime();

        public object GetNow() {
            lock (sync) {
                return new {
                    enabled = enabled(),
                    apiReachable = apiError == null && version != null,
                    apiError,
                    version,
                    state = now.State,
                    project = now.Project,
                    target = now.Target,
                    ra = now.Ra,
                    dec = now.Dec,
                    rotation = Num.N(now.Rotation),
                    filter = now.Filter,
                    exposureSeconds = Num.N(now.ExposureSeconds),
                    gain = now.Gain,
                    offset = now.Offset,
                    binning = now.Binning,
                    sinceUtc = now.SinceUtc,
                    targetEndsUtc = now.TargetEndsUtc,
                    waitUntilUtc = now.WaitUntilUtc,
                    stoppedAtUtc = now.StoppedAtUtc,
                    lastCompleted = now.LastCompletedTarget == null ? null : new {
                        target = now.LastCompletedTarget,
                        project = now.LastCompletedProject,
                        atUtc = now.LastCompletedUtc,
                    },
                };
            }
        }

        // ---------- background refresh ----------

        private void OnImageSaved(object sender, ImageSavedEventArgs e) {
            lock (sync) {
                progressDueUtc = DateTime.UtcNow + ProgressAfterImageDelay;
            }
        }

        private void OnProfileChanged(object sender, EventArgs e) {
            lock (sync) {
                planUpdatedUtc = null;
                progressUpdatedUtc = null;
                statsCache.Clear();
            }
        }

        private async Task RunAsync(CancellationToken ct) {
            using var timer = new PeriodicTimer(LoopInterval);
            do {
                if (!enabled()) {
                    continue;
                }
                try {
                    var nowUtc = DateTime.UtcNow;
                    if (version == null || apiError != null) {
                        await RefreshVersionAsync(ct);
                    }
                    if (apiError == null) {
                        // Progress first: it supplies the target→project names used by the plan.
                        if (progressUpdatedUtc == null || nowUtc - progressUpdatedUtc >= ProgressInterval || (progressDueUtc != null && nowUtc >= progressDueUtc)) {
                            await RefreshProgressAsync(ct);
                        }
                        if (planUpdatedUtc == null || nowUtc - planUpdatedUtc >= PlanInterval) {
                            await RefreshPlanAsync(ct);
                        }
                    }
                } catch (OperationCanceledException) {
                    break;
                } catch (Exception ex) {
                    Logger.Warning($"Remote Telemetry: Target Scheduler refresh failed: {ex.Message}");
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

        private async Task<string> GetAsync(string path, CancellationToken ct) {
            try {
                using var res = await Http.GetAsync($"http://localhost:{port()}/ts/v0/{path}", ct).ConfigureAwait(false);
                var body = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                if (!res.IsSuccessStatusCode) {
                    throw new InvalidOperationException($"HTTP {(int)res.StatusCode}");
                }
                SetApiError(null);
                return body;
            } catch (HttpRequestException ex) {
                SetApiError(ex.InnerException?.Message ?? ex.Message);
                throw;
            } catch (TaskCanceledException) when (!ct.IsCancellationRequested) {
                SetApiError("timed out");
                throw;
            }
        }

        private void SetApiError(string error) {
            if (apiError != error) {
                apiError = error;
                StatusChanged?.Invoke(this, EventArgs.Empty);
            }
        }

        private async Task RefreshVersionAsync(CancellationToken ct) {
            try {
                var body = await GetAsync("version", ct);
                var v = body.Trim().Trim('"');
                if (v != version) {
                    version = v;
                    StatusChanged?.Invoke(this, EventArgs.Empty);
                }
            } catch (Exception ex) when (ex is HttpRequestException || ex is InvalidOperationException || ex is TaskCanceledException) {
            }
        }

        private string ProfileId() => profileService.ActiveProfile?.Id.ToString();

        // ---------- plan preview ----------

        private sealed class TsPreviewItem {
            public string Id { get; set; }
            public string Name { get; set; }
            public bool WaitPeriod { get; set; }
            public DateTimeOffset StartTime { get; set; }
            public DateTimeOffset EndTime { get; set; }
            public List<TsPreviewExposure> ExposurePlan { get; set; }
        }

        private sealed class TsPreviewExposure {
            public string FilterName { get; set; }
            public double Exposure { get; set; }
            public int Count { get; set; }
        }

        /// <summary>Re-runs the TS preview. Manual refreshes within the cooldown return the cached plan.</summary>
        public async Task<object> RefreshPlanAsync(CancellationToken ct, bool manual = false) {
            if (!enabled()) {
                return GetPlan();
            }
            await planLock.WaitAsync(ct);
            try {
                if (manual && planUpdatedUtc != null && DateTime.UtcNow - planUpdatedUtc < ManualRefreshCooldown) {
                    return GetPlan();
                }
                var pid = ProfileId();
                var body = await GetAsync($"profiles/{pid}/preview", ct);
                var items = JsonSerializer.Deserialize<List<TsPreviewItem>>(body, TsJson) ?? new List<TsPreviewItem>();
                Dictionary<string, string> projects;
                lock (sync) {
                    projects = projectByTarget;
                }
                var mapped = items.Select(i => new {
                    targetId = i.Id,
                    name = i.Name,
                    project = i.Id != null && projects.TryGetValue(i.Id, out var p) ? p : null,
                    waitPeriod = i.WaitPeriod,
                    startUtc = i.StartTime.UtcDateTime,
                    endUtc = i.EndTime.UtcDateTime,
                    exposures = (i.ExposurePlan ?? new List<TsPreviewExposure>())
                        .Where(x => x.Count > 0)
                        // TS lists one entry per filter switch; merge them, keeping first-seen order.
                        .GroupBy(x => (x.FilterName, x.Exposure))
                        .Select(g => new {
                            filter = g.Key.FilterName,
                            exposureSeconds = g.Key.Exposure > 0 ? g.Key.Exposure : (double?)null,
                            count = g.Sum(x => x.Count),
                        }).ToList(),
                }).ToList();
                lock (sync) {
                    plan = mapped;
                    planUpdatedUtc = DateTime.UtcNow;
                }
            } catch (Exception ex) when (ex is HttpRequestException || ex is InvalidOperationException || ex is JsonException || (ex is TaskCanceledException && !ct.IsCancellationRequested)) {
                Logger.Warning($"Remote Telemetry: Target Scheduler preview failed: {ex.Message}");
            } finally {
                planLock.Release();
            }
            return GetPlan();
        }

        public object GetPlan() {
            lock (sync) {
                return new {
                    enabled = enabled(),
                    apiReachable = apiError == null && version != null,
                    apiError,
                    updatedUtc = planUpdatedUtc,
                    nextAutoRefreshUtc = planUpdatedUtc + PlanInterval,
                    manualRefreshCooldownSeconds = (int)ManualRefreshCooldown.TotalSeconds,
                    items = plan,
                };
            }
        }

        // ---------- project progress ----------

        private sealed class TsProject {
            public string Id { get; set; }
            public string Name { get; set; }
            public string State { get; set; }
            public int Priority { get; set; }
            public bool EnableGrader { get; set; }
        }

        private sealed class TsTarget {
            public string Id { get; set; }
            public string Name { get; set; }
            public bool Active { get; set; }
            public double RA { get; set; }
            public double Dec { get; set; }
            public List<TsExposurePlan> ExposurePlan { get; set; }
        }

        private sealed class TsExposurePlan {
            public string TemplateName { get; set; }
            public string FilterName { get; set; }
            public double Exposure { get; set; }
            public int Desired { get; set; }
            public int Acquired { get; set; }
            public int Accepted { get; set; }
            public int Ungraded { get; set; }
        }

        public async Task RefreshProgressAsync(CancellationToken ct) {
            await progressLock.WaitAsync(ct);
            try {
                var pid = ProfileId();
                var projects = JsonSerializer.Deserialize<List<TsProject>>(await GetAsync($"profiles/{pid}/projects", ct), TsJson) ?? new List<TsProject>();
                var targetProjects = new Dictionary<string, string>();
                var result = new List<object>();

                foreach (var project in projects.Where(p => !string.Equals(p.State, "Closed", StringComparison.OrdinalIgnoreCase))) {
                    var targets = JsonSerializer.Deserialize<List<TsTarget>>(await GetAsync($"projects/{project.Id}/targets", ct), TsJson) ?? new List<TsTarget>();
                    var targetRows = new List<(object Row, bool Active, int Desired, int Done, double Seconds)>();

                    foreach (var t in targets) {
                        targetProjects[t.Id] = project.Name;
                        var filters = (t.ExposurePlan ?? new List<TsExposurePlan>()).Select(e => {
                            // Accepted counts toward completion; with grading off TS accepts every frame.
                            var remaining = Math.Max(0, e.Desired - e.Accepted);
                            return new {
                                template = e.TemplateName,
                                filter = e.FilterName,
                                exposureSeconds = e.Exposure > 0 ? e.Exposure : (double?)null,
                                desired = e.Desired,
                                acquired = e.Acquired,
                                accepted = e.Accepted,
                                ungraded = e.Ungraded,
                                remaining,
                                remainingSeconds = e.Exposure > 0 ? remaining * e.Exposure : (double?)null,
                            };
                        }).ToList();
                        var desired = filters.Sum(f => f.desired);
                        var done = filters.Sum(f => Math.Min(f.accepted, f.desired));
                        var seconds = filters.Sum(f => f.remainingSeconds ?? 0);
                        targetRows.Add((new {
                            id = t.Id,
                            name = t.Name,
                            active = t.Active,
                            raHours = Num.N(t.RA),
                            decDegrees = Num.N(t.Dec),
                            percentComplete = desired > 0 ? Math.Round(100.0 * done / desired, 1) : (double?)null,
                            remainingSeconds = seconds,
                            filters,
                        }, t.Active, desired, done, seconds));
                    }

                    // Inactive targets are never scheduled, so they don't count toward the project.
                    var counted = targetRows.Where(r => r.Active).ToList();
                    var pDesired = counted.Sum(r => r.Desired);
                    var pDone = counted.Sum(r => r.Done);
                    result.Add(new {
                        id = project.Id,
                        name = project.Name,
                        state = project.State,
                        priority = project.Priority,
                        gradingEnabled = project.EnableGrader,
                        percentComplete = pDesired > 0 ? Math.Round(100.0 * pDone / pDesired, 1) : (double?)null,
                        remainingSeconds = counted.Sum(r => r.Seconds),
                        targets = targetRows.Select(r => r.Row).ToList(),
                    });
                }

                lock (sync) {
                    progress = result;
                    progressUpdatedUtc = DateTime.UtcNow;
                    progressDueUtc = null;
                    projectByTarget = targetProjects;
                }
            } catch (Exception ex) when (ex is HttpRequestException || ex is InvalidOperationException || ex is JsonException || (ex is TaskCanceledException && !ct.IsCancellationRequested)) {
                Logger.Warning($"Remote Telemetry: Target Scheduler progress failed: {ex.Message}");
            } finally {
                progressLock.Release();
            }
        }

        public object GetProgress() {
            lock (sync) {
                return new {
                    enabled = enabled(),
                    apiReachable = apiError == null && version != null,
                    apiError,
                    updatedUtc = progressUpdatedUtc,
                    projects = progress,
                };
            }
        }

        // ---------- target statistics ----------

        public async Task<object> GetStatisticsAsync(Guid targetId, CancellationToken ct) {
            if (statsCache.TryGetValue(targetId, out var cached) && DateTime.UtcNow - cached.At < StatisticsTtl) {
                return cached.Data;
            }
            var body = await GetAsync($"targets/{targetId}/statistics", ct);
            using var doc = JsonDocument.Parse(body);
            var rows = doc.RootElement.EnumerateArray().Select(e => new {
                filter = Str(e, "FilterName"),
                exposureSeconds = Dbl(e, "Exposure"),
                hfrMean = Dbl(e, "HFRMean"),
                hfrStDev = Dbl(e, "HFRStdDev"),
                fwhmMean = Dbl(e, "FWHMMean"),
                fwhmStDev = Dbl(e, "FWHMStdDev"),
                eccentricityMean = Dbl(e, "EccentricityMean"),
                eccentricityStDev = Dbl(e, "EccentricityStdDev"),
            }).ToList<object>();
            if (statsCache.Count > 200) {
                statsCache.Clear();
            }
            statsCache[targetId] = (DateTime.UtcNow, rows);
            return rows;
        }

        private static string Str(JsonElement e, string name) =>
            e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        // TS reports 0 when no graded frames exist yet; surface that as null.
        private static double? Dbl(JsonElement e, string name) =>
            e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.GetDouble() > 0 ? Math.Round(v.GetDouble(), 3) : null;

        public void Dispose() {
            cts.Cancel();
            foreach (var topic in Topics) {
                try {
                    broker.Unsubscribe(topic, this);
                } catch {
                }
            }
            imageSaveMediator.ImageSaved -= OnImageSaved;
            profileService.ProfileChanged -= OnProfileChanged;
            cts.Dispose();
        }
    }
}
