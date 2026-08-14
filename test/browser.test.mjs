import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  acquireBrowser,
  browserExecutableCandidates,
  browserOptions,
  createDedicatedWorkPage,
  findBrowserExecutable,
  isManagedBrowserEndpoint,
  parseLocalCdpEndpoint
} from '../src/browser.mjs';

test('任务始终新建专用标签页，不接管油猴或其他已有标签', async () => {
  const extensionPage = { url: () => 'chrome-extension://example/options.html' };
  const personalPage = { url: () => 'https://example.com/' };
  const workPage = { url: () => 'about:blank' };
  let calls = 0;
  const context = {
    pages: () => [extensionPage, personalPage],
    newPage: async () => { calls++; return workPage; }
  };
  assert.equal(await createDedicatedWorkPage(context), workPage);
  assert.equal(calls, 1);
  assert.deepEqual(context.pages(), [extensionPage, personalPage]);
});

test('本程序自启动的专用 Edge 复用唯一首页标签，不再额外弹出第二个页面', async () => {
  const homePage = { url: () => 'https://www.acgo.cn/', isClosed: () => false };
  let newPageCalls = 0;
  const context = {
    pages: () => [homePage],
    newPage: async () => { newPageCalls++; throw new Error('不应新建第二个页面'); }
  };
  assert.equal(await createDedicatedWorkPage(context, { reuseExisting: true }), homePage);
  assert.equal(newPageCalls, 0);
});

test('专用 Edge 恢复首页和 403 时只保留首页，关闭其余遗留页面', async () => {
  let closed403 = 0;
  const forbiddenPage = { url: () => 'https://www.acgo.cn/403', isClosed: () => false, close: async () => { closed403++; } };
  const homePage = { url: () => 'https://www.acgo.cn/', isClosed: () => false, close: async () => {} };
  const context = { pages: () => [forbiddenPage, homePage], newPage: async () => { throw new Error('不应新建页面'); } };
  assert.equal(await createDedicatedWorkPage(context, { reuseExisting: true, closeOtherPages: true }), homePage);
  assert.equal(closed403, 1);
});

test('普通外接浏览器即使已有首页和 403，也只新建任务页且不关闭原标签', async () => {
  let closeCalls = 0;
  const oldPages = [
    { url: () => 'https://www.acgo.cn/', close: async () => { closeCalls++; } },
    { url: () => 'https://www.acgo.cn/403', close: async () => { closeCalls++; } }
  ];
  const workPage = { url: () => 'about:blank' };
  const context = { pages: () => oldPages, newPage: async () => workPage };
  assert.equal(await createDedicatedWorkPage(context), workPage);
  assert.equal(closeCalls, 0);
});

test('只在 DevToolsActivePort 与当前浏览器 ID 一致时识别为专用 profile', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/current-id' }) });
  assert.equal(await isManagedBrowserEndpoint('http://127.0.0.1:9222', 'C:\\profile', {
    fetchImpl,
    readFile: async () => '9222\n/devtools/browser/current-id\n'
  }), true);
  assert.equal(await isManagedBrowserEndpoint('http://127.0.0.1:9222', 'C:\\profile', {
    fetchImpl,
    readFile: async () => '9222\n/devtools/browser/stale-id\n'
  }), false);
});

test('自启动上下文没有可复用页面时仍能创建任务标签', async () => {
  const workPage = { url: () => 'about:blank' };
  const context = { pages: () => [], newPage: async () => workPage };
  assert.equal(await createDedicatedWorkPage(context, { reuseExisting: true }), workPage);
});

test('browserOptions uses the 2.0 root CDP endpoint and nested browser settings', () => {
  assert.deepEqual(browserOptions({
    cdpUrl: 'http://127.0.0.1:8111',
    browser: {
      autoLaunch: false,
      executablePath: 'nested-edge.exe',
      userDataDir: 'nested-profile',
      startupTimeoutMs: 1234,
      closeOnFinish: false,
      closeOnFailure: true,
      startUrl: 'about:blank'
    }
  }), {
    cdpUrl: 'http://127.0.0.1:8111',
    autoLaunch: false,
    executablePath: 'nested-edge.exe',
    userDataDir: 'nested-profile',
    startupTimeoutMs: 1234,
    closeOnFinish: false,
    closeOnFailure: true,
    startUrl: 'about:blank'
  });

  const defaults = browserOptions();
  assert.equal(defaults.cdpUrl, 'http://127.0.0.1:9222');
  assert.equal(defaults.autoLaunch, true);
  assert.equal(defaults.startupTimeoutMs, 20000);
});

test('parseLocalCdpEndpoint accepts only valid local HTTP endpoints', () => {
  assert.deepEqual(parseLocalCdpEndpoint('http://127.0.0.1:9222/'), {
    url: 'http://127.0.0.1:9222', hostname: '127.0.0.1', port: 9222
  });
  assert.deepEqual(parseLocalCdpEndpoint('http://localhost:9333'), {
    url: 'http://localhost:9333', hostname: 'localhost', port: 9333
  });
  assert.deepEqual(parseLocalCdpEndpoint('http://[::1]:9444'), {
    url: 'http://[::1]:9444', hostname: '::1', port: 9444
  });
  assert.equal(parseLocalCdpEndpoint('https://127.0.0.1:9222'), null);
  assert.equal(parseLocalCdpEndpoint('http://192.168.1.2:9222'), null);
  assert.equal(parseLocalCdpEndpoint('not a URL'), null);
});

test('browser executable candidates keep every Edge location ahead of Chrome', () => {
  const candidates = browserExecutableCandidates({
    'ProgramFiles(x86)': 'C:\\PF86',
    ProgramFiles: 'C:\\PF64',
    LOCALAPPDATA: 'C:\\Local'
  });
  const edgeIndexes = candidates
    .map((candidate, index) => /Microsoft[\\/]Edge/i.test(candidate) ? index : -1)
    .filter(index => index >= 0);
  const chromeIndexes = candidates
    .map((candidate, index) => /Google[\\/]Chrome/i.test(candidate) ? index : -1)
    .filter(index => index >= 0);
  assert.equal(edgeIndexes.length, 3);
  assert.equal(chromeIndexes.length, 3);
  assert.ok(Math.max(...edgeIndexes) < Math.min(...chromeIndexes));
});

test('findBrowserExecutable honors an explicit path without probing fallback candidates', async () => {
  const checked = [];
  const configuredPath = path.join('fixtures', 'custom-msedge.exe');
  const result = await findBrowserExecutable({
    configuredPath,
    env: {},
    access: async candidate => checked.push(candidate)
  });
  assert.equal(result.executablePath, path.resolve(configuredPath));
  assert.deepEqual(checked, [path.resolve(configuredPath)]);
  assert.deepEqual(result.checked, checked);
});

test('findBrowserExecutable selects Edge before an available Chrome fallback', async () => {
  const env = {
    'ProgramFiles(x86)': 'C:\\PF86',
    ProgramFiles: 'C:\\PF64',
    LOCALAPPDATA: 'C:\\Local'
  };
  const checked = [];
  const candidates = browserExecutableCandidates(env);
  const availableEdge = candidates[1];
  const availableChrome = candidates.find(candidate => /Google[\\/]Chrome/i.test(candidate));
  const result = await findBrowserExecutable({
    env,
    access: async candidate => {
      checked.push(candidate);
      if (candidate !== availableEdge && candidate !== availableChrome) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
  });
  assert.equal(result.executablePath, availableEdge);
  assert.ok(!checked.includes(availableChrome), 'Chrome must not be probed after an available Edge is found');
});

test('acquireBrowser connects to an existing endpoint without spawning a process', async () => {
  const fake = fakeBrowser();
  let spawnCalls = 0;
  const session = await acquireBrowser({ browser: { cdpUrl: 'http://127.0.0.1:9551' } }, {
    chromiumImpl: { connectOverCDP: async () => fake.browser },
    spawnImpl: () => { spawnCalls++; throw new Error('must not spawn'); },
    logger: silentLogger
  });

  assert.equal(session.launchedByUs, false);
  assert.equal(session.context, fake.context);
  assert.equal(session.product, 'Microsoft Edge/151.0.0.0');
  assert.equal(spawnCalls, 0);
  await session.dispose({ successful: true });
  assert.equal(fake.browserCloseCommands, 0, 'existing browser stays open by default');
  assert.equal(fake.disconnectCalls, 1);
});

test('acquireBrowser auto-launches after connection failure and reconnects over CDP', async () => {
  const fake = fakeBrowser();
  const child = fakeChild();
  const connectUrls = [];
  const spawnCalls = [];
  const mkdirCalls = [];
  let connectAttempt = 0;
  const edgePath = path.resolve('C:\\Fake\\Microsoft\\Edge\\Application\\msedge.exe');
  const profilePath = path.resolve('tmp-edge-profile');

  const session = await acquireBrowser({
    cdpUrl: 'http://127.0.0.1:9552',
    browser: {
      executablePath: edgePath,
      userDataDir: profilePath,
      startupTimeoutMs: 1000,
      startUrl: 'about:blank'
    }
  }, {
    chromiumImpl: {
      connectOverCDP: async url => {
        connectUrls.push(url);
        if (++connectAttempt === 1) throw new Error('ECONNREFUSED');
        return fake.browser;
      }
    },
    spawnImpl: (...args) => (spawnCalls.push(args), child),
    fetchImpl: async url => ({
      ok: true,
      status: 200,
      json: async () => ({ webSocketDebuggerUrl: `ws://${new URL(url).host}/devtools/browser/mock` })
    }),
    platform: 'win32',
    access: async candidate => assert.equal(candidate, edgePath),
    mkdir: async (...args) => mkdirCalls.push(args),
    logger: silentLogger
  });

  assert.deepEqual(connectUrls, ['http://127.0.0.1:9552', 'http://127.0.0.1:9552']);
  assert.equal(session.launchedByUs, true);
  assert.equal(session.executablePath, edgePath);
  assert.equal(session.userDataDir, profilePath);
  assert.equal(spawnCalls.length, 1);
  const [spawnExecutable, launchArgs, spawnOptions] = spawnCalls[0];
  assert.equal(spawnExecutable, edgePath);
  assert.ok(launchArgs.includes('--remote-debugging-port=9552'));
  assert.ok(launchArgs.includes(`--user-data-dir=${profilePath}`));
  assert.ok(launchArgs.includes('--disable-extensions'));
  assert.ok(launchArgs.includes('--edge-skip-compat-layer-relaunch'));
  assert.ok(launchArgs.includes('about:blank'));
  assert.equal(spawnOptions.shell, false);
  assert.deepEqual(mkdirCalls, [[profilePath, { recursive: true }]]);
  child.exitCode = 0;
  await session.dispose({ successful: true });
  assert.equal(fake.browserCloseCommands, 1);
});

test('dispose is idempotent and inspect mode only disconnects without Browser.close', async () => {
  const fake = fakeBrowser();
  const session = await acquireBrowser({
    browser: { closeOnFinish: true }
  }, {
    chromiumImpl: { connectOverCDP: async () => fake.browser },
    logger: silentLogger
  });

  const first = session.dispose({ successful: true, inspectOnly: true });
  const second = session.dispose({ successful: true, inspectOnly: false });
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(fake.browserCloseCommands, 0);
  assert.equal(fake.disconnectCalls, 1);
});

test('successful full run sends Browser.close when closeOnFinish is enabled', async () => {
  const fake = fakeBrowser();
  const session = await acquireBrowser({
    browser: { closeOnFinish: true }
  }, {
    chromiumImpl: { connectOverCDP: async () => fake.browser },
    logger: silentLogger
  });

  await session.dispose({ successful: true });
  assert.equal(fake.browserCloseCommands, 1);
  assert.equal(fake.disconnectCalls, 1);
});

const silentLogger = { log() {}, warn() {}, error() {} };

function fakeBrowser() {
  const context = { marker: 'context' };
  let browserCloseCommands = 0;
  let disconnectCalls = 0;
  const browser = {
    contexts: () => [context],
    newContext: async () => { throw new Error('existing context should be used'); },
    newBrowserCDPSession: async () => ({
      send: async method => {
        if (method === 'Browser.getVersion') return { product: 'Microsoft Edge/151.0.0.0' };
        if (method === 'Browser.close') {
          browserCloseCommands++;
          return {};
        }
        throw new Error(`unexpected CDP command: ${method}`);
      },
      detach: async () => {}
    }),
    close: async () => { disconnectCalls++; }
  };
  return {
    browser,
    context,
    get browserCloseCommands() { return browserCloseCommands; },
    get disconnectCalls() { return disconnectCalls; }
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.unref = () => {};
  child.kill = () => {
    child.exitCode = 0;
    child.emit('exit', 0);
    return true;
  };
  return child;
}
