import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';

export function browserOptions(config = {}) {
  const nested = config.browser && typeof config.browser === 'object' ? config.browser : {};
  return {
    cdpUrl: String(config.cdpUrl || DEFAULT_CDP_URL),
    autoLaunch: nested.autoLaunch ?? true,
    executablePath: String(nested.executablePath || ''),
    userDataDir: String(nested.userDataDir || ''),
    startupTimeoutMs: positiveNumber(nested.startupTimeoutMs, 20000),
    closeOnFinish: nested.closeOnFinish,
    closeOnFailure: nested.closeOnFailure ?? false,
    startUrl: String(nested.startUrl || 'https://www.acgo.cn/')
  };
}

export function parseLocalCdpEndpoint(value) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_CDP_URL));
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return null;
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { url: url.href.replace(/\/$/, ''), hostname, port };
}

export function browserExecutableCandidates(env = process.env) {
  const candidates = [
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  return [...new Set(candidates.map(candidate => path.resolve(candidate)))];
}

export async function findBrowserExecutable({ configuredPath = '', env = process.env, access = fs.access } = {}) {
  const candidates = configuredPath
    ? [path.resolve(configuredPath)]
    : browserExecutableCandidates(env);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return { executablePath: candidate, checked: candidates };
    } catch {}
  }
  const label = configuredPath ? '配置的浏览器不存在' : '没有找到 Microsoft Edge 或 Google Chrome';
  throw new Error(`${label}。已检查：\n${candidates.map(candidate => `- ${candidate}`).join('\n') || '- （无可用候选路径）'}`);
}

export async function acquireBrowser(config = {}, dependencies = {}) {
  const options = browserOptions(config);
  const chromiumImpl = dependencies.chromiumImpl || chromium;
  const spawnImpl = dependencies.spawnImpl || spawn;
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const logger = dependencies.logger || console;
  const platform = dependencies.platform || process.platform;
  const env = dependencies.env || process.env;
  const access = dependencies.access || fs.access;
  const mkdir = dependencies.mkdir || fs.mkdir;
  const readFile = dependencies.readFile || fs.readFile;
  const managedUserDataDir = resolveUserDataDir(options, env);
  let initialError;

  try {
    const browser = await chromiumImpl.connectOverCDP(options.cdpUrl);
    const managedProfile = await isManagedBrowserEndpoint(options.cdpUrl, managedUserDataDir, { fetchImpl, readFile });
    return await createBrowserSession({
      browser,
      options,
      launchedByUs: false,
      managedProfile,
      logger,
      cdpUrl: options.cdpUrl,
      userDataDir: managedProfile ? managedUserDataDir : ''
    });
  } catch (error) {
    initialError = error;
  }

  if (!options.autoLaunch) {
    throw new Error(`无法连接浏览器调试端点 ${options.cdpUrl}，且自动启动已关闭：${initialError.message}`);
  }
  if (platform !== 'win32') {
    throw new Error(`无法连接浏览器调试端点 ${options.cdpUrl}。自动启动目前仅支持 Windows 10/11：${initialError.message}`);
  }

  const endpoint = parseLocalCdpEndpoint(options.cdpUrl);
  if (!endpoint) {
    throw new Error(`无法连接 ${options.cdpUrl}，且该地址不是本机 HTTP CDP 端点，程序不会自动启动本机浏览器：${initialError.message}`);
  }

  const resolved = await findBrowserExecutable({ configuredPath: options.executablePath, env, access });
  const userDataDir = managedUserDataDir;
  await mkdir(userDataDir, { recursive: true });

  const launchArgs = [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${endpoint.port}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check'
  ];
  if (/^msedge(?:\.exe)?$/i.test(path.basename(resolved.executablePath))) {
    // Current Windows Edge may otherwise relaunch itself through its
    // compatibility shim.  The replacement browser is no longer represented
    // by the ChildProcess returned from spawn(), so failure cleanup cannot
    // reliably terminate the instance that owns this temporary profile.
    launchArgs.push('--edge-skip-compat-layer-relaunch');
  }
  launchArgs.push(options.startUrl);
  logger.log(`未发现可连接的浏览器，正在启动：${path.basename(resolved.executablePath)}（端口 ${endpoint.port}）`);

  let child;
  try {
    child = spawnImpl(resolved.executablePath, launchArgs, {
      detached: false,
      shell: false,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref?.();
    await waitForCdp(endpoint.url, {
      timeoutMs: options.startupTimeoutMs,
      fetchImpl,
      child
    });
    const browser = await chromiumImpl.connectOverCDP(options.cdpUrl);
    return await createBrowserSession({
      browser,
      options,
      launchedByUs: true,
      managedProfile: true,
      child,
      logger,
      cdpUrl: options.cdpUrl,
      executablePath: resolved.executablePath,
      userDataDir
    });
  } catch (error) {
    await terminateOwnedProcess(child).catch(() => {});
    throw new Error(`自动启动浏览器失败（${resolved.executablePath}，${options.cdpUrl}）：${error.message}`);
  }
}

// Never navigate an arbitrary pre-existing tab. Extension welcome pages (for
// example Tampermonkey), personal browsing tabs and other ACGO pages all belong
// to the user, not to this run.
export async function createDedicatedWorkPage(context, { reuseExisting = false, closeOtherPages = false } = {}) {
  if (!context || typeof context.newPage !== 'function') {
    throw new Error('浏览器上下文不可用，无法创建任务专用标签页');
  }
  if (reuseExisting && typeof context.pages === 'function') {
    const pages = context.pages().filter(page => !page.isClosed?.());
    const existingPage = pages.find(page => isAcgoHome(page.url?.())) || pages.at(-1);
    if (existingPage) {
      if (closeOtherPages) {
        await Promise.allSettled(pages.filter(page => page !== existingPage).map(page => page.close()));
      }
      return existingPage;
    }
  }
  return context.newPage();
}

async function createBrowserSession({ browser, options, launchedByUs, managedProfile = launchedByUs, child, logger, cdpUrl, executablePath = '', userDataDir = '' }) {
  const contexts = browser.contexts();
  const context = contexts[0] || await browser.newContext();
  let product = '';
  try {
    const session = await browser.newBrowserCDPSession();
    product = String((await session.send('Browser.getVersion'))?.product || '');
    await session.detach().catch(() => {});
  } catch {}
  logger.log(`已连接浏览器${product ? `：${product}` : ''}`);

  let cleanupPromise;
  return {
    browser,
    context,
    product,
    launchedByUs,
    managedProfile,
    cdpUrl,
    executablePath,
    userDataDir,
    dispose({ successful = false, inspectOnly = false } = {}) {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        const shouldClose = !inspectOnly && (
          successful
            ? (managedProfile || options.closeOnFinish === true)
            : Boolean(options.closeOnFailure)
        );
        if (shouldClose) {
          try {
            const session = await browser.newBrowserCDPSession();
            await session.send('Browser.close');
          } catch {}
          if (launchedByUs) await waitForChildExit(child, 3000).catch(() => {});
        }
        await browser.close().catch(() => {});
        if (shouldClose && launchedByUs && child && child.exitCode === null) {
          await terminateOwnedProcess(child).catch(() => {});
        }
      })();
      return cleanupPromise;
    }
  };
}

export async function isManagedBrowserEndpoint(cdpUrl, userDataDir, { fetchImpl = globalThis.fetch, readFile = fs.readFile } = {}) {
  if (!parseLocalCdpEndpoint(cdpUrl) || !userDataDir) return false;
  try {
    const [devToolsFile, versionResponse] = await Promise.all([
      readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8'),
      fetchImpl(`${String(cdpUrl).replace(/\/$/, '')}/json/version`)
    ]);
    if (!versionResponse?.ok) return false;
    const version = await versionResponse.json();
    const lines = String(devToolsFile).split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    const activePath = lines[1] || '';
    const currentPath = new URL(String(version?.webSocketDebuggerUrl || '')).pathname;
    return /^\/devtools\/browser\//u.test(activePath) && activePath === currentPath;
  } catch {
    return false;
  }
}

async function waitForCdp(url, { timeoutMs, fetchImpl, child }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(`浏览器进程在调试端点就绪前退出（exitCode=${child.exitCode}）`);
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      try {
        const response = await fetchImpl(`${url}/json/version`, { signal: controller.signal });
        if (response.ok) {
          const body = await response.json();
          if (body?.webSocketDebuggerUrl) return body;
          lastError = new Error('端口可访问，但返回内容不是浏览器 CDP 信息');
        } else {
          lastError = new Error(`HTTP ${response.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`等待浏览器调试端点超时（${timeoutMs} ms）${lastError ? `：${lastError.message}` : ''}`);
}

async function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return;
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, timeoutMs))
  ]);
}

async function terminateOwnedProcess(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  child.kill();
  await waitForChildExit(child, 2000);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function resolveUserDataDir(options, env) {
  return options.userDataDir
    ? path.resolve(options.userDataDir)
    : path.join(env.LOCALAPPDATA || env.TEMP || process.cwd(), 'ACGO-Crawler', 'Edge-Profile');
}

function isAcgoHome(value) {
  try {
    const url = new URL(String(value || ''));
    return url.hostname === 'www.acgo.cn' && url.pathname === '/';
  } catch {
    return false;
  }
}
