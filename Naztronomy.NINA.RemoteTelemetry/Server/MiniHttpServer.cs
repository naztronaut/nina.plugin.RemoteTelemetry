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
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NINA.Core.Utility;

namespace Naztronomy.NINA.RemoteTelemetry.Server {

    public sealed class HttpRequest {
        public string Method { get; init; }
        public string Path { get; init; }
        public IReadOnlyDictionary<string, string> Query { get; init; }
        public IReadOnlyDictionary<string, string> Headers { get; init; }

        public string Header(string name) => Headers.TryGetValue(name, out var v) ? v : null;

        public string QueryValue(string name) => Query.TryGetValue(name, out var v) ? v : null;

        public int QueryInt(string name, int fallback, int min, int max) {
            return int.TryParse(QueryValue(name), out var v) ? Math.Clamp(v, min, max) : fallback;
        }
    }

    public sealed class HttpResponse {
        public int Status { get; init; } = 200;
        public string ContentType { get; init; } = "application/json; charset=utf-8";
        public byte[] Body { get; init; } = Array.Empty<byte>();
        public Dictionary<string, string> Headers { get; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public static HttpResponse Text(int status, string text, string contentType = "text/plain; charset=utf-8") =>
            new HttpResponse { Status = status, ContentType = contentType, Body = Encoding.UTF8.GetBytes(text ?? string.Empty) };
    }

    /// <summary>
    /// Minimal HTTP/1.1 server on a raw TcpListener. Unlike HttpListener it needs no URL ACL or admin
    /// rights to listen on all interfaces. Supports small GET/HEAD/OPTIONS requests only; every
    /// connection is closed after a single response.
    /// </summary>
    public sealed class MiniHttpServer : IDisposable {
        private const int MaxHeaderBytes = 16 * 1024;
        private const int MaxConcurrentConnections = 32;
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);

        private readonly int port;
        private readonly Func<HttpRequest, Task<HttpResponse>> handler;
        private readonly SemaphoreSlim connectionSlots = new SemaphoreSlim(MaxConcurrentConnections);
        private TcpListener listener;
        private CancellationTokenSource cts;

        public MiniHttpServer(int port, Func<HttpRequest, Task<HttpResponse>> handler) {
            this.port = port;
            this.handler = handler;
        }

        public int Port => port;

        public void Start() {
            cts = new CancellationTokenSource();
            listener = new TcpListener(IPAddress.IPv6Any, port);
            listener.Server.DualMode = true;
            listener.Start();
            _ = AcceptLoopAsync(cts.Token);
        }

        private async Task AcceptLoopAsync(CancellationToken ct) {
            while (!ct.IsCancellationRequested) {
                TcpClient client;
                try {
                    client = await listener.AcceptTcpClientAsync(ct).ConfigureAwait(false);
                } catch (OperationCanceledException) {
                    break;
                } catch (ObjectDisposedException) {
                    break;
                } catch (Exception ex) {
                    Logger.Warning($"Remote Telemetry: accept failed: {ex.Message}");
                    continue;
                }

                if (!await connectionSlots.WaitAsync(0, ct).ConfigureAwait(false)) {
                    client.Dispose();
                    continue;
                }

                _ = Task.Run(async () => {
                    try {
                        await HandleClientAsync(client, ct).ConfigureAwait(false);
                    } finally {
                        connectionSlots.Release();
                    }
                }, ct);
            }
        }

        private async Task HandleClientAsync(TcpClient client, CancellationToken serverToken) {
            using (client)
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(serverToken)) {
                timeout.CancelAfter(RequestTimeout);
                try {
                    client.NoDelay = true;
                    var stream = client.GetStream();
                    var request = await ReadRequestAsync(stream, timeout.Token).ConfigureAwait(false);

                    HttpResponse response;
                    if (request == null) {
                        response = HttpResponse.Text(400, "Bad Request");
                    } else {
                        try {
                            response = await handler(request).ConfigureAwait(false);
                        } catch (Exception ex) {
                            Logger.Error($"Remote Telemetry: request {request.Path} failed", ex);
                            response = HttpResponse.Text(500, "Internal Server Error");
                        }
                    }

                    await WriteResponseAsync(stream, response, request?.Method == "HEAD", timeout.Token).ConfigureAwait(false);
                } catch (OperationCanceledException) {
                } catch (Exception ex) when (ex is System.IO.IOException || ex is SocketException) {
                }
            }
        }

        private static async Task<HttpRequest> ReadRequestAsync(NetworkStream stream, CancellationToken ct) {
            var buffer = new byte[MaxHeaderBytes];
            int total = 0;
            int headerEnd = -1;

            while (headerEnd < 0) {
                if (total == buffer.Length) {
                    return null;
                }
                var n = await stream.ReadAsync(buffer.AsMemory(total, buffer.Length - total), ct).ConfigureAwait(false);
                if (n == 0) {
                    return null;
                }
                var searchFrom = Math.Max(0, total - 3);
                total += n;
                headerEnd = IndexOfHeaderEnd(buffer, searchFrom, total);
            }

            var head = Encoding.ASCII.GetString(buffer, 0, headerEnd);
            var lines = head.Split("\r\n");
            var requestLine = lines[0].Split(' ');
            if (requestLine.Length != 3 || !requestLine[2].StartsWith("HTTP/1.", StringComparison.Ordinal)) {
                return null;
            }

            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 1; i < lines.Length; i++) {
                var colon = lines[i].IndexOf(':');
                if (colon > 0) {
                    headers[lines[i].Substring(0, colon).Trim()] = lines[i].Substring(colon + 1).Trim();
                }
            }

            var target = requestLine[1];
            var q = target.IndexOf('?');
            var rawPath = q >= 0 ? target.Substring(0, q) : target;
            var rawQuery = q >= 0 ? target.Substring(q + 1) : string.Empty;

            string path;
            try {
                path = Uri.UnescapeDataString(rawPath);
            } catch {
                return null;
            }

            return new HttpRequest {
                Method = requestLine[0].ToUpperInvariant(),
                Path = path,
                Query = ParseQuery(rawQuery),
                Headers = headers,
            };
        }

        private static int IndexOfHeaderEnd(byte[] buffer, int from, int to) {
            for (int i = from; i <= to - 4; i++) {
                if (buffer[i] == '\r' && buffer[i + 1] == '\n' && buffer[i + 2] == '\r' && buffer[i + 3] == '\n') {
                    return i;
                }
            }
            return -1;
        }

        private static Dictionary<string, string> ParseQuery(string query) {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries)) {
                var eq = pair.IndexOf('=');
                var key = eq >= 0 ? pair.Substring(0, eq) : pair;
                var value = eq >= 0 ? pair.Substring(eq + 1) : string.Empty;
                try {
                    result[Uri.UnescapeDataString(key.Replace('+', ' '))] = Uri.UnescapeDataString(value.Replace('+', ' '));
                } catch {
                }
            }
            return result;
        }

        private static async Task WriteResponseAsync(NetworkStream stream, HttpResponse response, bool headOnly, CancellationToken ct) {
            var sb = new StringBuilder();
            sb.Append("HTTP/1.1 ").Append(response.Status).Append(' ').Append(ReasonPhrase(response.Status)).Append("\r\n");
            sb.Append("Content-Type: ").Append(response.ContentType).Append("\r\n");
            sb.Append("Content-Length: ").Append(response.Body.Length).Append("\r\n");
            sb.Append("Connection: close\r\n");
            sb.Append("X-Content-Type-Options: nosniff\r\n");
            foreach (var h in response.Headers) {
                // Header values come from server code only, but strip CR/LF defensively.
                sb.Append(h.Key).Append(": ").Append(h.Value.Replace("\r", "").Replace("\n", "")).Append("\r\n");
            }
            sb.Append("\r\n");

            var headerBytes = Encoding.ASCII.GetBytes(sb.ToString());
            await stream.WriteAsync(headerBytes, ct).ConfigureAwait(false);
            if (!headOnly && response.Body.Length > 0) {
                await stream.WriteAsync(response.Body, ct).ConfigureAwait(false);
            }
            await stream.FlushAsync(ct).ConfigureAwait(false);
        }

        private static string ReasonPhrase(int status) => status switch {
            200 => "OK",
            204 => "No Content",
            400 => "Bad Request",
            401 => "Unauthorized",
            404 => "Not Found",
            405 => "Method Not Allowed",
            500 => "Internal Server Error",
            503 => "Service Unavailable",
            _ => "Unknown",
        };

        public void Dispose() {
            try {
                cts?.Cancel();
                listener?.Stop();
            } catch {
            }
            cts?.Dispose();
        }
    }
}
