# ACGO 代码证据包生成器

面向 Windows 10/11 x64 的 ACGO 课堂练习与比赛采集工具。它会使用已登录浏览器的授权，读取题面、学生完成情况和每次提交的完整代码，排除配置中的教师账号，最后生成一个可直接复制或上传给 AI 的 ZIP。

当前版本：`2.0.0`

## 最简单的使用方式

使用发行目录中的 `ACGO-Crawler-Launcher.exe`：

1. 输入团队页面链接或团队 ID。
2. 填作业 ID、竞赛 ID，至少选择一项，也可以两项同时运行。
3. 确认 `提示词.md` 路径。
4. 点击开始。程序会连接现有 CDP 浏览器；连接不到时自动启动 Microsoft Edge。
5. 首次使用时，在弹出的 Edge 中登录 ACGO。程序会等待并自动检测登录成功，然后继续任务。
6. 全部接口和文件校验通过后，启动器会定位最终 ZIP。

如果电脑没有 Node.js 20+，启动器会校验并解压配套的 `runtime/node-runtime.zip`，无需用户安装开发环境。

## ZIP 内容

```text
ACGO-代码证据包.zip
├─ 作业题目.md
├─ 比赛题目.md
├─ students/
│  └─ 学生名-用户ID/
│     ├─ 课堂练习.md
│     └─ 今日比赛.md
└─ 提示词.md
```

- `提示词.md` 是项目的正式完整提示词，并以同名文件放在 ZIP 根目录。
- ZIP 使用严格白名单，只包含已启用目标的题面、对应的学生 Markdown、`students/` 目录和 `提示词.md`；证据目录中的 README、排行榜、完成情况、`raw/` 与 `debug/` 均不进入 ZIP。
- 作业中的上午/下午必做、选做分隔条目会保留，供 AI 判断题目分组。
- `teacherUserIds` 中的账号会在提交接口调用之前排除，不进入排行榜、学生目录、结构化数据或 ZIP。
- `debug/` 永远不进入 ZIP。
- 新结果在暂存区完整生成后才替换正式输出；接口、代码详情或打包任一环节失败时，不会发布半成品。

## 图形启动器

构建完整 Windows x64 发行包：

```powershell
npm install
npm run build:launcher
```

生成：

- `dist/ACGO-Crawler/ACGO-Crawler-Launcher.exe`
- `dist/ACGO-Crawler-Windows-x64.zip`

启动器支持界面参数和现有 `config.json` 两种模式。完整说明见 [launcher/README.md](launcher/README.md)。

## 手工配置模式

需要 Node.js 20+。复制配置后编辑：

```powershell
npm install
Copy-Item config.example.json config.json
```

```json
{
  "targets": ["homework", "contest"],
  "homework": {
    "id": "10001",
    "teamCode": "1000000000000000000"
  },
  "contest": {
    "id": "20001",
    "teamCode": "1000000000000000000"
  },
  "sessionName": "ACGO-代码证据包",
  "promptPath": "提示词.md",
  "teacherUserIds": ["4741656"],
  "cdpUrl": "http://127.0.0.1:9222",
  "browser": {
    "autoLaunch": true,
    "startupTimeoutMs": 20000,
    "loginTimeoutMs": 600000,
    "closeOnFinish": false
  },
  "outputDirectory": "output",
  "pageSettleDelayMs": 300,
  "actionDelayMs": 100,
  "navigationTimeoutMs": 30000,
  "questionApiConcurrency": 4,
  "submissionApiConcurrency": 4,
  "submissionDetailConcurrency": 3,
  "apiRetryCount": 3,
  "maxRankingPages": 100,
  "saveDebugFiles": false
}
```

配置说明：

- `targets`：`homework`、`contest` 或两者。
- `teamCode`：团队页面 `https://www.acgo.cn/team/<数字>` 末尾的数字。
- `promptPath`：必需的完整提示词；相对 `config.json` 所在目录解析，默认 `提示词.md`。缺失或为空会失败。
- `teacherUserIds`：要排除的教师 ACGO 用户 ID，按完整字符串匹配。
- `cdpUrl`：优先连接的浏览器调试地址。
- `browser.autoLaunch`：连接失败时在 Windows 自动查找 Edge，找不到才回退 Chrome。
- `browser.loginTimeoutMs`：未登录时等待用户完成登录的最长时间，默认 600000 毫秒（10 分钟）；登录成功后自动继续。
- `browser.closeOnFinish`：是否连用户自己的外部 CDP 浏览器也一起关闭；默认 `false`。本工具专用 profile（包括上次失败保留、这次重新连接的实例）在完整任务成功后会自动关闭，诊断任务只断开。
- 2.0 的完整任务始终以本次新结果替换同名旧证据目录，不再支持混合保留旧输出。
- `navigationTimeoutMs`：页面导航超时；`pageSettleDelayMs`、`actionDelayMs`：页面稳定和接口节流等待。
- `questionApiConcurrency`、`submissionApiConcurrency`、`submissionDetailConcurrency`：题面、提交列表和提交详情并发上限。
- `apiRetryCount`：网络、429、5xx 重试上限；`maxRankingPages`：排行榜最大页数，达到上限仍不完整会失败。
- `saveDebugFiles`：保存敏感页面 HTML/截图，仅排错时开启；调试文件不打入 ZIP。

## 命令

```powershell
npm run inspect       # 页面和登录态诊断，不代表提交接口已全测
npm start             # 完整采集、严格校验并生成 ZIP
npm test              # 单元、故障注入和打包测试
npm run check         # 语法、测试、版本号和发行文件一致性
npm run build:launcher
```

完整任务会真实调用所有启用目标的题面、排行榜、提交列表和提交详情读取接口。任何预期提交缺少代码都会使本次任务失败。

## 浏览器行为

- 先尝试连接 `cdpUrl`，因此已有 Chrome 或 Edge 均兼容。
- 连接失败时，Windows 自动优先启动 Edge，并使用独立、持久的 `%LOCALAPPDATA%\ACGO-Crawler\Edge-Profile` 保存登录态。
- 程序自动启动的专用 Edge 默认禁用扩展，避免油猴等扩展欢迎页或脚本干扰；连接用户已有浏览器时不修改扩展设置。
- 本程序自动启动的专用 Edge 会复用它自己的唯一首页标签，并先确认登录再访问任务页，避免同时弹出首页和 403；连接用户已有浏览器时才新建专用工作标签，绝不接管、跳转或读取油猴欢迎页及其他已有标签页。
- 首次未登录时会保留自动启动的 Edge，并默认等待最多 10 分钟供登录；检测成功后自动继续原任务。
- 完整任务成功后会关闭本工具专用 profile 的浏览器，包括上次失败保留后本次重连的实例；用户自己的外部 CDP 浏览器默认只断开，只有手工显式配置 `closeOnFinish=true` 才会一并关闭。程序只会对本次自己启动且能确认 PID 的进程做 PID 级兜底清理。

## 给 AI 的用法

把最终 `ACGO-代码证据包.zip` 交给支持 ZIP 分析的 AI，并要求先读取包内根目录的 `提示词.md`。若某个平台不能展开 ZIP，先在本地解压，再上传同样的四类材料。

学生成绩、姓名和代码属于敏感数据。工具不会保存账号密码，鉴权头只在本次进程内复用；请只处理你有权访问的数据，并在人工核验后再把反馈发给家长。

## 2.0 配置边界

2.0 以 `config.example.json` 为唯一配置格式，不再兼容 1.x 的自动推断目标、旧“今日总结”、扁平浏览器开关、`packageName`、`excludedUserIds` 或保留旧输出等字段。遇到旧字段会明确失败并提示更新，避免配置看似生效、实际被忽略。

## 文档

- [部署与日常使用](docs/DEPLOYMENT.md)
- [开发与接口说明](docs/DEVELOPMENT.md)
