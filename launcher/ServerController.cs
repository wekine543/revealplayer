using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace RevealPlayer.Launcher;

public enum ServerState
{
    /// <summary>Nothing is listening, and nothing of ours is running.</summary>
    Stopped,
    /// <summary>Ours is starting, but the port does not answer yet.</summary>
    Starting,
    /// <summary>Ours is serving.</summary>
    Running,
    /// <summary>Something else is serving on the port — another copy, or a run left over.</summary>
    External,
    /// <summary>Start-up failed; <see cref="ServerController.Message"/> says why.</summary>
    Failed,
}

public sealed record StartOptions(int Port, bool Lan, string? AppDirectory, string? StoreDirectory);

/// <summary>
/// Runs the player: serves the built page and the combo store it talks to.
///
/// There is only one way to serve, and it needs nothing but this executable —
/// the page is a single `index.html` sitting beside it. That is what makes the
/// published folder self-contained: no node, no sources, no install.
/// </summary>
public sealed class ServerController : IDisposable
{
    private readonly Queue<string> _recent = new();
    private const int RecentLimit = 300;

    private LocalServer? _local;
    private int? _externalPid;

    public ServerState State { get; private set; } = ServerState.Stopped;
    public string Message { get; private set; } = string.Empty;
    public int? ProcessId { get; private set; }
    public DateTime? StartedAt { get; private set; }
    public bool IsBusy { get; private set; }

    /// <summary>The folder being served, once something is running.</summary>
    public string? AppDirectory { get; private set; }
    public string? StoreDirectory => _local?.StoreDirectory;

    public bool IsOurs => _local is not null;

    /// <summary>Recent output, kept only so the self test can report it.</summary>
    public IReadOnlyList<string> Recent => _recent.ToArray();

    public event Action<string>? Line;
    public event Action? Changed;
    /// <summary>The page picked a different folder to keep combos in.</summary>
    public event Action<string>? StoreDirectoryChanged;

    private void Emit(string line)
    {
        _recent.Enqueue(line);
        while (_recent.Count > RecentLimit) _recent.Dequeue();
        Line?.Invoke(line);
    }

    private void SetState(ServerState state, string message = "")
    {
        if (State == state && Message == message) return;
        State = state;
        Message = message;
        Changed?.Invoke();
    }

    // ---------------------------------------------------------------- discovery

    public static bool LooksLikeApp(string? dir) =>
        !string.IsNullOrWhiteSpace(dir) && File.Exists(Path.Combine(dir, "index.html"));

    /// <summary>The folder holding the player: configured, else this exe's own folder.</summary>
    public static string? DetectAppDirectory(string? configured)
    {
        if (LooksLikeApp(configured)) return configured;
        return LooksLikeApp(AppContext.BaseDirectory) ? AppContext.BaseDirectory : null;
    }

    /// <summary>Where combos go by default: a folder beside the executable.</summary>
    public static string DefaultStoreDirectory(string appDirectory) =>
        Path.Combine(appDirectory, LauncherSettings.StoreFolderName);

    /// <summary>
    /// Beside the executable when that is writable, otherwise under the user's
    /// AppData — the tool may well be unpacked into Program Files.
    /// </summary>
    public static string ResolveStoreDirectory(string? configured, string appDirectory)
    {
        if (!string.IsNullOrWhiteSpace(configured)) return configured;
        var beside = DefaultStoreDirectory(appDirectory);
        if (CanWrite(beside)) return beside;
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "RevealPlayer", LauncherSettings.StoreFolderName);
    }

    public static bool CanWrite(string directory)
    {
        try
        {
            Directory.CreateDirectory(directory);
            var probe = Path.Combine(directory, ".rp-write-test");
            File.WriteAllText(probe, "x");
            File.Delete(probe);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>First non-loopback IPv4 address, for the phone address to show.</summary>
    public static string? LanAddress()
    {
        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel) continue;
                foreach (var address in ni.GetIPProperties().UnicastAddresses)
                {
                    if (address.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    if (IPAddress.IsLoopback(address.Address)) continue;
                    var ip = address.Address.ToString();
                    // 169.254/16 means "no DHCP answer" — not a usable address.
                    if (ip.StartsWith("169.254.", StringComparison.Ordinal)) continue;
                    return ip;
                }
            }
        }
        catch
        {
            // No usable adapter; the caller will show the loopback address only.
        }
        return null;
    }

    // ------------------------------------------------------------------ probing

    private static readonly HttpClient Http = new(new SocketsHttpHandler
    {
        ConnectTimeout = TimeSpan.FromMilliseconds(1200),
        PooledConnectionLifetime = TimeSpan.FromMinutes(2),
    })
    { Timeout = TimeSpan.FromMilliseconds(2000) };

    /// <summary>True when anything at all answers on the port.</summary>
    public static async Task<bool> IsRespondingAsync(int port, int timeoutMs = 1200)
    {
        try
        {
            using var cts = new CancellationTokenSource(timeoutMs);
            using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{port}/");
            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>PID listening on the port, or null if none / not discoverable.</summary>
    public static int? PortOwnerPid(int port)
    {
        try
        {
            var start = new ProcessStartInfo("netstat", "-ano")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
            };
            using var netstat = Process.Start(start);
            if (netstat is null) return null;
            var output = netstat.StandardOutput.ReadToEnd();
            netstat.WaitForExit(4000);

            foreach (var raw in output.Split('\n'))
            {
                var line = raw.Trim();
                if (!line.StartsWith("TCP", StringComparison.OrdinalIgnoreCase)) continue;
                var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 5) continue;
                if (!parts[1].EndsWith($":{port}", StringComparison.Ordinal)) continue;
                if (!parts[3].Equals("LISTENING", StringComparison.OrdinalIgnoreCase)) continue;
                return int.TryParse(parts[4], out var pid) ? pid : null;
            }
        }
        catch
        {
            // netstat missing or blocked: stopping an outside server is then
            // simply not offered.
        }
        return null;
    }

    // ------------------------------------------------------------------ control

    public async Task<bool> StartAsync(StartOptions options)
    {
        if (IsBusy) return false;
        IsBusy = true;
        try
        {
            if (await IsRespondingAsync(options.Port))
            {
                await RefreshAsync(options.Port);
                SetState(ServerState.External, $"端口 {options.Port} 上已经有服务在运行了，不会重复启动");
                return true;
            }

            var appDirectory = DetectAppDirectory(options.AppDirectory)
                ?? throw new InvalidOperationException(
                    "没找到播放器文件：请把 index.html 和本程序放在同一个文件夹里 " +
                    $"（现在的位置是 {AppContext.BaseDirectory}）");

            var storeDirectory = ResolveStoreDirectory(options.StoreDirectory, appDirectory);

            SetState(ServerState.Starting, "正在启动…");
            Emit($"播放器文件夹: {appDirectory}");
            Emit($"收藏保存位置: {storeDirectory}");
            Emit($"服务地址    : {(options.Lan ? "本机 + 局域网（手机可访问）" : "仅本机")} · http://127.0.0.1:{options.Port}/");

            var server = new LocalServer(options.Port, options.Lan, appDirectory, storeDirectory);
            server.StoreDirectoryChanged += dir =>
            {
                Emit($"收藏保存位置已改为 {dir}");
                StoreDirectoryChanged?.Invoke(dir);
            };
            server.Start();

            // The listener is open already, but confirm it actually answers: a
            // port taken by another process would otherwise look like success.
            for (var i = 0; i < 20; i++)
            {
                if (await IsRespondingAsync(options.Port, 800)) break;
                await Task.Delay(150);
            }
            if (!await IsRespondingAsync(options.Port, 1200))
            {
                server.Stop();
                server.Dispose();
                throw new InvalidOperationException($"端口 {options.Port} 起不来 —— 可能被别的程序占用了，换一个端口再试");
            }

            _local = server;
            AppDirectory = appDirectory;
            ProcessId = Environment.ProcessId;
            StartedAt = DateTime.Now;
            SetState(ServerState.Running, "服务已启动，可以在浏览器里打开播放器了");
            Emit("已就绪");
            return true;
        }
        catch (Exception e)
        {
            Emit($"启动失败：{e.Message}");
            SetState(ServerState.Failed, e.Message);
            return false;
        }
        finally
        {
            IsBusy = false;
            Changed?.Invoke();
        }
    }

    /// <summary>
    /// Stop whatever is serving: our own listener if it is ours, otherwise
    /// whichever process owns the port (a second copy of this launcher, say).
    /// </summary>
    public async Task<bool> StopAsync(int port)
    {
        if (IsBusy) return false;
        IsBusy = true;
        try
        {
            var stoppedOurs = false;

            if (_local is not null)
            {
                Emit("正在停止服务…");
                _local.Stop();
                _local.Dispose();
                _local = null;
                stoppedOurs = true;
            }

            if (!stoppedOurs)
            {
                // Never this process: a running service *is* this process, and
                // killing the port owner would kill the launcher with it.
                var pid = _externalPid ?? PortOwnerPid(port);
                if (pid is int owner && owner != Environment.ProcessId)
                {
                    Emit($"停止端口 {port} 上的进程（PID {owner}）…");
                    TryKill(owner);
                }
                else if (pid is null)
                {
                    Emit($"端口 {port} 上没有可停止的服务");
                }
            }

            _externalPid = null;
            ProcessId = null;
            StartedAt = null;
            AppDirectory = null;

            // Give the OS a moment to release the socket before reporting.
            for (var i = 0; i < 20 && await IsRespondingAsync(port, 600); i++)
            {
                await Task.Delay(200);
            }
            SetState(ServerState.Stopped, "服务已停止");
            Emit("已停止");
            return true;
        }
        catch (Exception e)
        {
            Emit($"停止失败：{e.Message}");
            SetState(ServerState.Failed, e.Message);
            return false;
        }
        finally
        {
            IsBusy = false;
            Changed?.Invoke();
        }
    }

    private static void TryKill(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            process.Kill(entireProcessTree: true);
        }
        catch (Exception e)
        {
            Debug.WriteLine($"kill {pid} failed: {e.Message}");
        }
    }

    /// <summary>
    /// Poll the truth about the port and reconcile it with what we own, so the
    /// window stays right even when the service was started or stopped elsewhere.
    /// </summary>
    public async Task RefreshAsync(int port)
    {
        if (IsBusy) return;

        var responding = await IsRespondingAsync(port, 900);

        if (responding && IsOurs)
        {
            SetState(ServerState.Running, "服务已启动，可以在浏览器里打开播放器了");
            return;
        }
        if (responding)
        {
            _externalPid ??= PortOwnerPid(port);
            SetState(ServerState.External, "这个端口上已经有服务在运行（可能是另一个本程序），可以在这里把它停掉");
            return;
        }
        _externalPid = null;
        ProcessId = null;
        if (State != ServerState.Failed) SetState(ServerState.Stopped, string.Empty);
    }

    /// <summary>
    /// Let go of the service without stopping it. Used when the window closes
    /// while "keep running" is on — the service keeps serving the browser tab
    /// the user left open.
    /// </summary>
    public void Detach()
    {
        _local = null;
    }

    public void Dispose()
    {
        _local?.Dispose();
        _local = null;
    }
}
