# 部署文档

## 环境要求

- Windows 10/11
- Node.js 20 或更高版本
- Google Chrome
- 一个有权限查看对应 ACGO 团队、作业、比赛和提交记录的账号

## 首次部署

进入项目目录：

```powershell
cd <project-directory>
```

安装依赖：

```powershell
npm install
```

复制配置：

```powershell
Copy-Item config.example.json config.json
Copy-Item 今日总结.example.md 今日总结.md
```

CMD 用户：

```bat
copy config.example.json config.json
copy 今日总结.example.md 今日总结.md
```

## 启动 Chrome 登录态

先关闭所有普通 Chrome 窗口，再运行：

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:LOCALAPPDATA\ACGO-Crawler-Chrome"
```

如果 Chrome 在 `Program Files (x86)`：

```powershell
& "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:LOCALAPPDATA\ACGO-Crawler-Chrome"
```

在打开的 Chrome 中登录 ACGO。这个浏览器配置目录会保留登录态，后续通常不需要重复登录。

## 配置

编辑 `config.json`：

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
  "dailySummaryPath": "今日总结.md",
  "cdpUrl": "http://127.0.0.1:9222",
  "outputDirectory": "output",
  "cleanOutput": true,
  "navigationTimeoutMs": 30000,
  "pageSettleDelayMs": 300,
  "actionDelayMs": 100,
  "questionApiConcurrency": 4,
  "submissionApiConcurrency": 4,
  "submissionDetailConcurrency": 3,
  "apiRetryCount": 3,
  "maxRankingPages": 100,
  "saveDebugFiles": false
}
```

常用调整：

- 只爬作业：`"targets": ["homework"]`
- 只爬比赛：`"targets": ["contest"]`
- 每日总结文件：`"dailySummaryPath": "今日总结.md"`
- 保留旧输出：`"cleanOutput": false`
- 保存调试页面：`"saveDebugFiles": true`
- 限制最多分页：`"maxRankingPages": 100`
- 提高读取速度：适当调高 `questionApiConcurrency`、`submissionApiConcurrency`、`submissionDetailConcurrency`
- 遇到接口临时失败：适当降低并发，或调高 `actionDelayMs`
- 比赛入口：默认用 `contest.id` 和 `contest.teamCode` 打开比赛详情页，其余参数自动识别
- 比赛高级参数：`contest.matchRoundId`、`contest.examId`、`contest.openLevel` 通常不用填写

## 每日使用流程

1. 更新项目根目录的 `今日总结.md`。
2. 修改 `config.json` 中的作业号、比赛号、团队号。
3. 运行诊断：

```powershell
npm run inspect
```

4. 确认诊断正常后导出：

```powershell
npm start
```

5. 打开 `output/<sessionName>/` 查看证据包。

## 诊断重点

- Chrome 是否已登录。
- 比赛是否成功识别 `examId`。
- 作业题目链接是否识别。
- 比赛排行榜 `rankingRows` 是否等于 `rankingTotal`。
- `debug/诊断报告.json` 中是否有关键接口响应。

## 给 AI 的材料

- `prompts/家长反馈生成提示词.md`
- `今日总结.md`
- `作业题目.md`
- `比赛题目.md`
- 某个学生目录下的 `课堂练习.md`
- 同一个学生目录下的 `今日比赛.md`

## 更新版本

更新代码后运行：

```powershell
npm install
npm test
```

如果依赖没有变化，`npm install` 通常会很快完成。

## 常见问题

### 无法连接 Chrome

确认 Chrome 是用 `--remote-debugging-port=9222` 启动的，并且 `config.json` 中 `cdpUrl` 是 `http://127.0.0.1:9222`。

### 提示未登录

在远程调试 Chrome 里打开 ACGO 并登录，再重新运行。

### 比赛缺少 `examId`

保留 `contest.id` 和 `teamCode`，运行 `npm run inspect`。脚本会先访问比赛详情页，并尽量从页面里自动补出 `examId`。如果仍失败，可以把排行榜链接中的 `examId` 手动填入 `contest.examId`。

### 排行榜人数不完整

检查控制台是否有 `已读取 x/y 名学生` 警告。必要时提高：

```json
{
  "maxRankingPages": 200
}
```

如果 ACGO 临时改版，打开 `saveDebugFiles` 后重新运行诊断。

### 代码提交为空

确认当前账号有查看该学生提交详情的权限。若排行榜显示有提交但文件为空，请开启 `saveDebugFiles` 并保留 `raw/summary.json` 供排查。

