// ============================================================
//  BlockAnim.cs · WebView2 宿主
// ------------------------------------------------------------
//  职责：
//    1. 把编译进 exe 的 Web 应用释放到临时目录
//    2. 起一个只在回环地址监听的极简静态服务
//    3. 用 WebView2 加载它
//
//  为什么必须走 http:// 而不是 file://：
//    ES Module 在 file:// 下会被浏览器的 CORS 规则直接挡住，
//    一个模块都加载不了。file:// 必须自己实现一套模块加载器，
//    得不偿失。
//
//  为什么不用 HttpListener：
//    它在部分受限环境（企业策略 / 沙箱 / 容器）下拿不到
//    HTTP.SYS 的命名空间，会直接抛「句柄无效」。
//    我们只需要喂同机一个 WebView 静态文件，裸 TcpListener
//    更简单、依赖更少、启动即成。
// ============================================================

using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace BlockAnimDesktop;

public partial class BlockAnim : Window
{
    private const string Host = "127.0.0.1";

    /// <summary>
    /// 启动诊断日志。启动失败时把路径告诉用户，免得白屏一脸懵。
    /// </summary>
    public static readonly string DiagLog =
        Path.Combine(BaseDir(), "startup.log");

    public static void Log(string msg)
    {
        try
        {
            File.AppendAllText(DiagLog,
                $"[{DateTime.Now:HH:mm:ss.fff}] {msg}{Environment.NewLine}");
        }
        catch { }
    }

    private TcpListener? _tcp;

    /// <summary>释放出来的 Web 根目录</summary>
    private string? _webRoot;

    /// <summary>本地服务端口</summary>
    private int _port;

    public BlockAnim()
    {
        InitializeComponent();
        LoadWindowState();
        Loaded += OnLoaded;
        Closing += OnClosing;
    }

    // ============================================================
    //  启动
    // ============================================================
    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            Log("开始启动");

            // 1) 释放 Web 资源
            _webRoot = ExtractWebRoot();
            var count = Directory.GetFiles(_webRoot, "*", SearchOption.AllDirectories).Length;
            Log($"Web 根目录 {_webRoot}，共 {count} 个文件");

            // 2) 起本地静态服务
            _port = StartServer(_webRoot);
            Log($"本地服务已启动 http://{Host}:{_port}/");

            // 3) 装 WebView2
            var env = await CoreWebView2Environment.CreateAsync(null, UserDataDir());
            Log("WebView2 环境创建成功");

            await WebView.EnsureCoreWebView2Async(env);
            Log("WebView2 初始化成功");

            ConfigureWebView(WebView.CoreWebView2, $"http://{Host}:{_port}/");
            Log("已发起导航");
        }
        catch (Exception ex)
        {
            Log($"启动失败：{ex}");
            MessageBox.Show(
                $"启动失败：\n\n{ex.Message}\n\n" +
                $"诊断日志：{DiagLog}\n\n" +
                "如果提示缺少 WebView2 运行时，请安装 Microsoft Edge WebView2 Runtime：\n" +
                "https://developer.microsoft.com/microsoft-edge/webview2/",
                "积木动画工厂", MessageBoxButton.OK, MessageBoxImage.Error);
            Application.Current.Shutdown();
        }
    }

    private void ConfigureWebView(CoreWebView2 core, string url)
    {
        core.Settings.AreDefaultContextMenusEnabled = true;
        core.Settings.AreDevToolsEnabled = true;
        core.Settings.IsZoomControlEnabled = true;

        // 新窗口在当前窗口里打开，不要弹出一个没头没尾的浏览器
        core.NewWindowRequested += (s, args) =>
        {
            args.Handled = true;
            core.Navigate(args.Uri);
        };

        // 导出走浏览器 Blob 下载，交给系统默认程序即可
        core.DownloadStarting += (s, args) => args.Handled = false;

        core.NavigationCompleted += (s, args) =>
        {
            Log($"导航完成，IsSuccess={args.IsSuccess}");
            if (!args.IsSuccess)
            {
                Log($"导航失败：{args.WebErrorStatus}");
                return;
            }
            // 页面 ready 后再切换，避免白屏闪一下
            LoadingPanel.Visibility = Visibility.Collapsed;
            WebView.Visibility = Visibility.Visible;
        };

        core.Navigate(url);
    }

    // ============================================================
    //  资源释放
    // ============================================================
    /// <summary>
    /// 把嵌入资源里的 Web 应用写到临时目录。
    /// 目录名带内容指纹：重复启动复用已释放的文件，内容变了就换新目录。
    /// </summary>
    private static string ExtractWebRoot()
    {
        var asm = Assembly.GetExecutingAssembly();

        var stamp = Hash(asm);
        var root = Path.Combine(BaseDir(), $"web-{stamp}");

        var marker = Path.Combine(root, ".ready");
        if (File.Exists(marker)) return root;

        // 顺手清掉旧版本留下的目录。换版本后指纹变了，旧目录就没人用了，
        // 不清的话每次升级都在用户目录里堆一份完整的 Web 应用。
        CleanStaleWebDirs(keep: root);

        // 半成品目录先清掉，避免上次崩溃留下垃圾
        if (Directory.Exists(root))
        {
            try { Directory.Delete(root, recursive: true); } catch { }
        }
        Directory.CreateDirectory(root);

        // 资源名 → 相对路径
        //   web.index.html                → index.html
        //   web.src..renderer.js          → src/renderer.js
        //   web.src..sub..x.js            → src/sub/x.js
        //
        // .NET 的资源名里层级用「点」表示，但文件名本身也可能带点
        // （renderer.js），单点无法区分。所以约定「双点」代表一层目录
        // （见 csproj 里的 LogicalName 写法）。
        var rootFull = Path.GetFullPath(root);
        var written = 0;

        foreach (var name in asm.GetManifestResourceNames())
        {
            if (!name.StartsWith("web.", StringComparison.Ordinal)) continue;

            var rel = name.Substring(4).Replace("..", "\\");

            string dest;
            try { dest = Path.GetFullPath(Path.Combine(root, rel)); }
            catch { continue; }

            // 防目录穿越
            if (!dest.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
            {
                Log($"跳过可疑资源名：{name}");
                continue;
            }

            var dir = Path.GetDirectoryName(dest);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            using var src = asm.GetManifestResourceStream(name);
            if (src == null) { Log($"资源流为空：{name}"); continue; }
            using var dst = File.Create(dest);
            src.CopyTo(dst);
            written++;
        }

        Log($"已释放 {written} 个资源");

        if (written == 0)
            throw new InvalidOperationException(
                "没有找到任何内嵌的 Web 资源，程序包可能损坏了。");

        File.WriteAllText(marker, "ready");
        return root;
    }

    /// <summary>删掉旧版本遗留的 web-* 释放目录（保留当前这个）</summary>
    private static void CleanStaleWebDirs(string keep)
    {
        try
        {
            var baseDir = Path.GetDirectoryName(keep);
            if (string.IsNullOrEmpty(baseDir) || !Directory.Exists(baseDir)) return;

            foreach (var dir in Directory.GetDirectories(baseDir, "web-*"))
            {
                if (string.Equals(Path.GetFullPath(dir),
                                  Path.GetFullPath(keep),
                                  StringComparison.OrdinalIgnoreCase)) continue;
                try { Directory.Delete(dir, recursive: true); }
                catch { /* 删不掉就算了，不影响启动 */ }
            }
        }
        catch { }
    }

    /// <summary>用 index.html 的内容算一个稳定指纹</summary>
    private static string Hash(Assembly asm)
    {
        using var sha = System.Security.Cryptography.SHA256.Create();
        using var ms = new MemoryStream();
        using (var s = asm.GetManifestResourceStream("web.index.html"))
            if (s != null) s.CopyTo(ms);

        var hash = sha.ComputeHash(ms.ToArray());
        return Convert.ToHexString(hash).ToLowerInvariant().Substring(0, 12);
    }

    // ============================================================
    //  极简静态服务（裸 TCP）
    // ============================================================
    private static readonly Dictionary<string, string> Mime =
        new(StringComparer.OrdinalIgnoreCase)
        {
            [".html"]  = "text/html; charset=utf-8",
            [".js"]    = "text/javascript; charset=utf-8",
            [".mjs"]   = "text/javascript; charset=utf-8",
            [".css"]   = "text/css; charset=utf-8",
            [".json"]  = "application/json; charset=utf-8",
            [".png"]   = "image/png",
            [".jpg"]   = "image/jpeg",
            [".jpeg"]  = "image/jpeg",
            [".gif"]   = "image/gif",
            [".svg"]   = "image/svg+xml",
            [".ico"]   = "image/x-icon",
            [".webp"]  = "image/webp",
            [".woff2"] = "font/woff2",
            [".ttf"]   = "font/ttf",
            [".otf"]   = "font/otf",
            [".wav"]   = "audio/wav",
            [".mp3"]   = "audio/mpeg",
        };

    private int StartServer(string root)
    {
        // 端口 0：让系统分配空闲端口，避免和别的程序撞
        var tcp = new TcpListener(IPAddress.Loopback, 0);
        tcp.Start();
        var port = ((IPEndPoint)tcp.LocalEndpoint).Port;
        _tcp = tcp;

        new Thread(() => ServeLoop(tcp, root))
        {
            IsBackground = true,
            Name = "blockanim-http"
        }.Start();

        return port;
    }

    private static void ServeLoop(TcpListener tcp, string root)
    {
        var rootFull = Path.GetFullPath(root);

        while (true)
        {
            TcpClient client;
            try { client = tcp.AcceptTcpClient(); }
            catch { return; }                 // 已停止

            // 本地只有一个客户端，每个请求起一个后台线程足够
            new Thread(() => HandleClient(client, rootFull))
            {
                IsBackground = true
            }.Start();
        }
    }

    private static void HandleClient(TcpClient client, string rootFull)
    {
        using (client)
        {
            try
            {
                client.NoDelay = true;
                using var stream = client.GetStream();

                var header = ReadHeaders(stream);
                if (header == null) return;

                // GET /path HTTP/1.1
                var firstLine = header.Split('\n')[0].TrimEnd('\r');
                var parts = firstLine.Split(' ');
                if (parts.Length < 2 ||
                    !parts[0].Equals("GET", StringComparison.OrdinalIgnoreCase))
                {
                    WriteSimple(stream, 405, "只支持 GET");
                    return;
                }

                var rawPath = parts[1].Split('?')[0];
                string rel;
                try { rel = Uri.UnescapeDataString(rawPath).TrimStart('/'); }
                catch { rel = rawPath.TrimStart('/'); }

                if (rel.Length == 0) rel = "index.html";

                // 防目录穿越：解析后必须仍在 root 内
                string path;
                try { path = Path.GetFullPath(Path.Combine(rootFull, rel)); }
                catch { path = rootFull; }

                if (!path.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
                {
                    WriteSimple(stream, 403, "禁止访问");
                    return;
                }

                if (File.Exists(path))
                {
                    WriteFile(stream, path, File.ReadAllBytes(path));
                }
                else if (LooksLikeAsset(rel))
                {
                    // 静态资源找不到要老实报 404。
                    // 一律回 index.html 的话，少了一个 .js 也只会得到
                    // 「Unexpected token <」这种莫名其妙的前端报错，很难查。
                    WriteSimple(stream, 404, "Not Found: " + rel);
                }
                else
                {
                    // 其余按 SPA 处理：路由路径回根页面
                    var idx = Path.Combine(rootFull, "index.html");
                    WriteFile(stream, idx, File.ReadAllBytes(idx));
                }
            }
            catch
            {
                // 单个请求出错不该拖垮整个服务
            }
        }
    }

        /// <summary>
    /// 这个路径像不像「静态资源」？
    /// 像的话找不到就该报 404，而不是回 index.html。
    /// </summary>
    private static bool LooksLikeAsset(string rel)
    {
        var ext = Path.GetExtension(rel);
        return ext.Length > 0 && Mime.ContainsKey(ext);
    }

    /// <summary>读请求头，直到遇到空行</summary>
    private static string? ReadHeaders(NetworkStream stream)
    {
        var sb = new StringBuilder();

        while (sb.Length < 65536)
        {
            // 逐字节找 \r\n\r\n —— 请求头很小，逐字节最简单也最可靠
            var b = stream.ReadByte();
            if (b < 0) break;
            sb.Append((char)b);

            var n = sb.Length;
            if (n >= 4 &&
                sb[n - 4] == '\r' && sb[n - 3] == '\n' &&
                sb[n - 2] == '\r' && sb[n - 1] == '\n')
                return sb.ToString();
        }

        return sb.Length > 0 ? sb.ToString() : null;
    }

    private static void WriteFile(Stream stream, string path, byte[] body)
    {
        var ext = Path.GetExtension(path);
        var mime = Mime.TryGetValue(ext, out var m) ? m : "application/octet-stream";

        var head = Encoding.UTF8.GetBytes(
            "HTTP/1.1 200 OK\r\n" +
            $"Content-Type: {mime}\r\n" +
            $"Content-Length: {body.Length}\r\n" +
            "Cache-Control: no-cache\r\n" +
            "Connection: close\r\n" +
            "\r\n");

        stream.Write(head, 0, head.Length);
        stream.Write(body, 0, body.Length);
        stream.Flush();
    }

    private static void WriteSimple(Stream stream, int code, string message)
    {
        var body = Encoding.UTF8.GetBytes(message);
        var reason = code == 403 ? "Forbidden" : "Method Not Allowed";

        var head = Encoding.UTF8.GetBytes(
            $"HTTP/1.1 {code} {reason}\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            $"Content-Length: {body.Length}\r\n" +
            "Connection: close\r\n" +
            "\r\n");

        stream.Write(head, 0, head.Length);
        stream.Write(body, 0, body.Length);
        stream.Flush();
    }

    // ============================================================
    //  收尾
    // ============================================================
    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        try { _tcp?.Stop(); } catch { }
        SaveWindowState();
        Log("退出");
    }

    // ============================================================
    //  窗口状态
    // ============================================================
    private static string StateFile => Path.Combine(BaseDir(), "window.json");

    private static string UserDataDir() => Path.Combine(BaseDir(), "webview");

    /// <summary>
    /// 选一个**确定可写**的数据目录。
    ///
    /// 为什么不用 %TEMP%：在企业策略、受限令牌或某些沙箱环境下，
    /// %TEMP% 看着存在但建子目录会被拒（UnauthorizedAccessException），
    /// 表现为「程序起来了但什么都没有」。所以这里逐个试，谁能用用谁。
    /// </summary>
    private static string BaseDir()
    {
        foreach (var candidate in new[]
        {
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "BlockAnimFactory"),
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "BlockAnimFactory"),
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "BlockAnimFactory"),
        })
        {
            try
            {
                Directory.CreateDirectory(candidate);
                var probe = Path.Combine(candidate, ".probe");
                File.WriteAllText(probe, "1");
                File.Delete(probe);
                return candidate;
            }
            catch
            {
                // 试下一个
            }
        }

        // 兜底：可执行文件旁边。解压版通常可写。
        var fallback = Path.Combine(
            AppContext.BaseDirectory, "BlockAnimFactory");
        try { Directory.CreateDirectory(fallback); } catch { }
        return fallback;
    }

    private void LoadWindowState()
    {
        try
        {
            if (!File.Exists(StateFile)) return;
            var json = File.ReadAllText(StateFile);

            // 极简解析：只取四个数字，够用且不引第三方依赖
            var nums = new int[4];
            var idx = 0;
            var i = 0;
            while (i < json.Length && idx < 4)
            {
                if (char.IsDigit(json[i]) || json[i] == '-')
                {
                    var start = i;
                    if (json[i] == '-') i++;
                    while (i < json.Length && (char.IsDigit(json[i]) || json[i] == '.')) i++;
                    if (double.TryParse(json[start..i],
                            System.Globalization.NumberStyles.Float,
                            System.Globalization.CultureInfo.InvariantCulture, out var d))
                        nums[idx++] = (int)d;
                }
                i++;
            }

            // 尺寸明显不合理就当没读到（换过显示器/缩放比的情况）
            if (idx == 4 && nums[2] > 400 && nums[3] > 400)
            {
                Left = nums[0]; Top = nums[1];
                Width = nums[2]; Height = nums[3];
            }
        }
        catch { /* 读不到就用默认值 */ }
    }

    private void SaveWindowState()
    {
        try
        {
            var dir = Path.GetDirectoryName(StateFile)!;
            Directory.CreateDirectory(dir);
            File.WriteAllText(StateFile,
                $"{{\"left\":{Left},\"top\":{Top},\"width\":{Width},\"height\":{Height}}}");
        }
        catch { }
    }
}