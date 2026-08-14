# Windows 图形启动器

`ACGO-Crawler-Launcher.exe` 是面向 Windows 10/11 x64 的 WinForms 一键启动器。

当前版本：`2.0.0`。窗口标题、程序集版本、项目版本和发行文档会在构建时交叉校验。

- 启动器本身使用 Windows 自带的 .NET Framework 4.x，不要求用户安装 .NET SDK。
- 优先使用系统中满足 Node 20+ 的 `node.exe`。
- 未安装 Node 或版本过旧时，自动校验并解压配套的 `runtime/node-runtime.zip`。
- GUI 支持团队 ID / 团队页面 URL、作业 ID、竞赛 ID（二选一或同时），并强制使用完整 AI 提示词。默认读取启动器同目录的 `提示词.md`，也可在界面选择其他文件。
- 高级用户可以切换为现有 `config.json`，原手工配置流程不变。
- 界面填写模式会在成功后关闭本工具专用 profile 的浏览器，包括上次失败保留后本次重连的实例；用户自己的外部 CDP 浏览器只断开连接，不会关闭。手工 `config.json` 仍可用 `browser.closeOnFinish` 显式覆盖外部浏览器行为。
- 自启动 Edge 只使用一个任务页面，先在首页确认登录再进入作业或比赛，避免同时弹出首页与 403 页面。
- 运行期间实时显示爬虫日志，成功后可直接定位最终 ZIP。

## 构建

在项目根目录执行：

```powershell
npm run build:launcher
```

完整发布目录位于 `dist/ACGO-Crawler/`，同时生成 `dist/ACGO-Crawler-Windows-x64.zip`。发布目录必定包含项目根的 `提示词.md`；缺失时构建直接失败。构建脚本从 Node.js 官方发布站下载固定版本的 Windows x64 便携 ZIP，并按官方 `SHASUMS256.txt` 校验 SHA-256。

完整构建成功后会自动删除可重建的 `launcher/bin/` 与 `launcher/cache/`，项目中只保留最新展开发行目录和运输 ZIP。

快速开发构建（不下载运行时、不生成发布压缩包）：

```powershell
powershell -ExecutionPolicy Bypass -File launcher/build.ps1 -SkipRuntime -SkipDistributionZip
```

## 无界面自检

```powershell
dist\ACGO-Crawler\ACGO-Crawler-Launcher.exe --self-test
echo $LASTEXITCODE
```

退出码 `0` 表示源码、生产依赖及 Node 环境可用；若目录含便携运行时，自检还会要求 `node-runtime.zip` 与 `node-runtime.sha256` 成对存在。失败详情会写到发布目录内的 `launcher-self-test-error.txt`。
