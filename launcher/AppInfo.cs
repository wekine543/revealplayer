using System.Reflection;

namespace RevealPlayer.Launcher;

/// <summary>
/// Identity of the launcher, in one place: the version is shown in the title bar
/// and in the self test, so it is read from the assembly rather than typed out
/// twice (and it comes from the single spot it is set, the .csproj).
/// </summary>
internal static class AppInfo
{
    public const string Product = "RevealPlayer 后端服务";

    public static string Version { get; } =
        Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "1.0.0.0";

    /// <summary>Window title — the version belongs in it, so it is visible without clicking anything.</summary>
    public static string Title => $"{Product}启动器 {Version}";
}
