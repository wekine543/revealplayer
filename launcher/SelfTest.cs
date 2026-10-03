using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;

namespace RevealPlayer.Launcher;

/// <summary>
/// Headless run of everything the buttons drive: find the player, start the
/// service, fetch the page and the store API over HTTP, stop it, and confirm the
/// port is released. Writes `selftest.log` beside the executable, because a
/// windowed app has no console to print to.
///
/// Uses throwaway folders under %TEMP%, so it never touches real saved combos.
///
/// Run it with: RevealPlayer.Launcher.exe --selftest
/// </summary>
internal static class SelfTest
{
    public static int Run(string baseDir)
    {
        var report = new StringBuilder();
        var ok = true;
        var controller = new ServerController();
        controller.Line += line => report.Append("    | ").AppendLine(line);

        void Check(string label, bool condition, string detail)
        {
            if (!condition) ok = false;
            report.Append(condition ? "  [ok]   " : "  [FAIL] ").Append(label).Append(": ").AppendLine(detail);
        }

        var settings = LauncherSettings.Load();
        var port = settings.Port;
        var temp = Path.Combine(Path.GetTempPath(), $"revealplayer-selftest-{Environment.ProcessId}");
        var store = Path.Combine(temp, "store");
        var appDir = Path.Combine(temp, "app");

        report.Append("RevealPlayer 后端服务启动器 ").Append(AppInfo.Version).AppendLine(" — 自检");
        report.Append("时间: ").AppendLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));

        try
        {
            // Published layout: this program beside a built index.html. A
            // development build has none next to it, so one is assembled from
            // dist/ — the point is to exercise the same path either way.
            var published = ServerController.DetectAppDirectory(settings.AppDirectory);
            var appToServe = published;
            if (appToServe is null)
            {
                var dist = FindBuildOutput();
                if (dist is not null)
                {
                    Directory.CreateDirectory(appDir);
                    foreach (var file in Directory.GetFiles(dist))
                    {
                        File.Copy(file, Path.Combine(appDir, Path.GetFileName(file)), overwrite: true);
                    }
                    appToServe = appDir;
                }
            }

            report.Append("播放器文件夹: ").AppendLine(appToServe ?? "(没有 index.html)");
            report.Append("收藏保存位置: ").AppendLine(store);
            report.AppendLine("              (自检用临时文件夹，不动真实收藏)");
            report.Append("端口        : ").AppendLine(port.ToString());
            report.Append("局域网地址  : ").AppendLine(ServerController.LanAddress() ?? "(未检测到)");

            Check("启动前端口是空的", !ServerController.IsRespondingAsync(port).GetAwaiter().GetResult(),
                $"127.0.0.1:{port}");

            report.AppendLine("--- 启动 ---");
            var started = controller.StartAsync(new StartOptions(port, false, appToServe, store))
                .GetAwaiter().GetResult();
            Check("启动成功", started, $"{controller.State} / {controller.Message}");
            Check("状态为运行中", controller.State == ServerState.Running, controller.State.ToString());
            Check("端口已响应", ServerController.IsRespondingAsync(port).GetAwaiter().GetResult(), $"127.0.0.1:{port}");

            if (started)
            {
                var http = new HttpClient
                {
                    BaseAddress = new Uri($"http://127.0.0.1:{port}/"),
                    Timeout = TimeSpan.FromSeconds(30),
                };

                // The page itself.
                var home = http.GetAsync(string.Empty).GetAwaiter().GetResult();
                var html = home.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                Check("首页返回 200", home.IsSuccessStatusCode, $"{(int)home.StatusCode}");
                Check("首页是播放器页面", html.Contains("RevealPlayer", StringComparison.Ordinal),
                    $"{html.Length} 字符，{home.Content.Headers.ContentType}");
                if (appToServe is not null)
                {
                    var onDisk = File.ReadAllBytes(Path.Combine(appToServe, "index.html"));
                    Check("首页与磁盘文件一致", onDisk.Length == Encoding.UTF8.GetByteCount(html),
                        $"磁盘 {onDisk.Length} / 网络 {Encoding.UTF8.GetByteCount(html)} 字节");
                }

                // Store API — the same shape the player talks to.
                var config = http.GetStringAsync("__rp/store/config").GetAwaiter().GetResult();
                var configNode = JsonNode.Parse(config) as JsonObject;
                Check("读取收藏列表可用", configNode?["ok"]?.GetValue<bool>() == true,
                    config.Length > 120 ? config[..120] + "…" : config);
                Check("收藏列表带回保存位置", configNode?["dir"]?.GetValue<string>() == store,
                    configNode?["dir"]?.GetValue<string>() ?? "(无)");

                var combos = configNode?["combos"]?.DeepClone() as JsonArray ?? new JsonArray();
                combos.Add(new JsonObject
                {
                    ["id"] = "selftest",
                    ["name"] = "自检条目",
                    ["createdAt"] = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
                    ["mediaA"] = null,
                    ["mediaB"] = null,
                    ["maskSettings"] = new JsonObject(),
                });
                var put = http.PutAsync("__rp/store/config", new StringContent(
                        new JsonObject { ["combos"] = combos }.ToJsonString(), Encoding.UTF8, "application/json"))
                    .GetAwaiter().GetResult();
                Check("保存收藏可用", put.IsSuccessStatusCode, $"{(int)put.StatusCode}");

                var after = JsonNode.Parse(http.GetStringAsync("__rp/store/config").GetAwaiter().GetResult()) as JsonObject;
                var saved = after?["combos"] as JsonArray;
                Check("保存的组合被读回来",
                    saved is not null && saved.Any(c => c?["id"]?.GetValue<string>() == "selftest"),
                    $"{saved?.Count ?? 0} 条");
                Check("收藏文件真的落盘", File.Exists(Path.Combine(store, "revealplayer.config.json")),
                    Path.Combine(store, "revealplayer.config.json"));

                // Media: range requests are what make seeking work in a browser.
                var media = Path.Combine(store, "media");
                Directory.CreateDirectory(media);
                var payload = new byte[200];
                for (var i = 0; i < payload.Length; i++) payload[i] = (byte)i;
                File.WriteAllBytes(Path.Combine(media, "probe.mp4"), payload);

                var rangeRequest = new HttpRequestMessage(HttpMethod.Get, "__rp/store/media/probe.mp4");
                rangeRequest.Headers.Range = new RangeHeaderValue(10, 19);
                var range = http.SendAsync(rangeRequest).GetAwaiter().GetResult();
                var slice = range.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
                Check("视频分段请求返回 206", (int)range.StatusCode == 206, $"{(int)range.StatusCode}");
                Check("分段内容正确", slice.Length == 10 && slice[0] == 10 && slice[9] == 19,
                    $"{slice.Length} 字节，首字节 {slice[0]}");
                Check("分段信息头正确",
                    range.Content.Headers.ContentRange?.ToString() == "bytes 10-19/200",
                    range.Content.Headers.ContentRange?.ToString() ?? "(无)");

                var head = http.SendAsync(new HttpRequestMessage(HttpMethod.Head, "__rp/store/media/probe.mp4"))
                    .GetAwaiter().GetResult();
                Check("视频探测请求可用", head.IsSuccessStatusCode,
                    $"{(int)head.StatusCode} {head.Content.Headers.ContentType}");

                // Names with non-ASCII characters: these are the clips users
                // actually have (phone recordings), and a server that only
                // handles ASCII silently breaks most of their library.
                var unicodeName = "VID_20260902_211035_鸢青 空格.mp4";
                File.WriteAllBytes(Path.Combine(media, unicodeName), payload);
                var encoded = Uri.EscapeDataString(unicodeName);
                var unicode = http.SendAsync(new HttpRequestMessage(HttpMethod.Get,
                        $"__rp/store/media/{encoded}") { Headers = { Range = new RangeHeaderValue(0, 9) } })
                    .GetAwaiter().GetResult();
                var unicodeBytes = unicode.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
                Check("中文名/带空格的媒体能请求到", (int)unicode.StatusCode == 206,
                    $"{(int)unicode.StatusCode} {unicode.Content.Headers.ContentType} · /{encoded}");
                Check("中文名的分段内容正确",
                    unicodeBytes.Length == 10 && unicodeBytes[0] == 0 && unicodeBytes[9] == 9,
                    $"{unicodeBytes.Length} 字节，首字节 {unicodeBytes[0]}，末字节 {(unicodeBytes.Length > 9 ? unicodeBytes[9] : -1)}");

                // Upload: what saving a combo from a phone does.
                var upload = http.PostAsync("__rp/store/media?name=selftest-upload.bin&size=5",
                        new ByteArrayContent([1, 2, 3, 4, 5]))
                    .GetAwaiter().GetResult();
                var uploadText = upload.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                var uploadNode = JsonNode.Parse(uploadText) as JsonObject;
                Check("上传视频成功", upload.IsSuccessStatusCode && uploadNode?["ok"]?.GetValue<bool>() == true,
                    uploadText);
                var savedName = uploadNode?["name"]?.GetValue<string>();
                Check("上传的文件落盘", savedName is not null && File.Exists(Path.Combine(media, savedName)),
                    savedName ?? "(无)");
                if (savedName is not null)
                {
                    var fetched = http.GetByteArrayAsync($"__rp/store/media/{Uri.EscapeDataString(savedName)}")
                        .GetAwaiter().GetResult();
                    Check("上传后能原样取回", fetched.Length == 5 && fetched[4] == 5, $"{fetched.Length} 字节");
                }
            }

            // Let it settle and re-check: the state must survive a poll cycle.
            Thread.Sleep(1500);
            controller.RefreshAsync(port).GetAwaiter().GetResult();
            Check("1.5 秒后仍然运行中", controller.State == ServerState.Running,
                $"{controller.State} / {controller.Message}");

            report.AppendLine("--- 停止 ---");
            var stopped = controller.StopAsync(port).GetAwaiter().GetResult();
            Check("停止成功", stopped, controller.Message);
            Check("状态为已停止", controller.State == ServerState.Stopped, controller.State.ToString());
            Check("端口已释放", !ServerController.IsRespondingAsync(port).GetAwaiter().GetResult(), $"127.0.0.1:{port}");
            Check("没有残留进程", ServerController.PortOwnerPid(port) is null,
                ServerController.PortOwnerPid(port)?.ToString() ?? "(无)");
        }
        catch (Exception e)
        {
            ok = false;
            report.Append("自检异常: ").AppendLine(e.ToString());
        }
        finally
        {
            // Never leave a service behind, whatever went wrong above.
            if (controller.State is not (ServerState.Stopped or ServerState.Failed))
            {
                report.AppendLine("清理：停止残留服务");
                try { controller.StopAsync(port).GetAwaiter().GetResult(); } catch { /* best effort */ }
            }
            controller.Dispose();
            try { Directory.Delete(temp, recursive: true); } catch { /* temp files */ }
        }

        return Finish(baseDir, report, ok);
    }

    /// <summary>`dist/index.html` somewhere above the executable, if this is a development build.</summary>
    private static string? FindBuildOutput()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "dist");
            if (File.Exists(Path.Combine(candidate, "index.html"))) return candidate;
        }
        return null;
    }

    private static int Finish(string baseDir, StringBuilder report, bool ok)
    {
        report.AppendLine(ok ? "结果: 全部通过" : "结果: 有失败项");
        try
        {
            File.WriteAllText(Path.Combine(baseDir, "selftest.log"), report.ToString(), Encoding.UTF8);
        }
        catch
        {
            // Nothing else to do — the exit code still carries the outcome.
        }
        return ok ? 0 : 1;
    }
}
