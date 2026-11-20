/**
 * 修 E01-01-01：把机位改回贴地特写（避免和锁行不一致），并重建锁行。
 *   node tools/relock.mjs <projectId>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildLockLine } from '../engine/contracts.js';

const ROOT = 'D:\\智贸\\10-创意工作台\\projects';
const id = process.argv[2];
const dir = join(ROOT, id);
const file = join(dir, '03-storyboard.json');
const doc = JSON.parse(await readFile(file, 'utf8'));

const shot = doc.shots.find((row) => row.id === 'E01-01-01');
if (!shot) throw new Error('没有 E01-01-01');
shot.camera = { ...(shot.camera ?? {}), size: '贴地特写' };
const body = String(shot.prompt).split('\n光：')[0].replace(/画面一致性要求[\s\S]*$/, '').trim();
const lock = buildLockLine(shot);
if (!lock) throw new Error('锁行生成失败：现场表有空格');
const suffix = String(shot.prompt).includes('画面一致性要求')
  ? '\n' + String(shot.prompt).slice(String(shot.prompt).indexOf('画面一致性要求'))
  : '';
shot.prompt = `${body}\n${lock}${suffix}`;
await writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
console.log('E01-01-01 已重建：机位=贴地特写，锁行按现场表重写');
console.log(lock);
