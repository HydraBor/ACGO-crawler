import { cleanupMarkdown } from './markdown.mjs';

export function buildQuestionDataUrl({ buildId, questionId, homeworkId, teamCode }) {
  const url = new URL(`https://www.acgo.cn/_next/data/${encodeURIComponent(buildId)}/problemset/info/${encodeURIComponent(questionId)}.json`);
  url.searchParams.set('questionId', String(questionId));
  if (homeworkId) url.searchParams.set('homeworkId', String(homeworkId));
  if (teamCode) url.searchParams.set('teamCode', String(teamCode));
  return url.href;
}

export function problemFromNextData(payload, sourcePageUrl = '') {
  const pageProps = payload?.pageProps || payload?.props?.pageProps || payload;
  const info = pageProps?.questionInfo;
  if (!info?.questionId) throw new Error('Next Data 中缺少 pageProps.questionInfo');
  const type = info.questionTypeObject || {};
  const sections = [];

  addSection(sections, '题目描述', info.questionStem);
  addSection(sections, '输入格式', type.input);
  addSection(sections, '输出格式', type.output);

  const examples = Array.isArray(type.exampleGroupList) ? type.exampleGroupList : [];
  if (examples.length) {
    const sampleLines = ['### 输入输出样例', ''];
    examples.forEach((example, index) => {
      const number = index + 1;
      sampleLines.push(`#### 输入 #${number}`, '');
      if (example?.inputSample !== null && example?.inputSample !== undefined && String(example.inputSample) !== '') {
        sampleLines.push('```text', String(example.inputSample).replace(/\r\n/g, '\n').replace(/\n+$/, ''), '```', '');
      }
      sampleLines.push(`#### 输出 #${number}`, '');
      if (example?.outputSample !== null && example?.outputSample !== undefined && String(example.outputSample) !== '') {
        sampleLines.push('```text', String(example.outputSample).replace(/\r\n/g, '\n').replace(/\n+$/, ''), '```', '');
      }
    });
    sections.push(sampleLines.join('\n').trim());
  }

  addSection(sections, '说明/提示', type.instruction);

  return {
    questionId: String(info.questionId),
    title: `${info.questionCode || ''}${info.questionCode ? '.' : ''}${info.questionTitle || '未命名题目'}`,
    difficulty: info.difficultyObject?.tagTitle || '',
    timeLimit: info.timeLimit || '',
    memoryLimit: info.memoryLimit || '',
    url: sourcePageUrl,
    markdown: cleanupMarkdown(sections.filter(Boolean).join('\n\n')),
    knowledgeList: type.knowledgeList || []
  };
}

function addSection(sections, title, content) {
  if (content === null || content === undefined || String(content).trim() === '') return;
  sections.push(`### ${title}\n\n${String(content).replace(/\r\n/g, '\n').trim()}`);
}
