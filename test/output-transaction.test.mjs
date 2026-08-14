import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOutputTransaction } from '../src/output-transaction.mjs';

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acgo-output-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('成功提交以完整新目录替换旧输出并发布附属 ZIP', async t => {
  const parent = await temporaryDirectory(t);
  const finalDirectory = path.join(parent, '证据包');
  const finalZip = path.join(parent, '证据包.zip');
  await fs.mkdir(finalDirectory);
  await fs.writeFile(path.join(finalDirectory, 'old.txt'), 'old');
  await fs.writeFile(finalZip, 'old-zip');

  const transaction = await createOutputTransaction(finalDirectory, { token: 'success' });
  await fs.writeFile(path.join(transaction.stagingDirectory, 'new.txt'), 'new');
  const stagedZip = transaction.createArtifactPath(finalZip);
  await fs.writeFile(stagedZip, 'new-zip');
  await transaction.commit();

  assert.equal(await fs.readFile(path.join(finalDirectory, 'new.txt'), 'utf8'), 'new');
  await assert.rejects(fs.access(path.join(finalDirectory, 'old.txt')));
  assert.equal(await fs.readFile(finalZip, 'utf8'), 'new-zip');
  assert.deepEqual((await fs.readdir(parent)).sort(), ['证据包', '证据包.zip']);
});

test('回滚删除暂存产物且保持正式输出不变', async t => {
  const parent = await temporaryDirectory(t);
  const finalDirectory = path.join(parent, '证据包');
  await fs.mkdir(finalDirectory);
  await fs.writeFile(path.join(finalDirectory, 'sentinel.txt'), 'keep');

  const transaction = await createOutputTransaction(finalDirectory, { token: 'rollback' });
  await fs.writeFile(path.join(transaction.stagingDirectory, 'partial.txt'), 'partial');
  await transaction.rollback();

  assert.equal(await fs.readFile(path.join(finalDirectory, 'sentinel.txt'), 'utf8'), 'keep');
  assert.deepEqual(await fs.readdir(parent), ['证据包']);
});

test('inspect 复制旧输出但仅清空 debug', async t => {
  const parent = await temporaryDirectory(t);
  const finalDirectory = path.join(parent, '证据包');
  await fs.mkdir(path.join(finalDirectory, 'debug'), { recursive: true });
  await fs.mkdir(path.join(finalDirectory, 'students'), { recursive: true });
  await fs.writeFile(path.join(finalDirectory, 'debug', 'old.json'), 'old');
  await fs.writeFile(path.join(finalDirectory, 'students', 'student.md'), 'keep');

  const transaction = await createOutputTransaction(finalDirectory, { inspectOnly: true, token: 'inspect' });
  await fs.mkdir(path.join(transaction.stagingDirectory, 'debug'));
  await fs.writeFile(path.join(transaction.stagingDirectory, 'debug', 'new.json'), 'new');
  await transaction.commit();

  assert.equal(await fs.readFile(path.join(finalDirectory, 'students', 'student.md'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(finalDirectory, 'debug', 'new.json'), 'utf8'), 'new');
  await assert.rejects(fs.access(path.join(finalDirectory, 'debug', 'old.json')));
});

test('新版安装后即使旧备份清理失败也不回滚新版', async t => {
  const parent = await temporaryDirectory(t);
  const finalDirectory = path.join(parent, '证据包');
  const finalZip = path.join(parent, '证据包.zip');
  await fs.mkdir(finalDirectory);
  await fs.writeFile(path.join(finalDirectory, 'old.txt'), 'old');
  await fs.writeFile(finalZip, 'old-zip');

  const fsImpl = {
    ...fs,
    async rm(target, options) {
      if (String(target).includes('.backup-cleanup-failure')) {
        try {
          await fs.access(target);
          throw Object.assign(new Error('模拟防病毒软件占用旧备份'), { code: 'EPERM' });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return fs.rm(target, options);
    }
  };
  const transaction = await createOutputTransaction(finalDirectory, {
    token: 'cleanup-failure',
    fsImpl
  });
  await fs.writeFile(path.join(transaction.stagingDirectory, 'new.txt'), 'new');
  const stagedZip = transaction.createArtifactPath(finalZip);
  await fs.writeFile(stagedZip, 'new-zip');

  await transaction.commit();
  assert.equal(await fs.readFile(path.join(finalDirectory, 'new.txt'), 'utf8'), 'new');
  assert.equal(await fs.readFile(finalZip, 'utf8'), 'new-zip');
});
