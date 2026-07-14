import TurndownService from 'turndown';
import turndownPluginGfm from 'turndown-plugin-gfm';

export function htmlToMarkdown(html, baseUrl = '') {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*'
  });
  service.use(turndownPluginGfm.gfm);

  service.addRule('fencedPre', {
    filter: node => node.nodeName === 'PRE',
    replacement(content, node) {
      const code = node.textContent.replace(/\n+$/, '');
      return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
    }
  });

  service.addRule('absoluteImages', {
    filter: 'img',
    replacement(content, node) {
      const alt = node.getAttribute('alt') || '';
      const src = absoluteUrl(node.getAttribute('src') || '', baseUrl);
      return src ? `![${alt}](${src})` : '';
    }
  });

  service.addRule('absoluteLinks', {
    filter: 'a',
    replacement(content, node) {
      const href = absoluteUrl(node.getAttribute('href') || '', baseUrl);
      const label = content.trim() || href;
      return href ? `[${label}](${href})` : label;
    }
  });

  return cleanupMarkdown(service.turndown(html));
}

function absoluteUrl(value, baseUrl) {
  if (!value || value.startsWith('data:')) return value;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

export function cleanupMarkdown(markdown) {
  return normalizeMathBackslashes(String(markdown || ''))
    .replace(/\u00a0/g, ' ')
    .replace(/["“]`([^`\n]+)`["”]/g, '`"$1"`')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeMathBackslashes(markdown) {
  return markdown.replace(/\$\$[\s\S]*?\$\$|\$(?!\$)[^$\n]*\$/g, formula => {
    const delimiterLength = formula.startsWith('$$') ? 2 : 1;
    const delimiter = '$'.repeat(delimiterLength);
    const content = formula.slice(delimiterLength, -delimiterLength)
      // Turndown 会把公式命令中的单个反斜杠再次转义。
      // 仅还原“反斜杠 + TeX 命令/转义字符”，保留公式中的合法换行命令 \\\\。
      .replace(/\\\\(?=[A-Za-z{}_%#&])/g, '\\');
    return `${delimiter}${content}${delimiter}`;
  });
}

const TOP_LEVEL_SECTIONS = new Set([
  '题目描述',
  '输入格式',
  '输出格式',
  '输入输出样例',
  '说明/提示'
]);

/**
 * 从 ACGO 整页转换结果中只保留正式题面，并统一 Markdown 层级。
 */
export function normalizeProblemMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const titleIndex = lines.findIndex(line => /^#{1,6}\s+[A-Za-z]{1,10}\d+\s*[.．].+/.test(line.trim()));
  if (titleIndex < 0) {
    return { title: '', difficulty: '', body: cleanupMarkdown(markdown) };
  }

  const title = lines[titleIndex]
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  let endIndex = findProblemEnd(lines, titleIndex + 1);
  if (endIndex <= titleIndex) endIndex = lines.length;
  const problemLines = lines.slice(titleIndex + 1, endIndex);

  const firstSectionIndex = problemLines.findIndex(line => getTopLevelSection(line));
  const metadataLines = firstSectionIndex >= 0 ? problemLines.slice(0, firstSectionIndex) : problemLines;
  const difficulty = metadataLines
    .map(line => line.replace(/^[-*]\s+/, '').trim())
    .find(line => /^(入门|普及(?:[\/／]提高)?|提高(?:[+＋]?\/省选[-−]?)?|省选|NOI(?:[\/／]NOI\+)?|暂无评定)$/.test(line)) || '';

  const sections = [];
  let current = null;
  for (const originalLine of problemLines.slice(Math.max(0, firstSectionIndex))) {
    const sectionName = getTopLevelSection(originalLine);
    if (sectionName) {
      current = { name: sectionName, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(originalLine);
  }

  const rendered = [];
  for (const section of sections) {
    let contentLines = trimBlankLines(section.lines);
    if (section.name === '输入输出样例') contentLines = normalizeSamples(contentLines);
    else contentLines = normalizeNestedHeadings(contentLines);
    rendered.push(`### ${section.name}`, '', ...contentLines, '');
  }

  return {
    title,
    difficulty,
    body: cleanupMarkdown(rendered.join('\n'))
  };
}

function getTopLevelSection(line) {
  const match = String(line || '').trim().match(/^#{1,6}\s*(题目描述|输入格式|输出格式|输入输出样例|说明\s*[\/／]\s*提示)\s*$/);
  if (!match) return '';
  const normalized = match[1].replace(/\s+/g, '').replace('／', '/');
  return TOP_LEVEL_SECTIONS.has(normalized) ? normalized : '';
}

function findProblemEnd(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index].trim();

    // 作业题目页会在正式题面后显示“作业名称 + 当前题/总题数”。
    if (/^\d+\s*\/\s*\d+$/.test(line)) {
      let previous = index - 1;
      while (previous >= startIndex && !lines[previous].trim()) previous--;
      let blockStart = previous;
      while (blockStart > startIndex && lines[blockStart - 1].trim()) blockStart--;
      return blockStart;
    }

    if (/^(测试点信息得分率|输入解题思路|提交验证|代码\s*$)/.test(line)) return index;
    if (/^\[首页\]\(https?:\/\/www\.acgo\.cn\/?\)/.test(line)) return index;
  }
  return lines.length;
}

function normalizeSamples(lines) {
  const unindented = lines.map(line => line.startsWith('    ') ? line.slice(4) : line);
  const result = [];

  for (const line of unindented) {
    const trimmed = line.trim();
    const input = trimmed.match(/^(?:[-*]\s*)?输入\s*#?\s*(\d+)\s*$/i);
    const output = trimmed.match(/^(?:[-*]\s*)?输出\s*#?\s*(\d+)\s*$/i);
    if (input || output) {
      while (result.length && !result.at(-1).trim()) result.pop();
      if (result.length) result.push('');
      result.push(`#### ${input ? '输入' : '输出'} #${(input || output)[1]}`, '');
      continue;
    }
    result.push(line);
  }

  return trimBlankLines(result);
}

function normalizeNestedHeadings(lines) {
  return trimBlankLines(lines.map(line => {
    const match = line.trim().match(/^#{1,6}\s+(.+)$/);
    if (!match) return line;
    return `#### ${match[1].trim()}`;
  }));
}

function trimBlankLines(lines) {
  let left = 0;
  let right = lines.length;
  while (left < right && !lines[left].trim()) left++;
  while (right > left && !lines[right - 1].trim()) right--;
  return lines.slice(left, right);
}

export function languageFence(language = '', code = '') {
  const value = `${language}`.toLowerCase();
  if (/c\+\+|cpp|gnu\+\+/.test(value)) return 'cpp';
  if (/python|pypy/.test(value)) return 'python';
  if (/java/.test(value)) return 'java';
  if (/javascript|node/.test(value)) return 'javascript';
  if (/typescript/.test(value)) return 'typescript';
  if (/go(lang)?/.test(value)) return 'go';
  if (/rust/.test(value)) return 'rust';
  if (/^c$|gnu c/.test(value)) return 'c';
  if (/pascal/.test(value)) return 'pascal';
  if (/^\s*#include\s*</m.test(code)) return 'cpp';
  return '';
}

export function escapeTable(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

export function formatProblemHeading(index, originalTitle) {
  const rawTitle = String(originalTitle || '未命名题目');
  const title = rawTitle.replace(/^[A-Za-z]{1,10}\d+\s*[.．]\s*/, '').trim() || rawTitle;
  return `第${toChineseNumber(index)}题：${title}`;
}

function toChineseNumber(value) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number >= 100) return String(value);
  if (number < 10) return digits[number];
  const tens = Math.floor(number / 10);
  const ones = number % 10;
  return `${tens === 1 ? '' : digits[tens]}十${ones ? digits[ones] : ''}`;
}
