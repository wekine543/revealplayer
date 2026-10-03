using System.Windows;

namespace RevealPlayer.Launcher;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // `--selftest` exercises the whole start/stop path without a window, so
        // the published build can be checked from a script rather than only by
        // looking at it.
        if (e.Args.Any(a => string.Equals(a, "--selftest", StringComparison.OrdinalIgnoreCase)))
        {
            var exitCode = 0;
            // A plain thread on purpose: this one has no dispatcher, so the
            // awaits inside the self test do not try to come back to a UI thread
            // that is blocked waiting for them.
            var worker = new Thread(() => exitCode = SelfTest.Run(AppContext.BaseDirectory))
            {
                IsBackground = true,
            };
            worker.Start();
            worker.Join();
            Shutdown(exitCode);
            return;
        }

        var window = new MainWindow();
        // `--autostart` opens the window and immediately starts the backend —
        // handy for a shortcut, and it is how the end-to-end test drives the
        // real window instead of a stand-in.
        window.StartOnLoad = e.Args.Any(a => string.Equals(a, "--autostart", StringComparison.OrdinalIgnoreCase));
        window.Show();
    }
}
