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
using NINA.Core.Utility;
using NINA.Equipment.Equipment;
using NINA.Equipment.Interfaces.Mediator;
using NINA.Profile.Interfaces;
using NINA.Sequencer.Interfaces.Mediator;

namespace Naztronomy.NINA.RemoteTelemetry.Telemetry {

    /// <summary>NINA mediators the collector reads from. All are exported by NINA via MEF.</summary>
    public sealed class TelemetrySources {
        public IProfileService Profile { get; init; }
        public ISequenceMediator Sequence { get; init; }
        public ICameraMediator Camera { get; init; }
        public ITelescopeMediator Telescope { get; init; }
        public IFocuserMediator Focuser { get; init; }
        public IFilterWheelMediator FilterWheel { get; init; }
        public IRotatorMediator Rotator { get; init; }
        public IGuiderMediator Guider { get; init; }
        public IWeatherDataMediator Weather { get; init; }
        public ISafetyMonitorMediator SafetyMonitor { get; init; }
        public IDomeMediator Dome { get; init; }
        public IFlatDeviceMediator FlatDevice { get; init; }
        public ISwitchMediator Switch { get; init; }
    }

    /// <summary>Builds JSON-ready snapshots of NINA's current state.</summary>
    public sealed class TelemetryCollector {
        private readonly TelemetrySources s;
        private readonly ImageTracker images;
        private readonly LogTracker logs;
        private readonly DateTime startedUtc = DateTime.UtcNow;

        public TelemetryCollector(TelemetrySources sources, ImageTracker images, LogTracker logs) {
            s = sources;
            this.images = images;
            this.logs = logs;
        }

        public object GetInfo() {
            var profile = Safe(() => s.Profile.ActiveProfile);
            return new {
                apiVersion = 1,
                plugin = "Remote Telemetry",
                pluginVersion = typeof(TelemetryCollector).Assembly.GetName().Version?.ToString(),
                ninaVersion = Safe(() => CoreUtil.Version),
                machineName = Environment.MachineName,
                profile = profile?.Name,
                serverTimeUtc = DateTime.UtcNow,
                pluginStartedUtc = startedUtc,
                location = profile == null ? null : new {
                    latitude = Num.N(profile.AstrometrySettings.Latitude),
                    longitude = Num.N(profile.AstrometrySettings.Longitude),
                    elevation = Num.N(profile.AstrometrySettings.Elevation),
                },
            };
        }

        public object GetStatus() => new {
            info = GetInfo(),
            safety = GetSafety(),
            sequence = GetSequence(),
            devices = GetDevices(),
            lastImage = images.Latest,
            issues = logs.GetSummary(10),
        };

        public object GetSafety() {
            var safety = Safe(() => s.SafetyMonitor.GetInfo());
            var connected = safety?.Connected == true;
            return new {
                connected,
                name = connected ? safety.DisplayName : null,
                isSafe = connected ? safety.IsSafe : (bool?)null,
                state = !connected ? "unknown" : safety.IsSafe ? "safe" : "unsafe",
            };
        }

        public object GetSequence() {
            var running = Safe(() => s.Sequence.IsAdvancedSequenceRunning());

            var targets = Safe(() => s.Sequence.GetAllTargetsInAdvancedSequence()?
                .Select(t => new {
                    name = string.IsNullOrWhiteSpace(t.Target?.TargetName) ? t.Name : t.Target.TargetName,
                    status = t.Status.ToString(),
                    ra = t.Target?.InputCoordinates?.Coordinates?.RAString,
                    dec = t.Target?.InputCoordinates?.Coordinates?.DecString,
                })
                .ToList()) ?? new();

            var runningItems = Safe(() => s.Sequence.GetAdvancedSequencerCurrentRunningItems()?
                .Select(i => new { name = i.Name, category = i.Category })
                .ToList()) ?? new();

            var activeTarget = targets.FirstOrDefault(t => t.status == "RUNNING")?.name;

            return new {
                isRunning = running,
                activeTarget = activeTarget ?? (running ? images.Latest?.Target : null),
                runningItems,
                targets,
            };
        }

        public Dictionary<string, object> GetDevices() => new Dictionary<string, object> {
            ["camera"] = Device(() => s.Camera.GetInfo(), (i, d) => {
                d["state"] = i.CameraState.ToString();
                d["isExposing"] = i.IsExposing;
                d["exposureEndUtc"] = i.IsExposing ? i.ExposureEndTime.ToUniversalTime() : null;
                d["temperature"] = Num.N(i.Temperature);
                d["setPoint"] = i.CanSetTemperature ? Num.N(i.TemperatureSetPoint) : null;
                d["coolerOn"] = i.CoolerOn;
                d["coolerPower"] = Num.N(i.CoolerPower);
                d["dewHeaterOn"] = i.HasDewHeater ? i.DewHeaterOn : null;
                d["battery"] = i.HasBattery ? i.Battery : null;
                d["gain"] = i.Gain;
                d["offset"] = i.Offset;
                d["binX"] = i.BinX;
                d["binY"] = i.BinY;
                d["width"] = i.XSize;
                d["height"] = i.YSize;
                d["pixelSize"] = Num.N(i.PixelSize);
                d["lastDownloadSeconds"] = Num.N(i.LastDownloadTime);
            }),
            ["mount"] = Device(() => s.Telescope.GetInfo(), (i, d) => {
                d["ra"] = i.RightAscensionString;
                d["dec"] = i.DeclinationString;
                d["raHours"] = Num.N(i.RightAscension);
                d["decDegrees"] = Num.N(i.Declination);
                d["altitude"] = Num.N(i.Altitude);
                d["azimuth"] = Num.N(i.Azimuth);
                d["sideOfPier"] = i.SideOfPier.ToString();
                d["tracking"] = i.TrackingEnabled;
                d["slewing"] = i.Slewing;
                d["atPark"] = i.AtPark;
                d["atHome"] = i.AtHome;
                d["siderealTime"] = i.SiderealTimeString;
                d["timeToMeridianFlipHours"] = Num.N(i.TimeToMeridianFlip);
                d["timeToMeridianFlip"] = i.TimeToMeridianFlipString;
            }),
            ["guider"] = Device(() => s.Guider.GetInfo(), (i, d) => {
                var rms = i.RMSError;
                d["pixelScale"] = Num.N(i.PixelScale);
                d["rms"] = rms == null ? null : new {
                    totalArcsec = Num.N(rms.Total?.Arcseconds),
                    raArcsec = Num.N(rms.RA?.Arcseconds),
                    decArcsec = Num.N(rms.Dec?.Arcseconds),
                    peakRaArcsec = Num.N(rms.PeakRA?.Arcseconds),
                    peakDecArcsec = Num.N(rms.PeakDec?.Arcseconds),
                    totalPixels = Num.N(rms.Total?.Pixel),
                };
            }),
            ["focuser"] = Device(() => s.Focuser.GetInfo(), (i, d) => {
                d["position"] = i.Position;
                d["temperature"] = Num.N(i.Temperature);
                d["isMoving"] = i.IsMoving;
                d["isSettling"] = i.IsSettling;
                d["tempComp"] = i.TempComp;
            }),
            ["filterWheel"] = Device(() => s.FilterWheel.GetInfo(), (i, d) => {
                d["filter"] = i.SelectedFilter?.Name;
                d["isMoving"] = i.IsMoving;
            }),
            ["rotator"] = Device(() => s.Rotator.GetInfo(), (i, d) => {
                d["position"] = Num.N(i.Position);
                d["mechanicalPosition"] = Num.N(i.MechanicalPosition);
                d["isMoving"] = i.IsMoving;
            }),
            ["dome"] = Device(() => s.Dome.GetInfo(), (i, d) => {
                d["shutter"] = i.ShutterStatus.ToString();
                d["azimuth"] = Num.N(i.Azimuth);
                d["atPark"] = i.AtPark;
                d["slewing"] = i.Slewing;
                d["following"] = i.DriverFollowing || i.ApplicationFollowing;
            }),
            ["flatDevice"] = Device(() => s.FlatDevice.GetInfo(), (i, d) => {
                d["coverState"] = i.CoverState.ToString();
                d["lightOn"] = i.LightOn;
                d["brightness"] = i.Brightness;
            }),
            ["weather"] = Device(() => s.Weather.GetInfo(), (i, d) => {
                d["temperature"] = Num.N(i.Temperature);
                d["humidity"] = Num.N(i.Humidity);
                d["dewPoint"] = Num.N(i.DewPoint);
                d["pressure"] = Num.N(i.Pressure);
                d["cloudCover"] = Num.N(i.CloudCover);
                d["rainRate"] = Num.N(i.RainRate);
                d["skyBrightness"] = Num.N(i.SkyBrightness);
                d["skyQuality"] = Num.N(i.SkyQuality);
                d["skyTemperature"] = Num.N(i.SkyTemperature);
                d["starFwhm"] = Num.N(i.StarFWHM);
                d["windSpeed"] = Num.N(i.WindSpeed);
                d["windGust"] = Num.N(i.WindGust);
                d["windDirection"] = Num.N(i.WindDirection);
            }),
            ["safetyMonitor"] = Device(() => s.SafetyMonitor.GetInfo(), (i, d) => {
                d["isSafe"] = i.IsSafe;
            }),
            ["switch"] = Device(() => s.Switch.GetInfo(), (i, d) => {
                var writable = i.WritableSwitches?.Select(x => new { id = x.Id, name = x.Name, value = Num.N(x.Value), writable = true }) ?? Enumerable.Empty<object>();
                var readOnly = i.ReadonlySwitches?.Select(x => new { id = x.Id, name = x.Name, value = Num.N(x.Value), writable = false }) ?? Enumerable.Empty<object>();
                d["switches"] = writable.Cast<object>().Concat(readOnly).ToList();
            }),
        };

        private static Dictionary<string, object> Device<T>(Func<T> getInfo, Action<T, Dictionary<string, object>> details) where T : DeviceInfo {
            var info = Safe(getInfo);
            var d = new Dictionary<string, object> {
                ["connected"] = info?.Connected == true,
                ["name"] = info?.Connected == true ? (string.IsNullOrWhiteSpace(info.DisplayName) ? info.Name : info.DisplayName) : null,
            };
            if (info?.Connected == true) {
                d["driver"] = info.DriverInfo;
                d["driverVersion"] = info.DriverVersion;
                try {
                    details(info, d);
                } catch (Exception ex) {
                    d["error"] = ex.Message;
                }
            }
            return d;
        }

        private static T Safe<T>(Func<T> f) {
            try {
                return f();
            } catch {
                return default;
            }
        }
    }
}
