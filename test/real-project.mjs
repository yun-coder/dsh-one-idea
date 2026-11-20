/**
 * 用真实项目跑一遍 OpenFilm 收尾（不花额度、不调模型）。
 *
 *   node test/real-project.mjs "D:\智贸\10-创意工作台\projects\cs_xxxx"
 *
 * 拿项目里已有的 06-edl.json + segments/*.mp4 + project.json 的 render 任务，
 * 走和 executeEdlWithOpenFilm 完全相同的调用，然后用 look 逐帧体检，
 * 最后和旧 ffmpeg 成的 07-final.mp4 比时长、比体积。
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createMedia } from '../engine/media.js';
import { createOpenFilmFinisher } from '../engine/openfilm.js';

const projectDir = process.argv[2];
const flag = (name, fallback = '') => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
if (!projectDir || !existsSync(join(projectDir, 'project.json'))) {
  console.error('用法：node test/real-project.mjs <项目目录> [--quality=high] [--bitrate=8]');
  process.exit(2);
}

const project = JSON.parse(await readFile(join(projectDir, 'project.json'), 'utf8'));
const edl = JSON.parse(await readFile(join(projectDir, '06-edl.json'), 'utf8'));
const tasks = (project.stages?.render?.artifact?.tasks ?? []).filter((task) => task?.status === 'completed' && task.file);
console.log(`项目：${project.title}（${project.id}）`);
console.log(`片段：${tasks.length} 段｜EDL：${edl.order?.length ?? 0} 条｜目标 ${project.targetSeconds}s`);

const media = createMedia({});
const finisher = createOpenFilmFinisher({
  // 留空就走 PATH 上的 openfilm；OPENFILM_BIN 可以指到别的检出
  config: { openfilmCmd: process.env.OPENFILM_BIN ?? '', openfilmCheckouts: [] },
  media,
  log: (line) => console.log(`  ${line}`),
});

const usable = await finisher.available();
if (!usable.ok) {
  console.error(`找不到 OpenFilm：${usable.reason}`);
  process.exit(1);
}

const bySegment = new Map(tasks.map((task) => [String(task.segmentId), task]));
const order = (edl.order ?? []).map((entry) => ({ ...entry, task: bySegment.get(String(entry.segmentId)) })).filter((entry) => entry.task?.file);
console.log(`可剪：${order.length} 条 → ${order.map((entry) => entry.segmentId).join(' → ')}`);

const out = join(projectDir, '07-final-openfilm.mp4');
const quality = flag('quality', 'native');
const bitrate = Number(flag('bitrate', '0')) || 0;
console.log(`画质档：${quality}${bitrate ? ` · ${bitrate} Mbps` : ''}`);
const result = await finisher.finish({
  projectDir,
  edl,
  clips: order.map((entry) => entry.task.file),
  entries: order,
  bgm: null,
  width: Number(edl.width ?? 1080),
  height: Number(edl.height ?? 1920),
  lufs: Number(edl.audio?.lufs ?? -14),
  gainDb: Number(edl.audio?.gainDb ?? -18),
  fps: 30,
  workers: 3,
  quality,
  bitrate,
  finalFile: out,
});

const info = await media.probe(out);
const size = (await stat(out)).size;
console.log(`\n新成片：${info.width}x${info.height} · ${info.duration.toFixed(2)}s · ${(size / 1024 / 1024).toFixed(2)} MB · 渲染 ${result.elapsed}s`);

const old = join(projectDir, '07-final.mp4');
if (existsSync(old)) {
  const oldInfo = await media.probe(old);
  const oldSize = (await stat(old)).size;
  console.log(`旧成片：${oldInfo.width}x${oldInfo.height} · ${oldInfo.duration.toFixed(2)}s · ${(oldSize / 1024 / 1024).toFixed(2)} MB（ffmpeg concat）`);
  console.log(`时长差：${(info.duration - oldInfo.duration).toFixed(2)}s`);
}

const qa = await finisher.look({ filmDir: projectDir, file: out, lufs: Number(edl.audio?.lufs ?? -14) });
console.log(`\n逐帧体检：exit ${qa.exitCode}｜硬问题 ${qa.errors.length}｜提醒 ${qa.warnings.length}`);
for (const line of [...qa.errors.map((x) => `✗ ${x}`), ...qa.warnings.map((x) => `! ${x}`)]) console.log(`  ${line}`);
console.log(`\nfilm.html：${result.filmHtml}`);
