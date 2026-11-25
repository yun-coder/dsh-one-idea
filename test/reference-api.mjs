/**
 * 长视频「先截高光段再拉」端到端冒烟：假 ctx + 真 ffmpeg + 假模型 + 真 HTTP。
 *
 *   node test/reference-api.mjs
 *
 * 造一条 12 秒的测试片，配置成只拆 5 秒，走完整的拉片台链路：
 *   截取 → 切点/抽帧/联系表/音轨 → 转写 → 拆解报告
 * 验证的是：长视频会在拆之前先截断，记录里留下「原片多长、拆的是哪一段」。
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

const label = (ok, text) => console.log(`  ${ok ? '✓' : '✗'} ${text}`);
let failed = 0;
const check = (name, condition, detail = '') => {
  if (!condition) failed += 1;
  label(Boolean(condition), detail ? `${name}（${detail}）` : name);
};

const ffmpeg = process.env.FFMPEG_PATH
  || 'C:\\Users\\dsh\\AppData\\Local\\EaselTools\\ffmpeg\\ffmpeg-9.0.2-essentials_build\\bin\\ffmpeg.exe';
const scriptsDir = join(homedir(), '.dsh', 'skills', 'douyin-teardown', 'scripts');
if (!existsSync(ffmpeg) || !existsSync(join(scriptsDir, 'frames.mjs'))) {
  console.log('跳过：本机没有 ffmpeg 或 douyin-teardown 脚本');
  process.exit(0);
}

const run = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message).slice(-500)));
    else resolve(stdout);
  });
});

const root = await mkdtemp(join(tmpdir(), 'cs-ref-'));
const dataRoot = join(root, 'data');
const projectRoot = join(root, 'projects');
const source = join(root, 'long.mp4');
await run(ffmpeg, [
  '-y', '-v', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
  '-t', '12', '-shortest',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac',
  source,
]);
check('造出 12 秒测试片', existsSync(source));

const routes = [];
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
  tools: { register: () => () => {} },
  llm: {
    resolveModelInfo: async () => null,
    stream: async function* stream() {
      yield { type: 'text-delta', text: '# 拉片报告\n\n## 1. 3 秒钩子\n\n测试片。' };
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
  scriptsDir,
  ffmpegPath: ffmpeg,
  asrModel: 'medium',
  reaVideoCmd: '',
  reaVision: false,
  // 整片 12 秒，只拆 5 秒：走截取分支。
  referenceMaxSeconds: 5,
  referenceStartSeconds: 0,
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
  const created = await call('referenceStudio', { localPath: source });
  check('拉片任务已受理', created.body.ok === true && /^cs_/.test(created.body.value.id), created.body.error?.message);
  const id = created.body.value.id;

  let evidence = null;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const polled = await call('referenceEvidence', { id });
    const value = polled.body.value;
    if (value && ['done', 'failed'].includes(value.status)) {
      evidence = value;
      break;
    }
  }

  check('拉片跑完', evidence?.status === 'done', evidence?.error ?? evidence?.status ?? '超时没有结果');
  if (evidence?.status === 'done') {
    check('记录里写明原片多长', evidence.originalDuration >= 11 && evidence.originalDuration <= 13, String(evidence.originalDuration));
    check('只拆了 5 秒', evidence.window?.start === 0 && evidence.window?.seconds === 5, JSON.stringify(evidence.window));
    check('拆的是截出来的那 5 秒', evidence.summary?.duration >= 4 && evidence.summary?.duration <= 6, String(evidence.summary?.duration));
    check('有镜表', (evidence.shotTable ?? '').length > 0);
    check('有联系表', evidence.contactSheet === true);
    check('有拆解报告', String(evidence.report ?? '').includes('拉片报告'));
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

console.log(failed === 0 ? '\n全部通过：长视频会先截高光段再拆，记录里写明原片与窗口。' : `\n失败 ${failed} 项`);
if (failed > 0) process.exit(1);
