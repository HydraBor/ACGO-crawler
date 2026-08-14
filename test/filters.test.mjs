import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTeacherUserIdMatcher,
  isTeacherUserId,
  normalizeTeacherUserIds,
  rebaseCompetitionRanks
} from '../src/filters.mjs';

test('教师用户 ID 统一转字符串、去空白并稳定去重', () => {
  assert.deepEqual(
    normalizeTeacherUserIds([' 4741656 ', 4741656, '', null, undefined, '0007', '0007']),
    ['4741656', '0007']
  );
  assert.deepEqual(normalizeTeacherUserIds(' 4741656 '), ['4741656']);
  assert.deepEqual(normalizeTeacherUserIds(undefined), []);
});

test('教师用户 ID 只做完整字符串匹配', () => {
  const ids = normalizeTeacherUserIds(['4741656', '0007']);
  assert.equal(isTeacherUserId('4741656', ids), true);
  assert.equal(isTeacherUserId(4741656, ids), true);
  assert.equal(isTeacherUserId(' 4741656 ', ids), true);
  assert.equal(isTeacherUserId('474165', ids), false);
  assert.equal(isTeacherUserId('14741656', ids), false);
  assert.equal(isTeacherUserId(7, ids), false);
  assert.equal(isTeacherUserId('', ids), false);
  assert.equal(isTeacherUserId(null, ids), false);
});

test('教师 ID matcher 可复用规范化集合', () => {
  const matcher = createTeacherUserIdMatcher(['4741656', ' 4741656 ', '8']);
  assert.deepEqual(matcher.teacherUserIds, ['4741656', '8']);
  assert.equal(matcher.excludes('4741656'), true);
  assert.equal(matcher.excludes('47'), false);
});

test('过滤账号后压缩名次但保留并列组', () => {
  const records = [{ rank: 2 }, { rank: 3 }, { rank: 4 }, { rank: 4 }, { rank: 6 }];
  assert.deepEqual(rebaseCompetitionRanks(records, record => record.rank), [1, 2, 3, 3, 5]);
  assert.deepEqual(rebaseCompetitionRanks([{}, {}, {}], record => record.rank), [1, 2, 3]);
});
