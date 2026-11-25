/**
 * 项目之外的「关联数据」：复核通知队列 inbox.json、运行队列 queue.json。
 *
 * 删项目时必须一起清掉，否则打开面板/工具还会看到指向已删项目的记录
 * （以前就是这样：项目没了，inbox 里还躺着一堆复核记录，看着像「没删干净」）。
 *
 * 只碰这两个文件，不碰项目目录，也不碰独立出片/生图产物。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const readList = async (file) => {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/** 先写临时名再 rename：写到一半崩掉不会留下半份 JSON。 */
const writeList = async (file, list) => {
  const tmp = `${file}.tmp-${process.pid}`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await rename(tmp, file);
};

export function createTraces({ dataRoot, log = () => {} }) {
  const inboxFile = join(dataRoot, 'inbox.json');
  const queueFile = join(dataRoot, 'queue.json');
  const inboxId = (row) => String(row?.projectId ?? '');
  const queueId = (row) => String(row?.id ?? '');

  /**
   * 删掉这些项目留下的关联记录。
   * @returns {{inbox:number, queue:number}} 实际清掉的条数
   */
  const purge = async (projectIds) => {
    const ids = new Set((Array.isArray(projectIds) ? projectIds : [projectIds]).map(String).filter(Boolean));
    if (ids.size === 0) return { inbox: 0, queue: 0 };
    const result = { inbox: 0, queue: 0 };
    const inbox = await readList(inboxFile);
    const keptInbox = inbox.filter((row) => !ids.has(inboxId(row)));
    if (keptInbox.length !== inbox.length) {
      result.inbox = inbox.length - keptInbox.length;
      await writeList(inboxFile, keptInbox).catch((error) => log(`写 inbox 失败：${error.message}`));
    }
    const queue = await readList(queueFile);
    const keptQueue = queue.filter((row) => !ids.has(queueId(row)));
    if (keptQueue.length !== queue.length) {
      result.queue = queue.length - keptQueue.length;
      await writeList(queueFile, keptQueue).catch((error) => log(`写 queue 失败：${error.message}`));
    }
    return result;
  };

  /**
   * 清掉指向「已经不存在的项目」的关联记录（启动时跑一次，也顺手把历史残留收干净）。
   * 没有 id 的行不动：那可能是别的工具写的。
   */
  const sweep = async (knownIds) => {
    const known = new Set([...knownIds].map(String));
    const stale = (id) => Boolean(id) && !known.has(id);
    const result = { inbox: 0, queue: 0 };
    const inbox = await readList(inboxFile);
    const keptInbox = inbox.filter((row) => !stale(inboxId(row)));
    if (keptInbox.length !== inbox.length) {
      result.inbox = inbox.length - keptInbox.length;
      await writeList(inboxFile, keptInbox).catch((error) => log(`写 inbox 失败：${error.message}`));
    }
    const queue = await readList(queueFile);
    const keptQueue = queue.filter((row) => !stale(queueId(row)));
    if (keptQueue.length !== queue.length) {
      result.queue = queue.length - keptQueue.length;
      await writeList(queueFile, keptQueue).catch((error) => log(`写 queue 失败：${error.message}`));
    }
    return result;
  };

  return {
    inboxFile,
    queueFile,
    purge,
    sweep,
    readInbox: () => readList(inboxFile),
    readQueue: () => readList(queueFile),
  };
}
