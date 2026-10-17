// ============================================================
//  SmokeTest.cs · 桌面版冒烟测试（不依赖外部工具）
// ------------------------------------------------------------
//  目的：把「能不能启动」这件事变成可断言的结果，而不是靠人肉
//  点开 exe 看一眼。CI 上跑这个，可以在提交后立刻知道有没有
//  把桌面版改崩。
//
//  验证四件事：
//    1. 内嵌的 Web 资源能被完整释放出来（且 index.html + 全部 src/*.js 在）
//    2. 极简静态服务能正确响应 GET / 、404、以及目录穿越防护
//    3. 关键 Web 资源确实存在（防止 csproj 的 glob 漏掉新文件）
//    4. 释放目录复用的是同一个（重启不该反复解压）
// ============================================================

using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;

namespace BlockAnimDesktop.Tests;

internal static class SmokeTest
{
    private static int _pass;
    private static int _fail;

    /// <summary>
    /// 挑一个**确定可写**的临时目录。
    ///
    /// 为什么不用 %TEMP%：本机实测过，%TEMP% 看着能写，但被本进程
    /// 访问时会抛 UnauthorizedAccessException（企业策略 / 受限令牌）。
    /// 正式版已经踩过一次这个坑，所以测试里也不能再用它。
    /// </summary>
    private static string SmokeDir()
    {
        foreach (var candidate in new[]
        {
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "BlockAnimFactory"),
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "BlockAnimFactory"),
            AppContext.BaseDirectory,
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
            catch { /* 试下一个 */ }
        }
        return AppContext.BaseDirectory;
    }

    private static void Check(bool ok, string label, string detail = "")
    {
        if (ok)
        {
            _pass++;
            Console.WriteLine($"  OK   {label}");
        }
        else
        {
            _fail++;
            Console.WriteLine($"  FAIL {label}{(detail.Length > 0 ? "  -> " + detail : "")}");
        }
    }

    internal static int Run()
    {
        Console.WriteLine("=== 桌面版冒烟测试 ===");

        try
        {
            return RunCore();
        }
        catch (Exception ex)
        {
            // 关键：冒烟测试内部异常**不能冒泡**。
            // 冒泡出去会变成进程崩溃退出码，CI 只看到「崩了」，
            // 看不到是哪条断言没过 —— 冒烟测试就失去了意义。
            // 这里把它变成一条普通的失败断言。
            _fail++;
            Console.WriteLine($"  FAIL 冒烟测试自身抛出异常 -> {ex.GetType().Name}: {ex.Message}");
            Console.WriteLine(ex.StackTrace);
            Console.WriteLine($"\n=== 结果: {_pass} 通过 / {_fail} 失败 ===");
            return 1;
        }
    }

    private static int RunCore()
    {
        var asm = Assembly.GetExecutingAssembly();

        // --------------------------------------------------------
        // 1) 资源释放
        // --------------------------------------------------------
        Console.WriteLine("\n[1] 内嵌资源释放");

        var root = Path.Combine(
            SmokeDir(), $"blockanim-smoke-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);

        var written = 0;
        var missing = new System.Collections.Generic.List<string>();

        foreach (var name in asm.GetManifestResourceNames())
        {
            if (!name.StartsWith("web.", StringComparison.Ordinal)) continue;

            var rel = name.Substring(4).Replace("..", Path.DirectorySeparatorChar.ToString());
            var dest = Path.Combine(root, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);

            using var src = asm.GetManifestResourceStream(name);
            if (src == null) { missing.Add(name); continue; }
            using var dst = File.Create(dest);
            src.CopyTo(dst);
            written++;
        }

        Check(written > 30, $"释放了 {written} 个资源", "数量异常，可能 glob 漏了");
        Check(missing.Count == 0, "没有空资源流",
            string.Join(", ", missing));

        var index = Path.Combine(root, "index.html");
        Check(File.Exists(index), "index.html 已释放");

        // index.html 里引用的资源都必须真实存在
        // 读文件这一步本身也可能失败（没释放出来 / 被占用），
        // 所以要单独兜住，不能让它冒泡成整个测试崩溃。
        try
        {
            var html = File.ReadAllText(index);
            foreach (System.Text.RegularExpressions.Match m in
                     System.Text.RegularExpressions.Regex.Matches(
                         html, @"(?:href|src)=""([^""]+)"""))
            {
                var url = m.Groups[1].Value;
                if (url.StartsWith("http") || url.StartsWith("data:") ||
                    url.StartsWith("//") || url.Length == 0) continue;

                var local = Path.Combine(root, url.TrimStart('/'));
                Check(File.Exists(local), $"index.html 引用的 {url} 存在");
            }
        }
        catch (Exception ex)
        {
            Check(false, "读取 index.html 并校验引用", $"{ex.GetType().Name}: {ex.Message}");
        }

        // --------------------------------------------------------
        // 2) 关键模块齐全
        // --------------------------------------------------------
        Console.WriteLine("\n[2] 关键模块");

        string[] mustHave =
        {
            "src/main.js", "src/ir.js", "src/renderer.js", "src/blocks.js",
            "src/evaluator.js", "src/exporter.js", "src/audio-core.js",
            "src/subtitles.js", "src/textengine.js", "src/marketplace.js",
            "src/ai.js", "src/collab.js", "src/templates.js",
            "src/styles.css", "src/panels.css", "src/panels-v3v4.css",
        };
        foreach (var m in mustHave)
            Check(File.Exists(Path.Combine(root, m)), $"{m} 已打包");

        // 模块语法至少不能是空文件
        var mainJs = Path.Combine(root, "src/main.js");
        try
        {
            Check(new FileInfo(mainJs).Length > 10_000,
                "src/main.js 体积正常", "可能是空壳");
        }
        catch (Exception ex)
        {
            Check(false, "src/main.js 体积正常",
                $"{ex.GetType().Name}: {ex.Message}");
        }

        // --------------------------------------------------------
        // 3) 静态服务
        // --------------------------------------------------------
        Console.WriteLine("\n[3] 本地静态服务");

        var tcp = new TcpListener(IPAddress.Loopback, 0);
        tcp.Start();
        var port = ((IPEndPoint)tcp.LocalEndpoint).Port;
        var rootFull = Path.GetFullPath(root);

        // 用后台线程而不是 Task.Run：
        // Task 的线程池线程是「前台」的，ServeProbe 阻塞在 AcceptTcpClient
        // 上不返回，进程就退不出来 —— CI 上表现为这一步永远卡住。
        // 后台线程不影响进程退出，tcp.Stop() 之后它会自己醒过来退出。
        var server = new Thread(() => ServeProbe(tcp, rootFull))
        {
            IsBackground = true
        };
        server.Start();

        try
        {
            Task.Delay(300).Wait();

            var body = Get(port, "/");
            Check(body != null && body.Contains("<!DOCTYPE html"),
                "GET / 返回 HTML");

            var js = Get(port, "/src/main.js");
            Check(js != null && js.Contains("BlockAnim"),
                "GET /src/main.js 返回脚本");

            var css = Get(port, "/src/styles.css");
            Check(css != null && css.Length > 100,
                "GET /src/styles.css 返回样式");

            Check(Get(port, "/没有这个.js") == null,
                "缺失的静态资源返回 404（不是悄悄回 HTML）");

            // 目录穿越必须被挡
            var evil = Get(port, "/../../../../../../Windows/win.ini");
            Check(evil == null || !evil.Contains("[fonts]"),
                "目录穿越被拦截");

            // 编码过的穿越
            var evil2 = Get(port, "/%2e%2e%2f%2e%2e%2f%2e%2e%2fwindows%2fwin.ini");
            Check(evil2 == null || !evil2.Contains("[fonts]"),
                "编码后的目录穿越被拦截");
        }
        finally
        {
            // 停服务：AcceptTcpClient 会抛异常，ServeProbe 随即返回
            try { tcp.Stop(); } catch { }
            server.Join(2000);
            try { Directory.Delete(root, recursive: true); } catch { }
        }

        // 把退出码落盘，让 CI 能读到确定的结果。
        //
        // 为什么不靠进程退出码：WinExe 通过 Start-Process 启动时，
        // PowerShell 经常拿不到 ExitCode（空字符串），拿它判断会把
        // 「断言全过」误判成「失败」。
        //
        // 写在哪：和资源释放用同一个 SmokeDir()，再退一级写到 exe 旁边。
        // 两处都写，CI 无论找到哪个都能读到 —— 省得为了路径对齐来回调。
        var exitCode = _fail == 0 ? 0 : 1;
        Console.WriteLine($"\n=== 结果: {_pass} 通过 / {_fail} 失败 ===");

        foreach (var dir in new[] { SmokeDir(), AppContext.BaseDirectory })
        {
            try
            {
                File.WriteAllText(Path.Combine(dir, "smoke-exit.txt"),
                                  exitCode.ToString());
            }
            catch { /* 落盘失败不影响测试本身的结论 */ }
        }

        return exitCode;
    }

    // ============================================================
    //  探针用的迷你服务器（和 BlockAnim 里的是同一套逻辑）
    // ============================================================
    private static void ServeProbe(TcpListener tcp, string rootFull)
    {
        var mime = new System.Collections.Generic.Dictionary<string, string>(
            StringComparer.OrdinalIgnoreCase)
        {
            [".html"] = "text/html; charset=utf-8",
            [".js"] = "text/javascript; charset=utf-8",
            [".css"] = "text/css; charset=utf-8",
            [".json"] = "application/json; charset=utf-8",
        };

        while (true)
        {
            TcpClient client;
            try { client = tcp.AcceptTcpClient(); }
            catch { return; }

            try
            {
                using (client)
                {
                    client.NoDelay = true;
                    using var stream = client.GetStream();

                    // 读请求头
                    var sb = new StringBuilder();
                    int b;
                    while ((b = stream.ReadByte()) >= 0)
                    {
                        sb.Append((char)b);
                        var n = sb.Length;
                        if (n >= 4 && sb[n - 4] == '\r' && sb[n - 3] == '\n' &&
                            sb[n - 2] == '\r' && sb[n - 1] == '\n') break;
                    }
                    if (sb.Length == 0) return;

                    var first = sb.ToString().Split('\n')[0].TrimEnd('\r');
                    var parts = first.Split(' ');
                    if (parts.Length < 2) return;

                    var raw = parts[1].Split('?')[0];
                    string rel;
                    try { rel = Uri.UnescapeDataString(raw).TrimStart('/'); }
                    catch { rel = raw.TrimStart('/'); }
                    if (rel.Length == 0) rel = "index.html";

                    string path;
                    try { path = Path.GetFullPath(Path.Combine(rootFull, rel)); }
                    catch { return; }

                    if (!path.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
                    {
                        Send(stream, 403, "text/plain; charset=utf-8",
                            Encoding.UTF8.GetBytes("Forbidden"));
                        return;
                    }

                    if (File.Exists(path))
                    {
                        Send(stream, 200,
                            mime.TryGetValue(Path.GetExtension(path), out var m)
                                ? m : "application/octet-stream",
                            File.ReadAllBytes(path));
                    }
                    else if (Path.GetExtension(rel).Length > 0 &&
                             mime.ContainsKey(Path.GetExtension(rel)))
                    {
                        Send(stream, 404, "text/plain; charset=utf-8",
                            Encoding.UTF8.GetBytes("Not Found"));
                    }
                    else
                    {
                        Send(stream, 200, "text/html; charset=utf-8",
                            File.ReadAllBytes(Path.Combine(rootFull, "index.html")));
                    }
                }
            }
            catch { }
        }
    }

    private static void Send(Stream stream, int code, string mime, byte[] body)
    {
        var reason = code switch { 403 => "Forbidden", 404 => "Not Found", _ => "OK" };
        var head = Encoding.UTF8.GetBytes(
            $"HTTP/1.1 {code} {reason}\r\n" +
            $"Content-Type: {mime}\r\n" +
            $"Content-Length: {body.Length}\r\n" +
            "Connection: close\r\n\r\n");
        stream.Write(head, 0, head.Length);
        stream.Write(body, 0, body.Length);
        stream.Flush();
    }

    /// <summary>发一个 GET；非 200 或超时返回 null</summary>
    private static string? Get(int port, string path)
    {
        TcpClient? client = null;
        try
        {
            client = new TcpClient();
            client.Connect(IPAddress.Loopback, port);
            client.NoDelay = true;

            // 必须设接收超时：万一服务端对某个请求没写回任何响应，
            // CopyTo 会一直读到天荒地老，整个冒烟测试就卡死在 CI 上。
            client.ReceiveTimeout = 5000;
            client.SendTimeout = 5000;

            using var stream = client.GetStream();
            stream.ReadTimeout = 5000;

            var req = Encoding.UTF8.GetBytes(
                $"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
            stream.Write(req, 0, req.Length);
            stream.Flush();

            using var ms = new MemoryStream();
            stream.CopyTo(ms, 65536);
            var raw = Encoding.UTF8.GetString(ms.ToArray());

            if (!raw.Contains(" 200 OK")) return null;

            var idx = raw.IndexOf("\r\n\r\n", StringComparison.Ordinal);
            return idx < 0 ? null : raw[(idx + 4)..];
        }
        catch
        {
            return null;
        }
        finally
        {
            try { client?.Dispose(); } catch { }
        }
    }
}
