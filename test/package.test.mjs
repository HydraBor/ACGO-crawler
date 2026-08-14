import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildEvidencePackage, replaceFileAtomically } from '../src/package.mjs';

const execFileAsync = promisify(execFile);

test('ZIP 根目录严格只包含题面、students 和提示词.md', async t => {
  const fixture = await createFixture(t);
  const zipPath = path.join(fixture.directory, '产物', '自定义位置.zip');
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  await fs.writeFile(zipPath, '旧 ZIP 应被替换', 'utf8');

  const result = await buildEvidencePackage(fixture.root, { archiveName: 'package-slug', zipPath });
  const entries = await zipEntries(zipPath, fixture.directory);

  assert.equal(result.zipPath, zipPath);
  assert.ok(entries.includes('作业题目.md'));
  assert.ok(entries.includes('比赛题目.md'));
  assert.ok(entries.includes('提示词.md'));
  assert.ok(entries.includes('students/学生A-1/课堂练习.md'));
  assert.ok(entries.includes('students/学生A-1/今日比赛.md'));
  assert.deepEqual(entries, [
    '作业题目.md',
    '比赛题目.md',
    'students/学生A-1/今日比赛.md',
    'students/学生A-1/课堂练习.md',
    'students/学生B-2/课堂练习.md',
    '提示词.md'
  ]);
});

test('缺少根目录提示词.md 时明确失败', async t => {
  const fixture = await createFixture(t);
  await fs.rm(path.join(fixture.root, '提示词.md'));
  await assert.rejects(buildEvidencePackage(fixture.root), /缺少 提示词\.md/);
});

test('只运行作业时 ZIP 不包含比赛题面和学生比赛文件', async t => {
  const fixture = await createFixture(t);
  const zipPath = path.join(fixture.directory, 'homework-only.zip');
  await buildEvidencePackage(fixture.root, {
    archiveName: 'homework-only',
    zipPath,
    includeHomework: true,
    includeContest: false
  });
  const entries = await zipEntries(zipPath, fixture.directory);
  assert.ok(entries.includes('作业题目.md'));
  assert.ok(entries.includes('提示词.md'));
  assert.ok(entries.some(entry => entry.endsWith('/课堂练习.md')));
  assert.ok(!entries.some(entry => entry.endsWith('/比赛题目.md') || entry.endsWith('/今日比赛.md')));
});

test('只运行比赛时 ZIP 不包含作业题面和学生课堂文件', async t => {
  const fixture = await createFixture(t);
  const zipPath = path.join(fixture.directory, 'contest-only.zip');
  await buildEvidencePackage(fixture.root, {
    archiveName: 'contest-only',
    zipPath,
    includeHomework: false,
    includeContest: true
  });
  const entries = await zipEntries(zipPath, fixture.directory);
  assert.ok(entries.includes('比赛题目.md'));
  assert.ok(entries.includes('提示词.md'));
  assert.ok(entries.some(entry => entry.endsWith('/今日比赛.md')));
  assert.ok(!entries.some(entry => entry.endsWith('/作业题目.md') || entry.endsWith('/课堂练习.md')));
});

test('显式学生清单排除同目标的旧学生文件', async t => {
  const fixture = await createFixture(t);
  const zipPath = path.join(fixture.directory, 'current-students-only.zip');
  await buildEvidencePackage(fixture.root, {
    archiveName: 'current-students-only',
    zipPath,
    includeHomework: true,
    includeContest: true,
    studentFiles: [
      'students/学生A-1/课堂练习.md',
      'students/学生A-1/今日比赛.md'
    ]
  });
  const entries = await zipEntries(zipPath, fixture.directory);
  assert.ok(entries.includes('students/学生A-1/课堂练习.md'));
  assert.ok(!entries.some(entry => entry.includes('学生B-2')));
});

test('显式学生路径不能用上级目录逃出 students 白名单', async t => {
  const fixture = await createFixture(t);
  await fs.writeFile(path.join(fixture.root, '课堂练习.md'), '# 越界文件');
  await assert.rejects(buildEvidencePackage(fixture.root, {
    includeHomework: true,
    includeContest: false,
    studentFiles: ['students/../课堂练习.md']
  }), /路径不符合白名单/);
});

test('Windows 替换新 ZIP 失败时恢复旧 ZIP', async t => {
  const fixture = await createFixture(t);
  const source = path.join(fixture.directory, 'new.partial');
  const destination = path.join(fixture.directory, 'existing.zip');
  await fs.writeFile(source, 'new');
  await fs.writeFile(destination, 'old');
  let renameCount = 0;
  const fsImpl = {
    ...fs,
    async rename(from, to) {
      renameCount++;
      if (renameCount === 1) throw Object.assign(new Error('Windows 不允许覆盖'), { code: 'EPERM' });
      if (renameCount === 3) throw Object.assign(new Error('模拟新包安装失败'), { code: 'EACCES' });
      return fs.rename(from, to);
    }
  };
  await assert.rejects(replaceFileAtomically(source, destination, fsImpl), /模拟新包安装失败/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'old');
  assert.equal(await fs.readFile(source, 'utf8'), 'new');
  assert.equal((await fs.readdir(fixture.directory)).some(name => name.includes('.backup-')), false);
});

async function createFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acgo-package-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'staging-不应出现在zip顶层');
  const files = new Map([
    ['README.md', '# 使用说明'],
    ['提交给AI.md', '# 旧版单文件入口，不应进入 ZIP'],
    ['作业题目.md', '# 作业题面'],
    ['比赛题目.md', '# 比赛题面'],
    ['提示词.md', '# 预置提示词'],
    ['prompts/家长反馈生成提示词.md', '# 预置提示词'],
    ['prompts/批量处理说明.md', '# 批量说明'],
    ['students/学生B-2/课堂练习.md', '# 学生B作业代码'],
    ['students/学生A-1/课堂练习.md', '# 学生A作业代码'],
    ['students/学生A-1/今日比赛.md', '# 学生A比赛代码'],
    ['raw/summary.json', '{"value":"原始数据"}'],
    ['debug/page.html', '调试秘密'],
    ['students/学生A-1/其他文件.txt', '不得打包']
  ]);
  for (const [relativePath, content] of files) {
    const filename = path.join(root, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content, 'utf8');
  }
  return { directory, root };
}

async function zipEntries(zipPath, temporaryParent) {
  if (process.platform === 'win32') {
    const psZipPath = zipPath.replaceAll("'", "''");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$zip = '${psZipPath}'`,
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      '$archive = [IO.Compression.ZipFile]::OpenRead($zip)',
      'try { ($archive.Entries | ForEach-Object { $_.FullName }) -join "`n" } finally { $archive.Dispose() }'
    ].join('; ');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    return stdout.trim().split(/\r?\n/).filter(Boolean);
  }

  const script = 'import sys, zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))';
  const { stdout } = await execFileAsync('python3', ['-c', script, zipPath], { encoding: 'utf8' });
  return stdout.trim().split(/\r?\n/).filter(Boolean);
}
