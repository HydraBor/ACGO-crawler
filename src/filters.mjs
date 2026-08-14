/**
 * 把配置中的教师 ACGO 用户 ID 规范为可安全比较的字符串数组。
 *
 * 用户 ID 可能来自 JSON 数字、字符串或单个值。这里始终按字符串处理，
 * 避免业务代码使用 Number 后产生精度问题。空值会被忽略，顺序保持稳定。
 */
export function normalizeTeacherUserIds(value) {
  const values = Array.isArray(value) ? value : [value];
  const unique = new Set();

  for (const item of values) {
    if (item === null || item === undefined) continue;
    const userId = String(item).trim();
    if (userId) unique.add(userId);
  }

  return [...unique];
}

/**
 * 严格判断一个 ACGO 用户 ID 是否位于教师排除列表中。
 *
 * 此函数不做子串、数值或姓名匹配。调用方可以传规范化数组、Set，或原始配置值。
 */
export function isTeacherUserId(userId, teacherUserIds = []) {
  if (userId === null || userId === undefined) return false;
  const candidate = String(userId).trim();
  if (!candidate) return false;

  if (teacherUserIds instanceof Set) return teacherUserIds.has(candidate);
  return normalizeTeacherUserIds(teacherUserIds).includes(candidate);
}

/**
 * 供大量记录过滤时复用，避免每次判断都重新构造集合。
 */
export function createTeacherUserIdMatcher(value) {
  const teacherUserIds = normalizeTeacherUserIds(value);
  const teacherUserIdSet = new Set(teacherUserIds);
  return {
    teacherUserIds,
    excludes: userId => isTeacherUserId(userId, teacherUserIdSet)
  };
}

/**
 * 在过滤部分账号后重新压缩竞赛名次，同时保留原榜单的并列组。
 * 例如原名次 2,3,4,4,6（第 1 名被排除）会变为 1,2,3,3,5。
 */
export function rebaseCompetitionRanks(items, sourceRankOf) {
  let previousSourceRank = '';
  let previousDisplayRank = 0;
  return [...(items || [])].map((item, index) => {
    const sourceRank = String(sourceRankOf?.(item) ?? '').trim();
    const isTiedWithPrevious = index > 0 && sourceRank && sourceRank === previousSourceRank;
    const displayRank = isTiedWithPrevious ? previousDisplayRank : index + 1;
    previousSourceRank = sourceRank;
    previousDisplayRank = displayRank;
    return displayRank;
  });
}
