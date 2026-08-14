import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PROMPT_OUTPUT_PATH = '提示词.md';

/**
 * 读取可选的自定义提示词。未配置 promptPath（包括空字符串）时返回项目内置提示词；
 * 一旦配置非空路径，文件缺失、不可读或内容为空都会明确失败。
 */
export async function loadPrompt({ promptPath = '提示词.md', configDirectory = process.cwd() } = {}) {
  const configuredPath = String(promptPath || '').trim() || '提示词.md';

  const baseDirectory = path.resolve(String(configDirectory || process.cwd()));
  const filename = path.isAbsolute(configuredPath)
    ? path.normalize(configuredPath)
    : path.resolve(baseDirectory, configuredPath);

  let markdown;
  try {
    markdown = await fs.readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`找不到完整提示词文件：${configuredPath}。请在项目目录放置 提示词.md，或用 promptPath 指定其他文件。`);
    }
    throw new Error(`无法读取 promptPath 指向的提示词文件 ${configuredPath}：${error.message}`);
  }

  const normalized = normalizePromptMarkdown(markdown);
  if (!normalized) {
    throw new Error(`promptPath 指向的提示词文件为空：${configuredPath}`);
  }

  return buildPromptResult(normalized, {
    mode: 'custom',
    sourceName: path.basename(filename)
  });
}

export function promptMetadata(markdown, { mode = 'custom', sourceName = '提示词.md' } = {}) {
  const normalized = normalizePromptMarkdown(markdown);
  return {
    mode,
    sourceName: String(sourceName || ''),
    output: PROMPT_OUTPUT_PATH,
    // 主流程落盘时统一为规范化正文加一个换行；这里哈希同一份实际打包字节。
    sha256: createHash('sha256').update(`${normalized}\n`, 'utf8').digest('hex')
  };
}

function buildPromptResult(markdown, metadataOptions) {
  const normalized = normalizePromptMarkdown(markdown);
  return {
    markdown: normalized,
    metadata: promptMetadata(normalized, metadataOptions)
  };
}

function normalizePromptMarkdown(markdown) {
  return String(markdown || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}
