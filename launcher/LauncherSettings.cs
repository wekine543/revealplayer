using System.IO;
using System.Text.Json;

namespace RevealPlayer.Launcher;

/// <summary>
/// What the launcher remembers between runs. Deliberately a plain file next to
/// the executable rather than a registry key or %APPDATA%: the whole point of
/// this tool is a folder the user can look at, move and understand.
/// </summary>
public sealed class LauncherSettings
{
    public const int DefaultPort = 5174;
    public const string FileName = "launcher.settings.json";
    public const string StoreFolderName = "revealplayer-store";

    /// <summary>
    /// Folder holding the player (`index.html`). Empty means "the folder this
    /// program sits in", which is how the published copy is laid out.
    /// </summary>
    public string? AppDirectory { get; set; }

    /// <summary>
    /// Where the saved combos live — the same `revealplayer.config.json` +
    /// `media/` layout the player uses everywhere. Empty means a
    /// `revealplayer-store` folder beside the executable.
    /// </summary>
    public string? StoreDirectory { get; set; }

    public int Port { get; set; } = DefaultPort;

    /// <summary>Also serve to the local network, so a phone on the same Wi-Fi can open the player.</summary>
    public bool AllowLan { get; set; }

    public static string FilePath => Path.Combine(AppContext.BaseDirectory, FileName);

    public static LauncherSettings Load()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                var parsed = JsonSerializer.Deserialize<LauncherSettings>(File.ReadAllText(FilePath));
                if (parsed is not null)
                {
                    if (parsed.Port is < 1 or > 65535) parsed.Port = DefaultPort;
                    return parsed;
                }
            }
        }
        catch (Exception e)
        {
            // A half-written or hand-edited file must not stop the app from
            // opening — the defaults are perfectly usable.
            System.Diagnostics.Debug.WriteLine($"[launcher] settings unreadable: {e.Message}");
        }
        return new LauncherSettings();
    }

    public void Save()
    {
        try
        {
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions
            {
                WriteIndented = true,
            }));
        }
        catch (Exception e)
        {
            System.Diagnostics.Debug.WriteLine($"[launcher] could not save settings: {e.Message}");
        }
    }
}
