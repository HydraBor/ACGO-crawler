import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

/**
 * 将爬取结果整理为可直接复制或上传的 ZIP。
 *
 * archiveName 与源目录名解耦，仅用于产物元数据和默认 ZIP 文件名。
 * 四类 AI 材料直接位于 ZIP 根目录，不再嵌套同名文件夹。
 * zipPath 可指向主流程的临时交易路径；本函数仍会先写内部临时文件再 rename。
 */
export async function buildEvidencePackage(rootDirectory, options = {}) {
  const sourceRoot = path.resolve(String(rootDirectory || ''));
  const stat = await fs.stat(sourceRoot).catch(error => {
    if (error.code === 'ENOENT') throw new Error(`打包源目录不存在：${sourceRoot}`);
    throw error;
  });
  if (!stat.isDirectory()) throw new Error(`打包源路径不是目录：${sourceRoot}`);

  const packagedPromptPath = path.join(sourceRoot, '提示词.md');
  const packagedPrompt = await fs.readFile(packagedPromptPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw new Error('缺少 提示词.md，无法生成完整 ZIP。');
    throw error;
  });
  if (!packagedPrompt.trim()) throw new Error('提示词.md 为空，无法生成完整 ZIP。');

  const archiveName = validateArchiveName(options.archiveName || path.basename(sourceRoot));
  const zipPath = path.resolve(options.zipPath || path.join(path.dirname(sourceRoot), `${archiveName}.zip`));
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  const temporaryZipPath = `${zipPath}.partial-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    const files = await listAiMaterialFiles(sourceRoot, {
      includeHomework: options.includeHomework,
      includeContest: options.includeContest,
      studentFiles: options.studentFiles
    });
    await writeZip(temporaryZipPath, files);
    await replaceFileAtomically(temporaryZipPath, zipPath);
  } catch (error) {
    await fs.rm(temporaryZipPath, { force: true }).catch(() => {});
    throw new Error(`无法生成 ZIP ${zipPath}：${error.message}`, { cause: error });
  }

  const zipSize = (await fs.stat(zipPath)).size;
  return {
    archiveName,
    rootDirectory: sourceRoot,
    zipPath,
    zipSize
  };
}

export async function replaceFileAtomically(source, destination, fsImpl = fs) {
  try {
    await fsImpl.rename(source, destination);
  } catch (error) {
    // Windows 的某些文件系统/防病毒组合不允许 rename 直接覆盖现有文件。
    // 只在确认是目标冲突时回退；先备份旧文件，安装失败时必须恢复旧包。
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    const backup = `${destination}.backup-${process.pid}-${randomBytes(6).toString('hex')}`;
    let backedUp = false;
    try {
      await fsImpl.rename(destination, backup);
      backedUp = true;
      await fsImpl.rename(source, destination);
    } catch (installError) {
      if (backedUp) {
        await fsImpl.rm(destination, { force: true }).catch(() => {});
        try {
          await fsImpl.rename(backup, destination);
        } catch (restoreError) {
          throw new AggregateError([installError, restoreError], `新 ZIP 安装失败，且旧 ZIP 恢复失败：${destination}`);
        }
      }
      throw installError;
    }
    // 新包已经安装成功；旧备份清理失败不能回滚或删除新包。
    await fsImpl.rm(backup, { force: true }).catch(() => {});
  }
}

async function listAiMaterialFiles(root, { includeHomework, includeContest, studentFiles } = {}) {
  const result = [];
  const homeworkPath = path.join(root, '作业题目.md');
  const contestPath = path.join(root, '比赛题目.md');
  const promptPath = path.join(root, '提示词.md');
  const homeworkFileExists = await isFile(homeworkPath);
  const contestFileExists = await isFile(contestPath);
  const hasHomework = includeHomework === undefined ? homeworkFileExists : Boolean(includeHomework);
  const hasContest = includeContest === undefined ? contestFileExists : Boolean(includeContest);
  if (!hasHomework && !hasContest) throw new Error('缺少 作业题目.md 和 比赛题目.md，至少需要一个已启用目标的题面文件。');
  if (hasHomework && !homeworkFileExists) throw new Error('本次启用了作业，但缺少 作业题目.md。');
  if (hasContest && !contestFileExists) throw new Error('本次启用了比赛，但缺少 比赛题目.md。');

  if (hasHomework) result.push({ absolutePath: homeworkPath, relativePath: '作业题目.md' });
  if (hasContest) result.push({ absolutePath: contestPath, relativePath: '比赛题目.md' });

  const studentsRoot = path.join(root, 'students');
  const studentRootStat = await fs.stat(studentsRoot).catch(error => {
    if (error.code === 'ENOENT') throw new Error('缺少 students 文件夹，无法生成完整 ZIP。');
    throw error;
  });
  if (!studentRootStat.isDirectory()) throw new Error('students 不是文件夹，无法生成完整 ZIP。');

  const allowedStudentBasenames = new Set([
    ...(hasHomework ? ['课堂练习.md'] : []),
    ...(hasContest ? ['今日比赛.md'] : [])
  ]);
  if (Array.isArray(studentFiles)) {
    const normalizedStudentFiles = [...new Set(studentFiles.map(normalizeStudentRelativePath))].sort(compareRelativePaths);
    for (const relativePath of normalizedStudentFiles) {
      const basename = relativePath.split('/').at(-1);
      if (!allowedStudentBasenames.has(basename)) continue;
      const absolutePath = path.resolve(root, ...relativePath.split('/'));
      const relativeToStudents = path.relative(studentsRoot, absolutePath);
      if (!relativeToStudents || relativeToStudents.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToStudents)) {
        throw new Error(`学生材料路径越出 students 文件夹：${relativePath}`);
      }
      if (!await isFile(absolutePath)) throw new Error(`本次学生材料不存在：${relativePath}`);
      result.push({ absolutePath, relativePath });
    }
  } else {
    const studentDirectories = (await fs.readdir(studentsRoot, { withFileTypes: true })).sort(compareNames);
    for (const studentDirectory of studentDirectories) {
      if (!studentDirectory.isDirectory()) continue;
      const directory = path.join(studentsRoot, studentDirectory.name);
      const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(compareNames);
      for (const entry of entries) {
        if (!entry.isFile() || !allowedStudentBasenames.has(entry.name)) continue;
        result.push({
          absolutePath: path.join(directory, entry.name),
          relativePath: `students/${studentDirectory.name}/${entry.name}`
        });
      }
    }
  }
  if (!result.some(file => file.relativePath.startsWith('students/'))) {
    throw new Error('students 文件夹中没有与已启用目标对应的学生 Markdown，无法生成完整 ZIP。');
  }
  result.push({ absolutePath: promptPath, relativePath: '提示词.md' });
  return result;
}

function normalizeStudentRelativePath(value) {
  const relativePath = String(value || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const match = relativePath.match(/^students\/([^/]+)\/(?:课堂练习|今日比赛)\.md$/u);
  if (!match || ['.', '..'].includes(match[1])) {
    throw new Error(`学生材料路径不符合白名单：${value}`);
  }
  return relativePath;
}

async function isFile(filename) {
  return (await fs.stat(filename).catch(() => null))?.isFile() === true;
}

async function writeZip(destination, files) {
  if (files.length > 0xffff) throw new Error('ZIP 中文件数超过 65535，当前便携打包器不支持 ZIP64。');
  const handle = await fs.open(destination, 'wx');
  let offset = 0;
  const records = [];
  try {
    for (const file of files) {
      const data = await fs.readFile(file.absolutePath);
      const compressed = deflateRawSync(data, { level: 6 });
      checkZip32(data.length, `文件过大：${file.relativePath}`);
      checkZip32(compressed.length, `压缩后文件过大：${file.relativePath}`);
      checkZip32(offset, 'ZIP 体积超出 4 GiB，当前便携打包器不支持 ZIP64。');

      const zipName = file.relativePath.replaceAll('\\', '/');
      const name = Buffer.from(zipName, 'utf8');
      const { date, time } = dosDateTime((await fs.stat(file.absolutePath)).mtime);
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(8, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      await handle.write(local);
      await handle.write(name);
      await handle.write(compressed);
      records.push({ name, crc, compressedSize: compressed.length, size: data.length, date, time, offset });
      offset += local.length + name.length + compressed.length;
    }

    const centralOffset = offset;
    for (const record of records) {
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(8, 10);
      central.writeUInt16LE(record.time, 12);
      central.writeUInt16LE(record.date, 14);
      central.writeUInt32LE(record.crc, 16);
      central.writeUInt32LE(record.compressedSize, 20);
      central.writeUInt32LE(record.size, 24);
      central.writeUInt16LE(record.name.length, 28);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(record.offset, 42);
      await handle.write(central);
      await handle.write(record.name);
      offset += central.length + record.name.length;
    }

    const centralSize = offset - centralOffset;
    checkZip32(centralOffset, 'ZIP 体积超出 4 GiB，当前便携打包器不支持 ZIP64。');
    checkZip32(centralSize, 'ZIP 目录过大，当前便携打包器不支持 ZIP64。');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(records.length, 8);
    end.writeUInt16LE(records.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    await handle.write(end);
  } finally {
    await handle.close();
  }
}

function validateArchiveName(value) {
  const name = String(value || '').trim();
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
    throw new Error(`archiveName 不是有效的 Windows 目录名：${value}`);
  }
  return name;
}

function compareNames(left, right) {
  return left.name.localeCompare(right.name, 'zh-CN');
}

function compareRelativePaths(left, right) {
  return left.localeCompare(right, 'zh-CN');
}

function checkZip32(value, message) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error(message);
}

function dosDateTime(value) {
  const date = value instanceof Date && !Number.isNaN(value.valueOf()) ? value : new Date();
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let current = index;
  for (let bit = 0; bit < 8; bit++) current = (current & 1) ? (0xedb88320 ^ (current >>> 1)) : (current >>> 1);
  return current >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
