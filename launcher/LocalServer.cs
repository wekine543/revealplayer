using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace RevealPlayer.Launcher;

/// <summary>
/// The launcher's own web server: serves the built player, plus the combo-store
/// API that page talks to (`/__rp/store/...` — the same one the Vite dev server
/// provides, so the two are interchangeable).
///
/// Written directly on TcpListener rather than HttpListener or Kestrel because
/// HttpListener refuses to bind a LAN prefix without an administrator URL
/// reservation, which would defeat the point of a double-clickable tool.
/// </summary>
public sealed class LocalServer : IDisposable
{
    private const string StorePrefix = "/__rp/store";
    private const string ConfigName = "revealplayer.config.json";
    private const string MediaDir = "media";
    private const int MaxHeadBytes = 64 * 1024;
    private const int MaxJsonBytes = 32 * 1024 * 1024;

    private static readonly Dictionary<string, string> Mime = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".mjs"] = "text/javascript; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".json"] = "application/json; charset=utf-8",
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".webp"] = "image/webp",
        [".gif"] = "image/gif",
        [".bmp"] = "image/bmp",
        [".ico"] = "image/x-icon",
        [".woff2"] = "font/woff2",
        [".mp4"] = "video/mp4",
        [".m4v"] = "video/mp4",
        [".mov"] = "video/quicktime",
        [".webm"] = "video/webm",
        [".ogg"] = "video/ogg",
        [".ogv"] = "video/ogg",
    };

    private readonly CancellationTokenSource _cts = new();
    private TcpListener? _listener;
    private Task? _acceptLoop;

    public int Port { get; }
    public bool Lan { get; }
    public string AppDirectory { get; }
    public string? Error { get; private set; }

    /// <summary>Where combos are kept. Changeable from the page, like the dev server.</summary>
    public string StoreDirectory { get; private set; }

    /// <summary>Raised when the page picks a different store directory.</summary>
    public event Action<string>? StoreDirectoryChanged;

    private long _requests;
    public long Requests => Interlocked.Read(ref _requests);

    public LocalServer(int port, bool lan, string appDirectory, string storeDirectory)
    {
        Port = port;
        Lan = lan;
        AppDirectory = appDirectory;
        StoreDirectory = storeDirectory;
    }

    public void Start()
    {
        var address = Lan ? IPAddress.Any : IPAddress.Loopback;
        var listener = new TcpListener(address, Port);
        listener.Start();
        _listener = listener;
        _acceptLoop = Task.Run(() => AcceptLoopAsync(_cts.Token));
    }

    public void Stop()
    {
        try { _cts.Cancel(); } catch { /* already gone */ }
        try { _listener?.Stop(); } catch { /* already gone */ }
        try { _acceptLoop?.Wait(TimeSpan.FromSeconds(2)); } catch { /* shutting down anyway */ }
        _listener = null;
    }

    public void Dispose() => Stop();

    // ------------------------------------------------------------------ plumbing

    private async Task AcceptLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener!.AcceptTcpClientAsync(token);
            }
            catch
            {
                // Cancelled or the listener was closed: either way, done.
                return;
            }
            _ = Task.Run(() => HandleClientAsync(client), CancellationToken.None);
        }
    }

    private sealed record Request(
        string Method,
        string Path,
        string Query,
        Dictionary<string, string> Headers,
        NetworkStream Stream,
        /// <summary>
        /// Body bytes that arrived in the same read as the headers. Dropping
        /// these is what makes a small PUT hang: the client already sent the
        /// body, so waiting for it on the socket waits forever.
        /// </summary>
        byte[] Prefix);

    private async Task HandleClientAsync(TcpClient client)
    {
        using var _ = client;
        try
        {
            client.NoDelay = true;
            client.ReceiveTimeout = 30000;
            client.SendTimeout = 60000;
            using var stream = client.GetStream();

            var request = await ReadRequestAsync(stream, _cts.Token);
            if (request is null) return;
            Interlocked.Increment(ref _requests);
            await RouteAsync(request);
        }
        catch (Exception e)
        {
            Debug.WriteLine($"[launcher] request failed: {e.Message}");
        }
    }

    private static async Task<Request?> ReadRequestAsync(NetworkStream stream, CancellationToken token)
    {
        var buffer = new byte[8192];
        var head = new MemoryStream();
        var searched = 0;

        while (head.Length < MaxHeadBytes)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(), token);
            if (read <= 0) return null;
            head.Write(buffer, 0, read);

            var text = Encoding.ASCII.GetString(head.GetBuffer(), 0, (int)head.Length);
            var end = text.IndexOf("\r\n\r\n", Math.Max(0, searched - 3), StringComparison.Ordinal);
            if (end < 0)
            {
                searched = text.Length;
                continue;
            }

            var lines = text[..end].Split("\r\n");
            var parts = lines[0].Split(' ');
            if (parts.Length < 3) return null;

            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (var i = 1; i < lines.Length; i++)
            {
                var colon = lines[i].IndexOf(':');
                if (colon <= 0) continue;
                headers[lines[i][..colon].Trim()] = lines[i][(colon + 1)..].Trim();
            }

            var target = parts[1];
            var rawPath = target;
            var query = string.Empty;
            var mark = target.IndexOf('?');
            if (mark >= 0)
            {
                rawPath = target[..mark];
                query = target[mark..];
            }

            // Decode the escapes here rather than taking `Uri.AbsolutePath`:
            // that property leaves non-ASCII escapes such as `%E9%B8%A2` alone
            // (they are not ASCII characters it is willing to unescape), so a
            // file called "VID_...鸢青.mp4" resolves to a name that does not
            // exist and every request for it becomes a 404 — while the same
            // request for an ASCII name works, which makes it look like the
            // file is the problem.
            var path = Uri.UnescapeDataString(rawPath);
            if (path.Length == 0) path = "/";

            // Anything past the blank line is the start of the body.
            var bodyStart = end + 4;
            var buffered = (int)head.Length;
            var prefix = new byte[Math.Max(0, buffered - bodyStart)];
            if (prefix.Length > 0) Array.Copy(head.GetBuffer(), bodyStart, prefix, 0, prefix.Length);

            return new Request(parts[0].ToUpperInvariant(), path, query, headers, stream, prefix);
        }
        return null;
    }

    private async Task RouteAsync(Request request)
    {
        // Chrome announces a large upload with `Expect: 100-continue` and waits
        // for the go-ahead; without it the body only arrives after a timeout.
        if (request.Headers.TryGetValue("Expect", out var expect)
            && expect.Contains("100-continue", StringComparison.OrdinalIgnoreCase))
        {
            await request.Stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 100 Continue\r\n\r\n"));
        }

        var path = request.Path;

        if (path.StartsWith(StorePrefix, StringComparison.Ordinal))
        {
            await HandleStoreAsync(request, path[StorePrefix.Length..]);
            return;
        }

        if (request.Method is "GET" or "HEAD")
        {
            await ServeAppFileAsync(request, path);
            return;
        }

        await SendEmptyAsync(request.Stream, 405, "Method Not Allowed");
    }

    // --------------------------------------------------------------- static app

    private async Task ServeAppFileAsync(Request request, string path)
    {
        var relative = path.TrimStart('/');
        if (relative.Length == 0) relative = "index.html";

        var file = ResolveInside(AppDirectory, relative);
        // Unknown paths fall back to the single page: the player routes in the
        // browser, and a missing favicon should not be a 404 wall.
        if (file is null || !File.Exists(file))
        {
            if (!relative.Contains('.') || relative.EndsWith(".html", StringComparison.OrdinalIgnoreCase))
            {
                file = Path.Combine(AppDirectory, "index.html");
            }
            else
            {
                await SendEmptyAsync(request.Stream, 404, "Not Found");
                return;
            }
        }

        if (!File.Exists(file))
        {
            await SendTextAsync(request.Stream, 404, "Not Found",
                "没有找到 index.html —— 请把它和启动器放在同一个文件夹里。");
            return;
        }

        var info = new FileInfo(file);
        var type = Mime.TryGetValue(info.Extension, out var known) ? known : "application/octet-stream";
        var headOnly = request.Method == "HEAD";

        // The page itself is never stored: this is a single-file app with no
        // build hash in its name, so a device that keeps an old copy keeps an
        // old version of every fix inside it. The icons are stable and only
        // need revalidating.
        var cacheControl = info.Extension.Equals(".html", StringComparison.OrdinalIgnoreCase)
            ? "no-store"
            : "no-cache";
        var extra = new List<(string, string)> { ("Cache-Control", cacheControl) };
        var range = ParseRange(request.Headers.GetValueOrDefault("Range"), info.Length);
        if (range is { } slice)
        {
            extra.Add(("Content-Range", $"bytes {slice.Start}-{slice.End}/{info.Length}"));
            await SendHeadAsync(request.Stream, 206, "Partial Content", type, slice.Length, extra);
            if (!headOnly) await SendFileRangeAsync(request.Stream, file, slice.Start, slice.Length);
            return;
        }

        await SendHeadAsync(request.Stream, 200, "OK", type, info.Length, extra);
        if (!headOnly) await SendFileRangeAsync(request.Stream, file, 0, info.Length);
    }

    // ------------------------------------------------------------- store routes

    private async Task HandleStoreAsync(Request request, string route)
    {
        try
        {
            if (route.StartsWith("/media", StringComparison.OrdinalIgnoreCase)
                && request.Method is "GET" or "HEAD")
            {
                await ServeMediaAsync(request, route["/media".Length..].TrimStart('/'));
                return;
            }

            if (route.StartsWith("/config", StringComparison.OrdinalIgnoreCase))
            {
                if (request.Method == "GET")
                {
                    await SendJsonAsync(request.Stream, Payload());
                    return;
                }
                if (request.Method == "PUT")
                {
                    var body = await ReadBodyBytesAsync(request, MaxJsonBytes);
                    PatchConfig(body);
                    await SendJsonAsync(request.Stream, "{\"ok\":true,\"updatedAt\":" + DateTimeOffset.Now.ToUnixTimeMilliseconds() + "}");
                    return;
                }
            }

            if (route.StartsWith("/dir", StringComparison.OrdinalIgnoreCase) && request.Method == "POST")
            {
                var body = await ReadBodyBytesAsync(request, 64 * 1024);
                ChangeStoreDirectory(body);
                await SendJsonAsync(request.Stream, Payload());
                return;
            }

            if (route.StartsWith("/media", StringComparison.OrdinalIgnoreCase) && request.Method == "POST")
            {
                await UploadMediaAsync(request);
                return;
            }

            if (route.StartsWith("/open", StringComparison.OrdinalIgnoreCase) && request.Method == "POST")
            {
                var body = await ReadBodyBytesAsync(request, 64 * 1024);
                var path = ReadJsonString(body, "path") ?? StoreDirectory;
                OpenInShell(path);
                await SendJsonAsync(request.Stream, "{\"ok\":true}");
                return;
            }

            await SendEmptyAsync(request.Stream, 404, "Not Found");
        }
        catch (Exception e)
        {
            await SendJsonAsync(request.Stream, $"{{\"ok\":false,\"message\":{JsonSerializer.Serialize(e.Message)}}}", 500);
        }
    }

    private string ConfigFile => Path.Combine(StoreDirectory, ConfigName);

    /// <summary>
    /// The envelope the page expects: dir, combos and mask settings.
    ///
    /// `managed` tells the page that this server owns the storage — the folder
    /// was chosen in the launcher, so the page uses it as-is and never asks the
    /// user to pick one. The Vite dev server does not send it, which is what
    /// keeps the config-folder workflow untouched while developing.
    /// </summary>
    private string Payload()
    {
        var node = ReadConfigNode();
        var combos = node?["combos"] as JsonArray ?? new JsonArray();
        var mask = node?["maskSettings"];
        var payload = new JsonObject
        {
            ["ok"] = true,
            ["managed"] = true,
            ["dir"] = StoreDirectory,
            ["combos"] = combos.DeepClone(),
            ["maskSettings"] = mask?.DeepClone(),
        };
        return payload.ToJsonString();
    }

    private JsonObject? ReadConfigNode()
    {
        try
        {
            if (!File.Exists(ConfigFile)) return null;
            return JsonNode.Parse(File.ReadAllText(ConfigFile)) as JsonObject;
        }
        catch
        {
            // A truncated or hand-broken file must not fail every read.
            return null;
        }
    }

    /// <summary>Partial update: a field left out of the body is left alone on disk.</summary>
    private void PatchConfig(byte[] body)
    {
        var incoming = JsonNode.Parse(body) as JsonObject;
        if (incoming is null) return;

        var node = ReadConfigNode() ?? new JsonObject
        {
            ["version"] = 1,
            ["updatedAt"] = 0,
            ["maskSettings"] = null,
            ["combos"] = new JsonArray(),
        };

        if (incoming["combos"] is JsonArray combos) node["combos"] = combos.DeepClone();
        if (incoming.TryGetPropertyValue("maskSettings", out var mask)) node["maskSettings"] = mask?.DeepClone();
        node["updatedAt"] = DateTimeOffset.Now.ToUnixTimeMilliseconds();

        Directory.CreateDirectory(StoreDirectory);
        File.WriteAllText(ConfigFile, node.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    private void ChangeStoreDirectory(byte[] body)
    {
        var target = ReadJsonString(body, "path");
        if (string.IsNullOrWhiteSpace(target))
            throw new InvalidOperationException("missing path");

        var create = ReadJsonBool(body, "create");
        if (!Directory.Exists(target))
        {
            if (!create) throw new InvalidOperationException("该路径不存在");
            Directory.CreateDirectory(target);
        }
        StoreDirectory = target;
        StoreDirectoryChanged?.Invoke(target);
    }

    private async Task ServeMediaAsync(Request request, string name)
    {
        var file = ResolveInside(Path.Combine(StoreDirectory, MediaDir), name);
        if (file is null || !File.Exists(file))
        {
            await SendJsonAsync(request.Stream, "{\"ok\":false,\"message\":\"media not found\"}", 404);
            return;
        }

        var info = new FileInfo(file);
        var type = Mime.TryGetValue(info.Extension, out var known) ? known : "application/octet-stream";
        var extra = new List<(string, string)> { ("Accept-Ranges", "bytes"), ("Cache-Control", "no-cache") };

        var range = ParseRange(request.Headers.GetValueOrDefault("Range"), info.Length);
        if (range is { } slice)
        {
            extra.Add(("Content-Range", $"bytes {slice.Start}-{slice.End}/{info.Length}"));
            await SendHeadAsync(request.Stream, 206, "Partial Content", type, slice.Length, extra);
            if (request.Method != "HEAD") await SendFileRangeAsync(request.Stream, file, slice.Start, slice.Length);
            return;
        }

        await SendHeadAsync(request.Stream, 200, "OK", type, info.Length, extra);
        if (request.Method != "HEAD") await SendFileRangeAsync(request.Stream, file, 0, info.Length);
    }

    /// <summary>
    /// Save an uploaded clip under `media/`. An existing file of the same size is
    /// reused — another combo may already point at it — and a different file
    /// under the same name is never overwritten.
    /// </summary>
    private async Task UploadMediaAsync(Request request)
    {
        var query = ParseQuery(request.Query);
        var fileName = query.GetValueOrDefault("name") ?? "media";
        var size = long.TryParse(query.GetValueOrDefault("size"), out var declared) ? declared : -1;

        var mediaDir = Path.Combine(StoreDirectory, MediaDir);
        Directory.CreateDirectory(mediaDir);
        var baseName = SafeFileName(fileName);

        string? target = null;
        var name = baseName;
        var reuse = false;
        for (var n = 1; n <= 20; n++)
        {
            var candidate = n == 1 ? baseName : WithSuffix(baseName, n);
            var full = Path.Combine(mediaDir, candidate);
            if (!File.Exists(full))
            {
                target = full;
                name = candidate;
                break;
            }
            if (size > 0 && new FileInfo(full).Length == size)
            {
                target = full;
                name = candidate;
                reuse = true;
                break;
            }
        }

        if (target is null)
        {
            await SendJsonAsync(request.Stream, "{\"ok\":false,\"message\":\"cannot allocate a file name\"}", 500);
            return;
        }

        if (!reuse)
        {
            // Without a length there is no way to know where the body ends, and
            // the upload comes from the page itself, which always sets one.
            if (!request.Headers.ContainsKey("Content-Length"))
            {
                await SendJsonAsync(request.Stream, "{\"ok\":false,\"message\":\"missing content-length\"}", 411);
                return;
            }
            await using var file = File.Create(target);
            await CopyBodyAsync(request, file, ContentLengthOf(request));
        }

        var url = $"{StorePrefix}/media/{Uri.EscapeDataString(name)}";
        var body = new JsonObject { ["ok"] = true, ["url"] = url, ["name"] = name, ["reused"] = reuse };
        await SendJsonAsync(request.Stream, body.ToJsonString());
    }

    // ------------------------------------------------------------------- helpers

    private sealed record Slice(long Start, long End)
    {
        public long Length => End - Start + 1;
    }

    /// <summary>`bytes=a-b`, `bytes=a-`, `bytes=-n`; null when there is no usable range.</summary>
    private static Slice? ParseRange(string? header, long length)
    {
        if (string.IsNullOrWhiteSpace(header) || !header.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase))
            return null;
        var spec = header["bytes=".Length..].Split(',')[0].Trim();
        var dash = spec.IndexOf('-');
        if (dash < 0) return null;

        var fromText = spec[..dash];
        var toText = spec[(dash + 1)..];

        long start;
        long end;
        if (fromText.Length == 0)
        {
            if (!long.TryParse(toText, out var suffix) || suffix <= 0) return null;
            start = Math.Max(0, length - suffix);
            end = length - 1;
        }
        else
        {
            if (!long.TryParse(fromText, out start)) return null;
            end = toText.Length > 0 && long.TryParse(toText, out var to) ? Math.Min(to, length - 1) : length - 1;
        }
        if (start < 0 || start >= length || start > end) return null;
        return new Slice(start, end);
    }

    /// <summary>Decode a query string into a plain map — no framework needed.</summary>
    private static Dictionary<string, string> ParseQuery(string query)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = pair.IndexOf('=');
            var key = eq >= 0 ? pair[..eq] : pair;
            var value = eq >= 0 ? pair[(eq + 1)..] : string.Empty;
            result[Uri.UnescapeDataString(key.Replace('+', ' '))] =
                Uri.UnescapeDataString(value.Replace('+', ' '));
        }
        return result;
    }

    private static string? ReadJsonString(byte[] body, string key)
    {
        try
        {
            return (JsonNode.Parse(body) as JsonObject)?[key]?.GetValue<string>();
        }
        catch
        {
            return null;
        }
    }

    private static bool ReadJsonBool(byte[] body, string key)
    {
        try
        {
            return (JsonNode.Parse(body) as JsonObject)?[key]?.GetValue<bool>() ?? false;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Resolve a relative path, refusing anything that escapes `root`.</summary>
    private static string? ResolveInside(string root, string relative)
    {
        try
        {
            var rootFull = Path.GetFullPath(root);
            var full = Path.GetFullPath(Path.Combine(rootFull, relative.Replace('\\', '/').TrimStart('/')));
            if (full.Equals(rootFull, StringComparison.OrdinalIgnoreCase)) return full;
            return full.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                ? full
                : null;
        }
        catch
        {
            return null;
        }
    }

    private static string SafeFileName(string name)
    {
        var slash = name.LastIndexOfAny(['\\', '/']);
        var basename = slash >= 0 ? name[(slash + 1)..] : name;
        var builder = new StringBuilder(basename.Length);
        foreach (var ch in basename)
        {
            builder.Append(ch < 32 || "<>:\"|?*".Contains(ch) ? '_' : ch);
        }
        var cleaned = builder.ToString().Trim();
        return cleaned.Length > 0 ? cleaned : "media";
    }

    private static string WithSuffix(string name, int n)
    {
        var dot = name.LastIndexOf('.');
        return dot <= 0 ? $"{name} ({n})" : $"{name[..dot]} ({n}){name[(dot + 1)..]}";
    }

    private static void OpenInShell(string path)
    {
        try
        {
            if (!Directory.Exists(path)) Directory.CreateDirectory(path);
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true })?.Dispose();
        }
        catch (Exception e)
        {
            Debug.WriteLine($"[launcher] cannot open {path}: {e.Message}");
        }
    }

    // ------------------------------------------------------------------ transport

    private static long ContentLengthOf(Request request) =>
        request.Headers.TryGetValue("Content-Length", out var raw) && long.TryParse(raw, out var parsed) ? parsed : 0;

    private static async Task<byte[]> ReadBodyBytesAsync(Request request, int limit)
    {
        var length = ContentLengthOf(request);
        if (length <= 0) return [];
        if (length > limit) throw new InvalidOperationException($"body too large ({length} bytes)");

        var buffer = new byte[length];
        var fromPrefix = (int)Math.Min(length, request.Prefix.Length);
        if (fromPrefix > 0) Array.Copy(request.Prefix, buffer, fromPrefix);

        var offset = fromPrefix;
        while (offset < length)
        {
            var read = await request.Stream.ReadAsync(buffer.AsMemory(offset, (int)(length - offset)));
            if (read <= 0) throw new IOException("connection closed mid-body");
            offset += read;
        }
        return buffer;
    }

    /// <summary>Copy exactly `length` body bytes into `to`, prefix first.</summary>
    private static async Task CopyBodyAsync(Request request, Stream to, long length)
    {
        var fromPrefix = (int)Math.Min(length, request.Prefix.Length);
        if (fromPrefix > 0) await to.WriteAsync(request.Prefix.AsMemory(0, fromPrefix));
        await CopyExactAsync(request.Stream, to, length - fromPrefix);
    }

    private static async Task CopyExactAsync(NetworkStream from, Stream to, long length)
    {
        var buffer = new byte[128 * 1024];
        var remaining = length;
        while (remaining > 0)
        {
            var want = (int)Math.Min(buffer.Length, remaining);
            var read = await from.ReadAsync(buffer.AsMemory(0, want));
            if (read <= 0) throw new IOException("connection closed mid-upload");
            await to.WriteAsync(buffer.AsMemory(0, read));
            remaining -= read;
        }
    }

    private static async Task SendHeadAsync(
        NetworkStream stream, int status, string reason, string contentType, long length,
        IEnumerable<(string, string)>? extra = null)
    {
        var head = new StringBuilder();
        head.Append("HTTP/1.1 ").Append(status).Append(' ').Append(reason).Append("\r\n");
        head.Append("Content-Type: ").Append(contentType).Append("\r\n");
        head.Append("Content-Length: ").Append(length).Append("\r\n");
        head.Append("Connection: close\r\n");
        if (extra is not null)
        {
            foreach (var (key, value) in extra) head.Append(key).Append(": ").Append(value).Append("\r\n");
        }
        head.Append("\r\n");
        var bytes = Encoding.ASCII.GetBytes(head.ToString());
        await stream.WriteAsync(bytes);
    }

    private static async Task SendFileRangeAsync(NetworkStream stream, string file, long start, long length)
    {
        await using var source = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        source.Seek(start, SeekOrigin.Begin);
        var buffer = new byte[128 * 1024];
        var remaining = length;
        while (remaining > 0)
        {
            var want = (int)Math.Min(buffer.Length, remaining);
            var read = await source.ReadAsync(buffer.AsMemory(0, want));
            if (read <= 0) break;
            await stream.WriteAsync(buffer.AsMemory(0, read));
            remaining -= read;
        }
    }

    private static async Task SendEmptyAsync(NetworkStream stream, int status, string reason)
    {
        await SendHeadAsync(stream, status, reason, "text/plain; charset=utf-8", 0);
    }

    private static async Task SendTextAsync(NetworkStream stream, int status, string reason, string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        await SendHeadAsync(stream, status, reason, "text/plain; charset=utf-8", bytes.Length);
        await stream.WriteAsync(bytes);
    }

    private static async Task SendJsonAsync(NetworkStream stream, string json, int status = 200)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        // The combo list changes while the page is open — another device may be
        // the one editing it — so no response here may come back out of the
        // browser's HTTP cache.
        await SendHeadAsync(stream, status, status == 200 ? "OK" : "Error", "application/json; charset=utf-8",
            bytes.Length, [("Cache-Control", "no-store")]);
        await stream.WriteAsync(bytes);
    }
}
