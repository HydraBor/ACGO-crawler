# ACGO 代码证据包生成器

把 ACGO 团队作业和比赛数据整理成适合提交给 AI 的 Markdown 证据包，用来生成每个学生当天给家长看的反馈。工具会采集题面、排行榜、每题得分、提交次数以及每次提交的完整代码，并结合老师手写的 `今日总结.md` 生成提示词。

当前版本：`1.7.0`

## 功能

- 支持只爬作业、只爬比赛，或同时爬取两部分。
- 作业只需要配置 `homework.id` 和 `homework.teamCode`。
- 比赛只需要配置 `contest.id`、`contest.matchRoundId`、`contest.openLevel` 和 `contest.teamCode`；`contest.examId` 可选，缺省时会自动识别。
- 作业排行榜通过 ACGO 接口按 `pages/total` 自动翻页。
- 比赛排行榜按 `page=1,2,3...` 逐页读取并合并，避免漏掉第二页之后的学生。
- 每个学生分别生成 `课堂练习.md` 和 `今日比赛.md`，两类文件结构一致。
- 学生提交记录只保留反馈需要的结果、时间、语言、内存和代码。

## 输出结构

默认输出到 `output/<sessionName>/`：

```text
output/ACGO-代码证据包/
  README.md
  今日总结.md
  作业题目.md
  作业完成情况.md
  比赛题目.md
  比赛排行榜.md
  students/
    学生名-用户ID/
      课堂练习.md
      今日比赛.md
  prompts/
    家长反馈生成提示词.md
    批量处理说明.md
  raw/
    summary.json
```

每个学生文件包含：

- 总体摘要：用户 ID、排名、总分、总提交次数。
- 每题情况：题目、得分、状态、提交次数、用时。
- 提交代码：按题目和提交次数列出完整代码。
- 题目知识点：从题面接口读取到的知识点标签。

项目根目录的 `今日总结.md` 是每日手动填写区。你每天只需要更新这份文件，爬虫会在导出时复制到证据包，并嵌入 `prompts/家长反馈生成提示词.md`。

## 安装

需要 Node.js 20 或更高版本。

```powershell
npm install
Copy-Item config.example.json config.json
Copy-Item 今日总结.example.md 今日总结.md
```

CMD 用户：

```bat
copy config.example.json config.json
copy 今日总结.example.md 今日总结.md
```

## 启动可连接的 Chrome

先完全关闭所有 Chrome 窗口，然后在 PowerShell 中执行：

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:LOCALAPPDATA\ACGO-Crawler-Chrome"
```

如果 Chrome 安装在 `Program Files (x86)`：

```powershell
& "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:LOCALAPPDATA\ACGO-Crawler-Chrome"
```

在这个 Chrome 窗口中登录 ACGO，并确认账号有查看对应团队、作业、比赛和提交代码的权限。

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
    "matchRoundId": "20001",
    "openLevel": 2,
    "teamCode": "1000000000000000000"
  },
  "sessionName": "ACGO-代码证据包",
  "dailySummaryPath": "今日总结.md",
  "cdpUrl": "http://127.0.0.1:9222",
  "outputDirectory": "output",
  "cleanOutput": true,
  "navigationTimeoutMs": 30000,
  "actionDelayMs": 500,
  "questionApiConcurrency": 4,
  "apiRetryCount": 3,
  "maxRankingPages": 100,
  "saveDebugFiles": false
}
```

只爬作业：

```json
{
  "targets": ["homework"],
  "homework": {
    "id": "10001",
    "teamCode": "1000000000000000000"
  }
}
```

只爬比赛：

```json
{
  "targets": ["contest"],
  "contest": {
    "id": "20001",
    "matchRoundId": "20001",
    "openLevel": 2,
    "teamCode": "1000000000000000000"
  }
}
```

## 运行

先做诊断：

```powershell
npm run inspect
```

确认诊断正常后导出：

```powershell
npm start
```

验证代码：

```powershell
npm test
```

## 给 AI 的用法

给某个学生生成当日反馈时，建议提交：

1. `prompts/家长反馈生成提示词.md`
2. `今日总结.md`
3. `作业题目.md`
4. `比赛题目.md`
5. `students/学生名-用户ID/课堂练习.md`
6. `students/学生名-用户ID/今日比赛.md`

提示词已经要求 AI 结合今日总结、每题得分、提交次数、通过时间和完整代码，用通俗、正向、适合家长阅读的方式生成一段反馈。

## 文档

- [开发文档](docs/DEVELOPMENT.md)
- [部署文档](docs/DEPLOYMENT.md)

## 注意

- 工具不会保存账号或密码，也不会上传数据。
- 登录令牌只在运行内存中复用。
- 学生成绩和代码属于敏感数据，请只导出你有权限查看的数据并妥善保管。

