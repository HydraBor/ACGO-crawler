import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadPrompt, PROMPT_OUTPUT_PATH, promptMetadata } from '../src/prompt.mjs';

test('未配置 promptPath 时必须读取配置目录的提示词.md', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acgo-default-prompt-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, '提示词.md'), '老师的正式提示词\n', 'utf8');

  const result = await loadPrompt({ configDirectory: directory });
  const emptyPathResult = await loadPrompt({ promptPath: '   ', configDirectory: directory });
  assert.equal(result.metadata.mode, 'custom');
  assert.equal(result.metadata.sourceName, '提示词.md');
  assert.equal(result.metadata.output, PROMPT_OUTPUT_PATH);
  assert.match(result.metadata.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.markdown, '老师的正式提示词');
  assert.equal(result.metadata.sha256, createHash('sha256').update('老师的正式提示词\n', 'utf8').digest('hex'));
  assert.equal('sourcePath' in result.metadata, false);
  assert.equal('markdown' in result.metadata, false);
  assert.deepEqual(emptyPathResult, result);
});

test('自定义 promptPath 相对配置目录读取并生成安全元数据', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acgo-prompt-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, '提示词.md'), '\uFEFF自定义提示词\r\n\r\n请结合 `代码`。\r\n', 'utf8');

  const result = await loadPrompt({ promptPath: '提示词.md', configDirectory: directory });
  assert.equal(result.markdown, '自定义提示词\n\n请结合 `代码`。');
  assert.deepEqual(result.metadata, promptMetadata(result.markdown, {
    mode: 'custom',
    sourceName: '提示词.md'
  }));
  assert.doesNotMatch(JSON.stringify(result.metadata), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('非空 promptPath 缺失或文件为空时明确失败', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acgo-prompt-error-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, '空.md'), ' \r\n\t', 'utf8');

  await assert.rejects(loadPrompt({ promptPath: '不存在.md', configDirectory: directory }), /找不到.*不存在\.md/);
  await assert.rejects(loadPrompt({ promptPath: '空.md', configDirectory: directory }), /提示词文件为空.*空\.md/);
});
