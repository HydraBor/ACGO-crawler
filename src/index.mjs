import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';
import sanitizeFilename from 'sanitize-filename';
import {
  dedupeSubmissions,
  extractProblem
} from './extract.mjs';
import { escapeTable, formatProblemHeading, languageFence } from './markdown.mjs';
import { buildQuestionDataUrl, problemFromNextData } from './problem-data.mjs';
import { renderBatchInstructions, renderFeedbackPrompt } from './feedback.mjs';

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(args.config || 'config.json');
const configDirectory = path.dirname(configPath);
const config = normalizeConfig(await loadConfig(configPath));
const homeworkId = config.homework?.id || '';
const teamCode = config.homework?.teamCode || config.contest?.teamCode || '';
const contestConfig = config.contest;
const contestId = contestConfig?.id || '';
const packageSlug = config.packageName || config.sessionName || (
  [homeworkId ? `homework-${homeworkId}` : '', contestId ? `contest-${contestId}` : ''].filter(Boolean).join('-') || 'acgo-crawl'
);
const rootDirectory = path.resolve(config.outputDirectory || 'output', safeFilename(packageSlug));
const debugDirectory = path.join(rootDirectory, 'debug');
const rawDirectory = path.join(rootDirectory, 'raw');
const studentsDirectory = path.join(rootDirectory, 'students');
const promptsDirectory = path.join(rootDirectory, 'prompts');
const dailySummaryPath = resolveConfigPath(config.dailySummaryPath || config.dailySummaryFile || '今日总结.md');

if (config.cleanOutput !== false) {
  await cleanGeneratedOutput();
}

await Promise.all([
  rootDirectory,
  debugDirectory,
  rawDirectory,
  studentsDirectory,
  promptsDirectory
].map(directory => fs.mkdir(directory, { recursive: true })));

const dailySummaryMarkdown = await loadDailySummary(dailySummaryPath);

console.log(`正在连接 Chrome：${config.cdpUrl}`);
let browser;
try {
  browser = await chromium.connectOverCDP(config.cdpUrl || 'http://127.0.0.1:9222');
} catch (error) {
  fail(`无法连接 Chrome。请按 README 的命令用 --remote-debugging-port=9222 启动 Chrome。\n${error.message}`);
}

const context = browser.contexts()[0];
if (!context) fail('Chrome 中没有可用的浏览器上下文。');
context.setDefaultTimeout(config.navigationTimeoutMs || 30000);
context.setDefaultNavigationTimeout(config.navigationTimeoutMs || 30000);

const page = context.pages()[0] || await context.newPage();
const responseStore = createResponseStore(page);
const requestStore = createRequestStore(context);

try {
  const api = createAcgoApi(context, requestStore);
  if (args.inspectOnly) {
    await inspectConfiguredPages(page, api, responseStore);
    process.exitCode = 0;
  } else {
    const classroomDataset = config.homework ? await collectHomeworkDataset(page, api) : null;

    let contestDataset = null;
    if (contestConfig) {
      const contestPage = await context.newPage();
      try {
        contestDataset = await collectContestDataset(contestPage, api, contestConfig);
      } finally {
        await contestPage.close().catch(() => {});
      }
    }

    await writeCodeEvidenceFiles({ classroomDataset, contestDataset, dailySummaryMarkdown });

    const summary = { homeworkId, dailySummary: dailySummaryMarkdown, classroom: classroomDataset, contest: contestDataset };
    await writeJson(path.join(rawDirectory, 'summary.json'), summary);
    if (config.saveDebugFiles) {
      await writeJson(path.join(debugDirectory, '响应结构.json'), responseStore.shapes());
    }
    console.log(`导出完成：${rootDirectory}`);
  }
} catch (error) {
  console.error(`\n导出失败：${error.stack || error.message}`);
  try {
    await saveDebugPage(page, '发生错误时页面');
    await writeJson(path.join(debugDirectory, '响应结构.json'), responseStore.shapes());
  } catch {}
  process.exitCode = 1;
} finally {
  responseStore.dispose();
  requestStore.dispose();
  await browser.close().catch(() => {});
}

function parseArgs(values) {
  const result = {};
  for (let i = 0; i < values.length; i++) {
    if (values[i] === '--config') result.config = values[++i];
    else if (values[i] === '--inspect-only') result.inspectOnly = true;
  }
  return result;
}

function resolveConfigPath(value) {
  return path.isAbsolute(String(value || ''))
    ? String(value)
    : path.resolve(configDirectory, String(value || ''));
}

async function loadConfig(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    fail(`无法读取 ${filename}：${error.message}\n请先把 config.example.json 复制为 config.json。`);
  }
}

async function loadDailySummary(filename) {
  try {
    return (await fs.readFile(filename, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const template = defaultDailySummaryTemplate();
    await fs.writeFile(filename, `${template}\n`, 'utf8');
    console.warn(`未找到今日总结，已创建模板：${filename}`);
    return template.trim();
  }
}

function defaultDailySummaryTemplate() {
  return `## 今日总结

Day 01 集训总结

【今日学习目标】
（1）了解：
（2）掌握：
（3）掌握：

【今日重难点辨析】
（1）
（2）
（3）

【今日易错点】
（1）
（2）
（3）

【累计知识点数量】

【累计做题量】

【备注】
每位学员学习反馈卡会由班主任发放至各位家长微信，请注意查收，若有疑问可及时联系班主任。`;
}

function normalizeConfig(value) {
  const normalized = { ...value };
  normalized.homework = buildHomeworkConfig(value);
  normalized.contest = buildContestConfig(value);

  if (!normalized.homework && !normalized.contest) {
    fail('配置中没有可爬取目标。请在 config.json 中提供 homework、contest，或设置 targets。');
  }
  return normalized;
}

function buildHomeworkConfig(value) {
  const source = value.homework || {};
  const id = String(source.id || '');
  const currentTeamCode = String(source.teamCode || '');
  const groupId = source.groupId || '';
  if (!targetEnabled(value, 'homework', Boolean(id || currentTeamCode || source.enabled))) return null;
  if (!id || !currentTeamCode) fail('作业配置不完整：请提供 homework.id 和 homework.teamCode。');

  return {
    id,
    teamCode: currentTeamCode,
    groupId,
    questionUrl: buildHomeworkUrl({ homeworkId: id, teamCode: currentTeamCode, tab: 'question', groupId }),
    rankingUrl: buildHomeworkUrl({ homeworkId: id, teamCode: currentTeamCode, tab: 'ranking', groupId })
  };
}

function buildContestConfig(value) {
  const source = value.contest || {};
  const id = String(source.id || '');
  const matchRoundId = String(source.matchRoundId || id || '');
  const examId = String(source.examId || '');
  const openLevel = String(source.openLevel || '');
  const currentTeamCode = String(source.teamCode || '');
  if (!targetEnabled(value, 'contest', Boolean(id || currentTeamCode || source.enabled))) return null;
  if (!id || !currentTeamCode) fail('比赛配置不完整：请提供 contest.id 和 contest.teamCode。');

  const base = { contestId: id, matchRoundId, examId, openLevel, teamCode: currentTeamCode };
  return {
    id,
    matchRoundId,
    examId,
    openLevel,
    teamCode: currentTeamCode,
    questionUrl: buildContestUrl({ ...base, page: 'question' }),
    rankingUrl: buildContestUrl({ ...base, page: 'ranking' }),
    label: source.label || '今日比赛'
  };
}

function targetEnabled(value, target, hasConfig) {
  if (Array.isArray(value.targets)) return value.targets.includes(target);
  return hasConfig;
}

function buildHomeworkUrl({ homeworkId, teamCode, tab, groupId }) {
  const url = new URL(`https://www.acgo.cn/homework/${homeworkId}`);
  url.searchParams.set('teamCode', teamCode);
  if (groupId) url.searchParams.set('groupId', groupId);
  url.searchParams.set('tab', tab);
  return url.href;
}

function buildContestUrl({ page, contestId, matchRoundId, examId, openLevel, teamCode }) {
  const url = new URL(`https://www.acgo.cn/contest/${page}/${contestId}`);
  if (matchRoundId) url.searchParams.set('matchRoundId', matchRoundId);
  if (examId) url.searchParams.set('examId', examId);
  if (openLevel) url.searchParams.set('openLevel', openLevel);
  if (teamCode) url.searchParams.set('teamCode', teamCode);
  return url.href;
}

function extractContestId(url) {
  try {
    if (!url) return '';
    const parsed = new URL(url);
    return parsed.pathname.match(/\/contest\/(?:question|ranking|detail)\/(\d+)/)?.[1]
      || parsed.searchParams.get('matchRoundId')
      || parsed.searchParams.get('contestId')
      || '';
  } catch {
    return '';
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function cleanGeneratedOutput() {
  const targets = [
    studentsDirectory,
    promptsDirectory,
    rawDirectory,
    debugDirectory,
    path.join(rootDirectory, 'README.md'),
    path.join(rootDirectory, '今日总结.md'),
    path.join(rootDirectory, '作业题面.md'),
    path.join(rootDirectory, '作业题目.md'),
    path.join(rootDirectory, '比赛题目.md'),
    path.join(rootDirectory, '完成情况.md'),
    path.join(rootDirectory, '作业完成情况.md'),
    path.join(rootDirectory, '比赛排行榜.md'),
    path.join(rootDirectory, '课堂练习'),
    path.join(rootDirectory, '今日比赛')
  ];
  await Promise.all(targets.map(target => fs.rm(target, { recursive: true, force: true })));
}

async function gotoStable(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      break;
    } catch (error) {
      const retryable = /ERR_ABORTED|Navigation interrupted|frame was detached|Target closed/i.test(error.message || '');
      if (!retryable || attempt === 3) throw error;
      await page.waitForTimeout(1000 * attempt);
    }
  }
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(pageSettleDelayMs());
}

async function ensureLoggedIn(page) {
  const url = page.url();
  const body = await page.locator('body').innerText().catch(() => '');
  if (/login|signin/i.test(url) || (/登录/.test(body) && !/作业|题目|排行榜/.test(body))) {
    throw new Error('当前远程调试 Chrome 尚未登录 ACGO。请在该 Chrome 窗口登录后重新运行。');
  }
}

async function collectQuestionLinks(page, options = {}) {
  const links = await page.evaluate(() => {
    const origin = location.origin;
    const selectors = [
      'a[href*="/problem/"]', 'a[href*="/question/"]',
      'a[href*="/problemset/info/"]',
      'a[href*="problemId="]', 'a[href*="questionId="]'
    ];
    return [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))]
      .map(anchor => ({
        url: new URL(anchor.getAttribute('href'), origin).href,
        label: String(anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim()
      }))
      .filter(item => {
        const pathname = new URL(item.url).pathname;
        return !/homework\/\d+/i.test(pathname)
          && !/\/contest\/(?:question|ranking|detail)\//i.test(pathname);
      });
  });
  const unique = uniqueBy(links, item => item.url);
  if (!unique.length) {
    if (options.allowEmpty) return [];
    await saveDebugPage(page, '未识别到题目链接');
    throw new Error('没有识别到题目链接。请运行 npm run inspect，并检查 debug 目录。');
  }
  return unique;
}

async function inspectConfiguredPages(page, api, responseStore) {
  const report = {};
  if (config.homework) {
    console.log('诊断：读取作业题目入口…');
    await gotoStable(page, config.homework.questionUrl);
    await ensureLoggedIn(page);
    await saveDebugPage(page, 'inspect-作业题目入口');
    const questionLinks = await collectQuestionLinks(page).catch(error => ({ error: error.message }));

    console.log('诊断：读取作业排行榜入口…');
    await gotoStable(page, config.homework.rankingUrl);
    const ranking = await collectRankingFromApi(api, []);
    await saveDebugPage(page, 'inspect-作业排行榜入口');
    report.homework = {
      id: homeworkId,
      questionLinks,
      rankingRows: ranking.students.length,
      detailEntries: ranking.detailEntries.length
    };
  }

  if (contestConfig) {
    console.log('诊断：读取比赛题目入口…');
    await gotoStable(page, contestConfig.questionUrl);
    await ensureLoggedIn(page);
    const resolvedContest = await resolveContestConfigFromPage(page, contestConfig);
    await saveDebugPage(page, 'inspect-比赛题目入口');

    console.log('诊断：读取比赛排行榜入口…');
    const pageProps = await collectContestRankingPages(page, resolvedContest.rankingUrl);
    await saveDebugPage(page, 'inspect-比赛排行榜入口');
    report.contest = {
      id: resolvedContest.id,
      questionUrl: resolvedContest.questionUrl,
      rankingUrl: resolvedContest.rankingUrl,
      pagePropKeys: Object.keys(pageProps),
      rankingTotal: pageProps.listData?.total || 0,
      rankingRows: pageProps.listData?.list?.length || 0
    };
  }

  report.responseShapes = responseStore.shapes();
  await writeJson(path.join(debugDirectory, '诊断报告.json'), report);
  console.log(`诊断完成：${debugDirectory}`);
}

async function collectHomeworkDataset(page, api) {
  console.log('读取作业题目列表…');
  await gotoStable(page, config.homework.questionUrl);
  await ensureLoggedIn(page);
  await saveDebugPage(page, '01-作业题目入口');
  const questionLinks = await collectQuestionLinks(page);
  console.log(`识别到 ${questionLinks.length} 个题目链接。`);

  const problems = await collectProblems(page, questionLinks);
  await fs.writeFile(path.join(rootDirectory, '作业题目.md'), renderProblems(problems, homeworkId), 'utf8');

  console.log('读取作业排行榜及学生题目状态…');
  await gotoStable(page, config.homework.rankingUrl);
  const ranking = await collectRankingFromApi(api, problems);
  console.log('作业排行榜已通过 ACGO 接口读取。');
  console.log(`识别到 ${ranking.students.length} 名学生、${ranking.detailEntries.length} 个提交详情入口。`);
  await saveDebugPage(page, '03-作业排行榜解析后');
  await fs.writeFile(path.join(rootDirectory, '作业完成情况.md'), renderRanking(ranking, homeworkId), 'utf8');

  const students = new Map();
  for (const student of ranking.students) students.set(student.key, { ...student, submissions: [] });

  const homeworkSubmissionTasks = ranking.detailEntries;
  await mapWithConcurrency(homeworkSubmissionTasks, submissionApiConcurrency(), async (entry, index) => {
    console.log(`读取作业提交 ${index + 1}/${ranking.detailEntries.length}：${entry.username} / ${entry.questionTitle}`);
    let submissions = [];
    try {
      submissions = await collectSubmissionAttemptsFromApi(api, entry);
    } catch (error) {
      console.warn(`  作业提交接口读取失败：${error.message}`);
    }
    if (!submissions.length) {
      await saveDebugPage(page, `未读取到提交-${entry.username}-${entry.questionTitle}`);
    }
    const student = students.get(entry.studentKey) || {
      key: entry.studentKey,
      username: entry.username,
      userId: entry.userId,
      cells: {},
      submissions: []
    };
    student.submissions.push(...submissions.map(submission => ({
      ...submission,
      questionTitle: submission.questionTitle || entry.questionTitle,
      questionKey: entry.questionKey
    })));
    students.set(entry.studentKey, student);
    await delay(requestDelayMs());
  });

  for (const student of students.values()) {
    student.submissions = dedupeSubmissions(student.submissions);
    student.problemResults = buildHomeworkProblemResults(student, ranking.headers, problems, ranking.detailEntries);
    student.summary = {
      rank: student.cells?.名次 || '',
      totalScore: student.cells?.总分 || '',
      totalSubmitCount: student.submissions.length
    };
  }

  return {
    kind: 'classroom',
    label: '课堂练习',
    id: homeworkId,
    title: `ACGO 作业 ${homeworkId}`,
    url: config.homework.questionUrl,
    problems: normalizeProblemsForFeedback(problems),
    ranking,
    students: [...students.values()]
  };
}

async function collectProblems(page, questionLinks, options = {}) {
  const questionDataHomeworkId = options.homeworkId ?? homeworkId;
  const questionDataTeamCode = options.teamCode ?? teamCode;
  const stepLabel = options.stepLabel || '题面';
  const buildId = await page.evaluate(() => {
    try {
      return JSON.parse(document.querySelector('#__NEXT_DATA__')?.textContent || '{}').buildId || '';
    } catch {
      return '';
    }
  });
  if (!buildId) {
    console.warn('未识别到 Next.js buildId，题面将回退到逐页抓取。');
    return collectProblemsFromPages(page, questionLinks);
  }

  const requests = questionLinks.map((item, index) => ({
    index,
    item,
    questionId: extractQuestionId(item.url),
    dataUrl: buildQuestionDataUrl({
      buildId,
      questionId: extractQuestionId(item.url),
      homeworkId: questionDataHomeworkId,
      teamCode: questionDataTeamCode
    })
  }));
  console.log(`通过 Next Data 并发读取 ${requests.length} 道${stepLabel}…`);

  const fetched = await page.evaluate(async ({ requests, concurrency }) => {
    const results = new Array(requests.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const current = cursor++;
        if (current >= requests.length) return;
        const request = requests[current];
        try {
          const response = await fetch(request.dataUrl, { credentials: 'include' });
          const text = await response.text();
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            throw new Error(`HTTP ${response.status}，返回内容不是 JSON`);
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (!json?.pageProps?.questionInfo) {
            const redirect = json?.pageProps?.__N_REDIRECT;
            throw new Error(redirect ? `被重定向到 ${redirect}` : '响应中缺少 questionInfo');
          }
          results[current] = { ok: true, json };
        } catch (error) {
          results[current] = { ok: false, error: error.message || String(error) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, requests.length)) }, worker));
    return results;
  }, {
    requests: requests.map(request => ({ dataUrl: request.dataUrl })),
    concurrency: positiveInteger(config.questionApiConcurrency, 4)
  });

  const problems = new Array(questionLinks.length);
  const failed = [];
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    const result = fetched[index];
    if (result?.ok) {
      problems[index] = { ...request.item, ...problemFromNextData(result.json, request.item.url) };
      continue;
    }
    failed.push({ ...request, error: result?.error || '未知错误' });
  }

  if (!failed.length) {
    console.log(`题面接口读取完成：${problems.length}/${problems.length}。`);
    return problems;
  }

  console.warn(`${failed.length} 道题的 Next Data 获取失败，将仅对这些题回退到页面抓取。`);
  for (const failure of failed) {
    console.warn(`  T${failure.index + 1}：${failure.error}`);
    await gotoStable(page, failure.item.url);
    const problem = await extractProblem(page);
    problems[failure.index] = { ...failure.item, ...problem };
    await delay(requestDelayMs());
  }
  return problems;
}

async function collectProblemsFromPages(page, questionLinks) {
  const problems = [];
  for (let index = 0; index < questionLinks.length; index++) {
    const item = questionLinks[index];
    console.log(`2/4 读取题面 ${index + 1}/${questionLinks.length}：${item.label || item.url}`);
    await gotoStable(page, item.url);
    const problem = await extractProblem(page);
    problems.push({ ...item, ...problem });
    await delay(requestDelayMs());
  }
  return problems;
}

async function collectRankingFromApi(api, problems) {
  if (!teamCode) throw new Error('作业配置缺少 teamCode');
  const endpoint = `/acgoPms/api/team/${teamCode}/homework/ranking/${homeworkId}`;
  const pageSize = 100;
  const commonParams = {
    groupId: config.homework.groupId || '-1',
    homeworkId: String(homeworkId),
    teamCode
  };

  const firstPage = await api.get(endpoint, { ...commonParams, page: '1', pageSize: String(pageSize) });
  const records = [...(firstPage?.records || [])];
  const pages = Number(firstPage?.pages || Math.ceil(Number(firstPage?.total || records.length) / pageSize) || 1);
  for (let pageNumber = 2; pageNumber <= pages; pageNumber++) {
    const nextPage = await api.get(endpoint, { ...commonParams, page: String(pageNumber), pageSize: String(pageSize) });
    records.push(...(nextPage?.records || []));
  }

  const scoreList = await api.get(`/acgoPms/api/team/${teamCode}/homework/getQuestionScore/${homeworkId}`);
  const scoreByQuestionId = new Map((scoreList || []).map(item => [String(item.questionId), Number(item.score)]));
  const problemByQuestionId = new Map();
  for (let index = 0; index < problems.length; index++) {
    const problem = problems[index];
    const questionId = extractQuestionId(problem.url);
    if (!questionId) continue;
    const rawTitle = problem.title || problem.label || `T${index + 1}`;
    const title = rawTitle.replace(/^[A-Za-z]{1,10}\d+\s*[.．]\s*/, '').trim() || rawTitle;
    problemByQuestionId.set(String(questionId), {
      questionId: String(questionId),
      index: index + 1,
      title,
      fullScore: scoreByQuestionId.get(String(questionId)) ?? 100
    });
  }

  const questionOrder = problems.map((problem, index) => {
    const questionId = extractQuestionId(problem.url);
    return problemByQuestionId.get(String(questionId)) || {
      questionId: String(questionId || ''),
      index: index + 1,
      title: `T${index + 1}`,
      fullScore: 100
    };
  });
  const headers = ['名次', '用户名', '总分', ...questionOrder.map(question => `T${question.index}：${question.title}`)];
  const students = [];
  const detailEntries = [];

  for (const record of records) {
    const userId = String(record.userInfo?.userId || '');
    const username = cleanName(record.userInfo?.teamVo?.teamUserName || record.userInfo?.nickName || `用户${userId}`);
    const key = `${userId}:${username}`;
    const answerByQuestionId = new Map((record.homeworkAnswerList || []).map(answer => [String(answer.questionId), answer]));
    const cells = {
      名次: String(record.order ?? ''),
      用户名: username,
      总分: formatScoreAndTime(record.totalScore, record.totalCpuTimeStr)
    };

    for (const question of questionOrder) {
      const header = `T${question.index}：${question.title}`;
      const answer = answerByQuestionId.get(question.questionId);
      cells[header] = answer && answer.score !== null && answer.score !== undefined
        ? formatScoreAndTime(answer.score, answer.cpuTimeStr)
        : '';
      if (!answer?.questionId || answer.score === null || answer.score === undefined) continue;
      detailEntries.push({
        studentKey: key,
        username,
        userId,
        questionId: String(answer.questionId),
        questionIndex: question.index,
        questionTitle: formatProblemHeading(question.index, question.title),
        questionKey: String(answer.questionId),
        fullScore: question.fullScore,
        rankingScore: Number(answer.score),
        rankingRecordId: answer.recordId
      });
    }
    students.push({ key, username, userId, cells });
  }

  return { headers, students, detailEntries };
}

async function collectSubmissionAttemptsFromApi(api, entry) {
  const listEndpoint = `/acgoPms/api/team/${teamCode}/homework/questionAnswerRecord/list`;
  const viewEndpoint = `/acgoPms/api/team/${teamCode}/homework/questionAnswerRecord/view`;
  const records = await api.post(listEndpoint, {
    questionId: Number(entry.questionId),
    homeworkId: Number(homeworkId),
    userId: Number(entry.userId),
    teamCode
  });
  const sortedRecords = [...(records || [])].sort((left, right) => {
    const timeDifference = Number(left.createdAt || 0) - Number(right.createdAt || 0);
    return timeDifference || Number(left.id || 0) - Number(right.id || 0);
  });
  const attemptById = new Map(sortedRecords.map((record, index) => [String(record.id), index + 1]));
  const submissions = await mapWithConcurrency(sortedRecords, submissionDetailConcurrency(), async record => {
    const detail = await api.post(viewEndpoint, {
      teamCode,
      id: Number(record.id),
      homeworkId: Number(homeworkId)
    });
    const code = Array.isArray(detail?.answer) ? String(detail.answer[0] || '') : String(detail?.answer || '');
    if (!code) return null;
    return {
      submissionId: String(record.id),
      questionTitle: entry.questionTitle,
      attempt: String(attemptById.get(String(record.id)) || ''),
      status: submissionResult(detail, record),
      language: languageName(detail?.language ?? record.language),
      time: detail?.maxCpuTime === null || detail?.maxCpuTime === undefined ? '' : `${detail.maxCpuTime} ms`,
      memory: formatMemory(detail?.maxUsedMemory),
      submittedAt: formatSubmissionTime(detail?.createdAt ?? record.createdAt),
      code: code.replace(/\r\n/g, '\n')
    };
  });
  return sortSubmissionsByAttempt(submissions.filter(Boolean));
}

async function collectContestDataset(page, api, contest) {
  let runtimeContest = { ...contest };

  console.log('读取今日比赛题目列表…');
  await gotoStable(page, runtimeContest.questionUrl);
  await ensureLoggedIn(page);
  runtimeContest = await resolveContestConfigFromPage(page, runtimeContest);
  const contestTeamCode = new URL(runtimeContest.questionUrl).searchParams.get('teamCode') || runtimeContest.teamCode || teamCode;
  const id = extractContestId(runtimeContest.questionUrl) || runtimeContest.id;
  await saveDebugPage(page, '04-比赛题目入口');

  let questionList = [];
  try {
    questionList = await collectContestQuestionListFromApi(api, runtimeContest.rankingUrl);
    console.log('比赛题目列表已通过 ACGO 接口读取。');
  } catch (error) {
    console.warn(`比赛题目接口读取失败，将先尝试页面数据：${error.message}`);
  }

  const questionPageProps = await readNextPageProps(page);
  const questionLinks = await collectContestQuestionLinks(page, {
    questionList,
    pageProps: questionPageProps,
    contestTeamCode
  });
  console.log(`识别到 ${questionLinks.length} 个比赛题目链接。`);
  const rawProblems = await collectProblems(page, questionLinks, {
    homeworkId: '',
    teamCode: contestTeamCode,
    stepLabel: '比赛题面'
  });

  console.log('读取今日比赛排行榜…');
  const pageProps = await collectContestRankingPages(page, runtimeContest.rankingUrl);
  await saveDebugPage(page, '05-比赛排行榜解析后');

  const contestDataset = buildContestDataset({
    id,
    questionUrl: runtimeContest.questionUrl,
    rankingUrl: runtimeContest.rankingUrl,
    rawProblems,
    pageProps,
    questionList
  });

  if (contestDataset.ranking.total && contestDataset.ranking.total > contestDataset.students.length) {
    console.warn(`比赛排行榜页面只包含 ${contestDataset.students.length}/${contestDataset.ranking.total} 名学生；如有分页，请后续补充比赛排行榜接口或页面分页采集。`);
  }

  await collectContestSubmissions(api, contestDataset, contestTeamCode, runtimeContest.rankingUrl);
  await fs.writeFile(path.join(rootDirectory, '比赛题目.md'), renderContestProblems(contestDataset), 'utf8');
  await fs.writeFile(path.join(rootDirectory, '比赛排行榜.md'), renderContestRanking(contestDataset), 'utf8');
  return contestDataset;
}

async function collectContestRankingPages(page, rankingUrl) {
  const firstUrl = contestRankingPageUrl(rankingUrl, 1);
  await gotoStable(page, firstUrl);
  const firstProps = await readNextPageProps(page);
  const firstListData = firstProps.listData || {};
  const firstRecords = Array.isArray(firstListData.list) ? firstListData.list : [];
  const total = Number(firstListData.total || firstRecords.length || 0);
  const pageSize = contestRankingPageSize(rankingUrl, firstListData, firstRecords);
  const pageCount = Math.max(1, Math.ceil((total || firstRecords.length || pageSize) / pageSize));
  const maxPages = Math.max(1, Number(config.maxRankingPages || 100));
  const records = [...firstRecords];

  for (let pageNumber = 2; pageNumber <= Math.min(pageCount, maxPages); pageNumber++) {
    const pageUrl = contestRankingPageUrl(rankingUrl, pageNumber);
    await gotoStable(page, pageUrl);
    const pageProps = await readNextPageProps(page);
    const pageRecords = Array.isArray(pageProps.listData?.list) ? pageProps.listData.list : [];
    if (!pageRecords.length) break;
    records.push(...pageRecords);
    await delay(requestDelayMs());
  }

  const uniqueRecords = uniqueBy(records, contestRankingRecordKey);
  if (total && uniqueRecords.length < total) {
    console.warn(`比赛排行榜已读取 ${uniqueRecords.length}/${total} 名学生；请检查 maxRankingPages 或页面访问权限。`);
  } else if (pageCount > 1) {
    console.log(`比赛排行榜分页读取完成：${uniqueRecords.length}/${total || uniqueRecords.length} 名学生，${Math.min(pageCount, maxPages)} 页。`);
  }

  return {
    ...firstProps,
    listData: {
      ...firstListData,
      list: uniqueRecords,
      total: total || uniqueRecords.length
    }
  };
}

function contestRankingPageUrl(rankingUrl, pageNumber) {
  const url = new URL(rankingUrl);
  url.searchParams.set('page', String(pageNumber));
  return url.href;
}

function contestRankingPageSize(rankingUrl, listData, records) {
  const urlPageSize = Number(new URL(rankingUrl).searchParams.get('pageSize'));
  const configuredPageSize = Number(config.contestRankingPageSize || config.rankingPageSize || 0);
  const total = Number(listData.total || 0);
  return urlPageSize
    || Number(listData.pageSize || listData.size || 0)
    || configuredPageSize
    || (total > records.length && records.length < 20 ? 20 : Math.max(1, records.length || 20));
}

function contestRankingRecordKey(record) {
  return String(record?.userId || `${record?.rankOrder || record?.realRankOrder || ''}:${record?.nickName || ''}`);
}

async function collectContestQuestionLinks(page, { questionList, pageProps, contestTeamCode }) {
  const apiLinks = buildContestQuestionLinksFromList(questionList, contestTeamCode);
  if (apiLinks.length) return apiLinks;

  const nextLinks = buildContestQuestionLinksFromList(pageProps?.questionList, contestTeamCode);
  if (nextLinks.length) {
    console.log('比赛题面链接已通过页面数据生成。');
    return nextLinks;
  }

  const domLinks = await collectQuestionLinks(page, { allowEmpty: true });
  if (domLinks.length) return domLinks;

  await saveDebugPage(page, '未识别到比赛题目链接');
  throw new Error('没有识别到比赛题目链接，也没有从比赛题目接口中拿到 acgoQuestionId。请运行 npm run inspect，并检查 debug 目录。');
}

function buildContestQuestionLinksFromList(questionList, contestTeamCode) {
  if (!Array.isArray(questionList)) return [];
  const links = questionList.map((question, index) => {
    const questionId = contestProblemQuestionId(question);
    if (!questionId) return null;
    return {
      url: buildProblemUrl(questionId, contestTeamCode),
      label: question.questionTitle || question.title || question.name || `T${index + 1}`
    };
  }).filter(Boolean);
  return uniqueBy(links, item => item.url);
}

function contestProblemQuestionId(question) {
  return String(
    question?.acgoQuestionId
      || question?.acgoQuestion?.questionId
      || question?.questionInfo?.questionId
      || question?.problemId
      || ''
  );
}

async function resolveContestConfigFromPage(page, contest) {
  const resolved = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')].map(anchor => anchor.href);
    const questionUrl = links.find(href => /\/contest\/question\//.test(href) && /examId=/.test(href)) || '';
    const rankingUrl = links.find(href => /\/contest\/ranking\//.test(href) && /examId=/.test(href)) || '';
    let examId = '';
    try {
      const props = JSON.parse(document.querySelector('#__NEXT_DATA__')?.textContent || '{}')?.props?.pageProps || {};
      examId = String(props.contestInfo?.matchRounds?.programExamId || props.contestInfo?.matchRounds?.paperId || '');
    } catch {}
    return { questionUrl, rankingUrl, examId };
  });

  let questionUrl = resolved.questionUrl || contest.questionUrl;
  let rankingUrl = resolved.rankingUrl || contest.rankingUrl;
  if (!new URL(rankingUrl).searchParams.get('examId') && resolved.examId) {
    const question = new URL(questionUrl);
    const ranking = new URL(rankingUrl);
    question.searchParams.set('examId', resolved.examId);
    ranking.searchParams.set('examId', resolved.examId);
    questionUrl = question.href;
    rankingUrl = ranking.href;
  }

  return {
    ...contest,
    questionUrl,
    rankingUrl,
    examId: new URL(rankingUrl).searchParams.get('examId') || contest.examId || ''
  };
}

async function readNextPageProps(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(document.querySelector('#__NEXT_DATA__')?.textContent || '{}')?.props?.pageProps || {};
    } catch {
      return {};
    }
  });
}

async function collectContestQuestionListFromApi(api, rankingUrl) {
  const url = new URL(rankingUrl);
  const examId = Number(url.searchParams.get('examId'));
  const matchRoundId = Number(url.searchParams.get('matchRoundId') || extractContestId(rankingUrl));
  if (!examId || !matchRoundId) throw new Error('比赛链接缺少 examId 或 matchRoundId');
  return api.post('/acgoMatch/leaderboard/questionList', { examId, matchRoundId });
}

async function collectContestSubmissions(api, dataset, contestTeamCode, rankingUrl) {
  const examId = new URL(rankingUrl).searchParams.get('examId') || '';
  if (!examId) {
    console.warn('比赛链接缺少 examId，无法读取比赛提交代码。');
    return;
  }

  const tasks = dataset.students.flatMap(student => {
    student.submissions = [];
    return student.problemResults
      .filter(result => Number(result.submitCount) > 0)
      .map(result => ({ student, result }));
  });
  let cursor = 0;

  await mapWithConcurrency(tasks, submissionApiConcurrency(), async ({ student, result }) => {
    const current = ++cursor;
    console.log(`读取比赛提交 ${current}/${tasks.length}：${student.username} / T${result.index} ${result.title}`);
    try {
      const submissions = await collectContestSubmissionAttemptsFromApi(api, {
        teamCode: contestTeamCode,
        examId,
        userId: student.userId,
        questionId: result.questionId,
        questionKey: result.questionKey,
        questionTitle: `第${result.index}题：${result.title}`
      });
      result.submissions = submissions;
      student.submissions.push(...submissions);
    } catch (error) {
      console.warn(`  比赛提交读取失败：${error.message}`);
      result.submissions = [];
    }
    await delay(requestDelayMs());
  });

  for (const student of dataset.students) {
    student.submissions = sortSubmissionsByAttempt(dedupeSubmissions(student.submissions));
    student.summary.totalSubmitCount = student.submissions.length;
  }
}

async function collectContestSubmissionAttemptsFromApi(api, entry) {
  const listEndpoint = `/acgoMatch/api/team/${entry.teamCode}/questionAnswerRecord/list`;
  const viewEndpoint = `/acgoMatch/api/team/${entry.teamCode}/questionAnswerRecord/matchView`;
  const records = await api.post(listEndpoint, {
    teamCode: entry.teamCode,
    examId: String(entry.examId),
    questionId: String(entry.questionId),
    userId: String(entry.userId)
  });
  const sortedRecords = [...(records || [])].sort((left, right) => {
    const timeDifference = Number(left.createdAt || 0) - Number(right.createdAt || 0);
    return timeDifference || Number(left.id || 0) - Number(right.id || 0);
  });
  const attemptById = new Map(sortedRecords.map((record, index) => [String(record.id), index + 1]));
  const submissions = await mapWithConcurrency(sortedRecords, submissionDetailConcurrency(), async record => {
    const detail = await api.post(viewEndpoint, {
      teamCode: entry.teamCode,
      id: String(record.id)
    });
    const code = Array.isArray(detail?.answer) ? String(detail.answer[0] || '') : String(detail?.answer || record.answer?.[0] || '');
    if (!code) return null;
    return {
      submissionId: String(record.id),
      questionTitle: entry.questionTitle,
      questionKey: entry.questionKey,
      attempt: String(attemptById.get(String(record.id)) || ''),
      status: submissionResult(detail, record),
      language: languageName(detail?.language ?? record.language),
      time: detail?.maxCpuTime === null || detail?.maxCpuTime === undefined ? '' : `${detail.maxCpuTime} ms`,
      memory: formatMemory(detail?.maxUsedMemory),
      submittedAt: formatSubmissionTime(detail?.createdAt ?? record.createdAt),
      score: detail?.score ?? record.score ?? '',
      scoringRate: detail?.scoringRate || record.scoringRate || '',
      code: code.replace(/\r\n/g, '\n')
    };
  });
  return sortSubmissionsByAttempt(dedupeSubmissions(submissions.filter(Boolean)));
}

function buildContestDataset({ id, questionUrl, rankingUrl, rawProblems, pageProps, questionList }) {
  const contestInfo = pageProps.contestInfo || {};
  const apiQuestions = Array.isArray(questionList) ? questionList : [];
  const nextQuestions = Array.isArray(pageProps.questionList) ? pageProps.questionList : [];
  const orderSource = apiQuestions.length ? apiQuestions : nextQuestions;
  const rawProblemByAcgoId = new Map(rawProblems.map((problem, index) => [
    String(problem.questionId || extractQuestionId(problem.url) || index + 1),
    problem
  ]));

  const problems = orderSource.map((question, index) => {
    const acgoQuestionId = question.acgoQuestionId || extractQuestionId(rawProblems[index]?.url || '') || question.questionId;
    const rawProblem = rawProblemByAcgoId.get(String(acgoQuestionId)) || rawProblems[index] || {};
    const title = question.questionTitle || stripProblemCode(rawProblem.title || rawProblem.label || `T${index + 1}`);
    return {
      ...rawProblem,
      index: index + 1,
      questionKey: String(question.questionId || acgoQuestionId || index + 1),
      questionId: String(question.questionId || acgoQuestionId || ''),
      acgoQuestionId: String(acgoQuestionId || ''),
      title,
      fullScore: Number(question.score ?? rawProblem.fullScore ?? 100) || 100,
      score: Number(question.score ?? rawProblem.score ?? 100) || 100,
      url: rawProblem.url || buildProblemUrl(acgoQuestionId, new URL(questionUrl).searchParams.get('teamCode') || teamCode)
    };
  });

  const headers = [
    '名次',
    '参赛者',
    '总分',
    '总用时',
    ...problems.map(problem => `T${problem.index}：${problem.title}`)
  ];
  const records = Array.isArray(pageProps.listData?.list) ? pageProps.listData.list : [];
  const students = records.map((record, rowIndex) => {
    const username = cleanName(record.nickName || `用户${record.userId || rowIndex + 1}`);
    const userId = String(record.userId || '');
    const key = `${userId}:${username}`;
    const answerByQuestionId = new Map((record.rank || []).map(answer => [String(answer.questionId), answer]));
    const cells = {
      名次: String(record.rankOrder ?? record.realRankOrder ?? ''),
      参赛者: username,
      总分: formatContestScore(record.score, contestTotalScore(problems), record.penalty),
      总用时: formatDuration(record.penalty)
    };
    const problemResults = problems.map(problem => {
      const answer = answerByQuestionId.get(String(problem.questionId));
      const score = answer ? Number(answer.score ?? 0) : 0;
      const status = answer
        ? (answer.isAc ? '通过' : (score > 0 ? '部分得分' : '未通过'))
        : '未提交';
      const solvedAt = answer?.penalty ? formatDuration(answer.penalty) : '';
      const submitCount = answer?.submitNum ?? 0;
      const header = `T${problem.index}：${problem.title}`;
      cells[header] = answer
        ? `${score}/${problem.fullScore}${solvedAt ? `（${solvedAt}）` : ''}${submitCount ? `，提交${submitCount}次` : ''}`
        : '';
      return {
        index: problem.index,
        questionKey: problem.questionKey,
        questionId: problem.questionId,
        acgoQuestionId: problem.acgoQuestionId,
        title: problem.title,
        score,
        fullScore: problem.fullScore,
        status,
        submitCount,
        solvedAt,
        time: answer?.cpuTime || answer?.cpuTime === 0 ? `${answer.cpuTime} ms` : '',
        knowledgeList: problem.knowledgeList || []
      };
    });
    return {
      key,
      username,
      userId,
      cells,
      problemResults,
      submissions: [],
      summary: {
        rank: cells.名次,
        totalScore: formatContestScore(record.score, contestTotalScore(problems), record.penalty),
        rawScore: record.score ?? '',
        fullScore: contestTotalScore(problems),
        penalty: formatDuration(record.penalty),
        totalSubmitCount: record.submitNum ?? '',
        totalCpuTime: record.totalCpuTime ?? ''
      }
    };
  });

  return {
    kind: 'contest',
    label: '今日比赛',
    id,
    title: contestInfo.title || `ACGO 比赛 ${id}`,
    url: rankingUrl,
    questionUrl,
    rankingUrl,
    contestInfo: {
      title: contestInfo.title || '',
      examModel: contestInfo.examModel || '',
      contestTimeStr: contestInfo.contestTimeStr || '',
      durationStr: contestInfo.durationStr || '',
      applyNumb: contestInfo.applyNumb || ''
    },
    problems: normalizeProblemsForFeedback(problems),
    ranking: {
      headers,
      total: Number(pageProps.listData?.total || students.length),
      students
    },
    students
  };
}

function contestTotalScore(problems) {
  return problems.reduce((sum, problem) => sum + (Number(problem.fullScore) || 0), 0);
}

function formatContestScore(score, fullScore, penalty) {
  const scoreText = fullScore ? `${score ?? 0}/${fullScore}` : String(score ?? '');
  const penaltyText = formatDuration(penalty);
  return penaltyText ? `${scoreText}（${penaltyText}）` : scoreText;
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainingSeconds = Math.floor(value % 60);
  return [hours, minutes, remainingSeconds].map(part => String(part).padStart(2, '0')).join(':');
}

function buildProblemUrl(questionId, currentTeamCode) {
  if (!questionId) return '';
  const url = new URL(`https://www.acgo.cn/problemset/info/${questionId}`);
  if (currentTeamCode) url.searchParams.set('teamCode', currentTeamCode);
  return url.href;
}

function extractQuestionId(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.match(/\/(\d+)(?:\/)?$/)?.[1]
      || parsed.searchParams.get('questionId')
      || parsed.searchParams.get('problemId')
      || '';
  } catch {
    return '';
  }
}

function formatScoreAndTime(score, time) {
  if (score === null || score === undefined || score === '') return '';
  return time ? `${score}（${time}）` : String(score);
}

function languageName(value) {
  if (Number(value) === 2) return 'C++';
  if (Number(value) === 4) return 'Python';
  return value === null || value === undefined ? '' : String(value);
}

function submissionResult(detail, record) {
  if (Number(record?.status ?? detail?.status) === 1) return 'AC';
  if (detail?.compileError) return 'CE（编译错误）';
  const results = flatten(detail?.list || [])
    .map(item => item?.result || item?.resultDesc)
    .filter(Boolean);
  return [...new Set(results)].join('、') || '未通过';
}

function formatMemory(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${trimNumber(value / 1024)} KB`;
  return `${trimNumber(value / 1024 / 1024)} MB`;
}

function trimNumber(value) {
  return Number(value.toFixed(2)).toString();
}

function formatSubmissionTime(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const milliseconds = Number(value) < 1e12 ? Number(value) * 1000 : Number(value);
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function flatten(items) {
  return (items || []).flatMap(item => Array.isArray(item) ? flatten(item) : [item]);
}

function sortSubmissionsByAttempt(items) {
  return [...(items || [])].sort((left, right) => {
    const attemptDifference = submissionAttemptNumber(left.attempt) - submissionAttemptNumber(right.attempt);
    if (attemptDifference) return attemptDifference;
    const leftTime = Date.parse(left.submittedAt || '') || 0;
    const rightTime = Date.parse(right.submittedAt || '') || 0;
    return leftTime - rightTime;
  });
}

function submissionAttemptNumber(value) {
  const match = String(value || '').match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function createResponseStore(page) {
  const records = [];
  const handler = async response => {
    const contentType = response.headers()['content-type'] || '';
    if (!/json/i.test(contentType)) return;
    if (!/acgo\.cn/i.test(response.url())) return;
    try {
      const json = await response.json();
      records.push({ url: response.url(), status: response.status(), json });
    } catch {}
  };
  page.on('response', handler);
  return {
    count: () => records.length,
    since: index => records.slice(index),
    shapes: () => records.map(record => ({
      url: redactUrl(record.url),
      status: record.status,
      shape: jsonShape(record.json)
    })),
    dispose: () => page.off('response', handler)
  };
}

function createRequestStore(scope) {
  let apiHeaders = {};
  const handler = request => {
    if (!/gateway\.acgo\.cn/i.test(request.url())) return;
    request.allHeaders().then(headers => {
      const allowed = {};
      for (const [name, value] of Object.entries(headers)) {
        if (/^(access-token|authorization|x-access-token|app-id|appid|client-type|platform|x-[a-z0-9-]+)$/i.test(name)) {
          allowed[name] = value;
        }
      }
      if (Object.keys(allowed).length) apiHeaders = { ...apiHeaders, ...allowed };
    }).catch(() => {});
  };
  scope.on('request', handler);
  return {
    headers: () => ({ ...apiHeaders }),
    dispose: () => scope.off('request', handler)
  };
}

function createAcgoApi(context, requestStore) {
  const baseUrl = 'https://gateway.acgo.cn';
  const call = async (method, endpoint, payload) => {
    const headers = requestStore.headers();
    if (!Object.keys(headers).some(name => /token|authorization/i.test(name))) {
      throw new Error('没有从已登录浏览器请求中捕获到访问令牌，请刷新 ACGO 页面后重试');
    }
    const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;
    const options = { headers };
    if (method === 'GET' && payload) options.params = payload;
    if (method === 'POST') options.data = payload || {};
    const maxAttempts = Math.max(1, Number(config.apiRetryCount || 3));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = method === 'GET'
          ? await context.request.get(url, options)
          : await context.request.post(url, options);
        const text = await response.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(`${method} ${endpoint} 返回的不是 JSON（HTTP ${response.status()}）`);
        }
        if (!response.ok() || Number(body?.code) !== 200) {
          const message = `${method} ${endpoint} 失败：HTTP ${response.status()}，${body?.message || '未知错误'}`;
          if (attempt < maxAttempts && isRetryableApiError(message, response.status())) {
            await delay(500 * attempt);
            continue;
          }
          throw new Error(message);
        }
        return body.data;
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableApiError(error.message)) throw error;
        await delay(500 * attempt);
      }
    }
  };
  return {
    get: (endpoint, params) => call('GET', endpoint, params),
    post: (endpoint, data) => call('POST', endpoint, data)
  };
}

function isRetryableApiError(message, status = 0) {
  return Number(status) >= 500
    || /socket hang up|ECONNRESET|ETIMEDOUT|Timeout|network|fetch failed|ECONNREFUSED|EAI_AGAIN/i.test(String(message || ''));
}

function jsonShape(value, depth = 0) {
  if (depth > 4) return '…';
  if (Array.isArray(value)) return value.length ? [`Array(${value.length})`, jsonShape(value[0], depth + 1)] : ['Array(0)'];
  if (!value || typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, child]) => [key, jsonShape(child, depth + 1)]));
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|cookie|auth|session|ticket/i.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.href;
  } catch {
    return value;
  }
}

async function saveDebugPage(page, name) {
  if (!config.saveDebugFiles && !args.inspectOnly) return;
  const basename = safeFilename(name);
  await fs.writeFile(path.join(debugDirectory, `${basename}.html`), await page.content(), 'utf8');
  await page.screenshot({ path: path.join(debugDirectory, `${basename}.png`), fullPage: true }).catch(() => {});
}

async function writeCodeEvidenceFiles({ classroomDataset, contestDataset, dailySummaryMarkdown }) {
  await fs.writeFile(path.join(rootDirectory, 'README.md'), renderCodeEvidenceReadme({ classroomDataset, contestDataset, dailySummaryMarkdown }), 'utf8');
  await fs.writeFile(path.join(rootDirectory, '今日总结.md'), `${dailySummaryMarkdown.trim()}\n`, 'utf8');
  await fs.mkdir(promptsDirectory, { recursive: true });
  await fs.writeFile(path.join(promptsDirectory, '家长反馈生成提示词.md'), renderFeedbackPrompt({ dailySummaryMarkdown }), 'utf8');
  await fs.writeFile(path.join(promptsDirectory, '批量处理说明.md'), renderBatchInstructions({ hasDailySummary: Boolean(dailySummaryMarkdown?.trim()) }), 'utf8');

  const studentDirectories = new Map();
  const directoryFor = async student => {
    const key = student.userId ? `id:${student.userId}` : `name:${student.username}`;
    if (!studentDirectories.has(key)) {
      const directory = path.join(studentsDirectory, `${safeFilename(student.username || '未知学生')}-${safeFilename(student.userId || student.key)}`);
      await fs.mkdir(directory, { recursive: true });
      studentDirectories.set(key, directory);
    }
    return studentDirectories.get(key);
  };

  for (const student of classroomDataset?.students || []) {
    const directory = await directoryFor(student);
    await fs.writeFile(path.join(directory, '课堂练习.md'), renderStudent(student, classroomDataset), 'utf8');
  }

  for (const student of contestDataset?.students || []) {
    const directory = await directoryFor(student);
    await fs.writeFile(path.join(directory, '今日比赛.md'), renderContestStudent(student, contestDataset), 'utf8');
  }
}

function renderCodeEvidenceReadme({ classroomDataset, contestDataset, dailySummaryMarkdown }) {
  const chunks = [
    '# ACGO 代码证据包',
    '',
    '这个文件夹用于提交给 AI 生成学生当日反馈。每位学生按课堂练习和今日比赛分别整理 Markdown，包含每道题的完成情况以及每次提交的完整代码。',
    '',
    '## 文件结构',
    '',
    '- `作业题目.md`：课堂练习题面汇总。',
    '- `比赛题目.md`：今日比赛题面汇总。',
    '- `今日总结.md`：老师手动填写的当日学习目标、重难点和易错点。',
    '- `students/学生名-用户ID/课堂练习.md`：该学生课堂练习每题每次提交代码。',
    '- `students/学生名-用户ID/今日比赛.md`：该学生比赛每题每次提交代码。',
    '- `prompts/家长反馈生成提示词.md`：生成家长反馈时建议使用的提示词。',
    '- `prompts/批量处理说明.md`：批量处理多个学生时的操作说明。',
    '- `raw/summary.json`：结构化原始数据。',
    ''
  ];
  chunks.push('## 本次数据', '');
  if (dailySummaryMarkdown?.trim()) {
    const title = dailySummaryMarkdown.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#')) || '已填写';
    chunks.push(`- 今日总结：${title.replace(/^#+\s*/, '')}`);
  }
  if (classroomDataset) {
    chunks.push(`- 课堂练习：${classroomDataset.title || `作业 ${classroomDataset.id}`}，${classroomDataset.problems.length} 题，${classroomDataset.students.length} 名学生。`);
  }
  if (contestDataset) {
    chunks.push(`- 今日比赛：${contestDataset.title || `比赛 ${contestDataset.id}`}，${contestDataset.problems.length} 题，${contestDataset.students.length} 名学生。`);
  }
  chunks.push('', '## 给 AI 的建议', '');
  chunks.push('请先使用 `prompts/家长反馈生成提示词.md`，再让 AI 读取某个学生文件夹下的 `课堂练习.md` 和 `今日比赛.md`。反馈应依据每题得分、提交次数、通过时间和完整代码，说明今日掌握情况、薄弱点和后续练习建议。');
  return `${chunks.join('\n')}\n`;
}

function normalizeProblemsForFeedback(problems) {
  return (problems || []).map((problem, index) => ({
    ...problem,
    index: problem.index || index + 1,
    questionKey: String(problem.questionKey || problem.questionId || problem.acgoQuestionId || extractQuestionId(problem.url) || index + 1),
    questionId: String(problem.questionId || extractQuestionId(problem.url) || ''),
    acgoQuestionId: String(problem.acgoQuestionId || extractQuestionId(problem.url) || problem.questionId || ''),
    title: stripProblemCode(problem.title || problem.label || `T${index + 1}`),
    fullScore: Number(problem.fullScore ?? problem.score ?? 100) || 100,
    knowledgeList: problem.knowledgeList || []
  }));
}

function buildHomeworkProblemResults(student, headers, problems, detailEntries) {
  const normalizedProblems = normalizeProblemsForFeedback(problems);
  const fullScoreByQuestionKey = new Map((detailEntries || [])
    .filter(entry => entry.questionKey)
    .map(entry => [String(entry.questionKey), Number(entry.fullScore) || 100]));
  return normalizedProblems.map((problem, index) => {
    const header = headers[index + 3] || `T${index + 1}：${problem.title}`;
    const cell = student.cells?.[header] || '';
    const score = parseScore(cell);
    const fullScore = fullScoreByQuestionKey.get(String(problem.questionKey)) || problem.fullScore || 100;
    return {
      index: index + 1,
      questionKey: problem.questionKey,
      questionId: problem.questionId,
      acgoQuestionId: problem.acgoQuestionId,
      title: problem.title,
      score: score === null ? '' : score,
      fullScore,
      status: homeworkStatus(score, fullScore, cell),
      submitCount: countStudentSubmissionsForProblem(student, problem),
      solvedAt: extractParenthesized(cell),
      knowledgeList: problem.knowledgeList || []
    };
  });
}

function parseScore(value) {
  const match = String(value || '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function extractParenthesized(value) {
  return String(value || '').match(/[（(]([^）)]+)[）)]/)?.[1] || '';
}

function homeworkStatus(score, fullScore, cell) {
  if (!String(cell || '').trim()) return '未提交';
  if (score === null) return String(cell);
  if (score >= fullScore) return '通过';
  if (score > 0) return '部分得分';
  return '未通过';
}

function countStudentSubmissionsForProblem(student, problem) {
  const title = stripProblemCode(problem.title || '');
  if (!title) return 0;
  return (student.submissions || []).filter(submission => {
    if (submission.questionKey && String(submission.questionKey) === String(problem.questionKey)) return true;
    const submissionTitle = stripProblemCode(submission.questionTitle || '');
    return submissionTitle && (submissionTitle.includes(title) || title.includes(submissionTitle));
  }).length;
}

function stripProblemCode(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.replace(/^[A-Za-z]{1,10}\d+\s*[.．]\s*/, '').trim() || text;
}

function cleanName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim() || '未知用户';
}

function renderProblems(problems, id) {
  const chunks = [`# ACGO 作业 ${id}：题面汇总`, '', `共 ${problems.length} 道题。`, ''];
  problems.forEach((problem, index) => {
    const originalTitle = problem.title || problem.label || '未命名题目';
    chunks.push(`## ${formatProblemHeading(index + 1, originalTitle)}`, '');
    if (problem.difficulty) chunks.push(`**难度：** ${problem.difficulty}`, '');
    chunks.push(`**时间限制：** ${problem.timeLimit || '页面未识别'}`, '');
    chunks.push(`**内存限制：** ${problem.memoryLimit || '页面未识别'}`, '');
    chunks.push(problem.markdown || '_未能提取题面，请检查 debug 文件。_', '');
  });
  return `${chunks.join('\n').trim()}\n`;
}

function renderContestProblems(dataset) {
  const info = dataset.contestInfo || {};
  const chunks = [`# ${dataset.title}：题面汇总`, ''];
  if (info.contestTimeStr) chunks.push(`- 比赛时间：${info.contestTimeStr}`);
  if (info.durationStr) chunks.push(`- 时长：${info.durationStr}`);
  chunks.push(`- 共 ${dataset.problems.length} 道题。`, '');
  dataset.problems.forEach(problem => {
    chunks.push(`## ${formatProblemHeading(problem.index, problem.title)}`, '');
    chunks.push(`**分值：** ${problem.fullScore}`, '');
    if (problem.difficulty) chunks.push(`**难度：** ${problem.difficulty}`, '');
    chunks.push(`**时间限制：** ${problem.timeLimit || '页面未识别'}`, '');
    chunks.push(`**内存限制：** ${problem.memoryLimit || '页面未识别'}`, '');
    chunks.push(problem.markdown || '_未能提取题面，请检查 debug 文件。_', '');
  });
  return `${chunks.join('\n').trim()}\n`;
}

function renderContestRanking(dataset) {
  const chunks = [`# ${dataset.title}：排行榜`, '', `共 ${dataset.students.length} 名学生。`, ''];
  const headers = dataset.ranking.headers;
  chunks.push(`| ${headers.map(escapeTable).join(' | ')} |`);
  chunks.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const student of dataset.students) {
    chunks.push(`| ${headers.map(header => escapeTable(student.cells[header] || '')).join(' | ')} |`);
  }
  return `${chunks.join('\n')}\n`;
}

function renderContestStudent(student, dataset) {
  const chunks = [`# ${student.username}：今日比赛记录`, ''];
  if (student.userId) chunks.push(`- 用户 ID：${student.userId}`);
  if (student.summary.rank) chunks.push(`- 排名：${student.summary.rank}`);
  if (student.summary.totalScore) chunks.push(`- 总分：${student.summary.totalScore}`);
  if (student.summary.totalSubmitCount !== '') chunks.push(`- 总提交次数：${student.summary.totalSubmitCount}`);
  chunks.push('');

  chunks.push('## 每题情况', '');
  chunks.push('| 题目 | 得分 | 状态 | 提交次数 | 通过/最后得分用时 |');
  chunks.push('| --- | --- | --- | --- | --- |');
  for (const result of student.problemResults) {
    chunks.push(`| ${escapeTable(`T${result.index} ${result.title}`)} | ${escapeTable(`${result.score}/${result.fullScore}`)} | ${escapeTable(result.status)} | ${escapeTable(result.submitCount)} | ${escapeTable(result.solvedAt)} |`);
  }
  chunks.push('');
  chunks.push('## 提交代码', '');
  for (const result of student.problemResults) {
    chunks.push(`### T${result.index} ${result.title}`, '');
    const submissions = submissionsForProblem(student, result);
    if (!submissions.length) {
      chunks.push('_没有读取到该题提交代码。_', '');
      continue;
    }
    submissions.forEach((submission, index) => renderSubmissionBlock(chunks, submission, index));
  }

  renderKnowledgeSection(chunks, dataset.problems);
  return `${chunks.join('\n').trim()}\n`;
}

function renderRanking(ranking, id) {
  const headers = ranking.headers.length ? ranking.headers : Object.keys(ranking.students[0]?.cells || {});
  const chunks = [`# ACGO 作业 ${id}：完成情况`, '', `共 ${ranking.students.length} 名学生。`, ''];
  chunks.push(`| ${headers.map(escapeTable).join(' | ')} |`);
  chunks.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const student of ranking.students) {
    chunks.push(`| ${headers.map(header => escapeTable(student.cells[header] || '')).join(' | ')} |`);
  }
  return `${chunks.join('\n')}\n`;
}

function renderStudent(student, dataset) {
  const chunks = [`# ${student.username}：课堂练习记录`, ''];
  if (student.userId) chunks.push(`- 用户 ID：${student.userId}`);
  if (student.summary?.rank) chunks.push(`- 排名：${student.summary.rank}`);
  if (student.summary?.totalScore) chunks.push(`- 总分：${student.summary.totalScore}`);
  if (hasValue(student.summary?.totalSubmitCount)) chunks.push(`- 总提交次数：${student.summary.totalSubmitCount}`);
  chunks.push('');

  chunks.push('## 每题情况', '');
  if (student.problemResults?.length) {
    chunks.push('| 题目 | 得分 | 状态 | 提交次数 | 页面用时/信息 |');
    chunks.push('| --- | --- | --- | --- | --- |');
    for (const result of student.problemResults) {
      const scoreText = hasValue(result.score) ? `${result.score}/${result.fullScore}` : '';
      chunks.push(`| ${escapeTable(`T${result.index} ${result.title}`)} | ${escapeTable(scoreText)} | ${escapeTable(result.status)} | ${escapeTable(result.submitCount)} | ${escapeTable(result.solvedAt)} |`);
    }
  } else {
    const headers = dataset.ranking?.headers || [];
    chunks.push('| 项目 | 页面显示 |', '| --- | --- |');
    for (const header of headers) {
      if (student.cells?.[header] !== undefined) chunks.push(`| ${escapeTable(header)} | ${escapeTable(student.cells[header])} |`);
    }
  }
  chunks.push('');

  chunks.push('## 提交代码', '');
  for (const result of student.problemResults || []) {
    chunks.push(`### T${result.index} ${result.title}`, '');
    const submissions = submissionsForProblem(student, result);
    if (!submissions.length) {
      chunks.push('_没有读取到该题提交代码。_', '');
      continue;
    }
    submissions.forEach((submission, index) => renderSubmissionBlock(chunks, submission, index));
  }
  if (!student.problemResults?.length && !(student.submissions || []).length) {
    chunks.push('_没有读取到可见的提交记录。若排行榜显示该学生有提交，请查看 debug 文件。_', '');
  }

  renderKnowledgeSection(chunks, dataset.problems || []);
  return `${chunks.join('\n').trim()}\n`;
}

function submissionsForProblem(student, result) {
  const attached = Array.isArray(result.submissions) ? result.submissions : [];
  if (attached.length) return sortSubmissionsByAttempt(attached);
  const pool = student.submissions || [];
  const title = stripProblemCode(result.title || '');
  return sortSubmissionsByAttempt(pool.filter(submission => {
    if (submission.questionKey && result.questionKey && String(submission.questionKey) === String(result.questionKey)) return true;
    if (submission.questionId && result.questionId && String(submission.questionId) === String(result.questionId)) return true;
    const submissionTitle = stripProblemCode(submission.questionTitle || '');
    return title && submissionTitle && (submissionTitle.includes(title) || title.includes(submissionTitle));
  }));
}

function renderSubmissionBlock(chunks, submission, index) {
  chunks.push(`#### 第 ${submission.attempt || index + 1 || '?'} 次提交`, '');
  if (submission.status) chunks.push(`- 评测结果：${submission.status}`);
  if (hasValue(submission.score)) chunks.push(`- 得分：${submission.score}`);
  if (submission.scoringRate) chunks.push(`- 得分率：${submission.scoringRate}`);
  if (submission.language) chunks.push(`- 语言：${submission.language}`);
  if (submission.time) chunks.push(`- 运行时间：${submission.time}`);
  if (submission.memory) chunks.push(`- 运行内存：${submission.memory}`);
  if (submission.submittedAt) chunks.push(`- 提交时间：${submission.submittedAt}`);
  const fence = markdownFence(submission.code);
  chunks.push('', `${fence}${languageFence(submission.language, submission.code)}`, String(submission.code || '').trimEnd(), fence, '');
}

function renderKnowledgeSection(chunks, problems) {
  chunks.push('## 题目知识点', '');
  for (const problem of problems || []) {
    const knowledge = (problem.knowledgeList || []).map(item => item.knowledgeTitle || item.title || item.name || item).filter(Boolean).join('、') || '未提供';
    chunks.push(`- T${problem.index} ${problem.title}：${knowledge}`);
  }
}

function hasValue(value) {
  return value !== '' && value !== null && value !== undefined;
}

function markdownFence(code) {
  const longest = Math.max(2, ...[...String(code || '').matchAll(/`+/g)].map(match => match[0].length));
  return '`'.repeat(longest >= 3 ? longest + 1 : 3);
}

function safeFilename(value) {
  return sanitizeFilename(String(value || '').replace(/\s+/g, '_')) || 'unnamed';
}

function uniqueBy(items, keyOf) {
  const map = new Map();
  for (const item of items) map.set(keyOf(item), item);
  return [...map.values()];
}

async function mapWithConcurrency(items, concurrency, worker) {
  const list = [...(items || [])];
  if (!list.length) return [];

  const results = new Array(list.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(positiveInteger(concurrency, 1), list.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }));
  return results;
}

function submissionApiConcurrency() {
  return positiveInteger(config.submissionApiConcurrency ?? config.submissionConcurrency, 4);
}

function submissionDetailConcurrency() {
  return positiveInteger(config.submissionDetailConcurrency, 3);
}

function requestDelayMs() {
  return Math.max(0, Number(config.actionDelayMs ?? 100) || 0);
}

function pageSettleDelayMs() {
  return Math.max(0, Number(config.pageSettleDelayMs ?? 300) || 0);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

async function writeJson(filename, value) {
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function delay(milliseconds = 0) {
  return new Promise(resolve => setTimeout(resolve, Number(milliseconds) || 0));
}
