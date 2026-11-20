/**
 * 创意工作台的宿主侧。
 *
 * 一条流水线：
 *   产品画像 + 实时热点 → 创意 idea → 故事剧情 → 分镜脚本 → 人物形象六维 → 配音方案
 *   → 分段出片 → 成片剪辑。
 *
 * 三个 Agent（生产 / 剪辑团队 / 审核）各自独立上下文，通过「产物 + 门禁」交接；
 * 每个阶段都过确定性质量门 + 审核 Agent 打分，不过就打回重做，重试用完仍不过就停下来，
 * 通知人工复核（面板提醒 + inbox + 可选 webhook）。
 *
 * 面板只发请求：文件系统、密钥、模型调用、ffmpeg 全在这一侧。
 */
import { mkdir, copyFile, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

import { createStore, newProject, event, STAGES, STAGE_IDS, STAGE_BY_ID, STAGE_STATUS } from './engine/store.js';
import {
  GATES,
  SIX_DIMENSIONS,
  VOICE_CATALOG,
  describeFailures,
  applyLocks,
  loadShotContract,
  patchStoryboard,
  segmentsOf,
  gateRender,
} from './engine/contracts.js';
import { createAgents, extractJson } from './engine/agents.js';
import { loadMachineOverrides, resolveConfig } from './engine/config.js';
import { runDoctor } from './engine/doctor.js';
import { materializeDemo } from './engine/demo.js';
import { createReference } from './engine/reference.js';
import { detectBurnedCaptions } from './engine/burned-captions.js';
import { matchesStamp, promptLayerFingerprint } from './engine/fingerprint.js';
import { runVisionReview } from './engine/rea-vision.js';
import { createVideoEngine, createVideoTaskStore, findCodex, mimeOf, priceOf, taskView } from './engine/video.js';
import { createMedia, fadeFlagsOf } from './engine/media.js';
import { createOpenFilmFinisher } from './engine/openfilm.js';

const API_PREFIX = '/creative-studio/api';
const FILE_ROUTE = '/creative-studio/file';
const BODY_LIMIT = 4 * 1024 * 1024;
/** 包根目录：示例项目与包内资源都相对它找。 */
const PKG_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * 清洗用户贴进来的输入：浏览器/微信复制时常带首尾引号、书名号、空白甚至换行。
 * 不清掉的话，本机路径会 existsSync 失败，链接会带脏字符下载失败。
 */
function cleanInput(value) {
  return String(value ?? '')
    .replace(/[\u00a0\u3000]/g, ' ')
    .trim()
    .replace(/^[\s"'“”‘’《》<>]+/, '')
    .replace(/[\s"'“”‘’《》<>]+$/, '')
    .trim();
}

/**
 * 把「用户随手贴的东西」分到链接或本机路径：贴进第一个框的是路径也能用，反过来也认。
 */
function normalizeSource(urlRaw, localRaw) {
  let url = cleanInput(urlRaw);
  let localPath = cleanInput(localRaw);
  const looksLikePath = (value) => /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || /^\.{0,2}[\\/]/.test(value);
  const looksLikeUrl = (value) => /^https?:\/\//i.test(value);
  if (url && !localPath && looksLikePath(url) && !looksLikeUrl(url)) {
    localPath = url;
    url = '';
  }
  if (localPath && looksLikeUrl(localPath)) {
    url = url || localPath;
    localPath = '';
  }
  return { url, localPath };
}

const log = (...args) => console.error('[creative-studio]', ...args);

const sendJson = (res, status, payload) => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
};
const ok = (value) => ({ ok: true, value });
const fail = (code, message, details = {}) => ({ ok: false, error: { code, message, details } });

function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法JSON'));
      }
    });
    req.on('error', reject);
  });
}

const clock = () => new Date().toLocaleString('zh-CN', { hour12: false });
const nowIso = () => new Date().toISOString();

export const inject = ['connection', 'webServer', 'tools', 'llm', 'attachments'];

export function apply(ctx, config = {}) {
  const { options, dataRoot, projectRoot, promptsDir } = resolveConfig(config, loadMachineOverrides({ log }));
  const inboxFile = join(dataRoot, 'inbox.json');
  /** 正在跑的项目：id -> { stage, startedAt, stageStartedAt } */
  const jobs = new Map();
  const store = createStore({ root: projectRoot, isRunning: (id) => jobs.has(id) });
  /** 任务队列落盘：宿主重启后靠它把中断的阶段标出来，而不是一直显示"进行中"。 */
  const queueFile = join(dataRoot, 'queue.json');
  const persistQueue = () => {
    const rows = [...jobs.entries()].map(([jobId, job]) => ({
      id: jobId,
      stage: job.stage,
      startedAt: job.startedAt,
      stageStartedAt: job.stageStartedAt ?? null,
    }));
    writeFile(queueFile, JSON.stringify(rows, null, 2), 'utf8').catch(() => {});
  };
  const beginJob = (jobId, job) => {
    jobs.set(jobId, job);
    persistQueue();
  };
  const endJob = (jobId) => {
    jobs.delete(jobId);
    persistQueue();
  };
  // 启动时恢复：上次进程里的 running 都是死的，标成 interrupted 并写清怎么续跑。
  void (async () => {
    try {
      const text = await readFile(queueFile, 'utf8').catch(() => '');
      const parsed = text ? JSON.parse(text) : [];
      // 兼容手写/单条对象：正常写的是数组，但别让一个格式问题把恢复整段跳过。
      const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
      for (const row of rows) {
        const id = String(row?.id ?? '');
        if (!/^cs_[A-Za-z0-9_-]+$/.test(id)) continue;
        const stage = String(row?.stage ?? '');
        await store.update(id, (project) => {
          const record = project.stages?.[stage];
          if (record) {
            record.status = 'interrupted';
            record.error = `宿主重启，这一轮被中断；从「${STAGE_BY_ID[stage]?.label ?? stage}」再跑一次就能续上`;
          }
          project.running = null;
          event(project, { kind: 'run-interrupted', stage, text: `宿主重启，${STAGE_BY_ID[stage]?.label ?? stage}被中断` });
        }).catch(() => {});
        log(`恢复队列：${id} 的 ${stage} 标记为已中断`);
      }
      await writeFile(queueFile, '[]', 'utf8').catch(() => {});
    } catch (error) {
      log(`恢复任务队列失败（忽略）：${error.message}`);
    }
  })();
  const media = createMedia({ ffmpegPath: options.ffmpegPath, log });
  const openfilm = createOpenFilmFinisher({ config: options, log, media });
  const video = createVideoEngine({ config: options, log });
  const agents = createAgents({ callModel, config: { ...options, promptsDir } });
  const reference = createReference({
    scriptsDir: options.scriptsDir,
    nodePath: options.nodePath,
    pythonPath: options.pythonPath,
    asrModel: options.asrModel,
    log,
  });
  /** 独立出片任务的索引（h3_* 工具与「拉片台 / 出片」共用）。 */
  const videoTasks = createVideoTaskStore({ file: join(dataRoot, 'video-tasks.json'), log });

  let shotContractPromise;
  const getShotContract = () => (shotContractPromise ??= loadShotContract(options.skillDir).catch((error) => {
    log(`分镜门禁没载入（${options.skillDir}）：${error.message}`);
    shotContractPromise = null;
    throw error;
  }));

  // -------------------------------------------------------------------------
  // 模型：走宿主自己的ctx.llm，跟随当前默认模型  // -------------------------------------------------------------------------
  const effortCache = new Map();

  function resolveRoute() {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
    if (selection && typeof selection === 'object' && selection.provider && selection.model) {
      return { provider: String(selection.provider), model: String(selection.model) };
    }
    throw new Error('读不到默认模型：请先在设置里选一个模型，再跑创意工作台');
  }

  /** 阶段指纹：谁做的这一版（模型 + 提示词层）。读不到模型时退化成 unknown，不阻断流程。 */
  function stageFingerprint() {
    let model = 'unknown';
    try {
      const route = resolveRoute();
      model = `${route.provider}:${route.model}`;
    } catch {
      model = 'unknown';
    }
    return { model, prompts: promptLayerFingerprint(promptsDir) };
  }

  /** 推理档位取模型声明的最低一档：JSON 生成不需要长思考，也不要把输出预算烧在思考上。 */
  async function resolveEffort(llm, route) {
    const key = `${route.provider}/${route.model}`;
    if (effortCache.has(key)) return effortCache.get(key);
    let effort;
    try {
      const info = await llm.resolveModelInfo?.(route.provider, route.model);
      const efforts = info?.reasoning?.efforts ?? [];
      if (efforts.length > 0) {
        const order = ['minimal', 'none', 'low', 'medium', 'high', 'max'];
        const sorted = [...efforts].sort((a, b) => order.indexOf(String(a.id)) - order.indexOf(String(b.id)));
        effort = sorted[0]?.id;
      }
    } catch {
      effort = undefined;
    }
    effortCache.set(key, effort);
    return effort;
  }

  async function callModel({ system, user, temperature = 0.7, maxTokens, signal, images = [] }) {
    const route = resolveRoute();
    const effort = await resolveEffort(ctx.llm, route);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`模型调用超时（${Math.round(options.llmTimeoutMs / 1000)}s）`)), options.llmTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    // 图片走宿主的附件服务：先落成 attachment ref，再作为 image block 进消息。
    const blocks = [{ type: 'text', text: user }];
    for (const image of images) {
      const mediaType = /\.png$/i.test(image) ? 'image/png' : /\.webp$/i.test(image) ? 'image/webp' : 'image/jpeg';
      const ref = await ctx.attachments.saveImage({ data: await readFile(image), mediaType, name: basename(image) });
      blocks.push({ type: 'image', attachment: ref });
    }
    let out = '';
    try {
      for await (const chunk of ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        messages: [{ role: 'user', content: blocks, source: { kind: 'plugin:dsh-one-idea' } }],
        temperature,
        maxTokens: Number(maxTokens) || options.llmMaxTokens,
        signal: combined,
        ...(effort ? { reasoningEffort: effort } : {}),
      })) {
        if (chunk.type === 'text-delta') out += chunk.text;
        else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          throw new Error(chunk.reason.failure?.message ?? '模型调用失败');
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`模型调用被中断或超时（${Math.round(options.llmTimeoutMs / 1000)}s）`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!out.trim()) throw new Error('模型返回了空内容');
    return out;
  }

  // -------------------------------------------------------------------------
  // 阶段上下文与门禁
  // -------------------------------------------------------------------------
  async function artifactOf(project, stage) {
    return store.artifact(project, stage);
  }

  async function contextOf(project, stage) {
    const context = { project };
    if (stage === 'idea' || stage === 'story' || stage === 'storyboard') {
      if (project.reference?.report) {
        context.reference = { report: project.reference.report, summary: project.reference.summary ?? null };
      }
    }
    if (stage === 'story') context.idea = await pickIdea(project);
    if (stage === 'storyboard') {
      context.idea = await pickIdea(project);
      context.story = await artifactOf(project, 'story');
    }
    if (stage === 'characters') context.storyboard = await artifactOf(project, 'storyboard');
    if (stage === 'voice') {
      context.storyboard = await artifactOf(project, 'storyboard');
      context.characters = await artifactOf(project, 'characters');
    }
    if (stage === 'edit') {
      context.storyboard = await artifactOf(project, 'storyboard');
      context.characters = await artifactOf(project, 'characters');
      context.voice = await artifactOf(project, 'voice');
      context.render = project.stages.render?.artifact ?? null;
    }
    return context;
  }

  /** 用户可以在面板上指定一个创意方向：换成「只给这一个方向 + 推荐它」的形态喂给生产 Agent。 */
  async function pickIdea(project) {
    const doc = await artifactOf(project, 'idea');
    if (!doc) return null;
    if (project.chosenIdea === null || project.chosenIdea === undefined) return doc;
    const chosen = doc.ideas?.[project.chosenIdea] ?? doc.ideas?.find((idea) => idea.id === project.chosenIdea);
    if (!chosen) return doc;
    return { ideas: [chosen], recommended: { id: chosen.id, reason: '用户选定了这个方向' } };
  }

  async function runGate(stage, artifact, context) {
    const gate = GATES[stage];
    if (!gate) return { ok: true, failures: [], summary: '无门禁' };
    try {
      if (stage === 'storyboard') return gate(artifact, { ...context, shotContract: await getShotContract().catch(() => null) });
      return gate(artifact, context);
    } catch (error) {
      return { ok: false, failures: [`门禁自身出错：${error.message}`], summary: '门禁异常' };
    }
  }

  // -------------------------------------------------------------------------
  // 通知：需要人工复核时
  // -------------------------------------------------------------------------
  async function pushInbox(item) {
    let list = [];
    try {
      const parsed = JSON.parse(await readFile(inboxFile, 'utf8'));
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }
    list.unshift(item);
    await mkdir(join(projectRoot, '..'), { recursive: true });
    await writeFile(inboxFile, JSON.stringify(list.slice(0, 100), null, 2), 'utf8');
  }

  async function notifyReview(project, stage, payload) {
    const item = {
      at: Date.now(),
      atText: clock(),
      projectId: project.id,
      projectTitle: project.title,
      stage,
      stageLabel: STAGE_BY_ID[stage]?.label ?? stage,
      score: payload.score ?? null,
      issues: (payload.issues ?? []).slice(0, 8),
      gateFailures: (payload.gateFailures ?? []).slice(0, 8),
      reason: payload.reason ?? '质量不达标，重试用完',
    };
    project.pendingReview = item;
    event(project, { kind: 'review-request', stage, text: `需要人工复核：${item.stageLabel}（${item.reason}）` });
    await store.update(project.id, (fresh) => {
      fresh.pendingReview = item;
      fresh.stages[stage] = { ...fresh.stages[stage], status: 'needs_review' };
      event(fresh, { kind: 'review-request', stage, text: `需要人工复核：${item.stageLabel}（${item.reason}）` });
    }).catch(() => {});
    await pushInbox(item).catch((error) => log(`写inbox 失败：${error.message}`));
    log(`⚠ 需要复核：${project.title} / ${item.stageLabel} / ${item.reason}`);
    if (options.notifyWebhook) {
      fetch(options.notifyWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `创意工作台需要复核：${project.title}｜${item.stageLabel}｜${item.reason}`, ...item }),
      }).catch((error) => log(`webhook 推送失败：${error.message}`));
    }
    return item;
  }

  // -------------------------------------------------------------------------
  // 参考爆款：拉片 → 拆解报告（作为创意阶段的证据）
  // -------------------------------------------------------------------------
  async function runReferenceJob(project, { url, localPath, advanced = true }) {
    const dir = join(store.dirOf(project.id), 'reference');
    await mkdir(dir, { recursive: true });
    const patch = async (value) => {
      await store.update(project.id, (fresh) => {
        fresh.reference = { ...(fresh.reference ?? {}), ...value, dir, at: Date.now() };
      }).catch(() => {});
    };
    const stage = (status, text) => patch({ status, stage: text });
    try {
      await stage('running', '准备素材');
      // 本机路径给了就必须真的存在：否则会掉进「按链接下载」，最后报一句看不懂的空链接错误。
      if (!localPath && !url) throw new Error('没有拿到链接或本机路径：把抖音分享文案或 mp4 路径重新贴一次');
      if (localPath && !existsSync(localPath)) {
        throw new Error(`找不到这个本机视频：${localPath}（路径要完整、带盘符，不要带首尾引号）`);
      }
      let video;
      if (localPath && existsSync(localPath)) {
        video = join(dir, 'video.mp4');
        await copyFile(localPath, video);
        await writeFile(join(dir, 'meta.json'), JSON.stringify({ source: 'local', path: localPath }, null, 2), 'utf8');
        await stage('running', '已接收本地视频');
      } else {
        const fetched = await reference.fetch({
          url,
          dir,
          onStage: stage,
          // 抖音要「新鲜 cookie」：留空就用脚本自己的兜底提示；配了 cookies.txt（浏览器扩展导出）就能直接下。
          env: options.cookiesFile ? { YTDLP_COOKIES: options.cookiesFile } : undefined,
        });
        video = fetched.video;
      }
      const framed = await reference.frames({ video, dir, onStage: stage });
      // 烧字检测：素材画面上已经压了文字的话，复刻时再叠字幕就是双字幕，且剪辑阶段补不回来。
      // 检测失败不致命（detected:null = 没有结论），不阻断拉片。
      let burnedCaption = null;
      try {
        burnedCaption = await detectBurnedCaptions({
          video,
          seconds: framed.duration,
          ffmpegPath: options.ffmpegPath || 'ffmpeg',
          log,
        });
      } catch (error) {
        burnedCaption = { detected: null, reason: error.message };
        log(`[reference] 烧字检测失败（不影响继续）：${error.message}`);
      }
      const asr = await reference.asr({ audio: framed.audio, dir, onStage: stage });
      // 可选的高级拆解：逐镜判定实拍/AI/代码，并给出复刻路线。失败不致命。
      let rea = null;
      let reaError = null;
      if (advanced && options.reaVideoCmd) {
        try {
          rea = await reference.rea({ video, dir, cmd: options.reaVideoCmd, onStage: stage });
          // 工具只能测帧率、噪声，画面语义还得有人看：让能看图的模型逐镜复核，再把答案并回结论。
          if (options.reaVision !== false) {
            try {
              const reviewed = await runVisionReview({
                ctx,
                callModel,
                extractJson,
                reference,
                rea,
                config: options,
                log,
                onProgress: (text) => { stage('reviewing', text).catch(() => {}); },
              });
              rea = { ...rea, summary: reviewed.summary, timeline: reviewed.timeline, vision: reviewed.vision };
            } catch (error) {
              rea = { ...rea, visionError: error.message };
              log(`[reference] 看图复核失败（沿用工具判定）：${error.message}`);
            }
          }
        } catch (error) {
          reaError = error.message;
          log(`[reference] rea-video 失败（不影响基础拆解）：${error.message}`);
        }
      }
      const evidence = await reference.evidence(dir);
      evidence.rea = rea;
      await stage('analyzing', '生成拆解报告');
      const report = await agents.analyzeReference({ project, evidence });
      await writeFile(join(dir, 'report.md'), report, 'utf8');
      await patch({
        status: 'done',
        stage: '完成',
        error: null,
        summary: evidence.summary,
        shotCount: framed.shotCount,
        duration: framed.duration,
        burnedCaption,
        shotTable: evidence.shotTable,
        frames: evidence.frames ?? [],
        contactSheet: evidence.contactSheet ?? null,
        transcriptLines: asr?.lines ? asr.lines.slice(0, 4000) : asr?.error ? `（转写失败：${asr.error}）` : '（没有转写）',
        report: report.slice(0, 9000),
        reportFile: join(dir, 'report.md'),
        rea: rea ? { ok: true, summary: rea.summary, timeline: rea.timeline, videoMd: rea.videoMd, out: rea.out, reportHtml: rea.reportHtml, vision: rea.vision ?? null, visionError: rea.visionError ?? null } : null,
        reaError,
      });
      await store.update(project.id, (fresh) => {
        event(fresh, { kind: 'reference', text: `参考爆款拆解完成：${evidence.summary?.title ?? ''}（${framed.shotCount} 镜）` });
      }).catch(() => {});
    } catch (error) {
      await patch({ status: 'failed', stage: '失败', error: error.message });
      await store.update(project.id, (fresh) => {
        event(fresh, { kind: 'reference-error', text: `参考爆款拆解失败：${error.message}` });
      }).catch(() => {});
    }
  }

  /** 复刻分镜：把已经拉完的证据翻成 shot-contract 结构，补锁行后过一遍 13 道门。 */
  async function runReplicate(project) {
    const dir = join(store.dirOf(project.id), 'reference');
    const evidence = await reference.evidence(dir);
    const storyboard = await agents.replicateStoryboard({ project, evidence });
    const contract = await getShotContract().catch(() => null);
    const locked = applyLocks(storyboard, contract?.buildLock);
    const gate = await runGate('storyboard', storyboard, { project, shotContract: contract });
    await writeFile(join(dir, 'replicate.json'), JSON.stringify(storyboard, null, 2), 'utf8');
    const summary = { shots: (storyboard.shots ?? []).length, segments: segmentsOf(storyboard).length, locks: locked.changed, gate: { ok: gate.ok, failures: (gate.failures ?? []).slice(0, 6) } };
    await store.update(project.id, (fresh) => {
      fresh.reference = { ...(fresh.reference ?? {}), replicateFile: join(dir, 'replicate.json'), replicateSummary: summary, at: Date.now() };
      event(fresh, { kind: 'replicate', text: `复刻分镜已生成：${summary.shots} 镜 / ${summary.segments} 段${gate.ok ? '（13 道门全绿）' : `（门禁 ${(gate.failures ?? []).length} 条未过）`}` });
    });
    return { storyboard, gate, summary };
  }

  // -------------------------------------------------------------------------
  // 独立出片 / 生图 / 合片（h3_* 工具走这里，和创意阶段共用同一个引擎）
  // -------------------------------------------------------------------------
  async function loadImageFile(path, name) {
    if (!path || !existsSync(path)) throw new Error(`找不到图片：${path}`);
    const buffer = await readFile(path);
    const mime = /\.jpe?g$/i.test(path) ? 'image/jpeg' : /\.webp$/i.test(path) ? 'image/webp' : 'image/png';
    return { name: name || basename(path), mime, buffer };
  }

  /** 提交一段独立视频并等它落盘；任务写进持久化索引，重载后还能查。 */
  async function runStandaloneVideo({ prompt, mode = 't2va', seconds, resolution, aspectRatio, model, images = [], signal }) {
    await videoTasks.load();
    const created = await video.submit({
      prompt: String(prompt ?? '').trim(),
      mode,
      seconds: Number(seconds) || Number(options.seconds) || 5,
      resolution: resolution || options.resolution,
      aspect: aspectRatio || options.aspectRatio,
      model: model || options.videoModel,
      images,
    });
    const record = {
      id: created.taskId,
      provider: created.provider,
      providerLabel: created.label,
      prompt: String(prompt ?? '').trim(),
      mode,
      model: model || options.videoModel,
      resolution: resolution || options.resolution,
      seconds: Number(seconds) || Number(options.seconds) || 5,
      aspectRatio: aspectRatio || options.aspectRatio,
      status: 'queued',
      progress: 0,
      error: null,
      file: null,
      bytes: null,
      cost: Number((priceOf(model || options.videoModel, resolution || options.resolution) * (Number(seconds) || 5)).toFixed(2)),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await videoTasks.upsert(record);
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline && !signal?.aborted) {
      await new Promise((timer) => setTimeout(timer, 8000));
      try {
        const state = await video.status({ taskId: record.id, provider: record.provider });
        record.status = state.status;
        record.progress = state.progress ?? record.progress;
        record.error = state.error ?? null;
      } catch (error) {
        record.error = error.message;
      }
      await videoTasks.upsert(record);
      if (['completed', 'failed', 'cancelled'].includes(String(record.status))) break;
    }
    if (record.status === 'completed') {
      try {
        const saved = await video.download({ taskId: record.id, provider: record.provider, dir: join(dataRoot, 'videos'), filename: `${record.id}.mp4` });
        record.file = saved.file;
        record.bytes = saved.bytes;
        record.error = null;
      } catch (error) {
        record.error = `已完成但下载失败：${error.message}`;
      }
    }
    record.updatedAt = Date.now();
    await videoTasks.upsert(record);
    return record;
  }

  async function runStandaloneImage({ prompt, model, size }) {
    const result = await video.generateImage({
      prompt: String(prompt ?? '').trim(),
      model,
      size,
      dir: join(dataRoot, 'images'),
      filename: `img_${Date.now().toString(36)}.png`,
    });
    const info = await stat(result.file);
    return { id: basename(result.file, '.png'), file: result.file, bytes: info.size, model: result.model };
  }

  async function concatTasks(ids) {
    await videoTasks.load();
    const files = [];
    for (const id of ids) {
      const record = videoTasks.get(id);
      if (!record) throw new Error(`没有这个任务，${id}`);
      if (!record.file || !existsSync(record.file)) {
        const saved = await video.download({ taskId: record.id, provider: record.provider, dir: join(dataRoot, 'videos'), filename: `${record.id}.mp4` });
        record.file = saved.file;
        record.bytes = saved.bytes;
        await videoTasks.upsert(record);
      }
      files.push(record.file);
    }
    if (files.length < 2) throw new Error('至少选两段才能拼接');
    const output = join(dataRoot, 'videos', `concat-${Date.now()}.mp4`);
    await media.concatCopy({ files, output });
    const info = await stat(output);
    return { file: output, bytes: info.size };
  }

  /** 正在跑的拉片记录：删之前要先等它跑完，否则文件被占用或又被写回来。 */
  const referenceJobs = new Set();
  function startReferenceJob(project, input) {
    referenceJobs.add(project.id);
    runReferenceJob(project, input)
      .catch((error) => log(`拉片任务异常：${error.message}`))
      .finally(() => referenceJobs.delete(project.id));
  }

  // -------------------------------------------------------------------------
  // 生产阶段：生成 → 门禁 → 审核 → 打回重做
  // -------------------------------------------------------------------------
  const PRODUCE_STAGES = ['idea', 'story', 'storyboard', 'characters', 'voice'];

  async function runProduceStage(project, stage, { note, signal } = {}) {
    const record = project.stages[stage];
    record.status = 'running';
    record.error = null;
    record.attempts = 0;
    record.startedAt = Date.now();
    event(project, { kind: 'stage-start', stage, text: `${STAGE_BY_ID[stage].label}开始（生产 Agent）` });
    await store.save(project, { pipeline: true });

    const context = await contextOf(project, stage);
    // note 是用户或 Agent 对本轮的硬性要求，不是「上一版的错」，单独一路传，跨 attempt 都保留。
    const directive = String(note ?? '').trim();
    let issues = [];
    const maxAttempts = Math.max(1, Number(options.maxRework) + 1);
    let last = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      record.attempts = attempt;
      try {
        let artifact = await agents.produce({ stage, project, context, issues, directive, signal });
        if (stage === 'storyboard') {
          // 技能明确要求：锁行不能手写，用脚本生成后逐字贴进去。宿主在这里代劳。
          const contract = await getShotContract().catch(() => null);
          const locked = applyLocks(artifact, contract?.buildLock);
          if (locked.changed > 0) {
            event(project, { kind: 'locks', stage, text: `按现场表补齐 ${locked.changed} 条锁行` });
          }
        }
        const file = await store.writeArtifact(project, stage, artifact);
        const gate = await runGate(stage, artifact, context);
        const review = await agents.review({ stage, project, artifact, gate, attempt, signal });
        last = { artifact, gate, review, file };
        record.gate = { ok: gate.ok, failures: (gate.failures ?? []).slice(0, 12), at: Date.now() };
        record.review = {
          score: review.score,
          pass: review.pass,
          dimensions: review.dimensions,
          summary: review.summary,
          accepted: review.acceptedWithNotes ? 'with-notes' : 'clean',
          at: Date.now(),
        };
        record.file = file ? basename(file) : null;
        record.updatedAt = Date.now();
        await store.saveReview(project, stage, attempt, { stage, attempt, artifact, gate, review }).catch(() => {});

        if (gate.ok && review.pass) {
          record.status = 'done';
          record.error = null;
          // 记下这一版是谁做的：换模型或改提示词后，下游据此判定旧产物失效。
          record.stamp = stageFingerprint();
          const notes = (review.issues ?? []).slice(0, 6).map((issue) => `[${issue.severity ?? 'major'}] ${issue.where ?? ''}：${issue.problem ?? ''}`);
          record.issues = review.acceptedWithNotes ? notes : [];
          record.note = null;
          event(project, {
            kind: 'stage-done',
            stage,
            text: `${STAGE_BY_ID[stage].label}通过（第 ${attempt} 版，审核 ${review.score} 分${review.acceptedWithNotes ? `，${notes.length} 条建议` : ''}）`,
          });
          await store.save(project, { pipeline: true });
          if (stage === 'characters') await ensurePortraits(project, artifact);
          return { ok: true, stage, attempts: attempt, score: review.score };
        }

        const gateIssues = (gate.failures ?? []).map((failure) => describeFailures({ failures: [failure] }));
        const reviewIssues = (review.issues ?? []).map((issue) => `[${issue.severity ?? 'major'}] ${issue.where ?? ''}：${issue.problem ?? ''} → ${issue.fix ?? ''}`);
        issues = [...gateIssues, ...reviewIssues].filter(Boolean).slice(0, 20);
        record.status = 'rework';
        record.issues = issues;
        event(project, {
          kind: 'stage-rework',
          stage,
          text: `第 ${attempt} 版没过（门禁 ${gate.ok ? '通过' : '失败'} / 审核 ${review.score} 分），打回重做`,
        });
        await store.save(project, { pipeline: true });
      } catch (error) {
        record.error = error.message;
        record.status = 'failed';
        event(project, { kind: 'stage-error', stage, text: `${STAGE_BY_ID[stage].label}失败：${error.message}` });
        await store.save(project, { pipeline: true });
        return { ok: false, stage, error: error.message };
      }
      if (signal?.aborted) break;
    }

    record.status = 'needs_review';
    record.issues = issues;
    await store.save(project, { pipeline: true });
    const pending = await notifyReview(project, stage, {
      score: last?.review?.score ?? null,
      issues: last?.review?.issues ?? [],
      gateFailures: last?.gate?.failures ?? [],
      reason: `自动重做 ${record.attempts} 次仍未过`,
    });
    return { ok: false, stage, needsReview: true, pendingReview: pending };
  }

  /** 人物定妆图：过了六维门之后逐人生成，失败只记录不阻塞。 */
  async function ensurePortraits(project, artifact) {
    // 有 Codex 用 Codex 的 image_generation，否则用 HTTP 生图；两者都没有就跳过。
    if (!options.imageKey && !options.codexCmd && !findCodex()) return;
    const dir = join(store.dirOf(project.id), 'portraits');
    let changed = false;
    for (const character of artifact.characters ?? []) {
      if (character.portrait?.file && existsSync(character.portrait.file)) continue;
      try {
        const prompt = [artifact.style, character.prompt, '半身像，正面，纯灰背景，柔和均匀的柔光，无文字，无水印。']
          .filter(Boolean)
          .join('，');
        const result = await video.generateImage({ prompt, dir, filename: `${character.name}.png` });
        character.portrait = { file: result.file, model: result.model, at: Date.now() };
        changed = true;
        event(project, { kind: 'portrait', stage: 'characters', text: `定妆图已生成：${character.name}` });
      } catch (error) {
        character.portrait = { error: error.message, at: Date.now() };
        changed = true;
        event(project, { kind: 'portrait-error', stage: 'characters', text: `定妆图失败（${character.name}）：${error.message}` });
      }
      await store.save(project, { pipeline: true });
    }
    if (changed) await store.writeArtifact(project, 'characters', artifact);
  }

  // -------------------------------------------------------------------------
  // 出片阶段：每段一个任务，提交后统一轮询
  // -------------------------------------------------------------------------
  async function runRenderStage(project, { signal, forceSegmentId, compareOnly, note } = {}) {
    const storyboard = await artifactOf(project, 'storyboard');
    if (!storyboard) throw new Error('还没有分镜，不能出片');
    const characters = (await artifactOf(project, 'characters')) ?? { characters: [] };
    const segmentDir = join(store.dirOf(project.id), 'segments');
    await mkdir(segmentDir, { recursive: true });

    const record = project.stages.render;
    record.status = 'running';
    record.error = null;
    if (forceSegmentId) {
      if (!compareOnly || project.pendingReview?.stage !== 'edit') project.pendingReview = null;
      event(project, { kind: 'render-retake', stage: 'render', text: `只重新生成段 ${forceSegmentId}，其余段素材保留` });
    }
    event(project, { kind: 'stage-start', stage: 'render', text: '分段出片开始' });
    await store.save(project, { pipeline: true });

    const segments = segmentsOf(storyboard);
    const previous = new Map(((record.artifact?.tasks ?? [])).map((task) => [task.segmentId, task]));
    const tasks = [];
    const priorTake = compareOnly ? previous.get(forceSegmentId) : null;
    if (project.finalFile && !project.stages.edit.timeline) {
      project.stages.edit.timeline = reviewTimeline(await artifactOf(project, 'edit'), record.artifact);
    }
    const takes = record.artifact?.takes ?? {};
    for (const task of previous.values()) rememberTake(takes, task);
    record.artifact = { tasks, takes, startedAt: Date.now() };

    // 1) 提交（已完成的段直接复用，不重复花钱）
    for (const segment of segments) {
      const images = await referenceImages(segment, characters);
      const input = {
        prompt: forceSegmentId === segment.id && note
          ? [segment.prompt, `本段返工要求：${note}`].join('\n\n')
          : segment.prompt,
        mode: images.length > 0 ? 'ref2va' : 't2va',
        seconds: segment.duration,
        resolution: String(project.resolution || options.resolution),
        aspect: String(project.aspect || options.aspectRatio),
        model: options.videoModel,
      };
      const hash = createHash('sha256').update(JSON.stringify(input));
      for (const image of images) hash.update(JSON.stringify(image.subject)).update(createHash('sha256').update(image.buffer).digest());
      const inputHash = hash.digest('hex');
      const savedTask = previous.get(segment.id);
      const matchingInput = savedTask?.inputHash
        ? savedTask.inputHash === inputHash
        : savedTask?.prompt === input.prompt && savedTask?.seconds === input.seconds;
      const keepOtherSegment = forceSegmentId && forceSegmentId !== segment.id
        && savedTask?.status === 'completed' && existsSync(savedTask.file ?? '');
      const old = forceSegmentId !== segment.id && (matchingInput || keepOtherSegment) ? savedTask : null;
      if (old?.status === 'completed' && old.file && existsSync(old.file)) {
        // 改了 trimSubtitleBand：原来裁过、现在不裁，就退回原片，不必重新花钱生成。
        if (!options.trimSubtitleBand && old.rawFile && existsSync(old.rawFile) && old.file !== old.rawFile) {
          old.file = old.rawFile;
          event(project, { kind: 'render', stage: 'render', text: `段 ${segment.id} 改回未裁切的原片` });
        }
        tasks.push(old);
        continue;
      }
      const task = old?.taskId && !['failed', 'cancelled'].includes(old.status)
        ? old
        : { segmentId: segment.id, seconds: segment.duration, prompt: input.prompt, inputHash, status: 'queued', progress: 0, error: null, file: null, createdAt: Date.now() };
      tasks.push(task);
      if (!task.taskId) {
        try {
          const submitted = await video.submit({ ...input, images });
          task.taskId = submitted.taskId;
          task.provider = submitted.provider;
          task.providerLabel = submitted.label;
          task.referenceCount = submitted.referenceCount;
          task.referenceNames = submitted.referenceCount ? images.map((image) => image.subject) : [];
          task.status = 'queued';
          task.submittedAt = Date.now();
          event(project, { kind: 'render-submit', stage: 'render', text: `段 ${segment.id} 已提交（${submitted.label} · ${segment.duration}s）` });
        } catch (error) {
          task.status = 'failed';
          task.error = error.message;
          event(project, { kind: 'render-error', stage: 'render', text: `段${segment.id} 提交失败：${error.message}` });
        }
        await store.save(project, { pipeline: true });
      } else {
        task.status = 'queued';
      }
    }

    // 2) 轮询：上游最快几十秒，慢的几分钟；整体给 40 分钟
    const deadline = Date.now() + 40 * 60 * 1000;
    let consecutiveFailures = 0;
    while (Date.now() < deadline && !signal?.aborted) {
      const pending = tasks.filter((task) => ['queued', 'processing', 'unknown', 'in_progress', 'pending', 'running'].includes(String(task.status)) && task.taskId);
      if (pending.length === 0) break;
      let progressed = false;
      for (const task of pending) {
        try {
          const state = await video.status({ taskId: task.taskId, provider: task.provider });
          task.status = state.status === 'completed' ? 'processing' : state.status;
          task.progress = state.progress ?? task.progress ?? 0;
          if (state.error) task.error = state.error;
          progressed = true;
          if (state.status === 'completed') {
            const saved = await video.download({
              taskId: task.taskId,
              provider: task.provider,
              dir: segmentDir,
              filename: `${task.segmentId}-${task.taskId}.mp4`,
            });
            task.status = 'completed';
            task.rawFile = saved.file;
            task.file = saved.file;
            if (!priorTake?.file && (project.finalFile || project.stages.edit?.finalFile)) project.stages.edit.stale = true;
            if (options.trimSubtitleBand) {
              const trimmed = saved.file.replace(/\.mp4$/i, '') + '.trimmed.mp4';
              try {
                await media.trimBand({ input: saved.file, output: trimmed, ratio: options.subtitleBandRatio });
                task.file = trimmed;
                task.trimmed = true;
              } catch (error) {
                task.error = `已下载，裁字幕带失败：${error.message}`;
              }
            }
            const info = await media.probe(task.file).catch(() => null);
            if (info?.duration) task.duration = Math.round(info.duration * 10) / 10;
            // 落盘成功就把之前轮询超时留下的错误清掉，别让任务卡显示假错误。
            if (task.file && existsSync(task.file)) task.error = null;
            rememberTake(takes, task);
            event(project, { kind: 'render-done', stage: 'render', text: `段${task.segmentId} 完成${task.duration ? `（${task.duration}s）` : ''}` });
          } else if (state.status === 'failed') {
            event(project, { kind: 'render-error', stage: 'render', text: `段 ${task.segmentId} 失败：${state.error ?? '未知原因'}` });
          }
        } catch (error) {
          task.error = error.message;
        }
      }
      await store.save(project, { pipeline: true });
      // 一次轮询全部超时不算「跑完了」：上游偶尔抽风，连续 5 轮都拿不到状态才放弃。
      if (!progressed) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) break;
      } else {
        consecutiveFailures = 0;
      }
      if (tasks.every((task) => ['completed', 'failed', 'cancelled'].includes(String(task.status)))) break;
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 8000));
    }

    const gate = gateRender(record.artifact, { storyboard });
    record.gate = { ok: gate.ok, failures: (gate.failures ?? []).slice(0, 12), at: Date.now() };
    record.completedAt = Date.now();
    if (gate.ok) {
      if (priorTake?.status === 'completed' && priorTake.file && existsSync(priorTake.file)) {
        const index = tasks.findIndex((task) => task.segmentId === forceSegmentId);
        tasks[index] = priorTake;
        event(project, { kind: 'render-alternate', stage: 'render', text: `段 ${forceSegmentId} 的候选素材已就绪，可在审片台对比后采用` });
      }
      record.status = 'done';
      event(project, { kind: 'stage-done', stage: 'render', text: `出片完成，${tasks.length} 段` });
      await store.save(project, { pipeline: true });
      return { ok: true, stage: 'render', tasks: tasks.length };
    }
    record.status = 'needs_review';
    await store.save(project, { pipeline: true });
    const pending = await notifyReview(project, 'render', {
      gateFailures: gate.failures,
      reason: '有段没出成功，需要人工决定重试还是改分镜',
    });
    return { ok: false, stage: 'render', needsReview: true, pendingReview: pending };
  }

  /** 以分镜的出场顺序绑定本段角色定妆图。 */
  async function referenceImages(segment, characters) {
    const portraits = new Map((characters?.characters ?? []).map(({ name, portrait }) => [name, portrait?.file]));
    const images = await Promise.all(segment.people.map(async (subject, index) => {
      const file = portraits.get(subject);
      if (!file) return null;
      const buffer = await readFile(file).catch(() => null);
      if (!buffer) return null;
      const mime = mimeOf(file);
      const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
      return { subject, name: `portrait-${index + 1}.${extension}`, mime, buffer };
    }));
    return images.filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // 剪辑阶段：剪辑团队 Agent 出 EDL → 宿主执行 ffmpeg → 审核 Agent 终审
  // -------------------------------------------------------------------------
  async function runEditStage(project, { note, signal } = {}) {
    const record = project.stages.edit;
    record.status = 'running';
    record.error = null;
    event(project, { kind: 'stage-start', stage: 'edit', text: '成片剪辑开始（剪辑团队 Agent）' });
    await store.save(project, { pipeline: true });

    const storyboard = await artifactOf(project, 'storyboard');
    const characters = await artifactOf(project, 'characters');
    const voice = await artifactOf(project, 'voice');
    const render = project.stages.render?.artifact;
    const completed = (render?.tasks ?? []).filter((task) => task?.status === 'completed' && task.file);
    if (completed.length === 0) throw new Error('没有可用的片段，先跑出片');

    const maxAttempts = Math.max(1, Number(options.maxRework) + 1);
    let issues = note ? [`用户要求：${note}`] : [];
    let last = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      record.attempts = attempt;
      let edl;
      try {
        edl = await agents.edit({ project, storyboard, render, voice, characters, issues, signal });
      } catch (error) {
        record.error = error.message;
        record.status = 'failed';
        event(project, { kind: 'stage-error', stage: 'edit', text: `剪辑方案生成失败：${error.message}` });
        await store.save(project, { pipeline: true });
        return { ok: false, stage: 'edit', error: error.message };
      }
      const gate = await runGate('edit', edl, { render, project });
      record.gate = { ok: gate.ok, failures: (gate.failures ?? []).slice(0, 12), at: Date.now() };
      await store.writeArtifact(project, 'edit', edl);

      if (!gate.ok) {
        issues = gate.failures.slice(0, 12);
        record.status = 'rework';
        record.issues = issues;
        event(project, { kind: 'stage-rework', stage: 'edit', text: `剪辑清单第${attempt} 版没过：${issues[0] ?? ''}` });
        await store.save(project, { pipeline: true });
        continue;
      }

      // 执行 EDL
      let output;
      try {
        output = await executeEdl(project, edl, completed);
        record.finalFile = output.finalFile;
        record.coverFile = output.coverFile;
        record.duration = output.duration;
        record.timeline = reviewTimeline(edl, render, output.timeline);
        record.stale = false;
        record.note = null;
        record.visual = null;
        record.review = null;
        record.openfilm = null;
        record.outputAt = Date.now();
        // 成片一剪出来就挂到项目上：审核可能不过，但片子本身要给人在面板里看得见。
        project.finalFile = output.finalFile;
        project.coverFile = output.coverFile;
        await store.save(project, { pipeline: true });
      } catch (error) {
        record.error = `剪辑执行失败：${error.message}`;
        record.status = 'failed';
        event(project, { kind: 'stage-error', stage: 'edit', text: record.error });
        await store.save(project, { pipeline: true });
        return { ok: false, stage: 'edit', error: record.error };
      }

      // 画面验收：抽三帧给能看图的模型。结构门和文本审核都看不出「拖鞋变成碗」这种事。
      let visual = null;
      try {
        const editDir = join(store.dirOf(project.id), 'edit');
        await mkdir(editDir, { recursive: true });
        const frames = [];
        for (const at of [0.12, 0.5, 0.88]) {
          const file = join(editDir, `check-${Math.round(at * 100)}.jpg`);
          await media.frame({ input: output.finalFile, output: file, at: Math.max(0.1, (output.duration || 1) * at) });
          frames.push(file);
        }
        visual = await agents.reviewFrames({ project, frames, signal });
        record.visual = visual;
        event(project, {
          kind: visual.pass ? 'visual-pass' : 'visual-fail',
          stage: 'edit',
          text: visual.pass ? '画面验收通过' : `画面验收拦下：${visual.summary || (visual.issues[0]?.problem ?? '')}`,
        });
        await store.save(project, { pipeline: true });
      } catch (error) {
        visual = { pass: true, issues: [], summary: '', error: error.message };
        record.visual = visual;
        log(`[edit] 画面验收失败（不阻塞）：${error.message}`);
      }

      // 逐帧体检（OpenFilm 收尾时才有）：白闪 / 黑帧 / 静帧 / 响度，作为审核的客观证据。
      // 文本审核只读 JSON，看不出「这一刀闪了一下」；这一步是真逐帧看的。
      let openfilmQa = null;
      if (output?.engine === 'openfilm' && options.openfilmLook) {
        try {
          openfilmQa = await openfilm.look({ filmDir: store.dirOf(project.id), file: output.finalFile, lufs: Number(edl.audio?.lufs ?? -14) });
          record.openfilm = { ok: openfilmQa.ok, errors: (openfilmQa.errors ?? []).slice(0, 6), warnings: (openfilmQa.warnings ?? []).slice(0, 6), at: Date.now() };
          event(project, {
            kind: openfilmQa.ok ? 'openfilm-pass' : 'openfilm-fail',
            stage: 'edit',
            text: openfilmQa.ok
              ? `逐帧体检通过${openfilmQa.warnings?.length ? `（${openfilmQa.warnings.length} 个提醒）` : ''}`
              : `逐帧体检拦下：${openfilmQa.errors?.[0] ?? openfilmQa.warnings?.[0] ?? ''}`,
          });
          await store.save(project, { pipeline: true });
        } catch (error) {
          openfilmQa = { ok: true, errors: [], warnings: [], error: error.message };
          record.openfilm = { error: error.message };
          log(`[edit] 逐帧体检失败（不阻塞）：${error.message}`);
        }
      }

      // 终审：把整条片子的证据交给审核Agent
      let review;
      try {
        review = await agents.review({
          stage: 'edit',
          project,
          artifact: {
            storyboard: {
              title: storyboard?.title,
              targetSeconds: storyboard?.targetSeconds,
              shots: (storyboard?.shots ?? []).map((shot) => ({ id: shot.id, segment: shot.segment, action: shot.action, dialogue: (storyboard?.beats ?? []).filter((beat) => beat.kind === 'line' && (shot.claims ?? []).includes(beat.id)).map((beat) => `${beat.speaker}）${beat.text}`) })),
            },
            edl,
            output: { duration: output.duration, segments: completed.length, engine: output.engine ?? 'ffmpeg' },
            visual: visual ? { pass: visual.pass, score: visual.score, summary: visual.summary, issues: visual.issues } : null,
            openfilm: openfilmQa ? { ok: openfilmQa.ok, errors: openfilmQa.errors, warnings: openfilmQa.warnings } : null,
            voice: { bgm: voice?.bgm, mix: voice?.mix },
          },
          gate,
          attempt,
          signal,
        });
      } catch (error) {
        review = { score: 0, pass: false, issues: [{ severity: 'major', where: '终审', problem: error.message, fix: '重试终审或人工复核' }], summary: '终审失败' };
      }
      record.review = {
        score: review.score,
        pass: review.pass,
        dimensions: review.dimensions,
        summary: review.summary,
        accepted: review.acceptedWithNotes ? 'with-notes' : 'clean',
        at: Date.now(),
      };
      // 画面验收有 blocker 就是不过：文本审核看不出的硬伤，以看图的结论为准。
      if (visual && visual.pass === false) {
        review.pass = false;
        review.issues = [...(visual.issues ?? []), ...(review.issues ?? [])];
        review.summary = `画面验收未过：${visual.summary || visual.issues?.[0]?.problem || ''}${review.summary ? `｜${review.summary}` : ''}`;
        record.review = { score: review.score, pass: false, dimensions: review.dimensions, summary: review.summary, at: Date.now() };
      }
      // 逐帧体检的硬问题同样一票否决：确定性 / 渲染层面的错，模型打分看不出来。
      if (openfilmQa && openfilmQa.errors?.length) {
        const problems = openfilmQa.errors.slice(0, 6).map((text) => ({ severity: 'major', where: '成片逐帧体检', problem: text, fix: '按这一条改剪辑清单（切点、时长、音轨）后重剪' }));
        review.pass = false;
        review.issues = [...problems, ...(review.issues ?? [])];
        review.summary = `逐帧体检未过：${openfilmQa.errors[0]}${review.summary ? `｜${review.summary}` : ''}`;
        record.review = { score: review.score, pass: false, dimensions: review.dimensions, summary: review.summary, at: Date.now() };
      }
      await store.saveReview(project, 'edit', attempt, { edl, gate, review, output }).catch(() => {});
      last = { edl, gate, review };

      if (review.pass) {
        record.status = 'done';
        project.finalFile = output.finalFile;
        project.coverFile = output.coverFile;
        // 发布包只是附加产物：写失败不应该把整条成片判成失败。
        await writePublishPack(project, edl, output).catch((error) => log(`发布包写入失败：${error.message}`));
        event(project, { kind: 'stage-done', stage: 'edit', text: `成片完成（审核 ${review.score} 分，${output.duration}s）` });
        await store.save(project, { pipeline: true });
        return { ok: true, stage: 'edit', score: review.score, finalFile: output.finalFile };
      }

      issues = (review.issues ?? []).map((issue) => `[${issue.severity ?? 'major'}] ${issue.where ?? ''}：${issue.problem ?? ''} → ${issue.fix ?? ''}`).slice(0, 12);
      record.status = 'rework';
      record.issues = issues;
      event(project, { kind: 'stage-rework', stage: 'edit', text: `终审 ${review.score} 分没过，打回重剪` });
      await store.save(project, { pipeline: true });
      if (visual?.pass === false && visual.issues?.some((issue) => issue.action === 'segment' && ['blocker', 'major'].includes(issue.severity))) break;
    }

    record.status = 'needs_review';
    await store.save(project, { pipeline: true });
    const pending = await notifyReview(project, 'edit', {
      score: last?.review?.score ?? null,
      issues: last?.review?.issues ?? [],
      gateFailures: last?.gate?.failures ?? [],
      reason: record.visual?.issues?.some((issue) => issue.action === 'segment' && ['blocker', 'major'].includes(issue.severity))
        ? '源画面需返工，请在审片台定位分段' : `自动重剪 ${record.attempts} 次仍未过终审`,
    });
    return { ok: false, stage: 'edit', needsReview: true, pendingReview: pending };
  }

  /**
   * 按 EDL 真的剪一遍：统一规格 → 拼接 → 混音 → 抽封面。
   *
   * 两条收尾路径：
   *   - openfilm：片段原样进 film.html（不重编码），靠 OpenFilm 渲染，成片同时是可手改的工程；
   *   - ffmpeg：原来的 normalize → concat → mixAudio。
   * `finisher: 'auto'` 时先试 OpenFilm，失败一条日志退回 ffmpeg，绝不因为收尾器把整轮剪辑判死。
   */
  async function executeEdl(project, edl, completedTasks) {
    const mode = String(options.finisher ?? 'auto').toLowerCase();
    if (mode !== 'ffmpeg') {
      const usable = await openfilm.available().catch(() => ({ ok: false, reason: 'OpenFilm 不可用' }));
      if (usable.ok) {
        try {
          const output = await executeEdlWithOpenFilm(project, edl, completedTasks);
          setFinisher(project, 'openfilm', usable.version);
          return output;
        } catch (error) {
          log(`[edit] OpenFilm 收尾失败，退回 ffmpeg：${error.message}`);
          if (mode === 'openfilm') throw new Error(`OpenFilm 收尾失败：${error.message}`);
        }
      } else if (mode === 'openfilm') {
        throw new Error(usable.reason);
      }
    }
    const output = await executeEdlWithFfmpeg(project, edl, completedTasks);
    setFinisher(project, 'ffmpeg', '');
    return output;
  }

  /** 记下这一版成片是谁收的尾，面板与审核都看得到。 */
  function setFinisher(project, engine, version) {
    project.finisher = { engine, version: version || null, at: Date.now() };
    const stage = project.stages.edit;
    if (stage) stage.finisher = project.finisher.engine;
  }

  /** OpenFilm 收尾：EDL → film.html → render → 封面。 */
  async function executeEdlWithOpenFilm(project, edl, completedTasks) {
    const dir = store.dirOf(project.id);
    const order = (edl.order ?? []).map((entry) => ({ ...entry, task: new Map(completedTasks.map((task) => [String(task.segmentId), task])).get(String(entry.segmentId)) })).filter((entry) => entry.task?.file);
    if (order.length === 0) throw new Error('剪辑清单里没有任何可用片段');
    const width = Number(options.outWidth) || 1080;
    const height = Number(options.outHeight) || 1920;
    const lufs = Number(edl.audio?.lufs ?? -14);
    const bgm = await resolveBgm(edl.audio?.bgm);
    const finalFile = join(dir, '07-final.mp4');

    const output = await openfilm.finish({
      projectDir: dir,
      edl,
      clips: order.map((entry) => entry.task.file),
      entries: order,
      bgm,
      width,
      height,
      lufs,
      gainDb: Number(edl.audio?.gainDb ?? -18),
      quality: String(options.openfilmQuality ?? 'native'),
      bitrate: Number(options.openfilmBitrate) || 0,
      fps: 30,
      workers: Number(options.openfilmWorkers) || 0,
      finalFile,
    });

    const info = await media.probe(finalFile);
    const coverFile = join(dir, 'cover.jpg');
    await media.frame({ input: finalFile, output: coverFile, at: Math.min(0.6, Math.max(0.1, (info.duration || 1) * 0.05)) }).catch(() => {});

    return {
      finalFile,
      coverFile: existsSync(coverFile) ? coverFile : null,
      duration: Math.round((info.duration || 0) * 10) / 10,
      bgm: bgm ?? null,
      width: info.width || width,
      height: info.height || height,
      engine: 'openfilm',
      filmHtml: output.filmHtml,
      renderSeconds: output.elapsed,
      timeline: output.timeline,
    };
  }

  /** 原来的 ffmpeg 收尾，一字未改（OpenFilm 不可用或失败时的退路）。 */
  async function executeEdlWithFfmpeg(project, edl, completedTasks) {
    const dir = join(store.dirOf(project.id), 'edit');
    await mkdir(dir, { recursive: true });
    const bySegment = new Map(completedTasks.map((task) => [String(task.segmentId), task]));
    const order = (edl.order ?? []).map((entry) => ({ ...entry, task: bySegment.get(String(entry.segmentId)) })).filter((entry) => entry.task?.file);
    if (order.length === 0) throw new Error('剪辑清单里没有任何可用片段');

    const width = Number(options.outWidth) || 1080;
    const height = Number(options.outHeight) || 1920;
    const normalized = [];
    for (const [index, entry] of order.entries()) {
      const target = join(dir, `norm-${String(index + 1).padStart(2, '0')}-${entry.segmentId}.mp4`);
      await media.normalize({
        input: entry.task.file,
        output: target,
        width,
        height,
        fade: String(entry.transition ?? 'cut') === 'fade',
        trimStart: Number(entry.trimStart) || 0,
        trimEnd: entry.trimEnd === null || entry.trimEnd === undefined ? null : Number(entry.trimEnd),
      });
      normalized.push(target);
    }

    const joined = join(dir, 'joined.mp4');
    await media.concatCopy({ files: normalized, output: joined });

    const bgm = await resolveBgm(edl.audio?.bgm);
    const finalFile = join(store.dirOf(project.id), '07-final.mp4');
    await media.mixAudio({
      input: joined,
      output: finalFile,
      bgm,
      gainDb: Number(edl.audio?.gainDb ?? -18),
      lufs: Number(edl.audio?.lufs ?? -14),
    });

    const info = await media.probe(finalFile);
    const coverFile = join(store.dirOf(project.id), 'cover.jpg');
    await media.frame({ input: finalFile, output: coverFile, at: Math.min(0.6, Math.max(0.1, (info.duration || 1) * 0.05)) }).catch(() => {});

    return {
      finalFile,
      coverFile: existsSync(coverFile) ? coverFile : null,
      duration: Math.round((info.duration || 0) * 10) / 10,
      bgm: bgm ?? null,
      width: info.width,
      height: info.height,
      engine: 'ffmpeg',
    };
  }

  /** BGM 目录里按 EDL 的情绪描述模糊匹配一个文件；匹配不到就不混。 */
  async function resolveBgm(hint) {
    const dir = options.bgmDir;
    if (!dir || !existsSync(dir)) return null;
    const wanted = String(hint ?? '').trim();
    if (!wanted) return null;
    const files = (await readdir(dir).catch(() => [])).filter((name) => /\.(mp3|m4a|wav|aac|flac)$/i.test(name));
    if (files.length === 0) return null;
    const hit = files.find((name) => wanted.includes(name.replace(/\.[^.]+$/, ''))) ?? files.find((name) => name.replace(/\.[^.]+$/, '').split(/[-_\s]/).some((token) => token.length >= 2 && wanted.includes(token)));
    return hit ? join(dir, hit) : null;
  }

  async function writePublishPack(project, edl, output) {
    const packaging = edl.packaging ?? {};
    const asList = (value) => (Array.isArray(value) ? value.map(String).filter(Boolean) : typeof value === 'string' && value.trim() ? [value.trim()] : []);
    const notes = asList(edl.notes);
    const hashtags = asList(packaging.hashtags);
    const lines = [
      `# ${packaging.title || project.title}`,
      '',
      `- 项目：${project.title}（${project.id}）`,
      `- 成片：${output.finalFile}（${output.duration}s / ${output.width}x${output.height}）`,
      `- 平台：${project.platform}｜目标时长：${project.targetSeconds}s`,
      '',
      '## 发布文案',
      packaging.description || '（未生成）',
      '',
      '## 封面文案',
      packaging.hook || '（未生成）',
      '',
      `## 话题\n${hashtags.join(' ') || '（未生成）'}`,
      '',
      `## 剪辑判断\n${edl.rationale || '（未生成）'}`,
      '',
      `## 执行提醒\n${notes.map((note) => `- ${note}`).join('\n') || '（无）'}`,
      '',
      `> 生成时间，${clock()}`,
    ];
    await writeFile(join(store.dirOf(project.id), '08-publish.md'), lines.join('\n'), 'utf8');
  }

  /** 人工通过成片后重写发布包：过审的成片可能被上一次重剪改过时长。*/
  async function refreshPublishPack(project) {
    const edl = await store.artifact(project, 'edit').catch(() => null);
    if (!edl || !project.finalFile) return;
    await writePublishPack(project, edl, {
      finalFile: project.finalFile,
      duration: project.stages.edit?.duration ?? 0,
      width: Number(options.outWidth),
      height: Number(options.outHeight),
    }).catch((error) => log(`发布包重写失败：${error.message}`));
  }

  // -------------------------------------------------------------------------
  // 流水线调度  // -------------------------------------------------------------------------
  async function runPipeline(id, { from, note, signal, internal = false, only = false, forceSegmentId, compareOnly = false, stopBeforeRender = false } = {}) {
    if (!internal && jobs.has(id)) return { ok: false, error: '这个项目正在跑，等它跑完' };
    const job = { id, stage: from ?? 'idea', startedAt: Date.now() };
    beginJob(id, job);
    const results = [];
    try {
      let project = await store.load(id);
      const startIndex = from ? STAGE_IDS.indexOf(from) : STAGE_IDS.findIndex((stage) => project.stages[stage]?.status !== 'done');
      if (startIndex < 0) return { ok: true, results: [], message: '所有阶段都已完成' };
      const planned = only && from ? [from] : STAGE_IDS.slice(startIndex);

      for (const stage of planned) {
        if (signal?.aborted) break;
        if (stage === 'render' && stopBeforeRender) {
          await store.update(id, (fresh) => event(fresh, { kind: 'render-ready', stage, text: '分段清单已就绪，请确认后开始出片' }));
          break;
        }
        project = await store.load(id);
        // 阶段指纹：换模型或改提示词后，旧的「已完成」不再算数，否则新模型会拿旧判断往下做。
        // 没有指纹的老项目按「不知道」处理，继续跳过——不因为一次升级让历史项目全部白跑。
        const stamp = stageFingerprint();
        const previousStamp = project.stages[stage]?.stamp ?? null;
        const staleReason = previousStamp && !matchesStamp(previousStamp, stamp)
          ? `上一版是 ${previousStamp.model} / 提示词 ${previousStamp.prompts} 做的，现在是 ${stamp.model} / ${stamp.prompts}`
          : null;
        if (staleReason) {
          event(project, { kind: 'stage-stale', stage, text: `${STAGE_BY_ID[stage].label}的旧产物作废，重跑：${staleReason}` });
          await store.save(project, { pipeline: true });
        }
        if (stage !== 'render' && stage !== 'edit' && project.stages[stage]?.status === 'done' && !note && !staleReason) {
          results.push({ stage, skipped: true });
          continue;
        }
        job.stage = stage;
        project.running = { stage, startedAt: job.startedAt, stageStartedAt: Date.now() };
        event(project, { kind: 'run', stage, text: `跑${STAGE_BY_ID[stage].label}` });
        await store.save(project, { pipeline: true });

        let result;
        if (PRODUCE_STAGES.includes(stage)) result = await runProduceStage(project, stage, { note, signal });
        else if (stage === 'render') result = await runRenderStage(project, { signal, forceSegmentId, compareOnly, note });
        else result = await runEditStage(project, { note, signal });
        results.push(result);

        if (!result.ok) break;
        // 每一阶段完成后重新读一次：审核/通知可能在别处改过状态。
        project = await store.load(id);
        project.running = null;
        await store.save(project, { pipeline: true });
      }
      return { ok: results.every((result) => result.ok || result.skipped), results, running: false };
    } catch (error) {
      log(`流水线失败（${id}）：`, error);
      await store.update(id, (project) => {
        project.running = null;
        event(project, { kind: 'run-error', text: `流水线中断：${error.message}` });
      }).catch(() => {});
      return { ok: false, error: error.message, results };
    } finally {
      endJob(id);
      await store.update(id, (project) => {
        project.running = null;
      }).catch(() => {});
    }
  }

  /** 后台跑，路由/工具立刻返回，面板靠 /state 轮询进度。 */
  function startPipeline(id, optionsForRun) {
    if (jobs.has(id)) return null;
    const controller = new AbortController();
    // 先登记再进 runPipeline（internal 模式不会重复登记）。
    beginJob(id, { id, stage: optionsForRun?.from ?? 'idea', startedAt: Date.now(), controller });
    const promise = runPipeline(id, { ...optionsForRun, signal: controller.signal, internal: true }).finally(() => {
      controller.abort();
    });
    // 后台失败不抛给 HTTP：状态已经写进项目里了。
    promise.catch((error) => log(`后台流水线异常（${id}）：${error.message}`));
    return { started: true, id };
  }

  // -------------------------------------------------------------------------
  // 面板 API
  // -------------------------------------------------------------------------
  function rememberTake(takes, task) {
    if (!task?.file || task.status !== 'completed') return;
    takes[basename(task.file)] = {
      taskId: task.taskId ?? null,
      inputHash: task.inputHash ?? null,
      prompt: task.prompt ?? null,
      seconds: task.seconds ?? null,
      provider: task.provider ?? null,
      providerLabel: task.providerLabel ?? null,
      referenceCount: task.referenceCount ?? null,
      referenceNames: task.referenceNames ?? null,
    };
  }

  async function segmentVersions(project, storyboard, render) {
    const directory = join(store.dirOf(project.id), 'segments');
    const files = (await readdir(directory, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile());
    const segments = segmentsOf(storyboard);
    return Object.fromEntries(segments.map(({ id }) => {
      const task = render?.tasks?.find((item) => item.segmentId === id);
      const prefix = `${id}-`;
      const names = files.map(({ name }) => name).filter((name) => name.startsWith(prefix)
        && !segments.some((segment) => segment.id.length > id.length && name.startsWith(`${segment.id}-`))
        && /^[\w-]+(?:\.trimmed)?\.mp4$/i.test(name.slice(prefix.length)));
      const current = task?.file ? basename(task.file) : null;
      return [id, names.filter((name) => name === current || !name.endsWith('.trimmed.mp4'))
        .filter((name) => !current?.endsWith('.trimmed.mp4') || name !== current.replace('.trimmed.mp4', '.mp4'))
        .sort((a, b) => Number(b === current) - Number(a === current) || a.localeCompare(b))
        .map((name) => ({ id: name, current: name === current }))];
    }));
  }

  function reviewTimeline(edl, render, actual = []) {
    const tasks = new Map((render?.tasks ?? []).map((task) => [String(task.segmentId), task]));
    let cursor = 0;
    return (edl?.order ?? []).filter((entry) => tasks.has(String(entry.segmentId))).map((entry, index) => {
      const task = tasks.get(String(entry.segmentId));
      const sourceStart = Math.max(0, Number(entry.trimStart) || 0);
      const total = Number(task.duration || task.seconds) || 0;
      const sourceEnd = entry.trimEnd == null ? total : Math.min(total, Number(entry.trimEnd));
      const start = actual[index]?.at ?? cursor;
      const length = actual[index]?.length ?? Math.max(0, sourceEnd - sourceStart);
      cursor = start + length;
      return { segmentId: entry.segmentId, start, end: cursor, sourceStart, version: task.file ? basename(task.file) : null };
    });
  }

  const handlers = {
    async config() {
      return ok({
        projectDir: projectRoot,
        reviewThreshold: Number(options.reviewThreshold) || 80,
        reviewPolicy: String(options.reviewPolicy ?? 'balanced'),
        promptsDir,
        maxRework: Number(options.maxRework) || 2,
        aspect: String(options.aspectRatio),
        aspects: ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9'].filter((value) => video.providers().length > 0),
        resolution: String(options.resolution),
        videoProviders: video.providers(),
        hasImage: video.hasImage,
        hasEasyframe: Boolean(options.easyframeApiKey),
        hasMnmx: Boolean(options.mnmxCardKey),
        hasLlm: Boolean(ctx.get('agentDefaultModel')),
        hasReference: reference.available(),
        hasRea: Boolean(options.reaVideoCmd),
        reaCmd: options.reaVideoCmd || '',
        scriptsDir: options.scriptsDir,
        bgmDir: options.bgmDir,
        ffmpegPath: media.ffmpeg,
        stages: STAGES.map((stage) => ({ id: stage.id, label: stage.label, agent: stage.agent })),
        dimensions: SIX_DIMENSIONS,
        voices: VOICE_CATALOG,
        statuses: STAGE_STATUS,
      });
    },

    /** 环境自检：装完先跑一遍，缺什么、怎么补一条条列出来 */
    async doctor() {
      return ok(runDoctor({ options, dataRoot, projectRoot, promptsDir }));
    },

    /** 提示词模板：列出现有覆盖文件（没写就是内置写法） */
    async prompts() {
      const names = ['idea', 'story', 'storyboard', 'characters', 'voice', 'edit', 'reviewer'];
      const items = names.map((name) => {
        let content = '';
        try {
          const file = join(promptsDir, `${name}.md`);
          if (existsSync(file)) content = readFileSync(file, 'utf8');
        } catch {
          content = '';
        }
        return { name, content, custom: Boolean(String(content).trim()) };
      });
      return ok({ dir: promptsDir, items });
    },

    /** 保存或清空某个阶段的提示词覆盖（content 为空 = 恢复默认） */
    async savePrompt(payload) {
      const names = ['idea', 'story', 'storyboard', 'characters', 'voice', 'edit', 'reviewer'];
      const name = String(payload?.name ?? '');
      if (!names.includes(name)) return fail('bad-request', `未知的模板：${name}`);
      const content = String(payload?.content ?? '');
      const file = join(promptsDir, `${name}.md`);
      if (!content.trim()) {
        await rm(file, { force: true }).catch(() => {});
        return ok({ name, cleared: true });
      }
      await mkdir(promptsDir, { recursive: true });
      await writeFile(file, content, 'utf8');
      return ok({ name, bytes: Buffer.byteLength(content, 'utf8') });
    },

    async projects() {
      const all = await store.list();
      return ok({ projects: all.filter((row) => row.kind !== 'reference') });
    },

    /** 拉片台：独立拉片（不依赖创意项目），记录也落在同一个项目目录下，kind=reference。 */
    async referenceStudio(payload) {
      const { url, localPath } = normalizeSource(payload?.url, payload?.localPath);
      if (!url && !localPath) return fail('bad-request', '给一条抖音链接，或一个本机视频路径');
      const label = String(payload?.title ?? '').trim();
      const project = newProject({
        kind: 'reference',
        title: label || (url ? `拉片 · ${url.slice(0, 40)}` : `拉片 · ${basename(localPath)}`),
        targetSeconds: 45,
      });
      project.brief.productName = label || '拉片记录';
      await store.save(project);
      event(project, { kind: 'create', text: '拉片台：新建拉片记录' });
      await store.save(project);
      startReferenceJob(project, { url, localPath });
      return ok({ id: project.id, started: true });
    },

    async referenceList() {
      const all = await store.list();
      return ok({ items: all.filter((row) => row.kind === 'reference').slice(0, 40) });
    },

    /** 拉片证据包：联系表 / 逐镜帧 / 台词 / 报告 / 复刻分镜。 */
    async referenceEvidence(payload) {
      const id = String(payload?.id ?? '');
      const project = await store.load(id);
      const ref = project.reference ?? {};
      let replicate = null;
      if (ref.replicateFile && existsSync(ref.replicateFile)) {
        replicate = JSON.parse(await readFile(ref.replicateFile, 'utf8').catch(() => 'null'));
      }
      let report = ref.report ?? '';
      if (ref.reportFile && existsSync(ref.reportFile)) report = await readFile(ref.reportFile, 'utf8').catch(() => report);
      return ok({
        id: project.id,
        title: project.title,
        kind: project.kind ?? 'studio',
        status: ref.status ?? 'idle',
        stage: ref.stage ?? '',
        error: ref.error ?? null,
        url: ref.url ?? '',
        summary: ref.summary ?? null,
        shotTable: ref.shotTable ?? '',
        frames: ref.frames ?? [],
        contactSheet: Boolean(ref.contactSheet),
        transcriptLines: ref.transcriptLines ?? '',
        report,
        rea: ref.rea ?? null,
        reaError: ref.reaError ?? null,
        replicate,
        replicateSummary: ref.replicateSummary ?? null,
      });
    },

    /** 复刻分镜：由拉片证据生成一份 shot-contract 结构的分镜。 */
    async referenceReplicate(payload) {
      const id = String(payload?.id ?? '');
      const project = await store.load(id);
      if (!project.reference?.report) return fail('not-ready', '这条还没拉完片，先等拆解完成');
      try {
        const result = await runReplicate(project);
        return ok({ storyboard: result.storyboard, gate: result.gate, summary: result.summary });
      } catch (error) {
        return fail('replicate-failed', error.message);
      }
    },

    /** 拿一条拉片记录开一个创意项目：拆解报告直接带过去当证据。 */
    async referenceToProject(payload) {
      const id = String(payload?.id ?? '');
      const source = await store.load(id);
      if (!source.reference?.report) return fail('not-ready', '这条还没拉完片');
      const productName = String(payload?.productName ?? '').trim();
      if (!productName) return fail('bad-request', '要填一个产品名才能开项目');
      const project = newProject({
        title: String(payload?.title ?? `${productName} · 爆款复刻`),
        platform: payload?.platform,
        targetSeconds: Math.round(Number(source.reference.summary?.duration) || 45),
        aspect: options.aspectRatio,
        resolution: options.resolution,
        brief: {
          productName,
          category: String(payload?.category ?? ''),
          audience: String(payload?.audience ?? ''),
          sellingPoints: Array.isArray(payload?.sellingPoints) ? payload.sellingPoints : [],
          tone: String(payload?.tone ?? ''),
          forbidden: Array.isArray(payload?.forbidden) ? payload.forbidden : [],
        },
      });
      project.reference = {
        status: 'done',
        stage: '完成',
        report: source.reference.report,
        reportFile: source.reference.reportFile,
        summary: source.reference.summary,
        sourceId: source.id,
        at: Date.now(),
      };
      await store.save(project);
      event(project, { kind: 'create', text: `从拉片记录「${source.title}」开的项目` });
      await store.save(project);
      return ok({ id: project.id, project });
    },

    async create(payload) {
      const project = newProject({
        title: payload?.title,
        platform: payload?.platform,
        targetSeconds: payload?.targetSeconds,
        aspect: payload?.aspect ?? options.aspectRatio,
        resolution: payload?.resolution ?? options.resolution,
        brief: payload?.brief,
      });
      if (!project.brief.productName) return fail('bad-request', '产品名不能为空');
      await store.save(project);
      event(project, { kind: 'create', text: '项目已创建' });
      await store.save(project);
      return ok({ id: project.id, project });
    },

    /** 载入示例项目：把 demo 的媒体复制到项目目录，替换占位路径后存成一条完成的项目。 */
    async createDemo() {
      const demoDir = join(PKG_ROOT, 'demo');
      const templateFile = join(demoDir, 'project.template.json');
      if (!existsSync(templateFile)) return fail('not-ready', '示例项目缺失：包里没有 demo/project.template.json');
      const template = JSON.parse(await readFile(templateFile, 'utf8'));
      const project = newProject({
        title: template.title,
        platform: template.platform,
        targetSeconds: template.targetSeconds,
        aspect: template.aspect,
        resolution: template.resolution,
        brief: template.brief,
      });
      const dir = store.dirOf(project.id);
      const { template: filled } = await materializeDemo({ demoDir, dir });
      project.brief = { ...project.brief, ...filled.brief };
      project.chosenIdea = filled.chosenIdea;
      project.stages = filled.stages;
      project.finalFile = filled.finalFile;
      project.coverFile = filled.coverFile;
      project.demo = filled.demo;
      event(project, { kind: 'demo', text: '示例项目已载入：可以直接看成片，也可以从任意阶段重跑' });
      await store.save(project);
      for (const stage of ['idea', 'story', 'storyboard', 'characters', 'voice', 'edit']) {
        const artifact = filled.stages?.[stage]?.artifact;
        if (artifact) await store.writeArtifact(project, stage, artifact).catch(() => {});
      }
      return ok({ id: project.id, dir });
    },

    async state(payload) {
      const id = String(payload?.id ?? '');
      if (!id) return fail('bad-request', '缺少项目 id');
      const project = await store.load(id);
      const artifacts = {};
      for (const stage of ['idea', 'story', 'storyboard', 'characters', 'voice', 'edit']) {
        const artifact = await store.artifact(project, stage).catch(() => null);
        if (artifact) artifacts[stage] = artifact;
      }
      const render = project.stages.render?.artifact ?? null;
      const plan = segmentsOf(artifacts.storyboard).map((segment) => ({
        id: segment.id, seconds: segment.seconds, generationSeconds: segment.duration, people: segment.people,
        opening: segment.startShot?.action, ending: segment.shots.at(-1)?.lastFrame,
        props: [...new Set(segment.shots.map((shot) => shot.others).filter(Boolean))],
        references: segment.people.filter((name) => artifacts.characters?.characters?.some((character) => character.name === name && character.portrait?.file && existsSync(character.portrait.file))),
      }));
      return ok({
        plan,
        versions: await segmentVersions(project, artifacts.storyboard, render),
        timeline: project.stages.edit?.timeline ?? reviewTimeline(artifacts.edit, render),
        project: {
          id: project.id,
          title: project.title,
          platform: project.platform,
          targetSeconds: project.targetSeconds,
          aspect: project.aspect,
          resolution: project.resolution,
          brief: project.brief,
          stages: project.stages,
          chosenIdea: project.chosenIdea,
          pendingReview: project.pendingReview,
          running: project.running,
          reference: project.reference && !referenceJobs.has(id)
            && ['running', 'analyzing', 'fetching', 'framing', 'asr', 'rea', 'reviewing'].includes(project.reference.status)
            ? { ...project.reference, status: 'failed', error: '拉片已中断，请重新选择参考视频' }
            : project.reference ?? null,
          finalFile: project.finalFile ?? project.stages.edit?.finalFile ?? null,
          coverFile: project.coverFile ?? project.stages.edit?.coverFile ?? null,
          events: (project.events ?? []).slice(-80),
          updatedAt: project.updatedAt,
        },
        artifacts,
        render,
        dir: store.dirOf(project.id),
      });
    },

    async updateBrief(payload) {
      const id = String(payload?.id ?? '');
      const patch = payload?.brief ?? {};
      const project = await store.update(id, (fresh) => {
        fresh.brief = { ...fresh.brief, ...patch, hotspots: Array.isArray(patch.hotspots) ? patch.hotspots.slice(0, 30) : fresh.brief.hotspots };
        if (payload?.title) fresh.title = String(payload.title);
        if (payload?.targetSeconds) fresh.targetSeconds = Math.max(10, Math.min(180, Math.round(Number(payload.targetSeconds))));
        if (Array.isArray(patch.sellingPoints)) fresh.brief.sellingPoints = patch.sellingPoints.map(String).filter(Boolean);
        if (Array.isArray(patch.forbidden)) fresh.brief.forbidden = patch.forbidden.map(String).filter(Boolean);
        event(fresh, { kind: 'brief', text: '画像 / 热点已更新' });
      });
      return ok({ project: { id: project.id, brief: project.brief, title: project.title, targetSeconds: project.targetSeconds } });
    },

    /** 抓实时热点：走宿主自己的 web 检索服务，抓不到就直说，不编。 */
    async hotspots(payload) {
      const id = String(payload?.id ?? '');
      const project = id ? await store.load(id).catch(() => null) : null;
      const brief = project?.brief ?? payload?.brief ?? {};
      const web = ctx.get('web');
      if (!web) return fail('no-web', '宿主没有可用的联网检索服务：可以直接手填热点，或在面板里改用「手动热点」。');
      const queries = [];
      if (brief.category) queries.push(`${brief.category} 最近的热点话题`);
      if (brief.productName) queries.push(`${brief.productName} 用户讨论 关注点`);
      if (brief.audience) queries.push(`${brief.audience} 最近在聊什么`);
      if (queries.length === 0) queries.push('今天的热点话题');
      const found = [];
      const errors = [];
      for (const query of queries.slice(0, 3)) {
        try {
          const result = await web.search({ query, maxResults: 6 });
          for (const source of result?.sources ?? []) {
            const title = String(source.title ?? '').trim();
            if (!title) continue;
            if (found.some((item) => item.title === title || item.url === source.url)) continue;
            found.push({
              title: title.slice(0, 80),
              url: source.url ?? '',
              snippet: String(source.snippet ?? source.summary ?? '').slice(0, 160),
              source: '实时检索',
              heat: null,
              query,
              at: nowIso(),
            });
          }
        } catch (error) {
          errors.push(`${query}（${error.message}）`);
        }
      }
      if (found.length === 0) {
        return fail('no-hotspot', `这次没抓到热点${errors.length ? `（${errors.join('；')}）` : ''}：手填几条，或者跳过热点直接跑`);
      }
      const hotspots = found.slice(0, 10);
      if (project) {
        await store.update(project.id, (fresh) => {
          fresh.brief.hotspots = hotspots;
          event(fresh, { kind: 'hotspots', text: `抓到 ${hotspots.length} 条实时热点` });
        });
      }
      return ok({ hotspots, errors });
    },

    /** 参考爆款：贴一条抖音链接（或本机 mp4）→ 拉片 → 拆解报告，报告会进创意阶段的证据。 */
    async reference(payload) {
      const id = String(payload?.id ?? '');
      const { url, localPath } = normalizeSource(payload?.url, payload?.localPath);
      if (!url && !localPath) return fail('bad-request', '给一条抖音链接，或一个本机视频路径');
      const project = await store.load(id);
      if (referenceJobs.has(id)) return fail('busy', '这条已经有拉片任务在跑');
      await store.update(id, (fresh) => {
        fresh.reference = { status: 'running', stage: '准备素材', url, localPath, at: Date.now() };
        event(fresh, { kind: 'reference', text: `开始拉片：${url || localPath}` });
      });
      startReferenceJob(project, { url, localPath, advanced: payload?.advanced !== false });
      return ok({ started: true });
    },

    async referenceReport(payload) {
      const id = String(payload?.id ?? '');
      const project = await store.load(id);
      const ref = project.reference ?? {};
      let report = ref.report ?? '';
      if (ref.reportFile && existsSync(ref.reportFile)) report = await readFile(ref.reportFile, 'utf8').catch(() => report);
      return ok({ reference: { ...ref, report }, report });
    },

    async run(payload) {
      const id = String(payload?.id ?? '');
      if (!id) return fail('bad-request', '缺少项目 id');
      const project = await store.load(id);
      if (jobs.has(id)) return fail('busy', '这个项目正在跑');
      const from = payload?.stage && STAGE_IDS.includes(String(payload.stage)) ? String(payload.stage) : undefined;
      if (from) {
        await store.update(id, (fresh) => {
          fresh.stages[from] = { ...fresh.stages[from], status: 'empty', error: null, issues: [] };
          if (from === 'characters' || from === 'voice' || from === 'storyboard' || from === 'story' || from === 'idea') {
            for (const later of STAGE_IDS.slice(STAGE_IDS.indexOf(from) + 1)) {
              if (fresh.stages[later]?.status === 'done') continue;
              fresh.stages[later] = { ...fresh.stages[later], status: 'empty' };
            }
          }
          fresh.pendingReview = null;
          event(fresh, { kind: 'run', stage: from, text: `从「${STAGE_BY_ID[from].label}」重跑` });
        });
      }
      await store.update(id, (fresh) => {
        if (fresh.pendingReview) fresh.pendingReview = null;
      });
      const started = startPipeline(id, { from, note: String(payload?.note ?? '') || undefined, only: Boolean(payload?.only), stopBeforeRender: payload?.stopBeforeRender === true });
      if (!started) return fail('busy', '这个项目正在跑');
      return ok({ started: true, project: project.id, from: from ?? 'idea', only: Boolean(payload?.only) });
    },

    async rerenderSegment(payload) {
      const id = String(payload?.id ?? '');
      const segmentId = String(payload?.segmentId ?? '');
      const project = await store.load(id);
      if (jobs.has(id)) return fail('busy', '这个项目正在跑');
      const storyboard = await store.artifact(project, 'storyboard');
      const segments = segmentsOf(storyboard);
      const oldTasks = project.stages.render?.artifact?.tasks ?? [];
      if (!segments.some((segment) => segment.id === segmentId)) return fail('not-found', '分镜里没有这个段落');
      const missing = segments.find((segment) => segment.id !== segmentId && !oldTasks.some((task) =>
        task.segmentId === segment.id && task.status === 'completed' && existsSync(task.file ?? ''),
      ));
      if (missing) return fail('not-ready', `段 ${missing.id} 没有可用素材，请先完成分段出片`);
      const started = startPipeline(id, { from: 'render', forceSegmentId: segmentId, only: payload?.compare === true, compareOnly: payload?.compare === true, note: String(payload?.note ?? '').trim().slice(0, 2000) });
      if (!started) return fail('busy', '这个项目正在跑');
      return ok({ started: true, segmentId });
    },

    async chooseSegmentVersion(payload) {
      const id = String(payload?.id ?? '');
      const segmentId = String(payload?.segmentId ?? '');
      const version = String(payload?.version ?? '');
      if (!/^cs_[A-Za-z0-9_-]+$/.test(id)) return fail('bad-request', '项目编号无效');
      const project = await store.load(id);
      if (jobs.has(id)) return fail('busy', '这个项目正在跑');
      const storyboard = await store.artifact(project, 'storyboard');
      const versions = await segmentVersions(project, storyboard, project.stages.render?.artifact);
      if (!Object.hasOwn(versions, segmentId) || !versions[segmentId].some((item) => item.id === version)) {
        return fail('not-found', '没有找到这个分段版本');
      }
      const file = join(store.dirOf(id), 'segments', version);
      const info = await media.probe(file);
      const currentEdl = await store.artifact(project, 'edit');
      return store.update(id, (fresh) => {
        if (jobs.has(id)) return fail('busy', '这个项目正在跑');
        const task = fresh.stages.render?.artifact?.tasks?.find((item) => item.segmentId === segmentId);
        if (!task || !info.duration) return fail('not-ready', '这段素材不可用');
        if (task.file !== file) {
          if (fresh.finalFile && !fresh.stages.edit.timeline) fresh.stages.edit.timeline = reviewTimeline(currentEdl, fresh.stages.render.artifact);
          const takes = fresh.stages.render.artifact.takes ??= {};
          rememberTake(takes, task);
          const metadata = Object.hasOwn(takes, version) ? takes[version] : {};
          Object.assign(task, {
            file, rawFile: file, status: 'completed', progress: 100, error: null, duration: info.duration,
            taskId: null, inputHash: null, prompt: null, provider: null, providerLabel: null, referenceCount: null, referenceNames: null,
            ...metadata,
          });
          const complete = segmentsOf(storyboard).every(({ id: segment }) => fresh.stages.render.artifact.tasks
            .some((item) => item.segmentId === segment && item.status === 'completed' && existsSync(item.file ?? '')));
          if (complete) {
            fresh.stages.render.status = 'done';
            fresh.stages.render.error = null;
            if (fresh.pendingReview?.stage === 'render') fresh.pendingReview = null;
          }
          fresh.stages.edit.stale = Boolean(fresh.finalFile || fresh.stages.edit.finalFile);
          event(fresh, { kind: 'segment-version', stage: 'render', text: `段 ${segmentId} 已切换素材版本` });
        }
        return ok({ segmentId, version });
      });
    },

    /**
     * 分镜局部编辑：只改一个镜头（提示词/时长）或一句台词，改完立刻重跑 13 道门，
     * 不重新生成整条分镜。门禁不过就标成待复核，不会把坏分镜当成已通过。
     */
    async updateStoryboard(payload) {
      const id = String(payload?.id ?? '');
      if (!/^cs_[A-Za-z0-9_-]+$/.test(id)) return fail('bad-request', '项目编号无效');
      const project = await store.load(id);
      if (!project) return fail('not-found', '项目不存在');
      if (jobs.has(id)) return fail('busy', '这个项目正在跑，等它停下来再改');
      const record = project.stages?.storyboard;
      if (!record?.artifact) return fail('not-ready', '还没有分镜，先把分镜阶段跑出来');
      const shotPatch = payload?.shot ?? null;
      const beatPatch = payload?.beat ?? null;
      if (!shotPatch?.id && !beatPatch?.id) return fail('bad-request', '要改什么：给 shot.id 或 beat.id');

      const doc = structuredClone(record.artifact);
      let changed = 0;
      try {
        changed = patchStoryboard(doc, { shot: shotPatch, beat: beatPatch }).changed;
      } catch (error) {
        return fail('bad-request', error.message);
      }
      if (changed === 0) return fail('bad-request', '内容没有变化');

      const context = await contextOf(project, 'storyboard');
      const gate = await runGate('storyboard', doc, context);
      const file = await store.writeArtifact(project, 'storyboard', doc).catch(() => null);
      await store.update(id, (fresh) => {
        const target = fresh.stages.storyboard;
        target.artifact = doc;
        target.editedAt = Date.now();
        target.gate = { ok: gate.ok, failures: (gate.failures ?? []).slice(0, 12), at: Date.now() };
        if (file) target.file = basename(file);
        if (gate.ok) {
          target.status = 'done';
          target.issues = [];
          target.error = null;
        } else {
          target.status = 'needs_review';
          target.issues = (gate.failures ?? []).slice(0, 8);
        }
        event(fresh, {
          kind: 'storyboard-edit',
          stage: 'storyboard',
          text: `手动改了 ${shotPatch?.id ?? beatPatch?.id}，门禁${gate.ok ? '通过' : `有 ${(gate.failures ?? []).length} 条未过`}`,
        });
      });
      return ok({ gate, changed });
    },

    async decide(payload) {
      const id = String(payload?.id ?? '');
      const decision = String(payload?.decision ?? '');
      const note = String(payload?.note ?? '').trim();
      if (!['approve', 'rework', 'skip'].includes(decision)) return fail('bad-request', '决定只能明approve / rework / skip');
      const project = await store.load(id);
      const stage = String(payload?.stage || project.pendingReview?.stage || '');
      if (!stage || !STAGE_IDS.includes(stage)) return fail('bad-request', '不知道要复核哪个阶段');
      if (decision === 'approve') {
        if (stage === 'edit' && (!project.finalFile && !project.stages.edit.finalFile || project.stages.edit.stale || jobs.has(id))) {
          return fail('not-ready', '请先合成当前素材，再通过成片');
        }
        await store.update(id, (fresh) => {
          fresh.stages[stage] = { ...fresh.stages[stage], status: 'done', note: note || '人工复核通过', error: null, issues: [] };
          fresh.pendingReview = null;
          event(fresh, { kind: 'review-approve', stage, text: `人工复核通过${note ? `（${note}` : ''}` });
        });
        // 人工通过成片时顺手重写发布包：过审后成片时长可能被上一步重剪过。
        if (stage === 'edit') await refreshPublishPack(await store.load(id));
        return ok({ approved: stage });
      }
      if (decision === 'skip') {
        await store.update(id, (fresh) => {
          fresh.stages[stage] = { ...fresh.stages[stage], status: 'skipped', note: note || '人工跳过' };
          fresh.pendingReview = null;
          event(fresh, { kind: 'review-skip', stage, text: `人工跳过：${stage}` });
        });
        return ok({ skipped: stage });
      }
      await store.update(id, (fresh) => {
        fresh.stages[stage] = { ...fresh.stages[stage], status: 'empty', issues: note ? [note] : [], note: null };
        fresh.pendingReview = null;
        event(fresh, { kind: 'review-rework', stage, text: `人工打回重做${note ? `（${note}` : ''}` });
      });
      if (jobs.has(id)) return fail('busy', '这个项目正在跑');
      startPipeline(id, { from: stage, note: note || undefined });
      return ok({ rework: stage });
    },

    async chooseIdea(payload) {
      const id = String(payload?.id ?? '');
      const index = Number(payload?.index);
      const project = await store.update(id, (fresh) => {
        fresh.chosenIdea = Number.isInteger(index) && index >= 0 ? index : null;
        event(fresh, { kind: 'choose-idea', text: `选定创意方向 #${(index ?? 0) + 1}` });
      });
      return ok({ chosenIdea: project.chosenIdea });
    },

    async remove(payload) {
      const id = String(payload?.id ?? '');
      if (!/^cs_[A-Za-z0-9_-]+$/.test(id)) return fail('bad-request', '项目 id 不合法');
      if (jobs.has(id)) return fail('busy', '这个项目正在跑，跑完再删');
      if (referenceJobs.has(id)) return fail('busy', '这条正在拉片，等它跑完再删');
      await store.remove(id);
      return ok({ removed: id });
    },

    async inbox() {
      try {
        const parsed = JSON.parse(await readFile(inboxFile, 'utf8'));
        return ok({ items: Array.isArray(parsed) ? parsed.slice(0, 30) : [] });
      } catch {
        return ok({ items: [] });
      }
    },

    /** 预览：把成片/封面/片段按 base64 交回面板。 */
    async media(payload) {
      const id = String(payload?.id ?? '');
      const kind = String(payload?.kind ?? 'final');
      const project = await store.load(id);
      let file;
      if (kind === 'final') file = project.finalFile ?? project.stages.edit?.finalFile;
      else if (kind === 'cover') file = project.coverFile ?? project.stages.edit?.coverFile;
      else if (kind === 'segment') {
        const task = (project.stages.render?.artifact?.tasks ?? []).find((row) => String(row.segmentId) === String(payload?.segmentId));
        file = task?.file;
      } else if (kind === 'portrait') {
        const characters = await store.artifact(project, 'characters');
        file = (characters?.characters ?? []).find((row) => row.name === String(payload?.name))?.portrait?.file;
      }
      if (!file || !existsSync(file)) return fail('not-found', '还没有这个文件');
      const info = await stat(file);
      if (info.size > 120 * 1024 * 1024) return fail('too-large', '文件超过 120MB，请直接打开路径');
      const bytes = await readFile(file);
      return ok({ filename: basename(file), mime: mimeOf(file), data: bytes.toString('base64'), bytes: info.size });
    },
  };

  // -------------------------------------------------------------------------
  // 路由
  // -------------------------------------------------------------------------
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) return sendJson(res, rejection, fail('forbidden', '来源或登录校验没通过'));
      if (req.method !== 'POST') return sendJson(res, 405, fail('method-error', '只接可POST'));
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const endpoint = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length + 1) : '';
      const handler = Object.hasOwn(handlers, endpoint) ? handlers[endpoint] : null;
      if (!handler) return sendJson(res, 404, fail('not-found', `未知操作 ${endpoint}`));
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (error) {
        return sendJson(res, 400, fail('bad-request', error.message));
      }
      try {
        return sendJson(res, 200, await handler(payload));
      } catch (error) {
        log(`${endpoint} 失败：`, error);
        return sendJson(res, 500, fail('internal', error instanceof Error ? error.message : String(error)));
      }
    },
  }), 'creative-studio: api routes');

  /** 成片流：支持 Range，浏览器 <video> 能拖进度条。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: FILE_ROUTE,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) {
        res.writeHead(rejection);
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal');
      const id = url.searchParams.get('id') ?? '';
      const kind = url.searchParams.get('kind') ?? 'final';
      if (!/^cs_[A-Za-z0-9_-]+$/.test(id)) {
        res.writeHead(400);
        res.end();
        return;
      }
      let file;
      try {
        const project = await store.load(id);
        if (kind === 'final') file = project.finalFile ?? project.stages.edit?.finalFile;
        else if (kind === 'cover') file = project.coverFile ?? project.stages.edit?.coverFile;
        else if (kind === 'segment') {
          const segmentId = url.searchParams.get('segmentId') ?? '';
          file = (project.stages.render?.artifact?.tasks ?? []).find((task) => String(task.segmentId) === segmentId)?.file;
        } else if (kind === 'segment-version') {
          const segmentId = url.searchParams.get('segmentId') ?? '';
          const version = url.searchParams.get('version') ?? '';
          const storyboard = await store.artifact(project, 'storyboard');
          const versions = await segmentVersions(project, storyboard, project.stages.render?.artifact);
          if (Object.hasOwn(versions, segmentId) && versions[segmentId].some((item) => item.id === version)) {
            file = join(store.dirOf(id), 'segments', version);
          }
        } else if (kind === 'portrait') {
          const characters = await store.artifact(project, 'characters');
          file = (characters?.characters ?? []).find((row) => row.name === url.searchParams.get('name'))?.portrait?.file;
        } else if (kind === 'ref') {
          const name = url.searchParams.get('name') ?? '';
          if (name.includes('..') || !/^[\w./\-\u4e00-\u9fa5]+$/.test(name)) throw new Error('非法的资源名');
          file = join(store.dirOf(id), 'reference', name);
        } else if (kind === 'check') {
          // 画面验收的抽帧：让面板里能直接看到「为什么不过」。
          const name = url.searchParams.get('name') ?? '';
          if (name.includes('..') || !/^[\w./-]+$/.test(name)) throw new Error('非法的资源名');
          file = join(store.dirOf(id), 'edit', name);
        }
      } catch {
        res.writeHead(404);
        res.end();
        return;
      }
      const root = resolve(projectRoot) + sep;
      if (!file || !resolve(file).startsWith(root) || !existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const info = await stat(file);
      const type = mimeOf(file);
      const range = req.headers.range;
      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        const start = match && match[1] ? Number(match[1]) : 0;
        const end = match && match[2] ? Number(match[2]) : info.size - 1;
        res.writeHead(206, {
          'content-type': type,
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${info.size}`,
          'accept-ranges': 'bytes',
        });
        res.end((await readFile(file)).subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { 'content-type': type, 'content-length': info.size, 'accept-ranges': 'bytes' });
      res.end(await readFile(file));
    },
  }), 'creative-studio: media route');

  /** 独立出片任务与生图产物：成片 / 图片 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/creative-studio/asset',
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) {
        res.writeHead(rejection);
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal');
      const type = url.searchParams.get('type') ?? 'video';
      const id = url.searchParams.get('id') ?? '';
      let file;
      if (type === 'image') {
        file = join(dataRoot, 'images', `${basename(id)}.png`);
      } else {
        await videoTasks.load();
        file = videoTasks.get(id)?.file;
      }
      const root = resolve(dataRoot) + sep;
      if (!file || !resolve(file).startsWith(root) || !existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const info = await stat(file);
      res.writeHead(200, { 'content-type': mimeOf(file), 'content-length': info.size, 'accept-ranges': 'bytes' });
      res.end(await readFile(file));
    },
  }), 'creative-studio: standalone asset route');

  // -------------------------------------------------------------------------
  // Agent 工具
  // -------------------------------------------------------------------------
  const textBlocks = (value) => [{ type: 'text', text: String(value) }];

  const newTool = {
    name: 'creative_studio_new',
    description:
      '在创意工作台新建一个项目：填产品画像（产品名/品类/人群/卖点/调性/禁用词）和拍摄目标，得到一个项目 id。之后用 creative_studio_run 跑流水线（创意 idea → 剧情 → 分镜 → 人物六维 → 配音 → 出片 → 成片剪辑）。热点不用手填：面板里能一键抓，或先建项目再让宿主抓。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'productName'],
      properties: {
        title: { type: 'string', description: '项目名，例如「清汤面·深夜面馆 45 秒」' },
        productName: { type: 'string', description: '产品名' },
        category: { type: 'string', description: '品类，例如「地方小吃到店体验」' },
        audience: { type: 'string', description: '目标人群' },
        sellingPoints: { type: 'array', items: { type: 'string' }, description: '核心卖点，逐条写' },
        tone: { type: 'string', description: '调性，例如「克制的温情，不要叫卖」' },
        forbidden: { type: 'array', items: { type: 'string' }, description: '客户禁用词' },
        targetSeconds: { type: 'integer', minimum: 10, maximum: 180, description: '目标时长（秒），默认 45' },
        platform: { type: 'string', enum: ['douyin', 'shipinhao', 'xiaohongshu', 'bilibili'], description: '投放平台，默认 douyin' },
        hotspots: {
          type: 'array',
          description: '可选：已经拿到的热点（不传就等面板抓）',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { title: { type: 'string' }, source: { type: 'string' }, heat: { type: 'string' } },
          },
        },
      },
    },
    timeoutMs: 120_000,
    async execute(args) {
      const project = newProject({
        title: args.title,
        platform: args.platform,
        targetSeconds: args.targetSeconds,
        aspect: options.aspectRatio,
        resolution: options.resolution,
        brief: {
          productName: args.productName,
          category: args.category,
          audience: args.audience,
          sellingPoints: args.sellingPoints,
          tone: args.tone,
          forbidden: args.forbidden,
          hotspots: (args.hotspots ?? []).map((hotspot) => ({ title: String(hotspot.title ?? ''), source: String(hotspot.source ?? '手动'), heat: hotspot.heat ?? null })),
        },
      });
      await store.save(project);
      event(project, { kind: 'create', text: '项目已创建（Agent）' });
      await store.save(project);
      return { id: project.id, dir: store.dirOf(project.id), title: project.title, targetSeconds: project.targetSeconds };
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlocks(`项目已建：${value.id}\n目录：${value.dir}\n下一步：creative_studio_run（可以 stage=idea 只跑创意，也可以不传 stage 跑全流程）`),
    },
  };

  const statusTool = {
    name: 'creative_studio_status',
    description:
      '看创意工作台的项目状态：每个阶段的状态/审核分数/门禁失败项/待人工复核项。不传 id 就列最近的项目。需要复核的项目会带 pendingReview。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '项目 id；省略则列最近 10 个项目' },
        full: { type: 'boolean', description: '为 true 时一并返回各阶段产物摘要' },
      },
    },
    timeoutMs: 60_000,
    async execute(args) {
      if (!args.id) {
        const projects = await store.list();
        return { projects: projects.slice(0, 10).map((row) => ({ id: row.id, title: row.title, doneStages: row.doneStages, totalStages: row.totalStages, pendingReview: row.pendingReview ? row.pendingReview.stageLabel : null, running: row.running?.stage ?? null, updatedAt: row.updatedAt })) };
      }
      const project = await store.load(String(args.id));
      const stages = STAGE_IDS.map((stage) => {
        const record = project.stages[stage] ?? {};
        return {
          id: stage,
          label: STAGE_BY_ID[stage].label,
          agent: STAGE_BY_ID[stage].agent,
          status: record.status ?? 'empty',
          attempts: record.attempts ?? 0,
          score: record.review?.score ?? null,
          gateOk: record.gate?.ok ?? null,
          failures: (record.gate?.failures ?? []).slice(0, 3),
          issues: (record.issues ?? []).slice(0, 3),
          error: record.error ?? null,
        };
      });
      const payload = {
        id: project.id,
        title: project.title,
        targetSeconds: project.targetSeconds,
        stages,
        pendingReview: project.pendingReview ?? null,
        finalFile: project.finalFile ?? project.stages.edit?.finalFile ?? null,
        dir: store.dirOf(project.id),
      };
      if (args.full) {
        payload.artifacts = {};
        for (const stage of ['idea', 'story', 'storyboard', 'characters', 'voice', 'edit']) {
          const artifact = await store.artifact(project, stage).catch(() => null);
          if (artifact) payload.artifacts[stage] = artifact;
        }
      }
      return payload;
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (Array.isArray(value.projects)) {
          const lines = value.projects.map((row) => `${row.id}｜${row.title}｜${row.doneStages}/${row.totalStages} 阶段${row.running ? `｜正在跑 ${row.running}` : ''}${row.pendingReview ? `｜⚠ 待复核：${row.pendingReview}` : ''}`);
          return textBlocks(lines.join('\n') || '还没有项目');
        }
        const lines = [`${value.title}（${value.id}）`];
        for (const stage of value.stages ?? []) {
          const flag = stage.status === 'done' ? '✓' : stage.status === 'needs_review' ? '⚠' : stage.status === 'failed' ? '✗' : '·';
          lines.push(`${flag} ${stage.label}｜${stage.status}${stage.attempts > 1 ? `（第 ${stage.attempts} 版）` : ''}${stage.score !== null ? `｜审核 ${stage.score}` : ''}${stage.error ? `｜${stage.error}` : ''}`);
          for (const failure of stage.failures ?? []) lines.push(`   门禁：${failure}`);
          for (const issue of stage.issues ?? []) lines.push(`   待修：${issue}`);
        }
        if (value.pendingReview) lines.push(`⚠ 待人工复核：${value.pendingReview.stageLabel}｜${value.pendingReview.reason}`);
        if (value.finalFile) lines.push(`成片：${value.finalFile}`);
        return textBlocks(lines.join('\n'));
      },
    },
  };

  const runTool = {
    name: 'creative_studio_run',
    description:
      '跑创意工作台的流水线。不传 stage 就从第一个未完成阶段往下跑（含出片与成片剪辑）；传 stage 就从该阶段重跑。生产、剪辑、审核三个 Agent 会自动串起来，质量不过自动打回重做；重试用完仍不过会停下来，把项目标成待人工复核。出片与剪辑是长任务，工具会等到这一轮跑完或停在待复核。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '项目 id' },
        stage: { type: 'string', enum: ['idea', 'story', 'storyboard', 'characters', 'voice', 'render', 'edit'], description: '从这个阶段开始跑；省略则从第一个未完成阶段开始' },
        note: { type: 'string', description: '给生产 Agent 的额外要求（例如「第三镜改成夜戏」）' },
        only: { type: 'boolean', description: '只跑 stage 这一个阶段就停（step-by-step 用）；省略则从该阶段一路跑到成片' },
        wait: { type: 'boolean', description: '为 false 时立刻返回，进度用 creative_studio_status 查（默认等）' },
      },
    },
    timeoutMs: 3_600_000,
    async execute(args) {
      const id = String(args.id);
      const project = await store.load(id);
      if (args.stage) {
        await store.update(id, (fresh) => {
          fresh.stages[args.stage] = { ...fresh.stages[args.stage], status: 'empty', error: null, issues: [] };
          for (const later of STAGE_IDS.slice(STAGE_IDS.indexOf(args.stage) + 1)) {
            if (fresh.stages[later]?.status === 'done') continue;
            fresh.stages[later] = { ...fresh.stages[later], status: 'empty' };
          }
          fresh.pendingReview = null;
        });
      }
      if (args.wait === false) {
        startPipeline(id, { from: args.stage, note: args.note, only: Boolean(args.only) });
        return { started: true, id };
      }
      const result = await runPipeline(id, { from: args.stage, note: args.note, only: Boolean(args.only) });
      return { ...result, id: project.id, title: project.title };
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value.started) return textBlocks(`已在后台开跑：${value.id}（用 creative_studio_status 查进度）`);
        const lines = [`${value.title ?? ''}｜${value.id ?? ''}`];
        for (const row of value.results ?? []) {
          if (row.skipped) lines.push(`· ${row.stage}：已完成，跳过`);
          else if (row.ok) lines.push(`✓ ${STAGE_BY_ID[row.stage]?.label ?? row.stage}${row.score ? `｜审核 ${row.score} 分` : ''}`);
          else if (row.needsReview) lines.push(`⚠ ${STAGE_BY_ID[row.stage]?.label ?? row.stage}：需要人工复核`);
          else lines.push(`✗ ${STAGE_BY_ID[row.stage]?.label ?? row.stage}：${row.error ?? '失败'}`);
        }
        if (value.error) lines.push(`错误：${value.error}`);
        if (value.finalFile) lines.push(`成片：${value.finalFile}`);
        return textBlocks(lines.join('\n'));
      },
    },
  };

  const decideTool = {
    name: 'creative_studio_decide',
    description: '对创意工作台的「待人工复核」做裁决：approve 通过并记为完成，rework 带着意见打回重做，skip 跳过这个阶段。裁决后会清掉待复核标记。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'decision'],
      properties: {
        id: { type: 'string', description: '项目 id' },
        decision: { type: 'string', enum: ['approve', 'rework', 'skip'], description: '通过 / 打回 / 跳过' },
        stage: { type: 'string', enum: ['idea', 'story', 'storyboard', 'characters', 'voice', 'render', 'edit'], description: '复核哪个阶段；省略则用项目上待复核的那个' },
        note: { type: 'string', description: '裁决意见：打回时这段会逐条塞进生产 Agent 的提示词' },
      },
    },
    timeoutMs: 120_000,
    async execute(args) {
      const project = await store.load(String(args.id));
      const stage = String(args.stage || project.pendingReview?.stage || '');
      if (!stage) return { error: '这个项目没有待复核项' };
      if (stage === 'edit' && args.decision === 'approve'
        && ((!project.finalFile && !project.stages.edit.finalFile) || project.stages.edit.stale || jobs.has(project.id))) {
        return { error: '请先合成当前素材，再通过成片' };
      }
      if (args.decision === 'rework') {
        await store.update(project.id, (fresh) => {
          fresh.stages[stage] = { ...fresh.stages[stage], status: 'empty', issues: args.note ? [args.note] : [], note: null };
          fresh.pendingReview = null;
          event(fresh, { kind: 'review-rework', stage, text: `Agent 裁决打回：${args.note ?? ''}` });
        });
        const result = await runPipeline(project.id, { from: stage, note: args.note });
        return { rework: stage, ...result };
      }
      await store.update(project.id, (fresh) => {
        fresh.stages[stage] = {
          ...fresh.stages[stage],
          status: args.decision === 'skip' ? 'skipped' : 'done',
          note: args.note ? `人工复核：${args.note}` : '人工复核通过',
          issues: [],
        };
        fresh.pendingReview = null;
        event(fresh, { kind: 'review-decide', stage, text: `${args.decision}：${args.note ?? ''}` });
      });
      if (args.decision !== 'skip' && stage === 'edit') await refreshPublishPack(await store.load(project.id));
      return args.decision === 'skip' ? { skipped: stage } : { approved: stage };
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value.approved) return textBlocks(`已通过：${value.approved}`);
        if (value.skipped) return textBlocks(`已跳过：${value.skipped}`);
        if (value.rework) {
          const lines = [`已打回：${value.rework}`];
          for (const row of value.results ?? []) lines.push(`· ${row.stage}: ${row.ok ? '通过' : row.needsReview ? '再次待复核' : row.error ?? '失败'}`);
          return textBlocks(lines.join('\n'));
        }
        return textBlocks('没有变化');
      },
    },
  };

  const editShotTool = {
    name: 'creative_studio_edit_shot',
    description:
      '（创意工作台内置）改分镜里的一个镜头（提示词/动作/时长）或一句台词，改完立刻重跑 13 道门；不重新生成整条分镜，也不花钱。改完可以用 creative_studio_run(stage=render) 只重渲受影响的分段。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '项目 id' },
        shotId: { type: 'string', description: '镜头 id，例如 E01-SH03' },
        prompt: { type: 'string', description: '新的镜头提示词（至少 60 字）' },
        action: { type: 'string', description: '新的动作描述（一镜只做一件事）' },
        durationSec: { type: 'number', description: '这一镜的时长（秒）' },
        beatId: { type: 'string', description: '要改的台词节拍 id' },
        text: { type: 'string', description: '新的台词原文' },
        speaker: { type: 'string', description: '说话人（可不填）' },
      },
    },
    timeoutMs: 120_000,
    async execute(args) {
      const shot = args.shotId
        ? { id: args.shotId, prompt: args.prompt, action: args.action, durationSec: args.durationSec }
        : null;
      const beat = args.beatId ? { id: args.beatId, text: args.text, speaker: args.speaker } : null;
      const result = await handlers.updateStoryboard({ id: args.id, shot, beat });
      if (!result.ok) return { error: result.error.message };
      return { gate: result.value.gate, changed: result.value.changed };
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value.error) return textBlocks(`没改成：${value.error}`);
        const failures = value.gate?.failures ?? [];
        return textBlocks(value.gate?.ok
          ? `已改 ${value.changed} 处，13 道门全过`
          : `已改 ${value.changed} 处，但门禁有 ${failures.length} 条没过：\n${failures.slice(0, 6).map((item) => `· ${item}`).join('\n')}`);
      },
    },
  };

  // -------------------------------------------------------------------------
  // 原 video-h3 的工具名原样保留：技能与老习惯里的 h3_* 调用继续可用，
  // 实现已经换成创意工作台自己的引擎（同一套 EasyFrame / 鼠鼠工具 / ffmpeg）。
  // -------------------------------------------------------------------------
  const refreshStandalone = async (record) => {
    if (!record) return null;
    try {
      const state = await video.status({ taskId: record.id, provider: record.provider });
      record.status = state.status;
      record.progress = state.progress ?? record.progress;
      record.error = state.error ?? null;
      if (state.status === 'completed' && (!record.file || !existsSync(record.file))) {
        const saved = await video.download({ taskId: record.id, provider: record.provider, dir: join(dataRoot, 'videos'), filename: `${record.id}.mp4` });
        record.file = saved.file;
        record.bytes = saved.bytes;
        record.error = null;
      }
    } catch (error) {
      record.error = error.message;
    }
    record.updatedAt = Date.now();
    await videoTasks.upsert(record);
    return record;
  };

  const h3VideoTool = {
    name: 'h3_generate_video',
    description:
      '（创意工作台内置）用 MiniMax-H3 生成一段 5–15 秒视频并等待完成，返回落盘路径。默认文生视频；传 firstFrame/lastFrame 走首尾帧，传 references 走多参考（最多 9 张）。图片必须是本机文件路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: '画面描述：主体、动作、运镜、光线、情绪' },
        mode: { type: 'string', enum: ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'], description: '默认 t2va；有首尾帧用 fl2va，单张用 i2va' },
        seconds: { type: 'integer', minimum: 5, maximum: 15, description: '时长，默认取插件配置' },
        resolution: { type: 'string', enum: ['480p', '720p'], description: '分辨率，默认取插件配置' },
        aspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '4:5', '5:4'], description: '画幅，默认 16:9' },
        firstFrame: { type: 'string', description: '首帧图片的绝对路径（i2va / fl2va）。' },
        lastFrame: { type: 'string', description: '尾帧图片的绝对路径（fl2va）。' },
        references: { type: 'array', items: { type: 'string' }, description: '多参考图片绝对路径，最多 9 张（ref2va）。' },
      },
    },
    timeoutMs: 1_800_000,
    async execute(args) {
      const refs = Array.isArray(args.references) ? args.references.slice(0, 9) : [];
      const mode = ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'].includes(String(args.mode))
        ? String(args.mode)
        : args.firstFrame && args.lastFrame ? 'fl2va' : refs.length > 0 ? 'ref2va' : args.firstFrame ? 'i2va' : 't2va';
      const images = [];
      if (args.firstFrame) images.push(await loadImageFile(args.firstFrame, 'first.png'));
      if (args.lastFrame) images.push(await loadImageFile(args.lastFrame, 'last.png'));
      for (const [index, path] of refs.entries()) images.push(await loadImageFile(path, `ref${index + 1}.png`));
      const record = await runStandaloneVideo({
        prompt: args.prompt,
        mode,
        seconds: args.seconds,
        resolution: args.resolution,
        aspectRatio: args.aspectRatio,
        images,
      });
      // 返回给模型的对象必须是「无据 JSON」：不带 undefined 字段。
      const result = { taskId: record.id, status: record.status, seconds: record.seconds, resolution: record.resolution, cost: record.cost };
      if (record.file) result.file = record.file;
      if (record.error) result.error = record.error;
      return result;
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlocks([`任务 ${value.taskId}：${value.status}`, value.file ? `成品：${value.file}` : '', value.cost ? `预估费用：¥${value.cost}` : '', value.error ? `错误：${value.error}` : ''].filter(Boolean).join('\n')),
    },
  };

  const h3TasksTool = {
    name: 'h3_video_tasks',
    description: '（创意工作台内置）查看独立出片任务：不传 taskId 列最近任务，传了就刷新那一条并返回状态/成品路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: '任务 ID；省略则列最近 20 条' },
        refresh: { type: 'boolean', description: '是否向上游刷新状态，默认 true' },
      },
    },
    timeoutMs: 120_000,
    async execute(args) {
      await videoTasks.load();
      if (args.taskId) {
        const record = videoTasks.get(args.taskId);
        if (!record) return { tasks: [], error: '没有这个任务' };
        if (args.refresh !== false) await refreshStandalone(record);
        return { tasks: [taskView(record)] };
      }
      return { tasks: videoTasks.list().slice(0, 20).map(taskView) };
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value.error) return textBlocks(value.error);
        const rows = (value.tasks ?? []).map((task) => `${task.id} ${task.status}${task.file ? ` -> ${task.file}` : ''}${task.error ? `（${task.error}）` : ''}`);
        return textBlocks(rows.join('\n') || '还没有任务');
      },
    },
  };

  const h3ConcatTool = {
    name: 'h3_concat_videos',
    description: '（创意工作台内置）按给定顺序把已完成的出片任务拼成一条 MP4（本机 ffmpeg，不消耗额度）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskIds'],
      properties: { taskIds: { type: 'array', items: { type: 'string' }, minItems: 2, description: '按成片顺序排好的任务 ID' } },
    },
    timeoutMs: 600_000,
    async execute(args) {
      const result = await concatTasks(args.taskIds.map(String));
      return { file: result.file, bytes: result.bytes };
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlocks(`拼接完成，${value.file}`),
    },
  };

  const h3ImageTool = {
    name: 'h3_generate_image',
    description:
      '（创意工作台内置）生成一张图并保存到本机，返回路径；可直接作为 h3_generate_video 的首帧/尾帧。默认用本机 Codex 的 image_generation（消耗 Codex 额度，单张约 1–2 分钟）；没有 Codex 时走配置的 OpenAI 兼容生图端点。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: '画面描述：主体、构图、光线、风格' },
        model: { type: 'string', description: '生图模型 id，默认取插件配置（gpt-image-2）。' },
        size: { type: 'string', description: '尺寸，默认 auto；也可传 1024x1024 这类具体值' },
      },
    },
    timeoutMs: 900_000,
    async execute(args) {
      return runStandaloneImage({ prompt: args.prompt, model: args.model, size: args.size });
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlocks(`图片已生成：${value.file}`),
    },
  };

  const h3RemixTool = {
    name: 'h3_remix_video',
    description: '（创意工作台内置）拆解一条抖音爆款视频：下载 → 切点分镜 → 语音转写 → 生成解析报告（吸引点/情绪触发/共鸣与价值/内容结构/复刻方向）。返回产物目录、镜表摘要与报告全文。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        url: { type: 'string', description: '抖音分享文案或链接；传 localPath 时可省' },
        localPath: { type: 'string', description: '本机视频文件绝对路径（先把抖音视频存到手机/电脑再传进来）。' },
        analyze: { type: 'boolean', description: '是否生成解析报告，默认 true' },
        replicate: { type: 'boolean', description: '是否同时生成复刻分镜 JSON，默认 false' },
      },
    },
    timeoutMs: 1_800_000,
    async execute(args) {
      const source = normalizeSource(args.url, args.localPath);
      const project = newProject({
        kind: 'reference',
        title: `拉片 · ${String(source.url || source.localPath).slice(0, 40)}`,
        targetSeconds: 45,
      });
      project.brief.productName = '拉片记录';
      await store.save(project);
      await runReferenceJob(project, source);
      const fresh = await store.load(project.id);
      const ref = fresh.reference ?? {};
      if (ref.status !== 'done') throw new Error(ref.error ?? '拉片没有完成');
      let storyboard = null;
      let replicateSummary = null;
      if (args.replicate === true) {
        const result = await runReplicate(fresh);
        storyboard = result.storyboard;
        replicateSummary = result.summary;
      }
      return {
        dir: join(store.dirOf(project.id), 'reference'),
        title: String(ref.summary?.title ?? ''),
        duration: Number(ref.duration ?? 0),
        shotCount: Number(ref.shotCount ?? 0),
        ...(storyboard ? { storyboard, replicateSummary } : {}),
        report: String(ref.report ?? ''),
      };
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) =>
        textBlocks(
          [
            `拆解完成：${value.title || value.dir}`,
            `时长 ${value.duration}s · ${value.shotCount} 镜`,
            `产物目录：${value.dir}`,
            value.replicateSummary ? `复刻分镜：${value.replicateSummary.shots} 镜 / ${value.replicateSummary.segments} 段${value.replicateSummary.gate?.ok ? '（13 道门全绿）' : ''}` : '',
            value.report ? `\n${value.report.slice(0, 2000)}` : '',
          ].filter(Boolean).join('\n'),
        ),
    },
  };

  const fromRefTool = {
    name: 'creative_studio_from_reference',
    description:
      '拿一条已经拉完的拉片记录开一个创意项目：拆解报告会作为创意阶段的证据（至少一个方向要借用它验证过的结构，人物/台词/场景必须换掉），目标时长取原片时长。先 h3_remix_video 拉片，再把返回目录里的项目 id 传进来。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'productName'],
      properties: {
        id: { type: 'string', description: '拉片记录的项目 id（h3_remix_video 返回的目录里最后一级 reference 的上一级目录名）' },
        productName: { type: 'string', description: '要换进去的产品名' },
        title: { type: 'string', description: '项目名；省略则用「产品名 · 爆款复刻」' },
        category: { type: 'string', description: '品类' },
        audience: { type: 'string', description: '目标人群' },
        sellingPoints: { type: 'array', items: { type: 'string' }, description: '卖点，逐条写' },
        tone: { type: 'string', description: '调性' },
        platform: { type: 'string', enum: ['douyin', 'shipinhao', 'xiaohongshu', 'bilibili'], description: '投放平台' },
        forbidden: { type: 'array', items: { type: 'string' }, description: '客户禁用词' },
      },
    },
    timeoutMs: 120_000,
    async execute(args) {
      const result = await handlers.referenceToProject({
        id: args.id,
        productName: args.productName,
        title: args.title,
        category: args.category,
        audience: args.audience,
        sellingPoints: args.sellingPoints,
        tone: args.tone,
        platform: args.platform,
        forbidden: args.forbidden,
      });
      if (!result?.ok) throw new Error(result?.error?.message ?? '开项目失败');
      return { id: result.value.id, title: result.value.project.title, targetSeconds: result.value.project.targetSeconds };
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlocks(`项目已建：${value.id}（目标 ${value.targetSeconds} 秒）\n下一步：creative_studio_run（stage=idea, only=true 先看创意方向）`),
    },
  };

  const briefTool = {
    name: 'creative_studio_brief',
    description: '改一个项目的画像或目标：产品名/品类/人群/卖点/调性/禁用词/目标时长。改完可以从某个阶段重跑（例如只改目标时长后重跑 storyboard）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '项目 id' },
        title: { type: 'string', description: '项目名' },
        targetSeconds: { type: 'integer', minimum: 10, maximum: 180, description: '目标时长（秒）' },
        productName: { type: 'string' },
        category: { type: 'string' },
        audience: { type: 'string' },
        sellingPoints: { type: 'array', items: { type: 'string' } },
        tone: { type: 'string' },
        forbidden: { type: 'array', items: { type: 'string' } },
        extra: { type: 'string', description: '补充要求（会进创意与分镜的提示词）' },
      },
    },
    timeoutMs: 60_000,
    async execute(args) {
      const result = await handlers.updateBrief({
        id: args.id,
        title: args.title,
        targetSeconds: args.targetSeconds,
        brief: {
          productName: args.productName,
          category: args.category,
          audience: args.audience,
          sellingPoints: args.sellingPoints,
          tone: args.tone,
          forbidden: args.forbidden,
          extra: args.extra,
        },
      });
      if (!result?.ok) throw new Error(result?.error?.message ?? '改画像失败');
      return { id: result.value.project.id, title: result.value.project.title, targetSeconds: result.value.project.targetSeconds };
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlocks(`已更新：${value.title}（目标 ${value.targetSeconds} 秒）`),
    },
  };

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(newTool),
      ctx.tools.register(statusTool),
      ctx.tools.register(runTool),
      ctx.tools.register(decideTool),
      ctx.tools.register(editShotTool),
      ctx.tools.register(fromRefTool),
      ctx.tools.register(briefTool),
      ctx.tools.register(h3VideoTool),
      ctx.tools.register(h3TasksTool),
      ctx.tools.register(h3ConcatTool),
      ctx.tools.register(h3ImageTool),
      ctx.tools.register(h3RemixTool),
    ];
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* 忽略重复播放 */
        }
      }
    };
  }, 'creative-studio: tools');

  console.log(`[creative-studio] 已挂载：项目目录 ${projectRoot}，出片后端 ${video.providers().join(' → ') || '（未配置）'}，模型跟随宿主默认。`);
}
