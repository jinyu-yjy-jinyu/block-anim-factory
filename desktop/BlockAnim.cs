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
using System.Diagnostics;
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

    /// <summary>本地静态服务的并发上限。浏览器加载一个页面会并发几十上百个模块请求。</summary>
    private const int MaxConcurrentRequests = 64;

    /// <summary>
    /// 读一个请求头允许的最长等待。
    /// 客户端连上却不发数据时，没有这个上限线程会一直挂着。
    /// </summary>
    private const int HeaderReadTimeoutMs = 5000;

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
            // 重试时会再次走到这里。不先停掉上一次的监听器，
            // 每点一次「重试」就会多一个端口和一条后台线程。
            try { _tcp?.Stop(); } catch { }
            _tcp = null;

            Log("开始启动");

            // 1) 释放 Web 资源
            _webRoot = ExtractWebRoot();
            var count = Directory.GetFiles(_webRoot, "*", SearchOption.AllDirectories).Length;
            Log($"Web 根目录 {_webRoot}，共 {count} 个文件");

            // 2) 起本地静态服务
            _port = StartServer(_webRoot);
            Log($"本地服务已启动 http://{Host}:{_port}/");

            // 3) 装 WebView2
            // 重试时 WebView2 可能已经初始化过；此时必须复用，
            // 用一个新环境再调 EnsureCoreWebView2Async 会直接抛异常。
            if (WebView.CoreWebView2 != null)
            {
                Log("复用已初始化的 WebView2，重新导航");
                WebView.CoreWebView2.Navigate($"http://{Host}:{_port}/");
                return;
            }

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

        // 新窗口一律不开在应用内：外部链接交给系统浏览器，
        // 否则远端页面会继承本地页面的运行环境（与 Electron 壳同一原则）。
        core.NewWindowRequested += (s, args) =>
        {
            args.Handled = true;
            OpenExternal(args.Uri);
        };

        // 页面内的直接跳转同样限制在本地服务，防止被拖入链接带离应用。
        core.NavigationStarting += (s, args) =>
        {
            if (IsLocalUrl(args.Uri) || args.Uri == "about:blank") return;
            args.Cancel = true;
            OpenExternal(args.Uri);
        };

        // 导出走浏览器 Blob 下载，交给系统默认程序即可
        core.DownloadStarting += (s, args) => args.Handled = false;

        core.NavigationCompleted += (s, args) =>
        {
            Log($"导航完成，IsSuccess={args.IsSuccess}");
            if (!args.IsSuccess)
            {
                Log($"导航失败：{args.WebErrorStatus}");
                // 原来这里只写日志就 return，LoadingPanel 永久停在
                // 「正在启动…」——用户看到的是一个转不动的进度条加黑背景，
                // 完全不知道发生了什么。文件头 :38 的注释说「启动失败时把
                // 路径告诉用户」，这个意图只在 OnLoaded 的 try/catch 里兑现了，
                // 导航失败这条路没有。补上。
                ShowLoadError(
                    $"无法加载本地页面（错误码 {args.WebErrorStatus}）。\n\n" +
                    $"地址：http://{Host}:{_port}/\n\n" +
                    "常见原因：本地服务已被其它程序占用、杀软拦截了回环连接、" +
                    "或 WebView2 运行时缺失。");
                return;
            }
            // 页面 ready 后再切换，避免白屏闪一下
            LoadingPanel.Visibility = Visibility.Collapsed;
            WebView.Visibility = Visibility.Visible;
        };

        core.Navigate(url);
    }

    /// <summary>是不是本实例的本地页面</summary>
    private bool IsLocalUrl(string uri)
    {
        return Uri.TryCreate(uri, UriKind.Absolute, out var u)
            && u.Scheme == Uri.UriSchemeHttp
            && string.Equals(u.Host, Host, StringComparison.OrdinalIgnoreCase)
            && u.Port == _port;
    }

    /// <summary>外部链接交给系统默认浏览器；非 http(s) 一律丢弃</summary>
    private static void OpenExternal(string uri)
    {
        try
        {
            if (!Uri.TryCreate(uri, UriKind.Absolute, out var u)) return;
            if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) return;
            Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Log("打开外部链接失败：" + ex.Message);
        }
    }

    /// <summary>显示启动失败 UI，并把 LoadingPanel 留在可见状态（不要藏掉它）</summary>
    private void ShowLoadError(string message)
    {
        try
        {
            LoadingContent.Visibility = Visibility.Collapsed;
            LoadErrorLogPath.Text = DiagLog;
            LoadErrorText.Text = message;
            LoadErrorPanel.Visibility = Visibility.Visible;
            LoadingPanel.Visibility = Visibility.Visible;
        }
        catch (Exception ex)
        {
            // 连失败 UI 都画不出来时，至少别让用户对着一个假进度条发呆
            Log("显示失败 UI 时又出错：" + ex);
            MessageBox.Show(
                message,
                "积木动画工厂 · 启动失败",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnRetryClick(object sender, RoutedEventArgs e)
    {
        // 回到「正在启动…」并重新走一遍加载流程
        LoadingContent.Visibility = Visibility.Visible;
        LoadErrorPanel.Visibility = Visibility.Collapsed;
        WebView.Visibility = Visibility.Collapsed;
        Log("用户点击重试");
        // OnLoaded 是 async void，内部自带 try/catch，
        // 异常不会冒到这里，所以直接调用即可（不能写成 `_ = OnLoaded(...)`，
        // 那是对 void 赋值，编译不过）。
        OnLoaded(sender, e);
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
        var rootPrefix = rootFull.EndsWith(Path.DirectorySeparatorChar)
            ? rootFull
            : rootFull + Path.DirectorySeparatorChar;
        var written = 0;

        foreach (var name in asm.GetManifestResourceNames())
        {
            if (!name.StartsWith("web.", StringComparison.Ordinal)) continue;

            var rel = name.Substring(4).Replace("..", "\\");

            string dest;
            try { dest = Path.GetFullPath(Path.Combine(root, rel)); }
            catch { continue; }

            // 防目录穿越。必须带结尾分隔符比较：
            // 只比较 "C:\...\web-abc" 的话，"C:\...\web-abcdef\x"
            // 也会被当成根内路径放行。
            if (!dest.Equals(rootFull, StringComparison.OrdinalIgnoreCase) &&
                !dest.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
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

    /// <summary>
    /// 用全部内嵌 Web 资源的内容算指纹。
    ///
    /// 不能只哈希 index.html：新版本常常只改 src/*.js，外壳页面没变，
    /// 指纹就完全相同 → .ready 命中旧目录 → 用户升级后仍在跑旧代码。
    /// </summary>
    private static string Hash(Assembly asm)
    {
        using var sha = System.Security.Cryptography.SHA256.Create();

        var names = asm.GetManifestResourceNames()
            .Where(n => n.StartsWith("web.", StringComparison.Ordinal))
            .OrderBy(n => n, StringComparer.Ordinal);

        foreach (var name in names)
        {
            var nameBytes = Encoding.UTF8.GetBytes(name);
            sha.TransformBlock(nameBytes, 0, nameBytes.Length, null, 0);

            using var s = asm.GetManifestResourceStream(name);
            if (s == null) continue;
            var buf = new byte[81920];
            int n;
            while ((n = s.Read(buf, 0, buf.Length)) > 0)
                sha.TransformBlock(buf, 0, n, null, 0);
        }

        sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
        return Convert.ToHexString(sha.Hash!).ToLowerInvariant().Substring(0, 12);
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

        // 并发上限：浏览器加载页面会并发发几十上百个模块请求，
        // 而每个请求一个 new Thread 没有上限。
        // 更实际的风险是：客户端连上不发数据就断开时，HandleClient
        // 会阻塞在 ReadByte 上，线程不退；反复触发就把线程资源耗光。
        // 用信号量限流 + 有界线程池，超出的请求直接拒掉。
        var gate = new SemaphoreSlim(MaxConcurrentRequests);

        while (true)
        {
            TcpClient client;
            try { client = tcp.AcceptTcpClient(); }
            catch { return; }                 // 已停止

            // 拿不到许可就直接断开，不排队 —— 本机只服务一个 WebView，
            // 排队毫无意义，只会把挂死的连接堆在内存里。
            if (!gate.Wait(0))
            {
                Log($"并发已达上限（{MaxConcurrentRequests}），拒绝新连接");
                try { client.Close(); } catch { }
                continue;
            }

            ThreadPool.QueueUserWorkItem(_ =>
            {
                try { HandleClient(client, rootFull); }
                catch { }
                finally
                {
                    try { gate.Release(); } catch { }
                }
            });
        }
    }

    private static void HandleClient(TcpClient client, string rootFull)
    {
        var rootPrefix = rootFull.EndsWith(Path.DirectorySeparatorChar)
            ? rootFull
            : rootFull + Path.DirectorySeparatorChar;

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

                // 必须带结尾分隔符比较，否则根目录的「同前缀兄弟目录」
                // （web-abc 与 web-abcdef）会被误判为根内路径。
                if (!path.Equals(rootFull, StringComparison.OrdinalIgnoreCase) &&
                    !path.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
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

    /// <summary>
    /// 读请求头，直到遇到空行。
    ///
    /// 读超时是必需的，不是保险：65536 的上限只能防「超大请求头」，
    /// 防不住「连上不发」或「发一半就停」——这两种情况下
    /// ReadByte 会一直等下去，线程永不退出。
    /// </summary>
    private static string? ReadHeaders(NetworkStream stream)
    {
        var sb = new StringBuilder();

        // 单次读取的等待上限。超过就当作「这个请求废了」。
        var deadline = DateTime.UtcNow.AddMilliseconds(HeaderReadTimeoutMs);
        // ReadTimeout 只对同步 Read 生效，ReadByte 走的是同一层，
        // 但显式设一次更保险（有些实现路径不看它）。
        try { stream.ReadTimeout = HeaderReadTimeoutMs; } catch { }

        while (sb.Length < 65536)
        {
            // 逐字节找 \r\n\r\n —— 请求头很小，逐字节最简单也最可靠。
            // 但必须每轮检查时限，否则一个不发数据的连接能挂住线程到底。
            if (DateTime.UtcNow > deadline)
            {
                Log("读请求头超时，放弃该连接");
                return null;
            }

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
        // reason 短语要和状态码对上。原来写成
        // `code == 403 ? "Forbidden" : "Method Not Allowed"`，
        // 于是 404 被标成「Method Not Allowed」，响应行自相矛盾
        // （「HTTP/1.1 404 Method Not Allowed」），抓包一眼就看出来。
        // 与 SmokeTest.cs:319 的探针版本保持一致。
        var reason = code switch
        {
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            _ => "OK",
        };

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
                // 记下的位置可能来自已拔掉的显示器。默认
                // WindowStartupLocation=CenterScreen 只有在不显式设置
                // Left/Top 时才生效 —— 把窗口恢复到屏幕外，用户会以为
                // 程序没启动。超出虚拟桌面就丢弃，回到居中。
                var vLeft = SystemParameters.VirtualScreenLeft;
                var vTop = SystemParameters.VirtualScreenTop;
                var vRight = vLeft + SystemParameters.VirtualScreenWidth;
                var vBottom = vTop + SystemParameters.VirtualScreenHeight;
                var visible = nums[0] >= vLeft && nums[0] < vRight - 200
                           && nums[1] >= vTop && nums[1] < vBottom - 200;

                if (visible)
                {
                    Left = nums[0]; Top = nums[1];
                    Width = nums[2]; Height = nums[3];
                }
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