import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContestUrl, buildHomeworkUrl, normalizeConfig } from '../src/config.mjs';

test('2.0 配置只启用 targets 中声明的目标并生成稳定 URL', () => {
  const config = normalizeConfig({
    targets: ['homework'],
    homework: { id: 24031, teamCode: '2042058713337094144', groupId: '7' },
    contest: { id: 9, teamCode: 'ignored' },
    teacherUserIds: [4741656, ' 4741656 '],
    browser: { autoLaunch: false }
  });
  assert.equal(config.contest, null);
  assert.equal(config.homework.id, '24031');
  assert.deepEqual(config.teacherUserIds, ['4741656']);
  const url = new URL(config.homework.questionUrl);
  assert.equal(url.pathname, '/homework/24031');
  assert.equal(url.searchParams.get('teamCode'), '2042058713337094144');
  assert.equal(url.searchParams.get('groupId'), '7');
  assert.equal(config.browser.autoLaunch, false);
});

test('2.0 配置拒绝隐式目标、未知目标和旧配置字段', () => {
  assert.throws(() => normalizeConfig({ homework: { id: 1, teamCode: 2 } }), /targets/);
  assert.throws(() => normalizeConfig({ targets: ['unknown'] }), /不支持/);
  assert.throws(() => normalizeConfig({ targets: ['homework'], homework: { id: 1, teamCode: 2 }, cleanOutput: true }), /2\.0 已移除的旧字段/);
  assert.throws(() => normalizeConfig({ targets: ['homework'], homework: { id: 1, teamCode: 2 }, autoLaunchBrowser: true }), /autoLaunchBrowser/);
});

test('2.0 配置对启用目标和 browser 结构做严格校验', () => {
  assert.throws(() => normalizeConfig({ targets: ['contest'], contest: null }), /contest 不是 JSON 对象/);
  assert.throws(() => normalizeConfig({ targets: ['homework'], homework: { id: 1, teamCode: 2 }, browser: true }), /browser 必须是 JSON 对象/);
});

test('作业和比赛 URL 构造器保留必要参数', () => {
  const homework = new URL(buildHomeworkUrl({ homeworkId: '10', teamCode: '20', tab: 'ranking' }));
  assert.equal(homework.href, 'https://www.acgo.cn/homework/10?teamCode=20&tab=ranking');
  const contest = new URL(buildContestUrl({ page: 'question', contestId: '30', matchRoundId: '31', examId: '32', openLevel: '1', teamCode: '20' }));
  assert.equal(contest.pathname, '/contest/question/30');
  assert.equal(contest.searchParams.get('matchRoundId'), '31');
  assert.equal(contest.searchParams.get('examId'), '32');
});
