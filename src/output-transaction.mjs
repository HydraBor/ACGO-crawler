import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

export async function createOutputTransaction(finalDirectory, {
  inspectOnly = false,
  fsImpl = fs,
  token = `${process.pid}-${randomUUID()}`
} = {}) {
  const finalPath = validateFinalDirectory(finalDirectory);
  const parentDirectory = path.dirname(finalPath);
  const basename = path.basename(finalPath);
  const stagingDirectory = path.join(parentDirectory, `.${basename}.staging-${token}`);
  const targets = [];
  let finished = false;

  await fsImpl.mkdir(parentDirectory, { recursive: true });
  await fsImpl.rm(stagingDirectory, { recursive: true, force: true });
  if (inspectOnly && await pathExists(finalPath, fsImpl)) {
    await fsImpl.cp(finalPath, stagingDirectory, { recursive: true, force: true });
  } else {
    await fsImpl.mkdir(stagingDirectory, { recursive: true });
  }
  if (inspectOnly) {
    await fsImpl.rm(path.join(stagingDirectory, 'debug'), { recursive: true, force: true });
  }

  targets.push({ stagedPath: stagingDirectory, finalPath, kind: 'directory' });

  return {
    finalDirectory: finalPath,
    stagingDirectory,
    createArtifactPath(finalArtifactPath) {
      const resolvedFinal = path.resolve(finalArtifactPath);
      const artifactStagingPath = path.join(
        path.dirname(resolvedFinal),
        `.${path.basename(resolvedFinal)}.staging-${token}`
      );
      targets.push({ stagedPath: artifactStagingPath, finalPath: resolvedFinal, kind: 'artifact' });
      return artifactStagingPath;
    },
    async commit() {
      if (finished) throw new Error('输出事务已经结束，不能重复提交');
      const installed = [];
      const backups = [];
      try {
        for (const target of targets) {
          if (!await pathExists(target.stagedPath, fsImpl)) {
            throw new Error(`待发布产物不存在：${target.stagedPath}`);
          }
          await fsImpl.mkdir(path.dirname(target.finalPath), { recursive: true });
          const backupPath = path.join(
            path.dirname(target.finalPath),
            `.${path.basename(target.finalPath)}.backup-${token}`
          );
          await fsImpl.rm(backupPath, { recursive: true, force: true });
          if (await pathExists(target.finalPath, fsImpl)) {
            await fsImpl.rename(target.finalPath, backupPath);
            backups.push({ backupPath, finalPath: target.finalPath });
          }
        }

        for (const target of targets) {
          await fsImpl.rename(target.stagedPath, target.finalPath);
          installed.push(target.finalPath);
        }
        // 新版已经完整安装，此刻事务即告成功。旧备份的清理属于善后工作，
        // 清理失败绝不能触发回滚，否则可能在部分备份已删除后同时丢失新旧版本。
        finished = true;
      } catch (error) {
        for (const installedPath of installed.reverse()) {
          await fsImpl.rm(installedPath, { recursive: true, force: true }).catch(() => {});
        }
        for (const backup of backups.reverse()) {
          if (await pathExists(backup.backupPath, fsImpl)) {
            await fsImpl.rename(backup.backupPath, backup.finalPath).catch(() => {});
          }
        }
        throw new Error(`发布输出失败，已尝试恢复旧版本：${error.message}`, { cause: error });
      }
      await Promise.allSettled(backups.map(item => fsImpl.rm(item.backupPath, { recursive: true, force: true })));
    },
    async rollback() {
      if (finished) return;
      finished = true;
      await Promise.all(targets.map(target => fsImpl.rm(target.stagedPath, { recursive: true, force: true }).catch(() => {})));
    }
  };
}

function validateFinalDirectory(value) {
  const resolved = path.resolve(String(value || ''));
  const root = path.parse(resolved).root;
  if (!value || resolved === root || path.dirname(resolved) === resolved) {
    throw new Error(`拒绝把宽泛路径作为输出目录：${resolved}`);
  }
  return resolved;
}

async function pathExists(filename, fsImpl) {
  try {
    await fsImpl.access(filename);
    return true;
  } catch {
    return false;
  }
}
