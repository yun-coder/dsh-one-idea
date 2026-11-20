/**
 * 一次性修稿：按画面验收意见改三段的提示词，并把这三段的出片任务重置，
 * 让下一次「分段出片」用新提示词重新生成。
 *
 *   node tools/fix-segments.mjs <projectId>
 */
import { readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'D:\\智贸\\10-创意工作台\\projects';
const id = process.argv[2];
if (!id) throw new Error('用法：node tools/fix-segments.mjs <projectId>');
const dir = join(ROOT, id);

const ANTI_ARTIFACT = [
  '画面一致性要求：',
  '所有人物手指与脚趾结构正常（五指/五趾分明、不粘连、不变形）；',
  '产品是一只完整的白色棉拖鞋，鞋面与鞋底结构清晰、轮廓完整可辨，不要与碗、容器或其它物体融合；',
  '衣物为纯色无文字、无图案（不要出现任何英文字母或乱码）；',
  '冰箱内瓶身不带可读标签；',
  '同一厨房场景的浅色瓷砖地面、暖黄顶灯、冰箱冷白光保持一致。',
].join('');

const storyboardPath = join(dir, '03-storyboard.json');
const storyboard = JSON.parse(await readFile(storyboardPath, 'utf8'));

let changed = 0;
for (const shot of storyboard.shots) {
  const prompt = String(shot.prompt ?? '');
  if (!prompt.includes('画面一致性要求')) {
    shot.prompt = `${prompt}\n${ANTI_ARTIFACT}`;
    changed += 1;
  }
}
// 第一镜原来是大特写拍赤脚：脚趾占满画面，H3 最容易做坏。改成贴地中景，让脚与拖鞋同框。
const first = storyboard.shots.find((shot) => shot.id === 'E01-01-01');
if (first) {
  first.camera = { ...(first.camera ?? {}), size: '贴地中景（赤脚与两只拖鞋同时入画）' };
  first.prompt = String(first.prompt).replace(/贴地特写/g, '贴地中景').replace(/脚背|脚趾/g, '脚掌');
}
await writeFile(storyboardPath, JSON.stringify(storyboard, null, 2), 'utf8');
console.log(`提示词已改：${changed} 镜追加一致性要求，E01-01-01 改为贴地中景`);

const projectPath = join(dir, 'project.json');
const project = JSON.parse(await readFile(projectPath, 'utf8'));
const render = project.stages?.render;
const tasks = render?.artifact?.tasks ?? [];
let reset = 0;
for (const task of tasks) {
  // 只重置这三段（全部），保留 segmentId；清掉 taskId/file 让出片重新提交
  task.taskId = null;
  task.provider = null;
  task.providerLabel = null;
  task.status = 'failed';
  task.progress = 0;
  task.error = '按画面验收意见重做';
  task.file = null;
  task.rawFile = null;
  task.duration = null;
  task.submittedAt = null;
  reset += 1;
}
render.status = 'empty';
render.gate = null;
render.review = null;
render.issues = [];
render.visual = null;
project.pendingReview = null;
await writeFile(projectPath, JSON.stringify(project, null, 2), 'utf8');
console.log(`出片任务已重置：${reset} 段，下次出片会用新提示词重新生成`);

// 旧的成片和中间文件删掉，避免和新的混淆
for (const name of ['07-final.mp4', 'cover.jpg', '06-edl.json', '08-publish.md']) {
  const file = join(dir, name);
  if (existsSync(file)) await rm(file, { force: true });
}
await rm(join(dir, 'edit'), { recursive: true, force: true }).catch(() => {});
console.log('旧成片 / EDL / 发布包已清理');
