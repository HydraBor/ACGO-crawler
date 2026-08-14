import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { normalizeConfig } from '../src/config.mjs';

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const version = String(manifest.version || '');
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json 版本号无效：${version}`);

const expectedFiles = [
  'src/index.mjs', 'src/config.mjs', 'src/browser.mjs', 'src/filters.mjs',
  'src/login.mjs', 'src/output-transaction.mjs', 'src/package.mjs',
  'src/prompt.mjs', 'src/reliability.mjs', '提示词.md'
];
for (const relativePath of expectedFiles) {
  const filename = path.join(root, relativePath);
  if (!fs.statSync(filename, { throwIfNoEntry: false })?.isFile()) fail(`缺少 2.0 必需文件：${relativePath}`);
}
for (const obsoletePath of ['src/feedback.mjs', '提示词.example.md', '今日总结.example.md']) {
  if (fs.existsSync(path.join(root, obsoletePath))) fail(`发现 2.0 已废弃文件：${obsoletePath}`);
}

for (const filename of fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.mjs'))) {
  execFileSync(process.execPath, ['--check', path.join(root, 'src', filename)], { stdio: 'inherit' });
}

const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
normalizeConfig(JSON.parse(read('config.example.json')));
if (lock.version !== version || lock.packages?.['']?.version !== version) fail('package-lock.json 版本与 package.json 不一致');
if (!read('README.md').includes(`当前版本：\`${version}\``)) fail('README.md 版本与 package.json 不一致');
const assemblyVersion = version.replace(/\.\d+$/, match => `${match}.0`);
if (!read('launcher/AcgoCrawlerLauncher.cs').includes(`AssemblyVersion("${assemblyVersion}")`)) fail('启动器程序集版本与 package.json 不一致');
if (!read('launcher/AcgoCrawlerLauncher.cs').includes(`AssemblyFileVersion("${assemblyVersion}")`)) fail('启动器文件版本与 package.json 不一致');
if (!read('launcher/README.md').includes(`当前版本：\`${version}\``)) fail('启动器 README 版本与 package.json 不一致');
if (!read('launcher/USAGE.txt').includes(`版本 ${version}`)) fail('启动器使用说明版本与 package.json 不一致');

const prompt = read('提示词.md');
for (const requiredText of ['ZIP 中的材料（仅以下四类）', '`作业题目.md`', '`比赛题目.md`', '`students/`', '`提示词.md`', '280～320 个汉字']) {
  if (!prompt.includes(requiredText)) fail(`提示词.md 缺少 2.0 正式契约：${requiredText}`);
}
for (const forbiddenText of ['填0%，不得猜测', 'C 可能少于 3 人', 'raw/summary.json', '今日总结']) {
  if (prompt.includes(forbiddenText)) fail(`提示词.md 仍包含旧规则：${forbiddenText}`);
}

execFileSync(process.execPath, ['--test'], { cwd: root, stdio: 'inherit' });
console.log(`2.0 发布检查通过：${version}`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
