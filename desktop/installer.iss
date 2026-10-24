; ============================================================
;   installer.iss · Windows 安装包（Inno Setup）
; ------------------------------------------------------------
;   由 .github/workflows/desktop.yml 在构建出 desktop/out 之后调用：
;       iscc desktop/installer.iss
;
;   为什么用 Inno Setup 而不是 MSIX：
;     · MSIX 未签名时给用户添的麻烦更多（需要开开发者模式/侧载）
;     · Inno 免费、脚本简单、CI 里能静默跑
;     · 未签名安装包仍然会触发 SmartScreen，这个躲不掉 ——
;       项目既定不做代码签名（开源、不买证书）
;
;   安装目标刻意选 %LOCALAPPDATA%\Programs\... 而不是 Program Files：
;     未签名写入 Program Files 会弹 UAC 提权，体验更差；
;     %LOCALAPPDATA% 下不需要管理员权限，装完即用。
;
;   将来若换成 Electron/Tauri 壳，这个文件整体替换即可（electron-builder
;   自己有安装包配置），本文件不参与任何构建逻辑，只描述「怎么装」。
; ============================================================

#define AppName "积木动画工厂"
#define AppVersion "0.4.2"
#define AppPublisher "block-anim-factory"
#define AppURL "https://github.com/jinyu-yjy-jinyu/block-anim-factory"
#define AppExeName "积木动画工厂.exe"

[Setup]
; AppId 必须是固定 GUID，换壳时重生成一个，别复用（会和旧版卸载打架）
AppId={{7A3F9C2E-5B41-4D8A-9E6F-1C2D3E4F5A6B}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}

DefaultDirName={autopf}\{#AppName}
; {autopf} 在 PrivilegesRequired=lowest 下恒等于 {localappdata}\Programs，
; 即 %LOCALAPPDATA%\Programs\积木动画工厂 —— 不需要 UAC，未签名也能装。
; 只有权限为 admin 且能写 Program Files 时才会用真 Program Files，
; 而这里刻意锁在 lowest，所以行为是确定的。
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; 未签名安装包装在用户目录，不需要 UAC
PrivilegesRequired=lowest
; 架构标识：用 x64compatible（Inno 6.3+ 推荐），而不是已废弃的 x64。
; x64 会触发告警「Architecture identifier "x64" is deprecated，Substituting "x64os"」——
; 我们自己写明意图，别让编译器替我们猜。
; x64compatible = 「能在 x64 上跑」即可（含 ARM64 上的 x64 模拟），
; 对纯 .NET 自包含程序是正确语义；xe 包本身也只有 win-x64 一种。
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; OutputDir 是相对 .iss 文件所在目录（不是当前工作目录），
; 所以这里显式写 ..\ 让安装包落在项目根目录，
; 和 zip 产物（block-anim-factory-win-x64.zip）放在一起，CI 里统一按根目录取。
; 文件名刻意用纯 ASCII：
;   actions/upload-artifact 在收集文件时用的是 CI 里 path 的通配符，
;   而中文通配符会让它丢掉文件名前半截（实测产出 `-0.4.1-win-x64-setup.exe`，
;   「积木动画工厂」整段消失）。改成 ASCII 后两边都能稳定匹配。
;   注意：这只影响**下载下来的文件名**；安装后用户看到的
;   开始菜单项 / 桌面图标 / 卸载列表 / 向导里的程序名全部来自 AppName（中文），不受影响。
OutputDir=..
OutputBaseFilename=block-anim-factory-{#AppVersion}-win-x64-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 安装包双击时如果被杀软/浏览器改名过，提示一下来源，减少「这是病毒吗」的疑虑
AppComments=开源软件，未做代码签名。源码与构建过程见 GitHub。

UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExeName}

; 语言：刻意不声明 [Languages]。
;
; 为什么不声明 —— 两个原因，都是「不想让编译失败」：
;   1. 中文语言文件 ChineseSimplified.isl 虽然是 Inno 的官方翻译，
;      但它在编译器目录 Languages\ 下，不同版本/精简安装不一定有；
;      声明了却找不到会**直接编译失败**，而不是降级。
;   2. ISPP 里判断「文件是否存在」的函数在不同版本可用性不一，
;      用不确定的预处理器函数同样有编译失败风险。
;
; 代价是安装向导界面是英文。但用户实际看到的
; 「程序名」「开始菜单项」「桌面图标名」「卸载列表里的名字」全是中文，
; 因为这些来自 AppName 而不是语言文件。这个取舍是有意的。
;
; 将来要中文向导：在 CI 里往编译器目录的 Languages\ 拷一份
; ChineseSimplified.isl，再加回 [Languages] 一节即可。

[Tasks]
; 不用 {cm:CreateDesktopIcon} 这类语言常量 —— 那是给英文向导用的。
; 直接写中文，用户看到的就是中文，和语言文件无关。
Name: "desktopicon"; Description: "创建桌面快捷方式（可取消）"; \
    GroupDescription: "附加任务："; Flags: checkedonce

[Files]
; desktop/out/** 全部（就是 zip 里那 9 个文件）。
; 这里用 flags: recursesubdirs 把整个目录树带进去，
; 新增/删除文件不用改脚本 —— 换壳时也只改这个 Source。
Source: "..\desktop\out\*"; DestDir: "{app}"; \
    Flags: recursesubdirs ignoreversion createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; \
    WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; 装完默认不自动启动（用户要的是「像个软件」，不是被强行打开）
Filename: "{app}\{#AppExeName}"; Description: "立即运行 {#AppName}"; \
    Flags: nowait postinstall skipifsilent
