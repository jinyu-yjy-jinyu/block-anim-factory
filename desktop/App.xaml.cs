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
        // --smoke 模式：只跑资源与静态服务的断言，不开窗口。
        // CI 用它来验证「桌面版能被正确打包」。
        //
        // 用 Environment.Exit 而不是 Shutdown()：Shutdown 只是请求退出，
        // WPF 的消息循环、Dispatcher、还有 WebView2 的宿主线程都可能
        // 让进程赖着不走 —— CI 上表现为「断言全过，但这一步永远卡住」。
        if (e.Args.Contains("--smoke"))
            Environment.Exit(Tests.SmokeTest.Run());

        // 全局异常兜底：桌面端崩了就白屏，用户一脸懵。
        // 这里至少弹个框说明原因，而不是无声退出。
        DispatcherUnhandledException += OnDispatcherUnhandledException;

        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
        {
            var ex = args.ExceptionObject as Exception;
            BlockAnim.Log("AppDomain 未捕获: " + ex);
            MessageBox.Show(
                "发生未处理的错误：\n\n" + (ex?.Message ?? "未知错误"),
                "积木动画工厂",
                MessageBoxButton.OK, MessageBoxImage.Error);
        };
        base.OnStartup(e);
        var win = new BlockAnim();
        win.Show();
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
