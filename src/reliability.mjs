/**
 * Reliability helpers kept free of crawler startup side effects so their
 * failure behaviour can be covered by unit tests.
 */

export function uniqueByFirst(items, keyOf) {
  const map = new Map();
  for (const item of items || []) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

export function resolveContestQuestionOrder({
  apiQuestions,
  pageQuestions,
  rawProblems,
  rankingRecords
}) {
  const api = Array.isArray(apiQuestions) ? apiQuestions : [];
  const page = Array.isArray(pageQuestions) ? pageQuestions : [];
  const problems = Array.isArray(rawProblems) ? rawProblems : [];
  const rankTemplateCandidate = (Array.isArray(rankingRecords) ? rankingRecords : [])
    .map(record => Array.isArray(record?.rank) ? record.rank : [])
    .sort((left, right) => right.length - left.length)[0] || [];
  const expectedCount = Math.max(api.length, page.length, problems.length, rankTemplateCandidate.length);
  if (!expectedCount) return [];

  if (problems.length !== expectedCount) {
    throw new Error(`比赛题面完整性校验失败：题面 ${problems.length} 道，其他数据源最多 ${expectedCount} 道`);
  }
  if (rankTemplateCandidate.length && rankTemplateCandidate.length !== expectedCount) {
    throw new Error(`比赛题单完整性校验失败：排行榜含 ${rankTemplateCandidate.length} 题，预期 ${expectedCount} 题`);
  }

  const fullApi = api.length === expectedCount ? api : [];
  const fullPage = page.length === expectedCount ? page : [];
  if (fullApi.length && fullPage.length) {
    assertCompatibleQuestionSequences(fullApi, fullPage, '接口题单', '页面题单');
  }
  const preferred = fullApi.length ? fullApi : fullPage;
  if (preferred.length) {
    const preferredIds = preferred.map(internalQuestionId);
    const rawIds = problems.map(rawProblemId);
    const sourceUsesPublicIds = preferredIds.every(Boolean)
      && rawIds.every(Boolean)
      && preferredIds.every((id, index) => id === rawIds[index]);
    if (rankTemplateCandidate.length) {
      if (!sourceUsesPublicIds) {
        assertCompatibleQuestionSequences(preferred, rankTemplateCandidate, '比赛题单', '排行榜题序', internalQuestionId);
      }
    }
    assertQuestionSourceMatchesProblems(preferred, problems);
    const rawIndexById = new Map(problems.map((problem, index) => [rawProblemId(problem), index]));
    return preferred.map((question, index) => {
      const rankedQuestion = rankTemplateCandidate[index] || {};
      const rawProblemIndex = rawIndexById.get(externalQuestionId(question)) ?? index;
      return {
        ...question,
        questionId: sourceUsesPublicIds
          ? String(rankedQuestion.questionId || internalQuestionId(question))
          : internalQuestionId(question),
        acgoQuestionId: externalQuestionId(question) || rawIds[rawProblemIndex] || '',
        rawProblemIndex
      };
    });
  }

  const rankTemplate = rankTemplateCandidate.length === problems.length ? rankTemplateCandidate : [];

  return problems.map((problem, index) => {
    const rankedQuestion = rankTemplate[index] || {};
    const acgoQuestionId = String(
      problem?.acgoQuestionId
        || problemIdFromUrl(problem?.url)
        || problem?.questionId
        || ''
    );
    const questionId = String(
      rankedQuestion?.questionId
        || problem?.contestQuestionId
        || problem?.questionKey
        || acgoQuestionId
        || ''
    );
    return {
      ...rankedQuestion,
      questionId,
      acgoQuestionId,
      questionTitle: problem?.title || problem?.label || `T${index + 1}`,
      score: problem?.fullScore ?? problem?.score ?? 100,
      rawProblemIndex: index
    };
  });
}

function assertCompatibleQuestionSequences(left, right, leftLabel, rightLabel, idOf = comparableQuestionId) {
  const leftIds = left.map(idOf);
  const rightIds = right.map(idOf);
  if (leftIds.every(Boolean) && rightIds.every(Boolean) && leftIds.some((id, index) => id !== rightIds[index])) {
    throw new Error(`比赛题单完整性校验失败：${leftLabel}与${rightLabel}的题目 ID/顺序不一致`);
  }
}

function assertQuestionSourceMatchesProblems(source, problems) {
  const sourceIds = source.map(externalQuestionId);
  const problemIds = problems.map(rawProblemId);
  if (sourceIds.every(Boolean) && problemIds.every(Boolean) && sourceIds.some((id, index) => id !== problemIds[index])) {
    throw new Error('比赛题单完整性校验失败：题单与实际抓取题面的公开题号/顺序不一致');
  }
}

function comparableQuestionId(question) {
  return internalQuestionId(question) || externalQuestionId(question);
}

function internalQuestionId(question) {
  return String(question?.questionId || question?.contestQuestionId || question?.questionKey || '');
}

function externalQuestionId(question) {
  return String(
    question?.acgoQuestionId
      || question?.acgoQuestion?.questionId
      || question?.questionInfo?.questionId
      || question?.problemId
      || ''
  );
}

function rawProblemId(problem) {
  return String(problem?.acgoQuestionId || problemIdFromUrl(problem?.url) || problem?.questionId || '');
}

export async function collectPaginatedRecords({
  loadPage,
  recordsFromPage,
  totalFromPage,
  keyOf,
  maxPages = 100,
  label = '分页数据'
}) {
  const limit = positiveInteger(maxPages, 100);
  let firstPage;
  let expectedTotal = 0;
  let records = [];

  for (let pageNumber = 1; pageNumber <= limit; pageNumber++) {
    const pageData = await loadPage(pageNumber);
    if (pageNumber === 1) firstPage = pageData;
    const pageTotal = Number(totalFromPage(pageData) || 0);
    if (Number.isFinite(pageTotal) && pageTotal > expectedTotal) expectedTotal = pageTotal;

    const pageRecords = Array.isArray(recordsFromPage(pageData)) ? recordsFromPage(pageData) : [];
    if (!pageRecords.length) {
      if (expectedTotal && records.length < expectedTotal) {
        throw new Error(`${label}第 ${pageNumber} 页为空，仅读取 ${records.length}/${expectedTotal} 条`);
      }
      return { firstPage, records, total: expectedTotal || records.length, pagesRead: pageNumber };
    }

    const previousCount = records.length;
    records = uniqueByFirst([...records, ...pageRecords], keyOf);
    if (pageNumber > 1 && records.length === previousCount) {
      throw new Error(`${label}第 ${pageNumber} 页未产生新记录，无法确认分页完整性`);
    }
    if (expectedTotal && records.length >= expectedTotal) {
      return {
        firstPage,
        records,
        total: Math.max(expectedTotal, records.length),
        pagesRead: pageNumber
      };
    }
  }

  const totalText = expectedTotal ? `${records.length}/${expectedTotal}` : `${records.length}`;
  throw new Error(`${label}达到 maxPages=${limit} 后仍未读完（${totalText} 条）`);
}

export async function requestAcgoApiWithRetry({
  makeRequest,
  method,
  endpoint,
  maxAttempts = 3,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  baseDelayMs = 500
}) {
  const attempts = positiveInteger(maxAttempts, 3);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await makeRequest();
      const status = Number(response.status());
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw apiError(`${method} ${endpoint} 返回的不是 JSON（HTTP ${status}）`, {
          status,
          retryAfterMs: retryAfterMilliseconds(response)
        });
      }

      const appCode = Number(body?.code);
      const responseOk = typeof response.ok === 'function'
        ? response.ok()
        : status >= 200 && status < 300;
      if (!responseOk || appCode !== 200) {
        throw apiError(
          `${method} ${endpoint} 失败：HTTP ${status}，${body?.message || '未知错误'}`,
          { status, appCode, retryAfterMs: retryAfterMilliseconds(response) }
        );
      }
      return body.data;
    } catch (error) {
      if (attempt >= attempts || !isRetryableApiError(error)) throw error;
      const retryDelay = Number.isFinite(error?.retryAfterMs)
        ? Math.max(0, error.retryAfterMs)
        : Math.max(0, Number(baseDelayMs) || 0) * attempt;
      await wait(retryDelay);
    }
  }
  throw new Error(`${method} ${endpoint} 请求未完成`);
}

export function isRetryableApiError(errorOrMessage, status = 0) {
  const error = errorOrMessage && typeof errorOrMessage === 'object' ? errorOrMessage : null;
  const currentStatus = Number(error?.status ?? status ?? 0);
  const appCode = Number(error?.appCode ?? 0);
  const message = error?.message ?? errorOrMessage ?? '';
  return currentStatus === 429
    || currentStatus >= 500
    || appCode === 429
    || appCode >= 500
    || /socket hang up|ECONNRESET|ETIMEDOUT|Timeout|network|fetch failed|ECONNREFUSED|EAI_AGAIN/i.test(String(message));
}

export function retryAfterMilliseconds(response, now = Date.now()) {
  let value = '';
  try {
    const headers = response?.headers?.() || {};
    value = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1] || '';
  } catch {}
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

export function createMultiPageResponseStore(pageOrContext) {
  const scope = typeof pageOrContext?.context === 'function' ? pageOrContext.context() : pageOrContext;
  const records = [];
  const pending = new Set();
  let sequence = 0;

  const handler = response => {
    const currentSequence = sequence++;
    let task;
    task = captureJsonResponse(response, currentSequence, records)
      .finally(() => pending.delete(task));
    pending.add(task);
  };
  scope.on('response', handler);

  const flush = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };
  return {
    count: () => records.length,
    since: index => ordered(records).slice(index),
    flush,
    shapes: async () => {
      await flush();
      return ordered(records).map(record => ({
        url: redactUrl(record.url),
        status: record.status,
        shape: jsonShape(record.json)
      }));
    },
    dispose: async () => {
      scope.off('response', handler);
      await flush();
    }
  };
}

export function throwIfCollectedFailures(failures, total, label) {
  const errors = [...(failures || [])];
  if (!errors.length) return;
  throw new AggregateError(errors, `有 ${errors.length}/${Number(total) || errors.length} 个${label}读取失败`);
}

export function requireSubmissionCode(code, submissionId) {
  const value = String(code || '');
  if (!value) throw new Error(`提交 ${submissionId || '未知 ID'} 的详情未返回代码`);
  return value;
}

async function captureJsonResponse(response, sequence, records) {
  let contentType = '';
  try {
    contentType = response.headers()['content-type'] || '';
  } catch {}
  if (!/json/i.test(contentType)) return;
  if (!/acgo\.cn/i.test(response.url())) return;
  try {
    const json = await response.json();
    records.push({ sequence, url: response.url(), status: response.status(), json });
  } catch {}
}

function ordered(records) {
  return [...records].sort((left, right) => left.sequence - right.sequence);
}

function apiError(message, properties) {
  return Object.assign(new Error(message), properties);
}

function problemIdFromUrl(value) {
  try {
    const url = new URL(value);
    return url.pathname.match(/\/(?:problemset\/info|problem|question)\/(\d+)/i)?.[1]
      || url.searchParams.get('questionId')
      || url.searchParams.get('problemId')
      || '';
  } catch {
    return '';
  }
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

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
