/**
 * 面板 API 冒烟测试：把宿主侧真的跑起来（假 ctx + 真 HTTP），验证
 *   1) 删项目会把目录和关联记录（inbox / queue）一起清掉；
 *   2) 删完再查这个项目，返回的是「项目不存在」而不是 ENOENT 原文；
 *   3) 一键清空能把所有项目和残留记录清干净。
 *
 *   node test/panel-api.mjs
 *
 * 它不碰真实数据：dataDir / projectDir 全在临时目录里。
 */
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newProject } from '../engine/store.js';

const label = (ok, text) => console.log(`  ${ok ? '✓' : '✗'} ${text}`);
let failed = 0;
const check = (name, condition, detail = '') => {
  if (!condition) failed += 1;
  label(Boolean(condition), detail ? `${name}（${detail}）` : name);
};

const root = await mkdtemp(join(tmpdir(), 'cs-api-'));
const dataRoot = join(root, 'data');
const projectRoot = join(root, 'projects');
await mkdir(dataRoot, { recursive: true });
await mkdir(projectRoot, { recursive: true });

const alpha = newProject({ title: '项目 A' });
const beta = newProject({ title: '项目 B' });
for (const project of [alpha, beta]) {
  await mkdir(join(projectRoot, project.id), { recursive: true });
  await writeFile(join(projectRoot, project.id, 'project.json'), JSON.stringify(project), 'utf8');
}
await writeFile(join(dataRoot, 'inbox.json'), JSON.stringify([
  { projectId: alpha.id, stage: 'idea', reason: '需要复核' },
  { projectId: beta.id, stage: 'edit', reason: '需要复核' },
]), 'utf8');
await writeFile(join(dataRoot, 'queue.json'), '[]', 'utf8');

const readInbox = async () => JSON.parse(await readFile(join(dataRoot, 'inbox.json'), 'utf8').catch(() => '[]'));

// ---- 假 ctx：只实现 index.js 用到的那几个接口 ----
const routes = [];
const tools = [];
const ctx = {
  effect(fn) {
    const dispose = fn();
    return () => {
      try {
        dispose?.();
      } catch {
        /* 忽略 */
      }
    };
  },
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  connection: { requestRejection: () => undefined },
  tools: {
    register(tool) {
      tools.push(tool);
      return () => {};
    },
  },
  llm: { resolveModelInfo: async () => null, stream: async function* empty() {} },
  attachments: { saveImage: async () => ({ id: 'image-1' }) },
  get: () => undefined,
};

const { apply } = await import('../index.js');
apply(ctx, {
  dataDir: dataRoot,
  projectDir: projectRoot,
  skillDir: join(root, 'no-skill'),
  scriptsDir: join(root, 'no-scripts'),
  ffmpegPath: join(root, 'no-ffmpeg'),
});

check('注册了面板 API 路由', routes.some((route) => route.path === '/creative-studio/api'));
check('注册了 Agent 工具', tools.some((tool) => tool.name === 'creative_studio_status'));

// 真开一个 HTTP 服务，把请求交给插件注册的 handler（和宿主里的路径一致）。
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://dsh.internal').pathname;
  const route = routes.find((item) => (item.kind === 'prefix' ? path.startsWith(item.path) : path === item.path));
  if (!route) {
    res.writeHead(404);
    res.end();
    return;
  }
  route.handler(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const call = async (endpoint, payload = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}/creative-studio/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
};

try {
  const listed = await call('projects');
  check('列表同时给出创意项目和计数', listed.body.ok === true
    && listed.body.value.projects.length === 2
    && listed.body.value.projects.every((row) => row.kind === 'studio')
    && listed.body.value.referenceCount === 0, JSON.stringify(listed.body.value?.projects?.length));

  const state = await call('state', { id: alpha.id });
  check('能读到项目状态', state.body.ok === true && state.body.value.project.id === alpha.id);

  const missing = await call('state', { id: 'cs_19990101_nope0' });
  check('不存在的项目返回 not-found', missing.body.ok === false && missing.body.error.code === 'not-found');
  check('not-found 里没有 ENOENT 原文', !/ENOENT|no such file/i.test(missing.body.error.message), missing.body.error.message);

  const removed = await call('remove', { id: alpha.id });
  check('删除项目成功', removed.body.ok === true && removed.body.value.removed === alpha.id);
  check('项目目录被删掉', !existsSync(join(projectRoot, alpha.id)));
  check('关联复核记录一起清掉', removed.body.value.purged.inbox === 1, JSON.stringify(removed.body.value.purged));
  check('另一个项目的记录还在', (await readInbox()).length === 1 && (await readInbox())[0].projectId === beta.id);

  const afterRemove = await call('state', { id: alpha.id });
  check('删完再查是 not-found，不是 500', afterRemove.body.ok === false
    && afterRemove.body.error.code === 'not-found'
    && !/ENOENT|no such file/i.test(afterRemove.body.error.message), afterRemove.body.error?.message);

  const wiped = await call('removeAll');
  check('一键清空删掉剩下的项目', wiped.body.ok === true && wiped.body.value.removed.includes(beta.id));
  check('清空后没有项目目录', !existsSync(join(projectRoot, beta.id)));
  check('清空后关联记录也空', (await readInbox()).length === 0);

  const emptyList = await call('projects');
  check('清空后列表为空', emptyList.body.value.projects.length === 0 && emptyList.body.value.referenceCount === 0);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

console.log(failed === 0 ? '\n全部通过：删除会清掉项目目录和关联记录，页面拿不到裸报错。' : `\n失败 ${failed} 项`);
if (failed > 0) process.exit(1);
