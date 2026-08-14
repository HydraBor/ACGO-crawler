import fs from 'node:fs/promises';
import { normalizeTeacherUserIds } from './filters.mjs';

const SUPPORTED_TARGETS = new Set(['homework', 'contest']);
const DEPRECATED_TOP_LEVEL_KEYS = [
  'packageName', 'excludedUserIds', 'dailySummaryPath', 'dailySummaryFile',
  'loginTimeoutMs', 'submissionConcurrency', 'autoLaunchBrowser',
  'browserExecutablePath', 'browserUserDataDirectory', 'browserLaunchTimeoutMs',
  'closeBrowserOnFinish', 'teamId', 'teamPageUrl', 'cleanOutput'
];

export async function loadConfigFile(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 ${filename}：${error.message}\n请先把 config.example.json 复制为 config.json。`, { cause: error });
  }
}

export function normalizeConfig(value) {
  if (!isPlainObject(value)) throw new Error('config.json 顶层必须是 JSON 对象。');
  rejectDeprecatedKeys(value, DEPRECATED_TOP_LEVEL_KEYS, 'config.json 顶层');
  const targets = normalizeTargets(value.targets);
  const browser = value.browser === undefined ? {} : value.browser;
  if (!isPlainObject(browser)) throw new Error('browser 必须是 JSON 对象。');

  return {
    ...value,
    targets,
    sessionName: String(value.sessionName || 'ACGO-代码证据包').trim() || 'ACGO-代码证据包',
    promptPath: String(value.promptPath || '提示词.md').trim() || '提示词.md',
    teacherUserIds: normalizeTeacherUserIds(value.teacherUserIds),
    cdpUrl: String(value.cdpUrl || 'http://127.0.0.1:9222').trim(),
    browser: { ...browser },
    homework: targets.includes('homework') ? buildHomeworkConfig(value.homework) : null,
    contest: targets.includes('contest') ? buildContestConfig(value.contest) : null
  };
}

export function buildHomeworkUrl({ homeworkId, teamCode, tab, groupId = '' }) {
  const url = new URL(`https://www.acgo.cn/homework/${homeworkId}`);
  url.searchParams.set('teamCode', teamCode);
  if (groupId) url.searchParams.set('groupId', groupId);
  url.searchParams.set('tab', tab);
  return url.href;
}

export function buildContestUrl({ page, contestId, matchRoundId = '', examId = '', openLevel = '', teamCode = '' }) {
  const url = new URL(`https://www.acgo.cn/contest/${page}/${contestId}`);
  if (matchRoundId) url.searchParams.set('matchRoundId', matchRoundId);
  if (examId) url.searchParams.set('examId', examId);
  if (openLevel) url.searchParams.set('openLevel', openLevel);
  if (teamCode) url.searchParams.set('teamCode', teamCode);
  return url.href;
}

function normalizeTargets(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('targets 必须是包含 homework、contest 或两者的非空数组。');
  }
  const targets = [...new Set(value.map(item => String(item || '').trim()))];
  const unsupported = targets.filter(target => !SUPPORTED_TARGETS.has(target));
  if (unsupported.length) throw new Error(`targets 包含不支持的值：${unsupported.join('、')}`);
  return targets;
}

function buildHomeworkConfig(value) {
  if (!isPlainObject(value)) throw new Error('已启用作业，但 homework 不是 JSON 对象。');
  rejectDeprecatedKeys(value, ['enabled', 'teamId', 'teamPageUrl'], 'homework');
  const id = String(value.id || '').trim();
  const teamCode = String(value.teamCode || '').trim();
  const groupId = String(value.groupId || '').trim();
  if (!id || !teamCode) throw new Error('作业配置不完整：请提供 homework.id 和 homework.teamCode。');
  return {
    id,
    teamCode,
    groupId,
    questionUrl: buildHomeworkUrl({ homeworkId: id, teamCode, tab: 'question', groupId }),
    rankingUrl: buildHomeworkUrl({ homeworkId: id, teamCode, tab: 'ranking', groupId })
  };
}

function buildContestConfig(value) {
  if (!isPlainObject(value)) throw new Error('已启用比赛，但 contest 不是 JSON 对象。');
  rejectDeprecatedKeys(value, ['enabled', 'teamId', 'teamPageUrl', 'label'], 'contest');
  const id = String(value.id || '').trim();
  const teamCode = String(value.teamCode || '').trim();
  if (!id || !teamCode) throw new Error('比赛配置不完整：请提供 contest.id 和 contest.teamCode。');
  const matchRoundId = String(value.matchRoundId || id).trim();
  const examId = String(value.examId || '').trim();
  const openLevel = String(value.openLevel || '').trim();
  const base = { contestId: id, matchRoundId, examId, openLevel, teamCode };
  return {
    id,
    matchRoundId,
    examId,
    openLevel,
    teamCode,
    detailUrl: value.detailUrl || buildContestUrl({ contestId: id, teamCode, page: 'detail' }),
    questionUrl: buildContestUrl({ ...base, page: 'question' }),
    rankingUrl: buildContestUrl({ ...base, page: 'ranking' })
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectDeprecatedKeys(value, keys, location) {
  const found = keys.filter(key => Object.prototype.hasOwnProperty.call(value, key));
  if (found.length) {
    throw new Error(`${location} 包含 2.0 已移除的旧字段：${found.join('、')}。请按 config.example.json 更新配置。`);
  }
}
