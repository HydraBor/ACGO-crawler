# Windows 部署与使用

## 推荐：便携 GUI 发行包

目标平台为 Windows 10/11 x64。解压 `ACGO-Crawler-Windows-x64.zip` 后双击 `ACGO-Crawler-Launcher.exe`。

发行目录包含：

- x64 WinForms 启动器；
- 爬虫源码与生产依赖；
- 必需的 `提示词.md`；
- `runtime/node-runtime.zip` 及 SHA-256；
- 使用说明。

启动器优先使用系统 Node.js 20+。没有合格 Node 时，会校验配套 SHA-256，并以防 Zip Slip 的方式解压便携 Node 运行时。

## GUI 流程

1. 输入团队链接（例如 `https://www.acgo.cn/team/<团队ID>`）或纯团队 ID。
2. 选择作业、竞赛或同时采集，并填写相应 ID。
3. 使用发行目录中的 `提示词.md`，或选择另一份非空完整提示词。
4. 启动任务。程序先连 `cdpUrl`，失败后自动启动 Edge。
5. 首次未登录时，在 Edge 完成 ACGO 登录；核心程序会自动检测登录成功并继续，不需要重启命令。
6. 成功后打开 ZIP 所在目录。

完整任务成功后会关闭本工具专用 profile 的 Edge，包括上次失败保留后本次重连的实例；连接到用户自己的外部 CDP 浏览器时默认只断开。未登录或采集失败时，程序自动启动的 Edge 默认保留，以便登录或排错。

程序自动启动的专用 Edge 会禁用扩展，避免油猴等扩展的欢迎页或用户脚本干扰采集；这不会修改普通 Edge 的扩展配置。
本程序自动启动的专用 Edge 复用它自己的唯一首页标签，并先确认登录再访问任务页；连接用户已有浏览器时才新建工作标签，不会导航或读取已经存在的油猴、个人网页或其他标签页。

## 手工模式

也可以在 GUI 中选择已有 `config.json`，或直接执行：

```powershell
npm install
npm run inspect
npm start
```

`提示词.md` 是必需文件。`npm run inspect` 只做入口诊断，不能替代 `npm start` 对所有提交接口的完整测试。

## 输出与完成条件

成功标志必须同时满足：

- `<outputDirectory>/<sessionName>/raw/summary.json` 存在且可解析（仅供本地核验，不进入 AI ZIP）；
- ZIP 成功生成；
- 题目数、学生数、学生文件数和提交代码数通过完整性检查；
- 配置的教师 ID 不出现在正式输出；
- 没有提交详情接口失败或空代码；
- 控制台出现 `ZIP 已生成：<绝对路径>`。

程序通过暂存目录和回滚机制发布结果。失败时不会用半成品覆盖上一次完整输出；成功时始终完整替换同名旧目录，未知旧文件也不会残留。

## 常见问题

### Edge 已打开但提示未登录

请在程序弹出的独立 Edge 中登录 ACGO，而不是普通 Edge 窗口。程序默认等待 10 分钟并自动检测登录成功；该专用配置目录会保留登录态。

### 自动启动失败

程序按 Edge 的 Program Files、Program Files (x86)、LocalAppData 路径探测，再回退 Chrome。可在配置的 `browser.executablePath` 指定浏览器完整路径，并确认本机 CDP 端口未被其他程序占用。

### 排行榜或代码不完整

完整任务现在会严格失败，而不是静默导出。确认账号有查看团队、作业、比赛和学生代码的权限；必要时临时设置 `saveDebugFiles=true`，但调试 HTML/截图含敏感数据，应排错后删除。

### AI 不能读取 ZIP

ZIP 仍是完整交付物。先解压，再上传根目录 `提示词.md`、题面和 `students/` 中各学生 Markdown 文件。

## 更新与重建

```powershell
npm install
npm test
npm run build:launcher
```

完整构建从 Node.js 官方发布站下载固定 Windows x64 便携包，并核对官方 `SHASUMS256.txt`。构建失败时不要交付旧 `dist`。
