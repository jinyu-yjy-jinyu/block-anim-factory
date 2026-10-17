// ============================================================
//  App.xaml.cs · 桌面版入口
// ------------------------------------------------------------
//  只做两件事：挂上全局异常兜底、显示主窗口。
//  真正的启动逻辑在 BlockAnim.OnLoaded 里。
// ============================================================

using System;
using System.Linq;
using System.Windows;
using System.Windows.Threading;

namespace BlockAnimDesktop;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        // 异常兜底**必须**在 --smoke 分支之前注册。
        //
        // 原来它写在下面，导致 smoke 模式永远走不到：SmokeTest.Run() 里
        // 读 index.html、读 FileInfo 的地方没有包在断言里，资源没释放出来
        // 时直接抛，进程带崩溃退出码死掉 —— CI 拿到的是「崩了」而不是
        // 「哪条断言没过」，冒烟测试就失去了意义。
        RegisterGlobalExceptionHandlers();

        // --smoke 模式：只跑资源与静态服务的断言，不开窗口。
        // CI 用它来验证「桌面版能被正确打包」。
        //
        // 用 Environment.Exit 而不是 Shutdown()：Shutdown 只是请求退出，
        // WPF 的消息循环、Dispatcher、还有 WebView2 的宿主线程都可能
        // 让进程赖着不走 —— CI 上表现为「断言全过，但这一步永远卡住」。
        if (e.Args.Contains("--smoke"))
            Environment.Exit(Tests.SmokeTest.Run());

        base.OnStartup(e);
        var win = new BlockAnim();
        win.Show();
    }

    private void RegisterGlobalExceptionHandlers()
    {
        // 全局异常兜底：桌面端崩了就白屏，用户一脸懵。
        // 这里至少弹个框说明原因，而不是无声退出。
        DispatcherUnhandledException += OnDispatcherUnhandledException;

        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
        {
            var ex = args.ExceptionObject as Exception;
            BlockAnim.Log("AppDomain 未捕获: " + ex);
            // 注意：UnhandledException 可能在**非 UI 线程**触发
            //（后台线程抛异常就会走到这里）。直接在那个线程上调
            // MessageBox.Show 去创建窗口句柄不可靠，轻则不显示、重则再抛。
            // 所以切回 UI 线程执行；切不回去（Dispatcher 已关闭）就只写日志。
            var disp = Dispatcher;
            if (disp != null && !disp.HasShutdownStarted && !disp.HasShutdownFinished)
            {
                try
                {
                    disp.Invoke(() =>
                    {
                        MessageBox.Show(
                            "发生未处理的错误：\n\n" + (ex?.Message ?? "未知错误"),
                            "积木动画工厂",
                            MessageBoxButton.OK, MessageBoxImage.Error);
                    });
                    return;
                }
                catch (Exception)
                {
                    // 进程即将终止时 Dispatcher 可能已经不可用，
                    // 落到下面只写日志，不要让兜底本身再抛一次。
                }
            }
            BlockAnim.Log("（非 UI 线程且 UI 不可用，未弹窗）");
        };
    }

    private void OnDispatcherUnhandledException(
        object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        BlockAnim.Log("Dispatcher 未捕获: " + e.Exception);
        MessageBox.Show(
            "发生未处理的错误：\n\n" + e.Exception.Message,
            "积木动画工厂",
            MessageBoxButton.OK, MessageBoxImage.Error);
        e.Handled = true;
    }
}
