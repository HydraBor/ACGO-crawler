import assert from 'node:assert/strict';
import test from 'node:test';
import { isAcgoLoginRequired, waitForAcgoLogin } from '../src/login.mjs';

test('已登录页面不等待', async () => {
  const page = fakePage([{ url: 'https://www.acgo.cn/homework/1', body: '作业 题目 排行榜' }]);
  const result = await waitForAcgoLogin(page, { wait: async () => assert.fail('不应等待') });
  assert.deepEqual(result, { waited: false });
});

test('未登录时轮询，登录成功后返回给调用方恢复业务页', async () => {
  const page = fakePage([
    { url: 'https://www.acgo.cn/login', body: '请登录' },
    { url: 'https://www.acgo.cn/login', body: '请登录' },
    { url: 'https://www.acgo.cn/', body: '欢迎进入团队' }
  ]);
  let clock = 0;
  const logs = [];
  const result = await waitForAcgoLogin(page, {
    timeoutMs: 5000,
    pollIntervalMs: 1000,
    now: () => clock,
    wait: async milliseconds => { clock += milliseconds; page.advance(); },
    resume: async () => { page.gotoCalls.push('resume'); page.advance(); },
    logger: { log: message => logs.push(message) }
  });
  assert.deepEqual(result, { waited: true });
  assert.deepEqual(page.gotoCalls, ['resume']);
  assert.ok(logs.some(message => /自动检测/.test(message)));
  assert.ok(logs.some(message => /登录成功/.test(message)));
});

test('等待登录超时返回明确错误', async () => {
  const page = fakePage([{ url: 'https://www.acgo.cn/login', body: '请登录' }]);
  let clock = 0;
  await assert.rejects(() => waitForAcgoLogin(page, {
    timeoutMs: 2000,
    pollIntervalMs: 500,
    now: () => clock,
    wait: async milliseconds => { clock += milliseconds; },
    logger: { log() {} }
  }), error => error.code === 'LOGIN_TIMEOUT' && /等待 ACGO 登录超时/.test(error.message));
});

test('等待期间页面关闭会明确失败', async () => {
  const page = fakePage([{ url: 'https://www.acgo.cn/login', body: '请登录' }]);
  let clock = 0;
  await assert.rejects(() => waitForAcgoLogin(page, {
    timeoutMs: 2000,
    now: () => clock,
    wait: async milliseconds => { clock += milliseconds; page.closed = true; },
    logger: { log() {} }
  }), error => error.code === 'LOGIN_PAGE_CLOSED');
});

test('首次探测前页面已关闭也不能误判为已登录', async () => {
  const page = fakePage([{ url: 'https://www.acgo.cn/', body: '' }]);
  page.closed = true;
  await assert.rejects(
    () => waitForAcgoLogin(page, { logger: { log() {} } }),
    error => error.code === 'LOGIN_PAGE_CLOSED'
  );
});

test('登录页和已登录团队页识别正确', async () => {
  assert.equal(await isAcgoLoginRequired(fakePage([{ url: 'https://www.acgo.cn/login', body: '登录' }])), true);
  assert.equal(await isAcgoLoginRequired(fakePage([{ url: 'https://www.acgo.cn/team/1', body: '团队 登录记录' }])), false);
});

test('403 页面即使包含全站导航词也必须判定为未登录', async () => {
  const page = fakePage([{
    url: 'https://www.acgo.cn/403',
    body: '首页\n题库\n作业\n题目\n比赛\n团队\n登录\n注册\n您不是团队成员，无法访问团队'
  }]);
  assert.equal(await isAcgoLoginRequired(page), true);
});

test('403 时先打开 ACGO 首页等待登录，再恢复原目标页', async () => {
  const page = fakePage([
    { url: 'https://www.acgo.cn/403', body: '题目\n比赛\n团队\n登录\n注册' },
    { url: 'https://www.acgo.cn/', body: '首页\n题库\n比赛\n团队\n登录\n注册' },
    { url: 'https://www.acgo.cn/', body: '首页\n个人中心\n退出登录' },
    { url: 'https://www.acgo.cn/homework/1', body: '作业\n题目\n排行榜' }
  ]);
  let clock = 0;
  const calls = [];
  const result = await waitForAcgoLogin(page, {
    timeoutMs: 5000,
    pollIntervalMs: 500,
    now: () => clock,
    prepareLogin: async () => { calls.push('prepare'); page.advance(); },
    wait: async milliseconds => { clock += milliseconds; page.advance(); },
    resume: async () => { calls.push('resume'); page.advance(); },
    logger: { log() {} }
  });
  assert.deepEqual(result, { waited: true });
  assert.deepEqual(calls, ['prepare', 'resume']);
});

test('已确认登录但目标仍跳转 403 时返回明确的团队权限错误', async () => {
  const page = fakePage([
    { url: 'https://www.acgo.cn/403', body: '登录\n注册' },
    { url: 'https://www.acgo.cn/', body: '个人中心\n退出登录' },
    { url: 'https://www.acgo.cn/403', body: '您不是团队成员，无法访问团队' }
  ]);
  await assert.rejects(() => waitForAcgoLogin(page, {
    prepareLogin: async () => page.advance(),
    resume: async () => page.advance(),
    logger: { log() {} }
  }), error => error.code === 'ACGO_ACCESS_FORBIDDEN' && /团队访问权限/.test(error.message));
});

test('非 403 地址正文明确提示不是团队成员时也识别为权限状态', async () => {
  const page = fakePage([{
    url: 'https://www.acgo.cn/homework/1',
    body: '首页\n题库\n登录\n注册\n您不是团队成员，无法访问团队'
  }]);
  assert.equal(await isAcgoLoginRequired(page), true);
});

test('已登录页出现“退出登录”时不能误判为未登录', async () => {
  const page = fakePage([{
    url: 'https://www.acgo.cn/homework/1',
    body: '作业\n题目\n排行榜\n退出登录'
  }]);
  assert.equal(await isAcgoLoginRequired(page), false);
});

test('页面读取错误会重试，不能误判为已登录', async () => {
  let clock = 0;
  let calls = 0;
  const page = fakePage([{ url: 'https://www.acgo.cn/', body: '' }]);
  page.locator = () => ({ innerText: async () => {
    if (++calls < 3) throw new Error('execution context was destroyed');
    return '团队 题目';
  } });
  const result = await waitForAcgoLogin(page, {
    timeoutMs: 3000,
    pollIntervalMs: 500,
    now: () => clock,
    wait: async milliseconds => { clock += milliseconds; },
    logger: { log() {} }
  });
  assert.deepEqual(result, { waited: false });
  assert.equal(calls, 3);
});

test('持续无法读取页面时返回 LOGIN_CHECK_FAILED', async () => {
  let clock = 0;
  const page = fakePage([{ url: 'https://www.acgo.cn/', body: '' }]);
  page.locator = () => ({ innerText: async () => { throw new Error('page crashed'); } });
  await assert.rejects(() => waitForAcgoLogin(page, {
    timeoutMs: 1000,
    pollIntervalMs: 500,
    now: () => clock,
    wait: async milliseconds => { clock += milliseconds; },
    logger: { log() {} }
  }), error => error.code === 'LOGIN_CHECK_FAILED');
});

function fakePage(states) {
  let index = 0;
  const page = {
    closed: false,
    gotoCalls: [],
    url: () => states[Math.min(index, states.length - 1)].url,
    locator: () => ({ innerText: async () => states[Math.min(index, states.length - 1)].body }),
    isClosed: () => page.closed,
    advance: () => { index = Math.min(index + 1, states.length - 1); },
    goto: async url => { page.gotoCalls.push(url); }
  };
  return page;
}
