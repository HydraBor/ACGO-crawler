const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export async function waitForAcgoLogin(page, {
  timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  prepareLogin,
  resume,
  logger = console,
  now = Date.now,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
} = {}) {
  if (typeof page?.isClosed === 'function' && page.isClosed()) {
    throw loginError('检测登录状态时浏览器页面已被关闭，请保持登录窗口打开后重试', 'LOGIN_PAGE_CLOSED');
  }
  const limit = positiveMilliseconds(timeoutMs, DEFAULT_LOGIN_TIMEOUT_MS);
  const interval = positiveMilliseconds(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const deadline = now() + limit;
  let waitedForLogin = false;
  let needsResume = false;
  let loginPagePrepared = false;
  let resumeAttempts = 0;
  let announced = false;
  let lastProbeError = null;

  while (true) {
    if (typeof page?.isClosed === 'function' && page.isClosed()) {
      throw loginError('等待登录时浏览器页面已被关闭，请保持登录窗口打开后重试', 'LOGIN_PAGE_CLOSED');
    }

    let state;
    try {
      state = await inspectAcgoLoginState(page);
      lastProbeError = null;
    } catch (error) {
      lastProbeError = error;
      if (now() >= deadline) {
        throw loginError(`无法确认 ACGO 登录状态：${error.message}`, 'LOGIN_CHECK_FAILED', error);
      }
      await wait(Math.min(interval, Math.max(0, deadline - now())));
      continue;
    }

    if (!state.loginRequired) {
      if (!waitedForLogin) return { waited: false };
      if (needsResume && typeof resume === 'function') {
        await resume();
        resumeAttempts++;
        needsResume = false;
        continue;
      }
      logger.log('已检测到 ACGO 登录成功，正在继续任务…');
      return { waited: true };
    }

    waitedForLogin = true;
    needsResume = true;
    if (state.accessDenied && resumeAttempts > 0) {
      throw loginError(
        'ACGO 登录已成功，但重新访问目标后仍显示无团队访问权限。请确认登录账号属于该团队，并检查团队 ID、作业 ID或竞赛 ID。',
        'ACGO_ACCESS_FORBIDDEN'
      );
    }
    if (!loginPagePrepared && typeof prepareLogin === 'function') {
      logger.log('检测到 ACGO 未登录或跳转到 403 页面，正在打开 ACGO 首页供你登录…');
      try {
        await prepareLogin();
      } catch (error) {
        throw loginError(`无法打开 ACGO 登录入口：${error.message}`, 'LOGIN_PREPARE_FAILED', error);
      }
      loginPagePrepared = true;
      continue;
    }
    if (!announced) {
      logger.log(`当前尚未登录 ACGO。请在已打开的 Edge/Chrome 中完成登录；程序会自动检测并继续（最长等待 ${formatMinutes(limit)} 分钟）。`);
      announced = true;
    }
    if (now() >= deadline) {
      const suffix = lastProbeError ? `；最后一次状态检查错误：${lastProbeError.message}` : '';
      throw loginError(`等待 ACGO 登录超时（${formatMinutes(limit)} 分钟）。请确认已在程序打开的浏览器中完成登录${suffix}`, 'LOGIN_TIMEOUT');
    }
    await wait(Math.min(interval, Math.max(0, deadline - now())));
    if (typeof page?.isClosed === 'function' && page.isClosed()) {
      throw loginError('等待登录时浏览器页面已被关闭，请保持登录窗口打开后重试', 'LOGIN_PAGE_CLOSED');
    }
  }
}

export async function isAcgoLoginRequired(page) {
  return (await inspectAcgoLoginState(page)).loginRequired;
}

async function inspectAcgoLoginState(page) {
  const url = String(page?.url?.() || '');
  const pathname = safePathname(url);
  let body;
  try {
    body = await page?.locator?.('body')?.innerText?.({ timeout: 3000 });
  } catch (error) {
    if (isLoginPath(pathname) || isAccessDeniedPath(pathname)) {
      return { loginRequired: true, accessDenied: isAccessDeniedPath(pathname), pathname };
    }
    throw loginError(`无法读取当前页面以检查登录状态：${error.message}`, 'LOGIN_CHECK_FAILED', error);
  }
  if (body === undefined || body === null) {
    throw loginError('无法读取当前页面以检查登录状态', 'LOGIN_CHECK_FAILED');
  }
  const text = String(body);
  const lines = text.split(/\r?\n/u).map(line => line.replace(/\s+/gu, ' ').trim()).filter(Boolean);
  const hasExactLoginEntry = lines.some(line => /^(?:登录|去登录|立即登录|账号登录)$/u.test(line));
  const hasExactRegisterEntry = lines.some(line => /^(?:注册|立即注册|免费注册)$/u.test(line));
  const explicitLoggedOutMessage = /(?:尚未|还未|未)登录|请(?:先|重新)?登录|登录后(?:才可|即可)|您不是团队成员，无法访问团队/u.test(text);
  const hasLoggedInMarker = /退出登录|个人中心|我的主页/u.test(text);
  const accessDenied = isAccessDeniedPath(pathname)
    || /您不是团队成员，无法访问团队|没有团队访问权限|无权访问(?:该|此)?团队/u.test(text);
  const loginRequired = isLoginPath(pathname)
    || accessDenied
    || explicitLoggedOutMessage
    || (!hasLoggedInMarker && hasExactLoginEntry && hasExactRegisterEntry);
  return { loginRequired, accessDenied, pathname };
}

function safePathname(value) {
  try {
    return new URL(value).pathname.toLowerCase();
  } catch {
    return '';
  }
}

function isLoginPath(pathname) {
  return /\/(?:login|signin|sign-in|auth)(?:\/|$)/iu.test(pathname);
}

function isAccessDeniedPath(pathname) {
  return /\/(?:401|403)(?:\/|$)/u.test(pathname);
}

function loginError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function positiveMilliseconds(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function formatMinutes(milliseconds) {
  return Math.max(1, Math.ceil(milliseconds / 60000));
}
