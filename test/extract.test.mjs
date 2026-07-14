import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeSubmissions } from '../src/extract.mjs';
import { cleanupMarkdown, formatProblemHeading, htmlToMarkdown, languageFence, normalizeProblemMarkdown } from '../src/markdown.mjs';
import { buildQuestionDataUrl, problemFromNextData } from '../src/problem-data.mjs';
import { renderBatchInstructions, renderFeedbackPrompt } from '../src/feedback.mjs';

test('重复提交按提交 ID 去重', () => {
  const result = dedupeSubmissions([
    { submissionId: '7', code: 'int main(){}', status: 'WA' },
    { submissionId: '7', code: 'int main(){}', status: 'AC' }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'AC');
});

test('HTML 转 Markdown 保留链接、图片和代码块', () => {
  const markdown = htmlToMarkdown('<h2>题目描述</h2><a href="/p/1">链接</a><pre>1 2 3</pre>', 'https://acgo.cn/x');
  assert.match(markdown, /## 题目描述/);
  assert.match(markdown, /https:\/\/acgo.cn\/p\/1/);
  assert.match(markdown, /```\n1 2 3\n```/);
});

test('识别 C++ Markdown 围栏', () => {
  assert.equal(languageFence('GNU C++17', ''), 'cpp');
});

test('过滤 ACGO 页面杂项并重新整理题面', () => {
  const pageMarkdown = `
[题目详情](https://www.acgo.cn/problemset/info/109981)

# T109981.第一个程序

入门

通过率：70.00%

时间限制：1.00s

内存限制：128MB

#### 题目描述

作为你入门第一个程序，请输出"\`Hello world\`"

#### 输入格式

无

#### 输出格式

一行，如描述

#### 输入输出样例

- 输入#1

    输出#1

    \`\`\`
    Hello world
    \`\`\`

XM01-DAY01-初识C++

1/19

C++

#include <bits/stdc++.h>
`;
  const result = normalizeProblemMarkdown(pageMarkdown);
  assert.equal(result.title, 'T109981.第一个程序');
  assert.equal(result.difficulty, '入门');
  assert.match(result.body, /^### 题目描述/m);
  assert.match(result.body, /^#### 输入 #1/m);
  assert.match(result.body, /^#### 输出 #1/m);
  assert.match(result.body, /`"Hello world"`/);
  assert.doesNotMatch(result.body, /通过率|XM01|#include|题目详情/);
});

test('HTML 表格转换为 GFM Markdown 表格', () => {
  const markdown = htmlToMarkdown('<table><thead><tr><th>测试点</th><th>a</th></tr></thead><tbody><tr><td>1~10</td><td>1≤a≤100000</td></tr></tbody></table>');
  assert.match(markdown, /\| 测试点 \| a \|/);
  assert.match(markdown, /\| 1~10 \| 1≤a≤100000 \|/);
});

test('只消除数学公式中被重复转义的反斜杠', () => {
  const markdown = cleanupMarkdown('$1\\\\sim 10$ 与 $a \\\\leq b$\n\n```cpp\ncout << "\\\\n";\n```');
  assert.match(markdown, /\$1\\sim 10\$/);
  assert.match(markdown, /\$a \\leq b\$/);
  assert.match(markdown, /cout << "\\\\n";/);
});

test('题面标题使用中文题序并去除 ACGO 题号', () => {
  assert.equal(formatProblemHeading(1, 'T109981.第一个程序'), '第一题：第一个程序');
  assert.equal(formatProblemHeading(10, 'T109688.小码君买文具'), '第十题：小码君买文具');
  assert.equal(formatProblemHeading(19, 'T111807.乘法练习'), '第十九题：乘法练习');
});

test('从 Next Data 结构直接生成规范题面', () => {
  const payload = {
    pageProps: {
      questionInfo: {
        questionId: 109981,
        questionCode: 'T109981',
        questionTitle: '第一个程序',
        questionStem: '作为你入门第一个程序，请输出"`Hello world`"',
        difficultyObject: { tagTitle: '入门' },
        timeLimit: '1.00s',
        memoryLimit: '128MB',
        questionTypeObject: {
          input: '无',
          output: '一行，如描述',
          exampleGroupList: [{ inputSample: '', outputSample: 'Hello world' }],
          instruction: '',
          knowledgeList: [{ knowledgeId: 463, knowledgeTitle: '输入输出' }]
        }
      }
    }
  };
  const problem = problemFromNextData(payload, 'https://www.acgo.cn/problemset/info/109981');
  assert.equal(problem.title, 'T109981.第一个程序');
  assert.equal(problem.difficulty, '入门');
  assert.equal(problem.timeLimit, '1.00s');
  assert.match(problem.markdown, /^### 题目描述/m);
  assert.match(problem.markdown, /^#### 输出 #1/m);
  assert.match(problem.markdown, /```text\nHello world\n```/);
  assert.doesNotMatch(problem.markdown, /^### 说明\/提示/m);
});

test('正确构造题目 Next Data 地址', () => {
  const url = new URL(buildQuestionDataUrl({
    buildId: 'build-1',
    questionId: 109981,
    homeworkId: 22113,
    teamCode: '1000000000000000000'
  }));
  assert.equal(url.pathname, '/_next/data/build-1/problemset/info/109981.json');
  assert.equal(url.searchParams.get('questionId'), '109981');
  assert.equal(url.searchParams.get('homeworkId'), '22113');
});

test('反馈提示词面向当前代码证据包结构', () => {
  const prompt = renderFeedbackPrompt({ dailySummaryMarkdown: '【今日学习目标】\n（1）掌握：变量和输入' });
  const instructions = renderBatchInstructions();
  assert.match(prompt, /今日总结/);
  assert.match(prompt, /变量和输入/);
  assert.match(prompt, /课堂练习\.md/);
  assert.match(prompt, /今日比赛\.md/);
  assert.match(instructions, /今日总结\.md/);
  assert.match(instructions, /作业题目\.md/);
  assert.match(instructions, /比赛题目\.md/);
  assert.doesNotMatch(`${prompt}\n${instructions}`, /只输出代码/);
});

