using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Win32;

namespace RevealPlayer.Launcher;

public partial class MainWindow : Window
{
    private readonly ServerController _server = new();
    private readonly LauncherSettings _settings = LauncherSettings.Load();
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(1.5) };

    /// <summary>Set from `--autostart`: start the service as soon as the window is up.</summary>
    public bool StartOnLoad { get; set; }

    /// <summary>Set once the service is down, so the closing handshake runs once.</summary>
    private bool _closingAllowed;

    public MainWindow()
    {
        InitializeComponent();

        Title = AppInfo.Title;
        VersionChip.Text = "v" + AppInfo.Version;

        AppDirBox.Text = ServerController.DetectAppDirectory(_settings.AppDirectory)
            ?? AppContext.BaseDirectory;
        StoreDirBox.Text = _settings.StoreDirectory ?? string.Empty;
        PortBox.Text = _settings.Port.ToString();
        LanCheck.IsChecked = _settings.AllowLan;

        _server.Line += Log;
        _server.Changed += () => Dispatcher.BeginInvoke(new Action(Refresh));
        _server.StoreDirectoryChanged += dir => Dispatcher.BeginInvoke(new Action(() =>
        {
            // The player has a control for this too; keep the box and the
            // settings file in step when it is used from the browser.
            StoreDirBox.Text = dir;
            Persist();
            Refresh();
        }));

        Loaded += OnLoaded;
        Closing += OnClosing;
    }

    private int Port =>
        int.TryParse(PortBox.Text.Trim(), out var parsed) && parsed is > 0 and < 65536
            ? parsed
            : LauncherSettings.DefaultPort;

    private bool Lan => LanCheck.IsChecked == true;

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        Log($"RevealPlayer 后端服务启动器 {AppInfo.Version}");
        Log($"播放器文件夹: {ServerController.DetectAppDirectory(AppDirBox.Text.Trim()) ?? "(这里没有 index.html)"}");
        Log($"收藏保存位置: {ServerController.ResolveStoreDirectory(StoreDirBox.Text.Trim(), AppDirBox.Text.Trim())}");
        var lan = ServerController.LanAddress();
        Log($"局域网地址  : {lan ?? "(没检测到，手机可能连不上)"}");

        _timer.Tick += async (_, _) =>
        {
            try
            {
                await _server.RefreshAsync(Port);
            }
            catch (Exception ex)
            {
                Log($"状态更新失败：{ex.Message}");
            }
            Refresh();
        };
        _timer.Start();

        // Anything already serving the port shows up as running straight away.
        await _server.RefreshAsync(Port);
        Refresh();

        if (StartOnLoad && _server.State is ServerState.Stopped or ServerState.Failed)
        {
            await StartServerAsync();
        }
    }

    // ------------------------------------------------------------ presentation

    private void Refresh()
    {
        var port = Port;
        var lanAddress = ServerController.LanAddress();

        var (title, brushKey, fallbackDetail) = Describe(_server.State);
        StatusText.Text = title;
        StatusDot.Fill = (Brush)FindResource(brushKey);
        StatusDetail.Text = string.IsNullOrEmpty(_server.Message) ? fallbackDetail : _server.Message;

        LocalUrlText.Text = $"http://127.0.0.1:{port}/";
        LanUrlText.Text = lanAddress is null ? "(没检测到局域网地址)" : $"http://{lanAddress}:{port}/";
        LanRow.Visibility = Lan ? Visibility.Visible : Visibility.Collapsed;

        MetaText.Text = _server.StartedAt is not null
            ? $"已运行 {Uptime()}"
            : _server.State == ServerState.External
                ? "由另一个程序启动"
                : "—";

        StartButton.IsEnabled = !_server.IsBusy && _server.State is ServerState.Stopped or ServerState.Failed;
        StopButton.IsEnabled = !_server.IsBusy && _server.State
            is ServerState.Running or ServerState.Starting or ServerState.External;
        OpenPlayerButton.IsEnabled = !_server.IsBusy;
        OpenStoreButton.IsEnabled = !_server.IsBusy;
        BrowseAppButton.IsEnabled = !_server.IsBusy;
        BrowseStoreButton.IsEnabled = !_server.IsBusy;
        PortBox.IsEnabled = !_server.IsBusy;
    }

    private static (string Title, string BrushKey, string Detail) Describe(ServerState state) => state switch
    {
        ServerState.Running => ("运行中", "Ok", "在浏览器里打开下面的地址就能用。"),
        ServerState.Starting => ("启动中", "Warn", "请稍等…"),
        ServerState.External => ("运行中", "Ok", "这个端口上已经有服务在运行（可能是另一个本程序）。"),
        ServerState.Failed => ("启动失败", "Danger", "没启动成功，下面日志里有原因。"),
        _ => ("已停止", "TextGhost", "服务没有运行。点「启动服务」，就能在浏览器里打开播放器。"),
    };

    private string Uptime()
    {
        if (_server.StartedAt is not DateTime started) return "—";
        var elapsed = DateTime.Now - started;
        return elapsed.TotalHours >= 1
            ? elapsed.ToString(@"hh\:mm\:ss")
            : elapsed.ToString(@"mm\:ss");
    }

    private void Log(string line)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => Log(line)));
            return;
        }
        // Keep the view bounded so a long session never bogs down.
        if (LogBox.LineCount > 3000)
        {
            LogBox.Clear();
            LogBox.AppendText("（日志太长，已清掉前面的内容）" + Environment.NewLine);
        }
        LogBox.AppendText(line + Environment.NewLine);
        LogBox.ScrollToEnd();
    }

    // ---------------------------------------------------------------- actions

    private async void Start_Click(object sender, RoutedEventArgs e) => await StartServerAsync();

    private async Task StartServerAsync()
    {
        Persist();
        StartButton.IsEnabled = false;
        await _server.StartAsync(new StartOptions(
            Port,
            Lan,
            AppDirBox.Text.Trim(),
            StoreDirBox.Text.Trim()));
        // Remember whatever actually worked — on a fresh copy the paths in the
        // boxes were only guessed a moment ago.
        Persist();
        Refresh();
    }

    private async void Stop_Click(object sender, RoutedEventArgs e)
    {
        StopButton.IsEnabled = false;
        await _server.StopAsync(Port);
        Refresh();
    }

    private void OpenPlayer_Click(object sender, RoutedEventArgs e) => ShellOpen(LocalUrlText.Text);

    private void OpenStore_Click(object sender, RoutedEventArgs e)
    {
        var dir = _server.StoreDirectory
                  ?? ServerController.ResolveStoreDirectory(StoreDirBox.Text.Trim(), AppDirBox.Text.Trim());
        try
        {
            Directory.CreateDirectory(dir);
        }
        catch (Exception ex)
        {
            Log($"建不了收藏文件夹：{ex.Message}");
            return;
        }
        ShellOpen(dir);
    }

    private void CopyLocal_Click(object sender, RoutedEventArgs e) => Copy(LocalUrlText.Text);

    private void CopyLan_Click(object sender, RoutedEventArgs e) => Copy(LanUrlText.Text);

    private void ClearLog_Click(object sender, RoutedEventArgs e) => LogBox.Clear();

    private static void ShellOpen(string target)
    {
        try
        {
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            MessageBox.Show($"打不开「{target}」：{ex.Message}", AppInfo.Product, MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private static void Copy(string text)
    {
        try
        {
            Clipboard.SetText(text);
        }
        catch
        {
            // The clipboard can be locked by another process; nothing to do.
        }
    }

    private void BrowseApp_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog
        {
            Title = "选择播放器所在的文件夹（里面要有 index.html）",
            Multiselect = false,
        };
        if (Directory.Exists(AppDirBox.Text.Trim())) dialog.InitialDirectory = AppDirBox.Text.Trim();
        if (dialog.ShowDialog(this) != true) return;

        AppDirBox.Text = dialog.FolderName;
        Persist();
        Log($"播放器文件夹改为 {dialog.FolderName}");
        Log(ServerController.LooksLikeApp(dialog.FolderName)
            ? "这里找到了 index.html，可以启动。"
            : "这个文件夹里没有 index.html，启动会失败 —— 请选择放 index.html 的那个文件夹。");
    }

    private void BrowseStore_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog
        {
            Title = "选择收藏保存位置",
            Multiselect = false,
        };
        if (Directory.Exists(StoreDirBox.Text.Trim())) dialog.InitialDirectory = StoreDirBox.Text.Trim();
        if (dialog.ShowDialog(this) != true) return;

        StoreDirBox.Text = dialog.FolderName;
        Persist();
        Log($"收藏保存位置改为 {dialog.FolderName}");
    }

    private void Setting_Changed(object sender, RoutedEventArgs e)
    {
        Persist();
        Refresh();
    }

    private void Minimize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    // -------------------------------------------------------------- life cycle

    private void Persist()
    {
        var typedApp = AppDirBox.Text.Trim();
        _settings.AppDirectory = ServerController.LooksLikeApp(typedApp)
            ? typedApp
            : (typedApp.Length > 0 && typedApp != AppContext.BaseDirectory ? typedApp : null);

        var typedStore = StoreDirBox.Text.Trim();
        _settings.StoreDirectory = typedStore.Length > 0 ? typedStore : null;

        _settings.Port = Port;
        _settings.AllowLan = Lan;
        _settings.Save();
    }

    private async void OnClosing(object? sender, CancelEventArgs e)
    {
        Persist();

        var running = _server.State is ServerState.Running or ServerState.Starting;
        if (!_closingAllowed && running)
        {
            // The service lives in this process, so closing must stop it — but do
            // it before the window disappears, or the port would look busy for a
            // moment and the user would be left guessing.
            e.Cancel = true;
            _closingAllowed = true;
            Log("关闭前先停止服务…");
            await _server.StopAsync(Port);
            Close();
            return;
        }

        _timer.Stop();
        _server.Dispose();
    }
}
