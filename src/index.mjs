import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sanitizeFilename from 'sanitize-filename';
import {
  dedupeSubmissions,
  extractProblem
} from './extract.mjs';
import { escapeTable, formatProblemHeading, languageFence } from './markdown.mjs';
import { buildQuestionDataUrl, problemFromNextData } from './problem-data.mjs';
import { acquireBrowser, createDedicatedWorkPage } from './browser.mjs';
import { createTeacherUserIdMatcher, rebaseCompetitionRanks } from './filters.mjs';
import { buildContestUrl, loadConfigFile, normalizeConfig } from './config.mjs';
import { createOutputTransaction } from './output-transaction.mjs';
import { buildEvidencePackage } from './package.mjs';
import { loadPrompt } from './prompt.mjs';
import { waitForAcgoLogin } from './login.mjs';
import {
  collectPaginatedRecords,
  createMultiPageResponseStore,
  requireSubmissionCode,
  requestAcgoApiWithRetry,
  resolveContestQuestionOrder,
  throwIfCollectedFailures,
  uniqueByFirst
} from './reliability.mjs';

let args = {};
let configPath = '';
let configDirectory = '';
let config = {};
let homeworkId = '';
let teamCode = '';
let contestConfig = null;
let contestId = '';
let packageSlug = '';
let finalRootDirectory = '';
let rootDirectory = '';
let debugDirectory = '';
let rawDirectory = '';
let studentsDirectory = '';
let teacherUserMatcher = createTeacherUserIdMatcher([]);
let promptSource = null;

await main();

async function main() {
  let browserSession;
  let responseStore;
  let requestStore;
  let outputTransaction;
  let page;
  let runSucceeded = false;

  try {
    args = parseArgs(process.argv.slice(2));
    configPath = path.resolve(args.config || 'config.json');
    configDirectory = path.dirname(configPath);
    config = normalizeConfig(await loadConfigFile(configPath));
    homeworkId = config.homework?.id || '';
    teamCode = config.homework?.teamCode || config.contest?.teamCode || '';
    contestConfig = config.contest;
    contestId = contestConfig?.id || '';
    packageSlug = config.sessionName || (
      [homeworkId ? `homework-${homeworkId}` : '', contestId ? `contest-${contestId}` : ''].filter(Boolean).join('-') || 'acgo-crawl'
    );
    finalRootDirectory = path.resolve(config.outputDirectory || 'output', safeFilename(packageSlug));
    setOutputRoot(finalRootDirectory);
    teacherUserMatcher = createTeacherUserIdMatcher(config.teacherUserIds);
    promptSource = await loadPrompt({ promptPath: config.promptPath, configDirectory });

    console.log(`正在连接浏览器：${config.cdpUrl}`);
    browserSession = await acquireBrowser(config);
    const { context } = browserSession;
    context.setDefaultTimeout(config.navigationTimeoutMs || 30000);
    context.setDefaultNavigationTimeout(config.navigationTimeoutMs || 30000);
    page = await createDedicatedWorkPage(context, {
      reuseExisting: browserSession.managedProfile,
      closeOtherPages: browserSession.managedProfile
    });
    // 先在唯一的任务标签中确认登录，再访问受保护的作业/比赛页面。
    // 这样自启动 Edge 不会同时留下首页和 403 两个窗口；外接浏览器仍只使用新建标签。
    await gotoStable(page, 'https://www.acgo.cn/');
    await ensureLoggedIn(page, 'https://www.acgo.cn/');
    responseStore = createMultiPageResponseStore(context);
    requestStore = createRequestStore(context);

    outputTransaction = await createOutputTransaction(finalRootDirectory, {
      inspectOnly: Boolean(args.inspectOnly)
    });
    setOutputRoot(outputTransaction.stagingDirectory);
    await Promise.all([
      rootDirectory,
      rawDirectory,
      studentsDirectory
    ].map(directory => fs.mkdir(directory, { recursive: true })));
    if (args.inspectOnly || config.saveDebugFiles) {
      await fs.mkdir(debugDirectory, { recursive: true });
    } else {
      await fs.rm(debugDirectory, { recursive: true, force: true });
    }

    const api = createAcgoApi(context, requestStore);
    if (args.inspectOnly) {
      await inspectConfiguredPages(page, api, responseStore);
    } else {
      const classroomDataset = config.homework ? await collectHomeworkDataset(page, api) : null;

      let contestDataset = null;
      if (contestConfig) {
        contestDataset = await collectContestDataset(page, api, contestConfig);
      }

      assertExcludedTeachersAbsent(classroomDataset, contestDataset);
      const studentMaterialPaths = await writeCodeEvidenceFiles({ classroomDataset, contestDataset, prompt: promptSource.markdown });
      const summary = {
        homeworkId,
        prompt: promptSource.metadata,
        filters: {
          homeworkExcludedTeacherCount: classroomDataset?.excludedTeacherCount || 0,
          contestExcludedTeacherCount: contestDataset?.excludedTeacherCount || 0
        },
        classroom: classroomDataset,
        contest: contestDataset
      };
      await writeJson(path.join(rawDirectory, 'summary.json'), summary);
      if (config.saveDebugFiles) {
        await writeJson(path.join(debugDirectory, '响应结构.json'), await responseStore.shapes());
      }
      const finalZipPath = path.join(path.dirname(finalRootDirectory), `${safeFilename(packageSlug)}.zip`);
      const stagedZipPath = outputTransaction.createArtifactPath(finalZipPath);
      await buildEvidencePackage(rootDirectory, {
        archiveName: safeFilename(packageSlug),
        zipPath: stagedZipPath,
        includeHomework: Boolean(classroomDataset),
        includeContest: Boolean(contestDataset),
        studentFiles: studentMaterialPaths
      });
    }

    await outputTransaction.commit();
    runSucceeded = true;
    setOutputRoot(finalRootDirectory);
    if (args.inspectOnly) {
      console.log(`诊断完成：${debugDirectory}`);
    } else {
      console.log(`导出完成：${finalRootDirectory}`);
      console.log(`ZIP 已生成：${path.join(path.dirname(finalRootDirectory), `${safeFilename(packageSlug)}.zip`)}`);
    }
  } catch (error) {
    console.error(`\n${args.inspectOnly ? '诊断' : '导出'}失败：${error.stack || error.message}`);
    if (page && outputTransaction) {
      try {
        await saveDebugPage(page, '发生错误时页面');
        if (responseStore) await writeJson(path.join(debugDirectory, '响应结构.json'), await responseStore.shapes());
      } catch {}
    }
    process.exitCode = 1;
  } finally {
    if (responseStore) await responseStore.dispose().catch(() => {});
    requestStore?.dispose();
    if (outputTransaction && !runSucceeded) await outputTransaction.rollback().catch(() => {});
    if (runSucceeded && page && !page.isClosed()) await page.close().catch(() => {});
    if (browserSession) {
      await browserSession.dispose({ successful: runSucceeded, inspectOnly: Boolean(args.inspectOnly) }).catch(() => {});
    }
  }
}

function setOutputRoot(directory) {
  rootDirectory = path.resolve(directory);
  debugDirectory = path.join(rootDirectory, 'debug');
  rawDirectory = path.join(rootDirectory, 'raw');
  studentsDirectory = path.join(rootDirectory, 'students');
}

function parseArgs(values) {
  const result = {};
  for (let i = 0; i < values.length; i++) {
    if (values[i] === '--config') result.config = values[++i];
    else if (values[i] === '--inspect-only') result.inspectOnly = true;
  }
  return result;
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

async function ensureLoggedIn(page, targetUrl = '') {
  await waitForAcgoLogin(page, {
    timeoutMs: config.browser.loginTimeoutMs ?? 10 * 60 * 1000,
    pollIntervalMs: config.browser?.loginPollIntervalMs ?? 1000,
    prepareLogin: () => gotoStable(page, 'https://www.acgo.cn/'),
    resume: targetUrl ? () => gotoStable(page, targetUrl) : undefined
  });
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
  const unique = uniqueByFirst(links, item => item.url);
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
    await ensureLoggedIn(page, config.homework.questionUrl);
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
    console.log('诊断：读取比赛入口…');
    await gotoStable(page, contestConfig.detailUrl || contestConfig.questionUrl);
    await ensureLoggedIn(page, contestConfig.detailUrl || contestConfig.questionUrl);
    const resolvedContest = await resolveContestConfigFromPage(page, contestConfig);

    console.log('诊断：读取比赛题目入口…');
    await gotoStable(page, resolvedContest.questionUrl);
    await saveDebugPage(page, 'inspect-比赛题目入口');

    console.log('诊断：读取比赛排行榜入口…');
    const pageProps = await collectContestRankingPages(page, resolvedContest.rankingUrl);
    await saveDebugPage(page, 'inspect-比赛排行榜入口');
    report.contest = {
      id: resolvedContest.id,
      detailUrl: resolvedContest.detailUrl,
      questionUrl: resolvedContest.questionUrl,
      rankingUrl: resolvedContest.rankingUrl,
      pagePropKeys: Object.keys(pageProps),
      rankingTotal: pageProps.listData?.total || 0,
      rankingRows: pageProps.listData?.list?.length || 0
    };
  }

  report.responseShapes = await responseStore.shapes();
  await writeJson(path.join(debugDirectory, '诊断报告.json'), report);
  console.log(`诊断完成：${debugDirectory}`);
}

async function collectHomeworkDataset(page, api) {
  console.log('读取作业题目列表…');
  await gotoStable(page, config.homework.questionUrl);
  await ensureLoggedIn(page, config.homework.questionUrl);
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
  const submissionFailures = [];
  await mapWithConcurrency(homeworkSubmissionTasks, submissionApiConcurrency(), async (entry, index) => {
    console.log(`读取作业提交 ${index + 1}/${ranking.detailEntries.length}：${entry.username} / ${entry.questionTitle}`);
    let submissions = [];
    let submissionError = null;
    try {
      submissions = await collectSubmissionAttemptsFromApi(api, entry);
    } catch (error) {
      console.warn(`  作业提交接口读取失败：${error.message}`);
      submissionError = error;
    }
    if (!submissions.length && (submissionError || entry.expectedSubmissions)) {
      await saveDebugPage(page, `未读取到提交-${entry.username}-${entry.questionTitle}`);
      const message = submissionError?.message || '排行榜显示已提交，但提交接口未返回代码';
      submissionFailures.push(new Error(`${entry.username} / ${entry.questionTitle}：${message}`, { cause: submissionError || undefined }));
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

  throwIfCollectedFailures(submissionFailures, homeworkSubmissionTasks.length, '作业提交任务');

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
    students: [...students.values()],
    excludedTeacherCount: ranking.excludedTeacherCount || 0
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

  const rankingPages = await collectPaginatedRecords({
    maxPages: config.maxRankingPages || 100,
    label: '作业排行榜',
    keyOf: homeworkRankingRecordKey,

    allowTotalMismatchOnEmptyPage: true,

    loadPage: pageNumber => api.get(endpoint, {
      ...commonParams,
      page: String(pageNumber),
      pageSize: String(pageSize)
    }),
    recordsFromPage: pageData => pageData?.records,
    totalFromPage: pageData => pageData?.total
  });
  const records = rankingPages.records;
  if (rankingPages.pagesRead > 1) {
    console.log(`作业排行榜分页读取完成：${records.length}/${rankingPages.total || records.length} 名，${rankingPages.pagesRead} 页。`);
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

  const includedRecords = records.filter(record => !teacherUserMatcher.excludes(record.userInfo?.userId));
  const displayRanks = rebaseCompetitionRanks(includedRecords, record => record.order);
  for (let recordIndex = 0; recordIndex < includedRecords.length; recordIndex++) {
    const record = includedRecords[recordIndex];
    const userId = String(record.userInfo?.userId || '');
    const username = cleanName(record.userInfo?.teamVo?.teamUserName || record.userInfo?.nickName || `用户${userId}`);
    const key = `${userId}:${username}`;
    const answerByQuestionId = new Map((record.homeworkAnswerList || []).map(answer => [String(answer.questionId), answer]));
    const cells = {
      名次: String(displayRanks[recordIndex]),
      用户名: username,
      总分: formatScoreAndTime(record.totalScore, record.totalCpuTimeStr)
    };

    for (const question of questionOrder) {
      const header = `T${question.index}：${question.title}`;
      const answer = answerByQuestionId.get(question.questionId);
      cells[header] = answer && answer.score !== null && answer.score !== undefined
        ? formatScoreAndTime(answer.score, answer.cpuTimeStr)
        : '';
      detailEntries.push({
        studentKey: key,
        username,
        userId,
        questionId: question.questionId,
        questionIndex: question.index,
        questionTitle: formatProblemHeading(question.index, question.title),
        questionKey: question.questionId,
        fullScore: question.fullScore,
        rankingScore: answer?.score === null || answer?.score === undefined ? null : Number(answer.score),
        rankingRecordId: answer?.recordId,
        expectedSubmissions: Boolean(answer?.questionId && answer.score !== null && answer.score !== undefined)
      });
    }
    students.push({ key, username, userId, cells });
  }

  return {
    headers,
    students,
    detailEntries,
    excludedTeacherCount: records.length - includedRecords.length
  };
}

async function collectSubmissionAttemptsFromApi(api, entry) {
  const listEndpoint = `/acgoPms/api/team/${teamCode}/homework/questionAnswerRecord/list`;
  const viewEndpoint = `/acgoPms/api/team/${teamCode}/homework/questionAnswerRecord/view`;
  const records = await api.post(listEndpoint, {
    questionId: Number(entry.questionId),
    homeworkId: Number(homeworkId),
    userId: String(entry.userId),
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
    const rawCode = Array.isArray(detail?.answer) ? detail.answer[0] : detail?.answer;
    const code = requireSubmissionCode(rawCode, record.id);
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

  console.log('读取今日比赛入口…');
  await gotoStable(page, runtimeContest.detailUrl || runtimeContest.questionUrl);
  await ensureLoggedIn(page, runtimeContest.detailUrl || runtimeContest.questionUrl);
  runtimeContest = await resolveContestConfigFromPage(page, runtimeContest);

  console.log('读取今日比赛题目列表…');
  await gotoStable(page, runtimeContest.questionUrl);
  await ensureLoggedIn(page, runtimeContest.questionUrl);
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

  const expectedStudentCount = contestDataset.ranking.sourceTotal - contestDataset.excludedTeacherCount;
  if (expectedStudentCount !== contestDataset.students.length) {
    throw new Error(`比赛排行榜完整性校验失败：过滤教师后应有 ${expectedStudentCount} 名学生，实际读取 ${contestDataset.students.length} 名。`);
  }

  await collectContestSubmissions(api, contestDataset, contestTeamCode, runtimeContest.rankingUrl);
  await fs.writeFile(path.join(rootDirectory, '比赛题目.md'), renderContestProblems(contestDataset), 'utf8');
  await fs.writeFile(path.join(rootDirectory, '比赛排行榜.md'), renderContestRanking(contestDataset), 'utf8');
  return contestDataset;
}

async function collectContestRankingPages(page, rankingUrl) {
  const result = await collectPaginatedRecords({
    maxPages: config.maxRankingPages || 100,
    label: '比赛排行榜',
    keyOf: contestRankingRecordKey,
    loadPage: async pageNumber => {
      await gotoStable(page, contestRankingPageUrl(rankingUrl, pageNumber));
      const pageProps = await readNextPageProps(page);
      if (pageNumber > 1) await delay(requestDelayMs());
      return pageProps;
    },
    recordsFromPage: pageProps => pageProps.listData?.list,
    totalFromPage: pageProps => pageProps.listData?.total
  });
  const firstProps = result.firstPage || {};
  const firstListData = firstProps.listData || {};
  if (result.pagesRead > 1) {
    console.log(`比赛排行榜分页读取完成：${result.records.length}/${result.total || result.records.length} 名学生，${result.pagesRead} 页。`);
  }

  return {
    ...firstProps,
    listData: {
      ...firstListData,
      list: result.records,
      total: result.total || result.records.length
    }
  };
}

function homeworkRankingRecordKey(record) {
  return String(record?.userInfo?.userId || `${record?.order || ''}:${record?.userInfo?.nickName || ''}`);
}

function contestRankingPageUrl(rankingUrl, pageNumber) {
  const url = new URL(rankingUrl);
  url.searchParams.set('page', String(pageNumber));
  return url.href;
}

function contestRankingRecordKey(record) {
  return String(record?.userId || `${record?.rankOrder || record?.realRankOrder || ''}:${record?.nickName || ''}`);
}

async function collectContestQuestionLinks(page, { questionList, pageProps, contestTeamCode }) {
  const apiLinks = buildContestQuestionLinksFromList(questionList, contestTeamCode);
  const nextLinks = buildContestQuestionLinksFromList(pageProps?.questionList, contestTeamCode);
  const domLinks = await collectQuestionLinks(page, { allowEmpty: true });
  const sources = [
    { name: '题目接口', links: apiLinks, priority: 3 },
    { name: '页面数据', links: nextLinks, priority: 2 },
    { name: '页面链接', links: domLinks, priority: 1 }
  ].filter(source => source.links.length);
  const selected = sources.sort((left, right) =>
    right.links.length - left.links.length || right.priority - left.priority
  )[0];
  if (selected) {
    if (sources.some(source => source.links.length !== selected.links.length)) {
      console.warn(`比赛题单来源数量不一致（${sources.map(source => `${source.name}${source.links.length}题`).join('、')}），将采用最完整的${selected.name}并在排行榜阶段继续校验。`);
    } else if (selected.name !== '题目接口') {
      console.log(`比赛题面链接已通过${selected.name}生成。`);
    }
    return selected.links;
  }

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
  return uniqueByFirst(links, item => item.url);
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
    const questionUrl = links.find(href => /\/contest\/question\//.test(href) && /examId=/.test(href))
      || links.find(href => /\/contest\/question\//.test(href))
      || '';
    const rankingUrl = links.find(href => /\/contest\/ranking\//.test(href) && /examId=/.test(href))
      || links.find(href => /\/contest\/ranking\//.test(href))
      || '';
    const detailUrl = links.find(href => /\/contest\/detail\//.test(href) && /examId=/.test(href))
      || links.find(href => /\/contest\/detail\//.test(href))
      || location.href;
    let examId = '';
    let matchRoundId = '';
    let openLevel = '';
    try {
      const props = JSON.parse(document.querySelector('#__NEXT_DATA__')?.textContent || '{}')?.props?.pageProps || {};
      const contestInfo = props.contestInfo || {};
      const round = contestInfo.matchRounds || contestInfo.matchRound || {};
      examId = String(round.programExamId || round.paperId || props.examId || '');
      matchRoundId = String(round.id || props.matchRoundId || props.contestId || '');
      openLevel = String(contestInfo.openLevel || props.openLevel || '');
    } catch {}
    return { questionUrl, rankingUrl, detailUrl, examId, matchRoundId, openLevel };
  });

  const id = extractContestId(resolved.rankingUrl || resolved.questionUrl || resolved.detailUrl || contest.detailUrl || contest.rankingUrl || contest.questionUrl)
    || contest.id;
  const detailParams = contestParamsFromUrl(resolved.detailUrl);
  const rankingParams = contestParamsFromUrl(resolved.rankingUrl);
  const questionParams = contestParamsFromUrl(resolved.questionUrl);
  const fallbackParams = {
    contestId: id,
    teamCode: questionParams.teamCode || rankingParams.teamCode || detailParams.teamCode || contest.teamCode || teamCode,
    matchRoundId: questionParams.matchRoundId || rankingParams.matchRoundId || detailParams.matchRoundId || resolved.matchRoundId || contest.matchRoundId || id,
    examId: questionParams.examId || rankingParams.examId || detailParams.examId || resolved.examId || contest.examId || '',
    openLevel: questionParams.openLevel || rankingParams.openLevel || detailParams.openLevel || resolved.openLevel || contest.openLevel || ''
  };

  const detailUrl = fillContestUrl(
    resolved.detailUrl || contest.detailUrl || buildContestUrl({ ...fallbackParams, page: 'detail' }),
    fallbackParams
  );
  const questionUrl = fillContestUrl(
    resolved.questionUrl || buildContestUrl({ ...fallbackParams, page: 'question' }),
    fallbackParams
  );
  const rankingUrl = fillContestUrl(
    resolved.rankingUrl || buildContestUrl({ ...fallbackParams, page: 'ranking' }),
    fallbackParams
  );

  return {
    ...contest,
    id,
    matchRoundId: fallbackParams.matchRoundId,
    openLevel: fallbackParams.openLevel,
    detailUrl,
    questionUrl,
    rankingUrl,
    examId: fallbackParams.examId
  };
}

function contestParamsFromUrl(value) {
  try {
    if (!value) return {};
    const url = new URL(value);
    return {
      teamCode: url.searchParams.get('teamCode') || '',
      matchRoundId: url.searchParams.get('matchRoundId') || '',
      examId: url.searchParams.get('examId') || '',
      openLevel: url.searchParams.get('openLevel') || ''
    };
  } catch {
    return {};
  }
}

function fillContestUrl(value, params) {
  const url = new URL(value);
  if (params.teamCode && !url.searchParams.get('teamCode')) url.searchParams.set('teamCode', params.teamCode);
  if (params.matchRoundId && !url.searchParams.get('matchRoundId')) url.searchParams.set('matchRoundId', params.matchRoundId);
  if (params.examId && !url.searchParams.get('examId')) url.searchParams.set('examId', params.examId);
  if (params.openLevel && !url.searchParams.get('openLevel')) url.searchParams.set('openLevel', params.openLevel);
  return url.href;
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
  const hasExpectedSubmissions = dataset.students.some(student =>
    student.problemResults.some(result => Number(result.submitCount) > 0)
  );
  if (!examId) {
    if (hasExpectedSubmissions) throw new Error('比赛链接缺少 examId，无法完整读取已存在的比赛提交代码');
    return;
  }

  const tasks = dataset.students.flatMap(student => {
    student.submissions = [];
    return student.problemResults.map(result => ({ student, result }));
  });
  let cursor = 0;
  const failures = [];

  await mapWithConcurrency(tasks, submissionApiConcurrency(), async ({ student, result }) => {
    const current = ++cursor;
    console.log(`读取比赛提交 ${current}/${tasks.length}：${student.username} / T${result.index} ${result.title}`);
    try {
      const leaderboardSubmitCount = Number(result.submitCount) || 0;
      const submissions = await collectContestSubmissionAttemptsFromApi(api, {
        teamCode: contestTeamCode,
        examId,
        userId: student.userId,
        questionId: result.questionId,
        questionKey: result.questionKey,
        questionTitle: `第${result.index}题：${result.title}`
      });
      if (!submissions.length && leaderboardSubmitCount > 0) {
        throw new Error(`排行榜显示 ${leaderboardSubmitCount} 次提交，但提交接口未返回代码`);
      }
      result.leaderboardSubmitCount = leaderboardSubmitCount;
      result.submitCount = submissions.length;
      result.submissions = submissions;
      student.submissions.push(...submissions);
    } catch (error) {
      console.warn(`  比赛提交读取失败：${error.message}`);
      result.submissions = [];
      failures.push(new Error(`${student.username} / T${result.index} ${result.title}：${error.message}`, { cause: error }));
    }
    await delay(requestDelayMs());
  });

  throwIfCollectedFailures(failures, tasks.length, '比赛提交任务');

  for (const student of dataset.students) {
    student.submissions = sortSubmissionsByAttempt(dedupeSubmissions(student.submissions));
    student.summary.totalSubmitCount = student.submissions.length;
    for (const result of student.problemResults) {
      const header = `T${result.index}：${result.title}`;
      const scoreAndTime = String(student.cells?.[header] || '').split(/，提交\d+次/u)[0];
      student.cells[header] = result.submissions.length
        ? `${scoreAndTime}，提交${result.submissions.length}次`
        : scoreAndTime;
    }
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
    const rawCode = Array.isArray(detail?.answer) ? detail.answer[0] : (detail?.answer || record.answer?.[0]);
    const code = requireSubmissionCode(rawCode, record.id);
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
  const rankingRecords = Array.isArray(pageProps.listData?.list) ? pageProps.listData.list : [];
  const orderSource = resolveContestQuestionOrder({
    apiQuestions,
    pageQuestions: nextQuestions,
    rawProblems,
    rankingRecords
  });
  const rawProblemByAcgoId = new Map(rawProblems.map((problem, index) => [
    String(problem.questionId || extractQuestionId(problem.url) || index + 1),
    problem
  ]));

  const problems = orderSource.map((question, index) => {
    const rawProblemAtIndex = rawProblems[question.rawProblemIndex ?? index];
    const acgoQuestionId = question.acgoQuestionId || extractQuestionId(rawProblemAtIndex?.url || '') || question.questionId;
    const rawProblem = rawProblemByAcgoId.get(String(acgoQuestionId)) || rawProblemAtIndex || {};
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
  const records = rankingRecords.filter(record => !teacherUserMatcher.excludes(record?.userId));
  const displayRanks = rebaseCompetitionRanks(records, record => record.rankOrder ?? record.realRankOrder);
  const students = records.map((record, rowIndex) => {
    const username = cleanName(record.nickName || `用户${record.userId || rowIndex + 1}`);
    const userId = String(record.userId || '');
    const key = `${userId}:${username}`;
    const answerByQuestionId = new Map((record.rank || []).map(answer => [String(answer.questionId), answer]));
    const cells = {
      名次: String(displayRanks[rowIndex]),
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
        leaderboardSubmitCount: submitCount,
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
      total: students.length,
      sourceTotal: Number(pageProps.listData?.total || rankingRecords.length),
      students
    },
    students,
    excludedTeacherCount: rankingRecords.length - students.length
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
    return requestAcgoApiWithRetry({
      method,
      endpoint,
      maxAttempts: Math.max(1, Number(config.apiRetryCount || 3)),
      makeRequest: () => method === 'GET'
        ? context.request.get(url, options)
        : context.request.post(url, options),
      wait: delay
    });
  };
  return {
    get: (endpoint, params) => call('GET', endpoint, params),
    post: (endpoint, data) => call('POST', endpoint, data)
  };
}

async function saveDebugPage(page, name) {
  if (!config.saveDebugFiles && !args.inspectOnly) return;
  const basename = safeFilename(name);
  await fs.writeFile(path.join(debugDirectory, `${basename}.html`), await page.content(), 'utf8');
  await page.screenshot({ path: path.join(debugDirectory, `${basename}.png`), fullPage: true }).catch(() => {});
}

async function writeCodeEvidenceFiles({ classroomDataset, contestDataset, prompt }) {
  await fs.writeFile(path.join(rootDirectory, 'README.md'), renderCodeEvidenceReadme({ classroomDataset, contestDataset }), 'utf8');
  await fs.writeFile(path.join(rootDirectory, '提示词.md'), `${String(prompt || '').trim()}\n`, 'utf8');

  const studentDirectories = new Map();
  const studentMaterialPaths = [];
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
    studentMaterialPaths.push(`students/${path.basename(directory)}/课堂练习.md`);
  }

  for (const student of contestDataset?.students || []) {
    const directory = await directoryFor(student);
    await fs.writeFile(path.join(directory, '今日比赛.md'), renderContestStudent(student, contestDataset), 'utf8');
    studentMaterialPaths.push(`students/${path.basename(directory)}/今日比赛.md`);
  }
  return studentMaterialPaths;
}

function renderCodeEvidenceReadme({ classroomDataset, contestDataset }) {
  const chunks = [
    '# ACGO 代码证据包',
    '',
    '这个文件夹用于提交给 AI 生成学生当日反馈。每位学生按课堂练习和今日比赛分别整理 Markdown，包含每道题的完成情况以及每次提交的完整代码。',
    '',
    '## 文件结构',
    '',
    '- `作业题目.md`：课堂练习题面汇总。',
    '- `比赛题目.md`：今日比赛题面汇总。',
    '- `students/学生名-用户ID/课堂练习.md`：该学生课堂练习每题每次提交代码。',
    '- `students/学生名-用户ID/今日比赛.md`：该学生比赛每题每次提交代码。',
    '- `提示词.md`：提交给 AI 的完整任务提示词。',
    '- `raw/summary.json`：结构化原始数据。',
    '- 以上 README、排行榜、完成情况、`raw/` 等只供本地核验，不进入提交给 AI 的 ZIP。',
    ''
  ];
  chunks.push('## 本次数据', '');
  if (classroomDataset) {
    chunks.push(`- 课堂练习：${classroomDataset.title || `作业 ${classroomDataset.id}`}，${classroomDataset.problems.length} 题，${classroomDataset.students.length} 名学生。`);
  }
  if (contestDataset) {
    chunks.push(`- 今日比赛：${contestDataset.title || `比赛 ${contestDataset.id}`}，${contestDataset.problems.length} 题，${contestDataset.students.length} 名学生。`);
  }
  chunks.push('', '## 给 AI 的建议', '');
  chunks.push('请把最终 ZIP 提交给 AI，并要求它先读取根目录的 `提示词.md`，再结合题面和每位学生的提交材料。题目列表中的横线标题保留为上午/下午必做或选做的分组标记，AI 应结合其后的题目理解分组。');
  return `${chunks.join('\n')}\n`;
}

function assertExcludedTeachersAbsent(...datasets) {
  for (const dataset of datasets.filter(Boolean)) {
    for (const student of [...(dataset.students || []), ...(dataset.ranking?.students || [])]) {
      if (teacherUserMatcher.excludes(student.userId)) {
        throw new Error('教师账号过滤断言失败：最终数据仍包含配置的教师用户 ID');
      }
    }
  }
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
  return positiveInteger(config.submissionApiConcurrency, 4);
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
