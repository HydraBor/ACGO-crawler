# 开发与接口说明

## 架构

- `src/index.mjs`：CLI、配置、采集调度、渲染与输出事务集成。
- `src/config.mjs`：2.0 配置校验、目标规范化与入口 URL 构造。
- `src/browser.mjs`：CDP 连接、Edge/Chrome 探测启动和浏览器生命周期。
- `src/reliability.mjs`：分页、重试、响应结构收集、严格提交校验和比赛题序降级。
- `src/output-transaction.mjs`：暂存、原子替换和回滚。
- `src/package.mjs`：纯 Node ZIP 生成，固定 UTF-8 路径与四类材料严格白名单。
- `src/filters.mjs`：教师 userId 字符串规范化和严格匹配。
- `src/prompt.mjs`：必需提示词读取与安全元数据。
- `src/extract.mjs`、`src/markdown.mjs`、`src/problem-data.mjs`：题面、Markdown 和 Next Data 解析。
- `launcher/`：Windows x64 WinForms 启动器及发行构建。

## CLI

```text
node src/index.mjs [--config <path>] [--inspect-only]
```

应用不是 HTTP 服务，没有入站路由。

## 外部读取接口

页面：

- `https://www.acgo.cn/homework/{id}?teamCode=...&tab=question|ranking`
- `https://www.acgo.cn/contest/detail/{id}`
- `https://www.acgo.cn/contest/question/{id}`
- `https://www.acgo.cn/contest/ranking/{id}`
- `https://www.acgo.cn/problemset/info/{questionId}`
- `/_next/data/{buildId}/problemset/info/{questionId}.json`

网关：

- `GET /acgoPms/api/team/{teamCode}/homework/ranking/{homeworkId}`
- `GET /acgoPms/api/team/{teamCode}/homework/getQuestionScore/{homeworkId}`
- `POST /acgoPms/api/team/{teamCode}/homework/questionAnswerRecord/list`
- `POST /acgoPms/api/team/{teamCode}/homework/questionAnswerRecord/view`
- `POST /acgoMatch/leaderboard/questionList`
- `POST /acgoMatch/api/team/{teamCode}/questionAnswerRecord/list`
- `POST /acgoMatch/api/team/{teamCode}/questionAnswerRecord/matchView`

所有 POST 均为数据读取语义。鉴权头从已登录浏览器的 gateway 请求捕获，只在内存中使用。

## 完整性与可靠性

- 教师账号在作业和比赛排行榜结构化记录进入提交任务前过滤，使用字符串 ID，避免数值精度问题。
- 比赛排行榜不猜 `pageSize`，逐页读取，直到达到 total、空页或无新增；达到上限仍不完整会失败。
- Gateway 网络错误、429 和 5xx 会重试；非 JSON 5xx 保留 HTTP 状态参与重试，并尊重 `Retry-After`。
- 任一预期提交列表为空、提交详情失败或代码为空，完整任务聚合错误并失败。
- 比赛题目接口和页面 questionList 都缺失时，可用 `rawProblems` 加排行榜题序安全降级；无法可靠映射时不伪造。
- response store 监听浏览器 context，包含新开的比赛页，并在写结构前等待异步 JSON 解析完成。
- 正式输出和 ZIP 一起事务提交；失败会回滚。

## 浏览器所有权

优先连接配置的本机 CDP 端点。自动启动只适用于 Windows 本机 HTTP 端点，优先 Edge、回退 Chrome，并使用独立持久 profile。对外部浏览器只在显式 `closeOnFinish=true` 时发送 `Browser.close`；进程级兜底只针对本程序启动且能确认 PID 的实例。

`--inspect-only` 可以自动启动浏览器，但结束时只断开，方便首次登录。完整任务失败也默认保留自动启动的 Edge。

自启动浏览器复用启动时创建的唯一页面；外接浏览器始终新建任务页面。主流程先在 ACGO 首页完成登录状态确认，再进入受保护目标，并按顺序在同一任务页采集作业和比赛，避免多窗口与首次 403 闪现。

## 输出模型

提示词、题面、学生 Markdown 和内部核验数据先写 staging。ZIP 采用严格白名单，根目录只包含 `提示词.md`、已启用目标的题面文件和 `students/`；学生文件又由本次数据集生成的精确路径清单限制。内部 README、排行榜、完成情况、`raw/`、`debug/`、旧学生文件和其他文件均不打包。

完整任务始终从空 staging 生成同名输出，不再提供保留旧输出的模式；只有 `--inspect-only` 为了不破坏上一次有效证据，会复制正式目录并仅替换 `debug/`。2.0 配置要求显式 `targets`，并拒绝 1.x 旧字段。

作业中的横线分隔条目按需求保留，不在采集器中过滤；正式提示词负责识别其必做/选做语义。

## 测试

```powershell
node --check src/index.mjs
node --check src/config.mjs
node --check src/browser.mjs
node --check src/reliability.mjs
node --check src/package.mjs
npm test
npm run check
```

测试覆盖解析、教师过滤、提示词、输出事务、ZIP、分页、429/5xx、严格提交错误、响应 flush 和浏览器会话。Windows Edge 集成测试应使用随机端口和临时 profile，绝不能关闭用户的 9222 浏览器。

真实验收不能只看退出码：还应核对 summary 与磁盘学生目录、题目数、提交 ID/代码哈希、ZIP 条目、教师排除和旧输出清理。
