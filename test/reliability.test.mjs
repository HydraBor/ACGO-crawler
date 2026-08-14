import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  collectPaginatedRecords,
  createMultiPageResponseStore,
  requireSubmissionCode,
  requestAcgoApiWithRetry,
  resolveContestQuestionOrder,
  throwIfCollectedFailures,
  uniqueByFirst
} from '../src/reliability.mjs';

test('uniqueByFirst 保留首个出现的记录和顺序', () => {
  const result = uniqueByFirst([
    { id: 'a', value: 1 },
    { id: 'b', value: 2 },
    { id: 'a', value: 3 }
  ], item => item.id);
  assert.deepEqual(result, [
    { id: 'a', value: 1 },
    { id: 'b', value: 2 }
  ]);
});

test('比赛题序在接口和页面 questionList 缺失时回退到 rawProblems', () => {
  const order = resolveContestQuestionOrder({
    apiQuestions: [],
    pageQuestions: [],
    rawProblems: [
      { questionId: '116670', url: 'https://www.acgo.cn/problemset/info/116670', title: '题目一' },
      { questionId: '116669', url: 'https://www.acgo.cn/problemset/info/116669', title: '题目二' }
    ],
    rankingRecords: [
      { rank: [{ questionId: 171654, score: 100 }, { questionId: 171653, score: 80 }] }
    ]
  });

  assert.deepEqual(order.map(question => ({
    questionId: question.questionId,
    acgoQuestionId: question.acgoQuestionId,
    title: question.questionTitle
  })), [
    { questionId: '171654', acgoQuestionId: '116670', title: '题目一' },
    { questionId: '171653', acgoQuestionId: '116669', title: '题目二' }
  ]);
});

test('比赛题序在完整接口与页面题单一致时优先使用接口并保留映射', () => {
  const apiQuestions = [{ questionId: 9, acgoQuestionId: 7 }];
  const result = resolveContestQuestionOrder({
    apiQuestions,
    pageQuestions: [{ questionId: 9, acgoQuestionId: 7 }],
    rawProblems: [{ questionId: 7, url: 'https://www.acgo.cn/problemset/info/7' }],
    rankingRecords: [{ rank: [{ questionId: 9 }] }]
  });
  assert.equal(result[0].questionId, '9');
  assert.equal(result[0].rawProblemIndex, 0);
});

test('比赛接口题单截断时使用完整页面题单并校验排行榜', () => {
  const order = resolveContestQuestionOrder({
    apiQuestions: [{ questionId: 91, acgoQuestionId: 71 }],
    pageQuestions: [
      { questionId: 91, acgoQuestionId: 71 },
      { questionId: 92, acgoQuestionId: 72 }
    ],
    rawProblems: [
      { questionId: 71, url: 'https://www.acgo.cn/problemset/info/71' },
      { questionId: 72, url: 'https://www.acgo.cn/problemset/info/72' }
    ],
    rankingRecords: [{ rank: [{ questionId: 91 }, { questionId: 92 }] }]
  });
  assert.deepEqual(order.map(question => Number(question.questionId)), [91, 92]);
});

test('比赛题面少于排行榜题数时严格失败', () => {
  assert.throws(() => resolveContestQuestionOrder({
    apiQuestions: [{ questionId: 91, acgoQuestionId: 71 }],
    pageQuestions: [],
    rawProblems: [{ questionId: 71 }],
    rankingRecords: [{ rank: [{ questionId: 91 }, { questionId: 92 }] }]
  }), /题面完整性校验失败/);
});

test('排行榜 rank 长度与 rawProblems 不一致时严格失败，避免错位映射', () => {
  assert.throws(() => resolveContestQuestionOrder({
    apiQuestions: [],
    pageQuestions: [],
    rawProblems: [{ questionId: '116670', title: '唯一题' }],
    rankingRecords: [{ rank: [{ questionId: 1 }, { questionId: 2 }] }]
  }), /题面完整性校验失败/);
});

test('比赛排行榜不猜 pageSize，持续翻页直到达到 total', async () => {
  const pages = [
    { listData: { total: 25, list: records(1, 10) } },
    { listData: { total: 25, list: records(11, 10) } },
    { listData: { total: 25, list: records(21, 5) } }
  ];
  const loaded = [];
  const result = await collectPaginatedRecords({
    loadPage: async page => (loaded.push(page), pages[page - 1]),
    recordsFromPage: page => page.listData.list,
    totalFromPage: page => page.listData.total,
    keyOf: item => item.userId,
    maxPages: 10,
    label: '比赛排行榜'
  });

  assert.deepEqual(loaded, [1, 2, 3]);
  assert.equal(result.records.length, 25);
  assert.equal(result.pagesRead, 3);
});

test('比赛排行榜服务器忽略 page 而重复首页时严格失败', async () => {
  await assert.rejects(() => collectPaginatedRecords({
    loadPage: async () => ({ listData: { total: 20, list: records(1, 10) } }),
    recordsFromPage: page => page.listData.list,
    totalFromPage: page => page.listData.total,
    keyOf: item => item.userId,
    maxPages: 5,
    label: '比赛排行榜'
  }), /未产生新记录/);
});

test('比赛排行榜达到 maxPages 仍不完整时严格失败', async () => {
  await assert.rejects(() => collectPaginatedRecords({
    loadPage: async page => ({ listData: { total: 30, list: records((page - 1) * 10 + 1, 10) } }),
    recordsFromPage: page => page.listData.list,
    totalFromPage: page => page.listData.total,
    keyOf: item => item.userId,
    maxPages: 2,
    label: '比赛排行榜'
  }), /maxPages=2/);
});

test('Gateway 的非 JSON 500 会重试并返回后续成功数据', async () => {
  let calls = 0;
  const waits = [];
  const result = await requestAcgoApiWithRetry({
    method: 'GET',
    endpoint: '/example',
    maxAttempts: 3,
    makeRequest: async () => ++calls === 1
      ? response(500, '<html>upstream error</html>', 'text/html')
      : response(200, JSON.stringify({ code: 200, data: { ok: true } })),
    wait: async milliseconds => waits.push(milliseconds)
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [500]);
});

test('Gateway 429 按 Retry-After 重试', async () => {
  let calls = 0;
  const waits = [];
  await requestAcgoApiWithRetry({
    method: 'POST',
    endpoint: '/limited',
    maxAttempts: 2,
    makeRequest: async () => ++calls === 1
      ? response(429, 'too many requests', 'text/plain', { 'retry-after': '2' })
      : response(200, JSON.stringify({ code: 200, data: [] })),
    wait: async milliseconds => waits.push(milliseconds)
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
});

test('Gateway 非 JSON 400 不重试', async () => {
  let calls = 0;
  await assert.rejects(() => requestAcgoApiWithRetry({
    method: 'GET',
    endpoint: '/bad',
    maxAttempts: 3,
    makeRequest: async () => (calls++, response(400, 'bad request', 'text/plain')),
    wait: async () => {}
  }), /HTTP 400/);
  assert.equal(calls, 1);
});

test('responseStore 监听 context 中的新页并在 shapes 前 flush 异步解析', async () => {
  const context = new EventEmitter();
  const store = createMultiPageResponseStore(context);
  let release;
  const delayedJson = new Promise(resolve => { release = resolve; });
  context.emit('response', jsonResponse('https://www.acgo.cn/api/main?token=secret', { main: true }));
  context.emit('response', jsonResponse('https://gateway.acgo.cn/api/contest', delayedJson));
  context.emit('response', jsonResponse('https://example.com/not-acgo', { ignored: true }));

  const shapesPromise = store.shapes();
  release({ contest: { id: 1 } });
  const shapes = await shapesPromise;
  assert.equal(shapes.length, 2);
  assert.match(shapes[0].url, /token=%5BREDACTED%5D/);
  assert.match(shapes[1].url, /contest/);

  await store.dispose();
  context.emit('response', jsonResponse('https://www.acgo.cn/api/after', { ignored: true }));
  assert.equal((await store.shapes()).length, 2);
});

test('提交任务错误会聚合为严格失败，空错误集正常通过', () => {
  assert.doesNotThrow(() => throwIfCollectedFailures([], 2, '作业提交任务'));
  assert.throws(
    () => throwIfCollectedFailures([new Error('A'), new Error('B')], 3, '作业提交任务'),
    error => error instanceof AggregateError
      && error.errors.length === 2
      && /2\/3/.test(error.message)
  );
});

test('提交详情缺少代码时失败而不是静默过滤', () => {
  assert.equal(requireSubmissionCode('int main() {}', '7'), 'int main() {}');
  assert.throws(() => requireSubmissionCode('', '7'), /提交 7.*未返回代码/);
});

function records(start, count) {
  return Array.from({ length: count }, (_, index) => ({ userId: String(start + index) }));
}

function response(status, body, contentType = 'application/json', headers = {}) {
  return {
    status: () => status,
    ok: () => status >= 200 && status < 300,
    text: async () => body,
    headers: () => ({ 'content-type': contentType, ...headers })
  };
}

function jsonResponse(url, json) {
  return {
    url: () => url,
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    json: async () => await json
  };
}
