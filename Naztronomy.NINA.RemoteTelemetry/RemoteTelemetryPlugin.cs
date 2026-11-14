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
using System.ComponentModel;
using System.ComponentModel.Composition;
using System.Diagnostics;
using System.Linq;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Threading.Tasks;
using System.Windows.Input;
using RelayCommand = CommunityToolkit.Mvvm.Input.RelayCommand;
using Naztronomy.NINA.RemoteTelemetry.Server;
using Naztronomy.NINA.RemoteTelemetry.Telemetry;
using NINA.Core.Utility;
using NINA.Core.Utility.Notification;
using NINA.Equipment.Interfaces.Mediator;
using NINA.Plugin;
using NINA.Plugin.Interfaces;
using NINA.Profile;
using NINA.Profile.Interfaces;
using NINA.Sequencer.Interfaces.Mediator;
using NINA.WPF.Base.Interfaces.Mediator;

namespace Naztronomy.NINA.RemoteTelemetry {

    /// <summary>
    /// Plugin manifest. Hosts the telemetry HTTP server for the lifetime of NINA.
    /// The options UI is the DataTemplate "Remote Telemetry_Options" in Options.xaml.
    /// </summary>
    [Export(typeof(IPluginManifest))]
    public class RemoteTelemetryPlugin : PluginBase, INotifyPropertyChanged {
        private const int DefaultPort = 8787;

        private readonly PluginOptionsAccessor settings;
        private readonly IProfileService profileService;
        private readonly LogTracker logTracker;
        private readonly ImageTracker imageTracker;
        private readonly GuideTracker guideTracker;
        private readonly TargetSchedulerTracker schedulerTracker;
        private readonly AllSkyService allSky;
        private string allSkyStatus = string.Empty;
        private readonly TelemetryApi api;
        private MiniHttpServer server;
        private string serverStatus = "Stopped";

        [ImportingConstructor]
        public RemoteTelemetryPlugin(
            IProfileService profileService,
            ISequenceMediator sequenceMediator,
            IImageSaveMediator imageSaveMediator,
            ICameraMediator cameraMediator,
            ITelescopeMediator telescopeMediator,
            IFocuserMediator focuserMediator,
            IFilterWheelMediator filterWheelMediator,
            IRotatorMediator rotatorMediator,
            IGuiderMediator guiderMediator,
            IWeatherDataMediator weatherDataMediator,
            ISafetyMonitorMediator safetyMonitorMediator,
            IDomeMediator domeMediator,
            IFlatDeviceMediator flatDeviceMediator,
            ISwitchMediator switchMediator,
            IMessageBroker messageBroker) {
            this.profileService = profileService;
            settings = new PluginOptionsAccessor(profileService, Guid.Parse(Identifier));

            logTracker = new LogTracker();
            imageTracker = new ImageTracker(imageSaveMediator, () => PreviewMaxWidth);
            guideTracker = new GuideTracker(guiderMediator);
            schedulerTracker = new TargetSchedulerTracker(messageBroker, profileService, imageSaveMediator, () => TargetSchedulerEnabled, () => TargetSchedulerPort);
            schedulerTracker.StatusChanged += (_, _) => RaisePropertyChanged(nameof(TargetSchedulerStatus));

            var collector = new TelemetryCollector(new TelemetrySources {
                Profile = profileService,
                Sequence = sequenceMediator,
                Camera = cameraMediator,
                Telescope = telescopeMediator,
                Focuser = focuserMediator,
                FilterWheel = filterWheelMediator,
                Rotator = rotatorMediator,
                Guider = guiderMediator,
                Weather = weatherDataMediator,
                SafetyMonitor = safetyMonitorMediator,
                Dome = domeMediator,
                FlatDevice = flatDeviceMediator,
                Switch = switchMediator,
            }, imageTracker, logTracker, schedulerTracker.GetNow);

            api = new TelemetryApi(collector, imageTracker, logTracker, guideTracker, schedulerTracker, allSky = new AllSkyService(() => AllSkySource), new SequenceTracker(sequenceMediator), () => GuiderPixelScale(guiderMediator), () => ApiKey, () => AllowedOrigins);

            RestartServerCommand = new RelayCommand(RestartServer);
            GenerateApiKeyCommand = new RelayCommand(() => ApiKey = NewApiKey());
            OpenDashboardCommand = new RelayCommand(OpenDashboard);
            BrowseAllSkyFileCommand = new RelayCommand(BrowseAllSkyFile);
            BrowseAllSkyFolderCommand = new RelayCommand(BrowseAllSkyFolder);
            TestAllSkyCommand = new RelayCommand(() => _ = CheckAllSkyAsync());

            profileService.ProfileChanged += ProfileService_ProfileChanged;

            logTracker.Start();
            schedulerTracker.Start();
            _ = CheckAllSkyAsync();
            RestartServer();
        }

        public override Task Teardown() {
            profileService.ProfileChanged -= ProfileService_ProfileChanged;
            StopServer();
            imageTracker.Dispose();
            guideTracker.Dispose();
            schedulerTracker.Dispose();
            logTracker.Dispose();
            return base.Teardown();
        }

        private void ProfileService_ProfileChanged(object sender, EventArgs e) {
            RaisePropertyChanged(nameof(ServerEnabled));
            RaisePropertyChanged(nameof(ServerPort));
            RaisePropertyChanged(nameof(ApiKey));
            RaisePropertyChanged(nameof(AllowedOrigins));
            RaisePropertyChanged(nameof(PreviewMaxWidth));
            RaisePropertyChanged(nameof(TargetSchedulerEnabled));
            RaisePropertyChanged(nameof(TargetSchedulerPort));
            RaisePropertyChanged(nameof(TargetSchedulerStatus));
            RaisePropertyChanged(nameof(AllSkySource));
            _ = CheckAllSkyAsync();
            RestartServer();
        }

        public ICommand RestartServerCommand { get; }
        public ICommand GenerateApiKeyCommand { get; }
        public ICommand OpenDashboardCommand { get; }

        public bool ServerEnabled {
            get => settings.GetValueBoolean(nameof(ServerEnabled), true);
            set {
                settings.SetValueBoolean(nameof(ServerEnabled), value);
                RaisePropertyChanged();
                RestartServer();
            }
        }

        public bool TargetSchedulerEnabled {
            get => settings.GetValueBoolean(nameof(TargetSchedulerEnabled), true);
            set {
                settings.SetValueBoolean(nameof(TargetSchedulerEnabled), value);
                RaisePropertyChanged();
                RaisePropertyChanged(nameof(TargetSchedulerStatus));
            }
        }

        /// <summary>Port of Target Scheduler's local API (TS profile preferences, default 8188).</summary>
        public int TargetSchedulerPort {
            get => settings.GetValueInt32(nameof(TargetSchedulerPort), 8188);
            set {
                if (value < 1 || value > 65535) {
                    RaisePropertyChanged();
                    return;
                }
                settings.SetValueInt32(nameof(TargetSchedulerPort), value);
                RaisePropertyChanged();
            }
        }

        public string TargetSchedulerStatus => schedulerTracker?.StatusText ?? string.Empty;

        public ICommand BrowseAllSkyFileCommand { get; }
        public ICommand BrowseAllSkyFolderCommand { get; }
        public ICommand TestAllSkyCommand { get; }

        /// <summary>All-sky image source: an image file, a folder (newest image is used) or an http(s) URL.</summary>
        public string AllSkySource {
            get => settings.GetValueString(nameof(AllSkySource), string.Empty);
            set {
                settings.SetValueString(nameof(AllSkySource), value?.Trim().Trim('"') ?? string.Empty);
                RaisePropertyChanged();
                _ = CheckAllSkyAsync();
            }
        }

        public string AllSkyStatus {
            get => allSkyStatus;
            private set {
                allSkyStatus = value;
                RaisePropertyChanged();
            }
        }

        private async Task CheckAllSkyAsync() {
            if (allSky == null) {
                return;
            }
            if (string.IsNullOrWhiteSpace(AllSkySource)) {
                AllSkyStatus = "Not configured";
                return;
            }
            AllSkyStatus = "Checking…";
            try {
                using var cts = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(30));
                var info = await allSky.GetInfoAsync(force: true, cts.Token);
                AllSkyStatus = info.Error != null
                    ? $"Problem: {info.Error}"
                    : info.ImageId != null
                        ? $"OK: {info.FileName} ({info.SizeBytes / 1024} KB, {info.ImageTimeUtc?.ToLocalTime():g})"
                        : "No image found";
            } catch (Exception ex) {
                AllSkyStatus = $"Problem: {ex.Message}";
            }
        }

        private void BrowseAllSkyFile() {
            var dialog = new Microsoft.Win32.OpenFileDialog {
                Title = "Select the all-sky image file",
                Filter = "Images (*.jpg;*.jpeg;*.png;*.webp;*.gif)|*.jpg;*.jpeg;*.png;*.webp;*.gif",
            };
            if (dialog.ShowDialog() == true) {
                AllSkySource = dialog.FileName;
            }
        }

        private void BrowseAllSkyFolder() {
            var dialog = new Microsoft.Win32.OpenFolderDialog { Title = "Select the folder the all-sky camera saves images to" };
            if (dialog.ShowDialog() == true) {
                AllSkySource = dialog.FolderName;
            }
        }

        public int ServerPort {
            get => settings.GetValueInt32(nameof(ServerPort), DefaultPort);
            set {
                if (value < 1024 || value > 65535) {
                    Notification.ShowWarning("Remote Telemetry: port must be between 1024 and 65535.");
                    RaisePropertyChanged();
                    return;
                }
                settings.SetValueInt32(nameof(ServerPort), value);
                RaisePropertyChanged();
                RestartServer();
            }
        }

        /// <summary>Optional shared secret. When set, every /api request must send it.</summary>
        public string ApiKey {
            get => settings.GetValueString(nameof(ApiKey), string.Empty);
            set {
                settings.SetValueString(nameof(ApiKey), value?.Trim() ?? string.Empty);
                RaisePropertyChanged();
            }
        }

        /// <summary>CORS origins allowed to call the API: "*" or a comma-separated list.</summary>
        public string AllowedOrigins {
            get => settings.GetValueString(nameof(AllowedOrigins), "*");
            set {
                settings.SetValueString(nameof(AllowedOrigins), value?.Trim() ?? string.Empty);
                RaisePropertyChanged();
            }
        }

        public int PreviewMaxWidth {
            get => settings.GetValueInt32(nameof(PreviewMaxWidth), 1280);
            set {
                settings.SetValueInt32(nameof(PreviewMaxWidth), Math.Clamp(value, 200, 4096));
                RaisePropertyChanged();
            }
        }

        public string ServerStatus {
            get => serverStatus;
            private set {
                serverStatus = value;
                RaisePropertyChanged();
                RaisePropertyChanged(nameof(DashboardUrls));
            }
        }

        /// <summary>URLs other machines can use to reach this NINA instance.</summary>
        public IReadOnlyList<string> DashboardUrls {
            get {
                if (server == null) {
                    return Array.Empty<string>();
                }
                var urls = new List<string>();
                try {
                    foreach (var nic in NetworkInterface.GetAllNetworkInterfaces()) {
                        if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) {
                            continue;
                        }
                        foreach (var addr in nic.GetIPProperties().UnicastAddresses) {
                            if (addr.Address.AddressFamily == AddressFamily.InterNetwork) {
                                urls.Add($"http://{addr.Address}:{server.Port}/  ({nic.Name})");
                            }
                        }
                    }
                } catch {
                }
                urls.Add($"http://{Environment.MachineName.ToLowerInvariant()}:{server.Port}/  (hostname / Tailscale MagicDNS)");
                return urls;
            }
        }

        private void RestartServer() {
            StopServer();

            if (!ServerEnabled) {
                ServerStatus = "Disabled";
                return;
            }

            var port = ServerPort;
            try {
                var s = new MiniHttpServer(port, api.HandleAsync);
                s.Start();
                server = s;
                ServerStatus = $"Listening on port {port}";
                Logger.Info($"Remote Telemetry: listening on port {port}");
            } catch (Exception ex) {
                ServerStatus = $"Failed to start on port {port}: {ex.Message}";
                Logger.Error($"Remote Telemetry: failed to start on port {port}", ex);
                Notification.ShowError($"Remote Telemetry could not listen on port {port}: {ex.Message}");
            }
        }

        private void StopServer() {
            server?.Dispose();
            server = null;
        }

        private void OpenDashboard() {
            if (server == null) {
                return;
            }
            try {
                Process.Start(new ProcessStartInfo($"http://localhost:{server.Port}/") { UseShellExecute = true });
            } catch (Exception ex) {
                Logger.Error("Remote Telemetry: failed to open dashboard", ex);
            }
        }

        private static double? GuiderPixelScale(IGuiderMediator guider) {
            try {
                var info = guider.GetInfo();
                return info?.Connected == true ? info.PixelScale : null;
            } catch {
                return null;
            }
        }

        private static string NewApiKey() {
            return Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)).Replace('+', '-').Replace('/', '_').TrimEnd('=');
        }

        public event PropertyChangedEventHandler PropertyChanged;

        protected void RaisePropertyChanged([CallerMemberName] string propertyName = null) {
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
        }
    }
}
