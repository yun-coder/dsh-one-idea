/**
 * 一句话 / 剧本开工的端到端冒烟测试：假 ctx + 假模型 + 真 HTTP。
 *
 *   node test/intake-api.mjs
 *
 * 验证四件事：
 *   1) create 只给一段 idea 也能建项目，并记住原文；
 *   2) intake 让导演读一遍，返回带默认值的问题，且把画像填进项目；
 *   3) 问题没答完时 run 不开跑，只把 not-intake 的提示和问题交回来；
 *   4) 回答完（或全部用默认）之后状态变 done；剧本模式会把创意阶段标成 skipped；
 *   5) 提示词模板接口会把内置指令原文一起交出来（面板据此显示，不再像「没用」）。
 */
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const label = (ok, text) => console.log(`  ${ok ? '✓' : '✗'} ${text}`);
let failed = 0;
const check = (name, condition, detail = '') => {
  if (!condition) failed += 1;
  label(Boolean(condition), detail ? `${name}（${detail}）` : name);
};

const root = await mkdtemp(join(tmpdir(), 'cs-intake-'));
const dataRoot = join(root, 'data');
const projectRoot = join(root, 'projects');

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
  llm: {
    resolveModelInfo: async () => null,
    // 导演的返回值按输入内容分：剧本 → kind=script，想法 → kind=idea。
    stream: async function* stream(request) {
      const prompt = JSON.stringify(request?.messages?.[0]?.content ?? '');
      const script = prompt.includes('用户给的剧本');
      const payload = {
        summary: script ? '按剧本拍凌晨面馆' : '拍凌晨十二点还开门的清汤面',
        title: script ? '十二点的面' : '十二点的一碗面',
        kind: script ? 'script' : 'idea',
        brief: { productName: '清汤面', category: '地方小吃到店体验', tone: '克制的温情' },
        questions: [
          {
            field: 'targetSeconds',
            question: '这条想做多长？',
            why: '决定分几段',
            options: [{ label: '15 秒 · 一个钩子', value: '15' }, { label: '45 秒 · 完整故事', value: '45' }],
            default: '45',
          },
        ],
      };
      yield { type: 'text-delta', text: JSON.stringify(payload) };
    },
  },
  attachments: { saveImage: async () => ({ id: 'image-1' }) },
  get: (name) => (name === 'agentDefaultModel'
    ? { currentSelection: () => ({ provider: 'mock', model: 'mock-flash' }) }
    : undefined),
};

const { apply } = await import('../index.js');
apply(ctx, {
  dataDir: dataRoot,
  projectDir: projectRoot,
  skillDir: join(root, 'no-skill'),
  scriptsDir: join(root, 'no-scripts'),
  ffmpegPath: join(root, 'no-ffmpeg'),
});

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://dsh.internal').pathname;
  const route = routes.find((item) => (item.kind === 'prefix' ? path.startsWith(item.path) : path === item.path));
  if (!route) {
    res.writeHead(404);
    res.end();
    return;
  }
  void route.handler(req, res);
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
  check('注册了导演确认接口', routes.some((route) => route.path === '/creative-studio/api'));
  check('注册了 creative_studio_intake 工具', tools.some((tool) => tool.name === 'creative_studio_intake'));

  const empty = await call('create', {});
  check('什么都没给就报清楚', empty.body.ok === false && empty.body.error.code === 'bad-request', empty.body.error?.code);

  // ---- 想法：只给一句话 ----
  const created = await call('create', { idea: '拍凌晨十二点还开门的清汤面，12 块一碗，给加班的人看' });
  check('一句话就能建项目', created.body.ok === true && /^cs_/.test(created.body.value.id), created.body.error?.message);
  const ideaId = created.body.value.id;
  check('原文被记住', created.body.value.project.source?.kind === 'idea'
    && created.body.value.project.source.text.includes('12 块'));
  check('新建时还没确认过', created.body.value.project.intake?.status === 'idle');

  const read = await call('intake', { id: ideaId });
  check('导演读完给出问题', read.body.ok === true && read.body.value.questions.length === 1, read.body.error?.message);
  check('画像被导演填上', read.body.value.project.brief.productName === '清汤面', read.body.value.project.brief.productName);
  check('问题带推荐值', read.body.value.questions[0].default === '45');

  const blocked = await call('run', { id: ideaId });
  check('没答完时 run 不开跑', blocked.body.ok === false && blocked.body.error.code === 'need-intake', blocked.body.error?.code);
  check('run 把待确认问题交回来', blocked.body.error.details?.intake?.questions?.length === 1);

  const answered = await call('intakeAnswer', { id: ideaId, answers: [{ id: 'q1', value: '15' }] });
  check('逐条回答后确认完成', answered.body.ok === true && answered.body.value.intake.status === 'done');
  check('答案落进目标时长', answered.body.value.project.targetSeconds === 15, String(answered.body.value.project.targetSeconds));

  // ---- 剧本：整段贴进来 ----
  const scripted = await call('create', { script: '第一场 夜 面馆\n老周：还是不要葱？\n她点头。' });
  check('一段剧本也能建项目', scripted.body.ok === true && scripted.body.value.project.source?.kind === 'script');
  const scriptId = scripted.body.value.id;
  await call('intake', { id: scriptId });
  const scriptState = await call('state', { id: scriptId });
  check('剧本模式跳过创意发散', scriptState.body.value.project.stages.idea.status === 'skipped', scriptState.body.value.project.stages.idea.status);
  check('剧本模式识别为 script', scriptState.body.value.project.source?.kind === 'script');

  const defaults = await call('intakeAnswer', { id: scriptId, useDefaults: true });
  check('一句「全部用默认」也能确认完', defaults.body.ok === true && defaults.body.value.intake.status === 'done');

  // ---- 提示词模板：内置指令要看得见 ----
  const prompts = await call('prompts', {});
  const story = prompts.body.value?.items?.find((item) => item.name === 'story');
  check('模板接口返回内置指令', Boolean(story?.builtin?.includes('把选定的创意方向写成一条')));
  check('模板接口仍返回覆盖内容字段', typeof story?.content === 'string' && 'custom' in story);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

console.log(failed === 0 ? '\n全部通过：一句话/剧本能开工，导演问完才跑。' : `\n失败 ${failed} 项`);
if (failed > 0) process.exit(1);
