# 开发文档

## 项目目标

本项目把 ACGO 团队作业和比赛整理成“代码证据包”，供 AI 生成学生当日家长反馈。项目的核心输入是题面、排行榜、每题得分、提交次数和每次提交的完整代码；`今日总结.md` 提供老师当天的教学目标、重难点和易错点。

## 代码结构

- `src/index.mjs`：主入口，负责配置解析、浏览器连接、采集调度、分页、提交代码读取和文件写出。
- `src/extract.mjs`：页面题面提取，以及提交记录去重。
- `src/markdown.mjs`：HTML 转 Markdown、题面清理、表格转义和题目标题格式化。
- `src/problem-data.mjs`：ACGO Next Data 题面接口地址构造和题面结构解析。
- `src/feedback.mjs`：家长反馈提示词和批量处理说明。
- `test/extract.test.mjs`：单元测试。

## 配置模型

项目只维护当前短配置模型：

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
  }
}
```

比赛入口默认是 `contest/detail/{id}?teamCode={teamCode}`。`contest.matchRoundId` 默认等于 `contest.id`，`contest.examId` 和 `contest.openLevel` 会从详情页链接或 `contestInfo.matchRounds.programExamId`、`contestInfo.openLevel` 中识别；只有 ACGO 页面无法自动识别时才需要手动补充。

## 主流程

1. 读取 `config.json`，生成作业和比赛入口 URL。
2. 读取 `dailySummaryPath` 指向的 `今日总结.md`；如果文件不存在，自动创建模板。
3. 通过 Chrome DevTools Protocol 连接已登录 Chrome。
4. 监听 ACGO 网关请求头，用浏览器登录态调用接口。
5. 按 `targets` 采集作业、比赛或两者。
6. 写出题面、排行榜、学生记录、提示词、今日总结和 `raw/summary.json`。

## 作业采集

- 题目列表：从作业题目页识别 `problemset/info` 链接。
- 题面：优先通过 Next Data 并发读取；单题失败时才对该题做页面解析。
- 排行榜：调用 `/acgoPms/api/team/{teamCode}/homework/ranking/{homeworkId}`，按接口返回的 `pages` 自动翻页。
- 题目分值：调用 `/acgoPms/api/team/{teamCode}/homework/getQuestionScore/{homeworkId}`。
- 提交代码：调用作业 `questionAnswerRecord/list` 和 `questionAnswerRecord/view` 接口，按 `submissionApiConcurrency` 和 `submissionDetailConcurrency` 控制并发，保留每次提交的完整代码。

## 比赛采集

- 比赛入口：先访问详情页，再解析题目页、排行榜、`examId`、`openLevel` 和 `matchRoundId`。
- `examId`：优先使用配置，其次从比赛详情页或页面链接自动识别。
- 题目列表：调用 `/acgoMatch/leaderboard/questionList`，使用 `acgoQuestionId` 构造题面地址。
- 题面：通过 Next Data 并发读取。
- 排行榜：逐页打开比赛排行榜 `page=1,2,3...`，读取每页 `__NEXT_DATA__.props.pageProps.listData` 并按 `userId` 合并。
- 提交代码：调用比赛 `questionAnswerRecord/list` 和 `questionAnswerRecord/matchView` 接口，读取逻辑与作业提交保持一致的可控并发。

## 输出约定

```text
output/<sessionName>/
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

学生文件统一包含：

- 总体摘要
- 每题情况
- 提交代码
- 题目知识点

提交代码块只保留反馈需要的信息：

- 评测结果
- 得分和得分率
- 语言
- 运行时间和内存
- 提交时间
- 完整代码

## 调试

运行：

```powershell
npm run inspect
```

诊断结果写入：

```text
output/<sessionName>/debug/诊断报告.json
```

如需保存页面 HTML 和截图，将 `config.json` 中的 `saveDebugFiles` 设置为 `true`。

## 测试

```powershell
node --check src/index.mjs
node --check src/extract.mjs
node --check src/feedback.mjs
npm test
```

新增解析逻辑时，请优先补单元测试；新增采集目标时，先确认 ACGO 页面真实请求，再接入结构化接口。

