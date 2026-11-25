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
import { compactMessage, friendlyError } from './engine/errors.js';
import { createTraces } from './engine/traces.js';
import {
  GATES,
  SIX_DIMENSIONS,
  VOICE_CATALOG,
  describeFailures,
  applyLocks,
  fillStoryboardPrompts,
  normalizeStoryboard,
  normalizeVoicePlan,
  loadShotContract,
  patchStoryboard,
  segmentsOf,
  gateRender,
} from './engine/contracts.js';
import { createAgents, builtinPrompt, extractJson } from './engine/agents.js';
import { loadMachineOverrides, resolveConfig } from './engine/config.js';
import { runDoctor } from './engine/doctor.js';
import { createReference } from './engine/reference.js';
import { detectBurnedCaptions } from './engine/burned-captions.js';
import { matchesStamp, promptLayerFingerprint } from './engine/fingerprint.js';
import { runVisionReview } from './engine/rea-vision.js';
import { createVideoEngine, createVideoTaskStore, findCodex, mimeOf, priceOf, taskView } from './engine/video.js';
import { createMedia, fadeFlagsOf } from './engine/media.js';
import { createOpenFilmFinisher } from './engine/openfilm.js';
import { synthesizeLines, placeLines } from './engine/voice.js';

const API_PREFIX = '/creative-studio/api';
const FILE_ROUTE = '/creative-studio/file';
const BODY_LIMIT = 4 * 1024 * 1024;
/** 包根目录：包内资源（配音适配器、图标等）都相对它找。 */
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

/** 导演确认里能落到画像的字段（其余一律当补充说明）。 */
const INTAKE_BRIEF_FIELDS = ['productName', 'category', 'audience', 'sellingPoints', 'tone', 'priceBand', 'forbidden', 'extra', 'projectMode', 'audioMode'];
const PLATFORMS = ['douyin', 'shipinhao', 'xiaohongshu', 'bilibili'];

const oneLine = (value, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** 从用户贴的原文里起一个能认出来的项目名（不超过 18 字）。 */
function titleFromText(value, fallback = '未命名项目') {
  const line = String(value ?? '').split(/\r?\n/).map((row) => row.replace(/^[#\s>*\-—]+/, '').trim()).find(Boolean) ?? '';
  if (!line) return fallback;
  return line.length > 18 ? `${line.slice(0, 18)}…` : line;
}

/**
 * 把导演返回的东西收成可存的结构：只认白名单字段，问题最多 4 个、每个都必须有默认值。
 * 模型偶尔会多吐字段/把选项写成字符串，这里统一收口，别让脏值进项目文件。
 */
export function normalizeIntakeResult(raw, project = {}) {
  const incoming = raw?.brief ?? {};
  const brief = {};
  for (const key of ['productName', 'category', 'audience', 'tone', 'priceBand', 'extra']) {
    const value = String(incoming[key] ?? '').trim();
    if (value) brief[key] = oneLine(value, 240);
  }
  if (Array.isArray(incoming.sellingPoints)) {
    brief.sellingPoints = incoming.sellingPoints.map((item) => oneLine(item, 120)).filter(Boolean).slice(0, 8);
  }
  if (Array.isArray(incoming.forbidden)) {
    brief.forbidden = incoming.forbidden.map((item) => oneLine(item, 40)).filter(Boolean).slice(0, 12);
  }
  if (incoming.projectMode) brief.projectMode = incoming.projectMode === 'story' ? 'story' : 'promotion';
  if (incoming.audioMode) brief.audioMode = incoming.audioMode === 'no-dialogue' ? 'no-dialogue' : 'dialogue';

  const projectPatch = {};
  const seconds = Number(incoming.targetSeconds ?? raw?.targetSeconds);
  if (Number.isFinite(seconds) && seconds >= 10 && seconds <= 180) projectPatch.targetSeconds = Math.round(seconds);
  const platform = String(incoming.platform ?? raw?.platform ?? '');
  if (PLATFORMS.includes(platform)) projectPatch.platform = platform;
  const aspect = String(incoming.aspect ?? raw?.aspect ?? '').trim();
  if (aspect) projectPatch.aspect = aspect;

  const kind = incoming.kind === 'script' || raw?.kind === 'script' || project?.source?.kind === 'script' ? 'script' : 'idea';
  const questions = [];
  const seenFields = new Set();
  const list = Array.isArray(raw?.questions) ? raw.questions : [];
  for (const item of list) {
    if (questions.length >= 4) break;
    let field = String(item?.field ?? '').trim();
    if (!INTAKE_BRIEF_FIELDS.includes(field) && !['targetSeconds', 'platform', 'aspect'].includes(field)) field = 'extra';
    if (seenFields.has(field)) continue;
    const question = oneLine(item?.question, 120);
    if (!question) continue;
    const options = (Array.isArray(item?.options) ? item.options : [])
      .map((option) => ({ label: oneLine(option?.label, 60), value: oneLine(option?.value, 80) }))
      .filter((option) => option.label && option.value)
      .slice(0, 4);
    const fallback = options[0]?.value ?? '';
    let defaultValue = oneLine(item?.default, 80) || fallback;
    // 模型给的默认值不在选项里：退到第一个选项，别让面板上没有一个「推荐」。
    if (options.length > 0 && !options.some((option) => option.value === defaultValue)) defaultValue = fallback;
    if (!defaultValue) continue;
    seenFields.add(field);
    questions.push({
      id: `q${questions.length + 1}`,
      field,
      question,
      why: oneLine(item?.why, 120),
      options,
      default: defaultValue,
      kind: options.length > 0 ? 'choice' : 'text',
    });
  }

  return {
    summary: oneLine(raw?.summary, 200),
    title: oneLine(raw?.title, 32),
    kind,
    brief,
    projectPatch,
    questions,
  };
}

/** 把一条确认答案写进项目：画像字段进 brief，时长/平台/画幅进项目。 */
export function applyIntakeAnswer(project, field, value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  if (field === 'targetSeconds') {
    const seconds = Math.round(Number(text));
    if (!Number.isFinite(seconds)) return false;
    project.targetSeconds = Math.max(10, Math.min(180, seconds));
    return true;
  }
  if (field === 'platform') {
    if (!PLATFORMS.includes(text)) return false;
    project.platform = text;
    return true;
  }
  if (field === 'aspect') {
    project.aspect = text;
    return true;
  }
  if (field === 'sellingPoints' || field === 'forbidden') {
    project.brief[field] = text.split(/[\n，,、；;]/).map((item) => item.trim()).filter(Boolean).slice(0, 12);
    return true;
  }
  if (field === 'projectMode') {
    project.brief.projectMode = text === 'story' ? 'story' : 'promotion';
    return true;
  }
  if (field === 'audioMode') {
    project.brief.audioMode = text === 'no-dialogue' ? 'no-dialogue' : 'dialogue';
    return true;
  }
  if (['productName', 'category', 'audience', 'tone', 'priceBand', 'extra'].includes(field)) {
    project.brief[field] = text.slice(0, 600);
    return true;
  }
  // 没有对应字段的问题：当补充说明记下来，别丢掉用户写的东西。
  project.brief.extra = [String(project.brief.extra ?? '').trim(), text].filter(Boolean).join('\n').slice(0, 2000);
  return true;
}

/**
 * 长视频只拆一段：整片解码会让切点扫描自己就跑满十分钟。
 * 返回要不要截、从哪开始、截多长；0 秒 = 不截（整片拆）。
 */
export function pickReferenceWindow({ duration, startSeconds = 0, maxSeconds = 0, durationSeconds = 0 } = {}) {
  const total = Number(duration) || 0;
  if (total <= 0) return { trim: false, start: 0, seconds: 0, originalDuration: 0 };
  const start = Math.max(0, Math.min(Number(startSeconds) || 0, Math.max(0, total - 1)));
  const wanted = Number(durationSeconds) > 0 ? Number(durationSeconds) : Number(maxSeconds) || 0;
  // 剩下的比想要的还短（或配置里关掉了截取）：整段直接拆。
  if (!wanted || total - start <= wanted + 1) {
    return { trim: false, start, seconds: Number((total - start).toFixed(2)), originalDuration: Number(total.toFixed(2)) };
  }
  return {
    trim: true,
    start,
    seconds: Number(Math.min(wanted, total - start).toFixed(2)),
    originalDuration: Number(total.toFixed(2)),
  };
}

/** 面板/工具传来的截取参数：空值 = 用配置默认（referenceMaxSeconds / referenceStartSeconds）。 */
export function parseReferenceWindowInput(payload = {}) {
  const pick = (value) => {
    if (value === undefined || value === null || value === '') return undefined;
    const number = Math.round(Number(value));
    return Number.isFinite(number) && number >= 0 ? number : undefined;
  };
  return { startSeconds: pick(payload.startSeconds), durationSeconds: pick(payload.durationSeconds) };
}

/** 把秒数说成人话：3216 → 53:36。 */
const clockText = (seconds) => {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
};

/**
 * 视频生成用的「默剧版」提示词：对白全部交给后期 TTS，画面里的人物不开口。
 * H3 看到台词会自己张嘴念，嘴型节奏和我们的 TTS 对不上；把台词从画面提示词里拿掉，
 * 只留动作/视线/光位，人物用眼神和身体表演，口型问题就不存在了。
 */
export function silentPerformancePrompt(prompt) {
  const body = String(prompt ?? '')
    // 说话人 + 引号台词整段拿掉
    .replace(/[^\s：:（）()]*[：:]\s*「[^」]*」/g, '')
    // 剩下没有说话人的引号台词
    .replace(/「[^」]*」/g, '')
    // 开口/说话这类动作提示改成沉默表演
    .replace(/(画外开口|开口说|说完一句|说完|开口|嘴动一下|嘴动|说台词)/g, '沉默地看向对方')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `${body}\n\n本片对白后期配音：人物不开口、不做说话口型，用眼神、呼吸和身体动作表演，画面里看不到说话的口型。`;
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
  /** 项目之外的关联数据（复核通知、运行队列）：删项目时要一起清。 */
  const traces = createTraces({ dataRoot, log });
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
  // 启动时顺手收一遍历史残留：指向已删项目的复核记录、运行队列行。
  // 不这么做的话，删掉的项目会在 inbox.json 里一直躺着（面板不显示，但盘上还在）。
  void (async () => {
    try {
      const rows = await store.list();
      const swept = await traces.sweep(rows.map((row) => row.id));
      if (swept.inbox || swept.queue) {
        log(`清掉指向已删项目的残留记录：复核 ${swept.inbox} 条 / 队列 ${swept.queue} 条`);
      }
    } catch (error) {
      log(`清理残留记录失败（不影响使用）：${error.message}`);
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

  /** 本次项目实际用到的模型/接口：模型不固定，所以每次状态查询都实时算。 */
  function runtimeInfo() {
    let llm = null;
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
      if (selection?.provider && selection?.model) llm = { provider: String(selection.provider), model: String(selection.model) };
    } catch {
      llm = null;
    }
    return {
      llm,
      video: {
        provider: String(options.videoProvider ?? 'auto'),
        model: String(options.videoModel ?? ''),
        resolution: String(options.resolution ?? ''),
      },
      image: { backend: video.imageBackendLabel(), mode: String(options.imageBackend ?? 'auto') },
    };
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
      // 故事里有每个人物的年龄段：配音按年龄挑音色，别给夫人配少女声。
      context.story = await artifactOf(project, 'story');
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
  async function runReferenceJob(project, { url, localPath, advanced = true, startSeconds, durationSeconds }) {
    const dir = join(store.dirOf(project.id), 'reference');
    await mkdir(dir, { recursive: true });
    const patch = async (value) => {
      await store.update(project.id, (fresh) => {
        fresh.reference = { ...(fresh.reference ?? {}), ...value, dir, at: Date.now() };
      }).catch(() => {});
    };
    const stage = (status, text) => patch({ status, stage: text });
    let window = null;
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
        const info = await media.probe(localPath).catch(() => null);
        window = pickReferenceWindow({
          duration: info?.duration,
          startSeconds: startSeconds ?? options.referenceStartSeconds,
          maxSeconds: options.referenceMaxSeconds,
          durationSeconds,
        });
        if (window.trim) {
          // 直接从现在这个文件截，不先复制整片：53 分钟 400MB 的片子复制一遍纯属浪费。
          await reference.trim({
            video: localPath,
            out: video,
            start: window.start,
            seconds: window.seconds,
            ffmpegPath: options.ffmpegPath,
            onStage: stage,
          });
        } else {
          await copyFile(localPath, video);
        }
        await writeFile(join(dir, 'meta.json'), JSON.stringify({
          source: 'local',
          path: localPath,
          originalDuration: window.originalDuration,
          window: window.trim ? { start: window.start, seconds: window.seconds } : null,
        }, null, 2), 'utf8');
        await stage('running', window.trim
          ? `原片 ${clockText(window.originalDuration)}，只拆 ${clockText(window.start)}–${clockText(window.start + window.seconds)}`
          : '已接收本地视频');
      } else {
        const fetched = await reference.fetch({
          url,
          dir,
          onStage: stage,
          // 抖音要「新鲜 cookie」：留空就用脚本自己的兜底提示；配了 cookies.txt（浏览器扩展导出）就能直接下。
          env: options.cookiesFile ? { YTDLP_COOKIES: options.cookiesFile } : undefined,
        });
        video = fetched.video;
        const info = await media.probe(video).catch(() => null);
        window = pickReferenceWindow({
          duration: info?.duration,
          startSeconds: startSeconds ?? options.referenceStartSeconds,
          maxSeconds: options.referenceMaxSeconds,
          durationSeconds,
        });
        if (window.trim) {
          const clipped = join(dir, 'analysis.mp4');
          await reference.trim({
            video,
            out: clipped,
            start: window.start,
            seconds: window.seconds,
            ffmpegPath: options.ffmpegPath,
            onStage: stage,
          });
          // 整片副本只用于截取：留着白占几百 MB，删掉；来源与原始时长都写进 meta。
          await rm(video, { force: true }).catch(() => {});
          video = clipped;
          await writeFile(join(dir, 'meta.json'), JSON.stringify({
            ...(fetched.meta ?? {}),
            originalDuration: window.originalDuration,
            window: { start: window.start, seconds: window.seconds },
          }, null, 2), 'utf8');
        }
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
        // 长视频只拆了一段：面板要能说清「原片多长、拆的是哪一段」。
        window: window?.trim ? { start: window.start, seconds: window.seconds, originalDuration: window.originalDuration } : null,
        originalDuration: window?.originalDuration ?? null,
        report: report.slice(0, 9000),
        reportFile: join(dir, 'report.md'),
        rea: rea ? { ok: true, summary: rea.summary, timeline: rea.timeline, videoMd: rea.videoMd, out: rea.out, reportHtml: rea.reportHtml, vision: rea.vision ?? null, visionError: rea.visionError ?? null } : null,
        reaError,
      });
      await store.update(project.id, (fresh) => {
        event(fresh, { kind: 'reference', text: `参考爆款拆解完成：${evidence.summary?.title ?? ''}（${framed.shotCount} 镜）` });
      }).catch(() => {});
    } catch (error) {
      // 只把一句人话写进项目：面板上不铺命令行和上游日志，完整输出留在 reference/fetch.log 里。
      const reason = friendlyError(error, '参考爆款拆解失败');
      await patch({ status: 'failed', stage: '失败', error: reason });
      await store.update(project.id, (fresh) => {
        event(fresh, { kind: 'reference-error', text: `参考爆款拆解失败：${reason}` });
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
          // 先把「模型算不准」的几类问题就地修掉（台词时长/纯对白镜/镜长/分段），再跑门禁。
          const fixed = normalizeStoryboard(artifact);
          const fixedCount = fixed.changes.kinds + fixed.changes.lines + fixed.changes.beats + fixed.changes.claims + fixed.changes.shots + fixed.changes.segments + fixed.changes.actions;
          if (fixedCount > 0) {
            event(project, {
              kind: 'normalize',
              stage,
              text: `按门禁口径修正 ${fixedCount} 处：节拍类型 ${fixed.changes.kinds} / 台词时长 ${fixed.changes.lines} / 动作拍 ${fixed.changes.beats} / 未认领节拍 ${fixed.changes.claims} / 镜长 ${fixed.changes.shots} / 分段 ${fixed.changes.segments} / 动作措辞 ${fixed.changes.actions}`,
            });
          }
          // 长片（>60 秒）让模型只填现场表，prompt 由现场表重建：JSON 小一半，避免撞输出上限被截断。
          if (Number(project.targetSeconds) > 60) {
            const rebuilt = fillStoryboardPrompts(artifact);
            if (rebuilt.filled > 0) {
              event(project, { kind: 'prompts', stage, text: `长片省字：按现场表重建 ${rebuilt.filled} 条镜头提示词` });
            }
          }
          // 技能明确要求：锁行不能手写，用脚本生成后逐字贴进去。宿主在这里代劳。
          const contract = await getShotContract().catch(() => null);
          const locked = applyLocks(artifact, contract?.buildLock);
          if (locked.changed > 0) {
            event(project, { kind: 'locks', stage, text: `按现场表补齐 ${locked.changed} 条锁行` });
          }
        }
        if (stage === 'voice') {
          // 年龄对不上/两个人撞同一个音色：在门禁前按人物年龄改掉音色分配。
          const voiceFixed = normalizeVoicePlan(artifact, { story: context.story });
          if (voiceFixed.changes.age + voiceFixed.changes.clash > 0) {
            event(project, {
              kind: 'voice-plan',
              stage,
              text: `配音按人物修正：年龄不匹配 ${voiceFixed.changes.age} 人 / 撞音色 ${voiceFixed.changes.clash} 人`,
            });
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
          // 创意方向要人拍板：三条方向出来后先停下来，选一个再跑剧情（可在面板创意卡片里换方向）。
          if (stage === 'idea' && options.reviewIdea !== false) {
            record.status = 'needs_review';
            record.note = '等人工选方向';
            await store.save(project, { pipeline: true });
            const pending = await notifyReview(project, stage, {
              score: review.score,
              issues: [],
              gateFailures: [],
              reason: '创意方向已出：在创意卡片里选一个方向，点「通过」后再继续跑剧情',
            });
            return { ok: false, stage, needsReview: true, pendingReview: pending };
          }
          if (stage === 'characters') await ensurePortraits(project, artifact);
          if (stage === 'voice') {
            // 方案过了不算完：要真的合成出声音，并且念出来装得进镜头。装不进就停下来让人决定。
            const audio = await ensureVoiceAudio(project, artifact);
            if (audio?.hard?.length) {
              const failures = audio.hard.map((row) => `台词 ${row.beatId} 念出来 ${row.seconds}s，镜头只给了 ${row.slotSec}s（已加速到 ${Math.round(row.rate * 100)}% 仍超 ${row.overflowSec}s）：缩短台词，或把这一镜加长（可用 edit_shot）`);
              record.status = 'needs_review';
              record.issues = failures;
              event(project, { kind: 'voice-overflow', stage, text: `配音时长门拦下 ${failures.length} 句台词` });
              await store.save(project, { pipeline: true });
              const pending = await notifyReview(project, stage, {
                score: review.score, issues: [], gateFailures: failures,
                reason: '台词念出来装不进镜头',
              });
              return { ok: false, stage, needsReview: true, pendingReview: pending };
            }
          }
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
        // JSON 解析失败时把模型的原始输出留下来：分镜到底断在哪、是不是被截断，看文件就知道。
        if (stage === 'storyboard' && error?.raw) {
          const reviewDir = join(store.dirOf(project.id), 'review');
          await mkdir(reviewDir, { recursive: true }).catch(() => {});
          await writeFile(join(reviewDir, `storyboard-raw-${attempt}.txt`), String(error.raw).slice(0, 400_000), 'utf8').catch(() => {});
        }
        // 输出被截断是「这一版太长」，不是内容错：压缩要求后再试一轮，别整个阶段直接判死。
        const truncated = /截断|输出上限/.test(String(error.message));
        if (truncated && attempt < maxAttempts) {
          record.status = 'rework';
          record.issues = ['上一版输出被截断：这一版必须更短——镜头数再少一些，只填现场表字段，绝对不要输出 prompt。'];
          issues = record.issues;
          event(project, { kind: 'stage-rework', stage, text: `第 ${attempt} 版输出被截断，压缩后重试` });
          await store.save(project, { pipeline: true });
          continue;
        }
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
    // 人物多的时候一张张排队要好几分钟：两张并发，既不压垮接口也快一倍。
    const queue = (artifact.characters ?? []).filter((character) => !(character.portrait?.file && existsSync(character.portrait.file)));
    if (queue.length === 0) return;
    let changed = false;
    const worker = async () => {
      for (;;) {
        const character = queue.shift();
        if (!character) return;
        try {
          const prompt = [artifact.style, character.prompt, '半身像，正面，纯灰背景，柔和均匀的柔光，无文字，无水印。']
            .filter(Boolean)
            .join('，');
          // 生图接口偶尔会 transient 断流（terminated / timeout）：隔两秒再试一次，别因为一张图丢掉这个人物。
          let result;
          let lastError;
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
              result = await video.generateImage({ prompt, dir, filename: `${character.name}.png` });
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
              if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2000));
            }
          }
          if (!result) throw lastError;
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
    };
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
    if (changed) await store.writeArtifact(project, 'characters', artifact);
  }

  /**
   * 配音落地：方案 → 逐句 mp3（+ 时长门）。
   *
   * 这一步不改产物本身（05-voice.json 保持 Agent 写的样子），合成结果记在
   * stages.voice.audio 上，面板按 beatId 试听、剪辑按它铺轨。合成失败只记原因不阻塞——
   * 没有配音也要能把片子出出来，这是和原来行为的兼容点。
   */
  async function ensureVoiceAudio(project, artifact) {
    const record = project.stages.voice;
    const lines = Array.isArray(artifact?.lines) ? artifact.lines : [];
    if (lines.length === 0) {
      record.audio = { engine: null, lines: [], warnings: [], hard: [], skipped: 'no-dialogue', at: Date.now() };
      await store.save(project, { pipeline: true });
      return record.audio;
    }
    if (!options.ttsScript || !existsSync(options.ttsScript)) {
      record.audio = { ok: false, skipped: true, lines: [], error: '没配置 TTS 脚本：在 ~/.dsh/creative-studio/machine.json 里把 ttsScript 指向 Easel 的 skills/shared/scripts/tts.py' };
      event(project, { kind: 'voice-audio-skip', stage: 'voice', text: `配音未落地：${record.audio.error}` });
      await store.save(project, { pipeline: true });
      return record.audio;
    }
    try {
      const storyboard = await artifactOf(project, 'storyboard');
      const result = await synthesizeLines({
        storyboard,
        voice: artifact,
        dir: join(store.dirOf(project.id), 'voice'),
        python: options.ttsPython || 'python',
        script: options.ttsScript,
        provider: String(options.ttsProvider || options.ttsEngine || 'edge'),
        adapter: join(PKG_ROOT, 'tools', 'unisound_tts.py'),
        apiKey: String(options.ttsApiKey ?? ''),
        baseUrl: String(options.ttsBaseUrl ?? ''),
        engine: String(options.ttsEngine || 'edge'),
        maxRate: Number(options.ttsMaxRate) || undefined,
        ffprobe: media.ffprobe,
        log,
      });
      record.audio = { ...result, ok: result.hard.length === 0, at: Date.now() };
      event(project, {
        kind: 'voice-audio',
        stage: 'voice',
        text: `配音已合成 ${result.lines.length} 句（${result.engine}）${result.hard.length ? `，${result.hard.length} 句装不进镜头` : result.warnings.length ? `，${result.warnings.length} 句略超已加速` : ''}`,
      });
      await store.save(project, { pipeline: true });
      return record.audio;
    } catch (error) {
      record.audio = { ok: false, lines: [], error: error.message, at: Date.now() };
      event(project, { kind: 'voice-audio-error', stage: 'voice', text: `配音合成失败（不阻塞出片）：${error.message}` });
      await store.save(project, { pipeline: true });
      return record.audio;
    }
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
    const lineBeats = new Set((Array.isArray(storyboard.beats) ? storyboard.beats : [])
      .filter((beat) => beat?.kind === 'line')
      .map((beat) => String(beat.id)));
    for (const segment of segments) {
      const images = await referenceImages(segment, characters);
      const basePrompt = forceSegmentId === segment.id && note
        ? [segment.prompt, `本段返工要求：${note}`].join('\n\n')
        : segment.prompt;
      const hasDialogue = (segment.shots ?? []).some((shot) => (shot?.claims ?? [])
        .some((id) => lineBeats.has(String(id))));
      const input = {
        // 有台词的段：画面里人物不开口，台词全部交给后期 TTS，避免嘴型和配音对不上。
        prompt: hasDialogue ? silentPerformancePrompt(basePrompt) : basePrompt,
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
      if (edl.orderFixed) {
        event(project, { kind: 'edit-order', stage: 'edit', text: '叙事顺序修正：模型把后面的段提前了，已按分镜段序排回（只有 ≤2 秒的片头钩子允许前置）' });
      }
      await store.writeArtifact(project, 'edit', edl);

      if (!gate.ok) {
        issues = gate.failures.slice(0, 12);
        record.status = 'rework';
        record.issues = issues;
        event(project, { kind: 'stage-rework', stage: 'edit', text: `剪辑清单第${attempt} 版没过：${issues[0] ?? ''}` });
        await store.save(project, { pipeline: true });
        continue;
      }

      // 执行 EDL（配音跟着 EDL 的段重排/裁剪走：真实段长到这一步才知道，最终时间轴在这里定）
      let output;
      try {
        const voiceAudio = project.stages.voice?.audio;
        const placed = voiceAudio?.lines?.length
          ? placeLines({ lines: voiceAudio.lines, storyboard, edl, tasks: completed })
          : { lines: [], overflows: [], dropped: [], duration: 0 };
        record.audio = { count: placed.lines.length, overflows: placed.overflows, dropped: placed.dropped, duration: placed.duration, at: Date.now() };
        if (placed.overflows.length > 0) {
          event(project, {
            kind: 'voice-cut',
            stage: 'edit',
            text: `${placed.overflows.length} 句台词在裁切后超时（${placed.overflows[0].beatId} 超 ${placed.overflows[0].overflowSec}s），已裁到片尾、不往回挪（否则会和上一句叠音）`,
          });
        }
        output = await executeEdl(project, edl, completed, placed.lines);
        if (edl.audio?.bgm && !output.bgm) {
          event(project, {
            kind: 'bgm-missing',
            stage: 'edit',
            text: `BGM 没匹配到文件（${options.bgmDir || '未配置 bgmDir'}）：成片只有对白；在 bgmDir 放几首情绪词对得上的曲子`,
          });
        }
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
      // 画面验收只有 blocker 一票否决；major/minor 只记建议——手部穿模、纸上文字这类
      // AI 画面瑕疵很常见，判成 major 就否决会无限重做（而且模型重生成也未必更好）。
      const visualBlockers = (visual?.issues ?? []).filter((issue) => issue.severity === 'blocker');
      if (visual && visual.pass === false) {
        if (visualBlockers.length > 0) {
          review.pass = false;
          review.issues = [...(visual.issues ?? []), ...(review.issues ?? [])];
          review.summary = `画面验收未过：${visual.summary || visual.issues?.[0]?.problem || ''}${review.summary ? `｜${review.summary}` : ''}`;
          record.review = { score: review.score, pass: false, dimensions: review.dimensions, summary: review.summary, at: Date.now() };
        } else {
          review.issues = [...(visual.issues ?? []), ...(review.issues ?? [])];
          review.summary = `画面建议：${visual.summary || ''}${review.summary ? `｜${review.summary}` : ''}`;
          record.review = { score: review.score, pass: review.pass, dimensions: review.dimensions, summary: review.summary, at: Date.now() };
        }
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
      if (visual?.issues?.some((issue) => issue.severity === 'blocker' && issue.action === 'segment')) break;
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
  async function executeEdl(project, edl, completedTasks, voiceLines = []) {
    const mode = String(options.finisher ?? 'auto').toLowerCase();
    if (mode !== 'ffmpeg') {
      const usable = await openfilm.available().catch(() => ({ ok: false, reason: 'OpenFilm 不可用' }));
      if (usable.ok) {
        try {
          const output = await executeEdlWithOpenFilm(project, edl, completedTasks, voiceLines);
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
    const output = await executeEdlWithFfmpeg(project, edl, completedTasks, voiceLines);
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
  async function executeEdlWithOpenFilm(project, edl, completedTasks, voiceLines = []) {
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
      lines: voiceLines,
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
  async function executeEdlWithFfmpeg(project, edl, completedTasks, voiceLines = []) {
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
      lines: voiceLines,
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
      // skipped 也算「有结论」：剧本模式下创意阶段是主动跳过的，不能因此每次重跑。
      const settled = (stage) => ['done', 'skipped'].includes(project.stages[stage]?.status);
      const startIndex = from ? STAGE_IDS.indexOf(from) : STAGE_IDS.findIndex((stage) => !settled(stage));
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
        if (stage !== 'render' && stage !== 'edit' && settled(stage) && !note && !staleReason) {
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

  /**
   * 导演确认门控：项目里有想法/剧本，但导演的问题还没答完时，不许开跑。
   * assumeDefaults = 全部按推荐值收下，然后放行。
   */
  async function ensureIntake(project, { assumeDefaults = false } = {}) {
    const id = project.id;
    if (!project.source?.text || project.intake?.status === 'done') return { ok: true };
    if (assumeDefaults) {
      if (project.intake?.status !== 'ready') {
        const ran = await handlers.intake({ id });
        if (!ran.ok) return ran;
      }
      const done = await handlers.intakeAnswer({ id, useDefaults: true });
      return done.ok ? { ok: true } : done;
    }
    if (!project.intake || ['idle', 'failed'].includes(project.intake.status)) {
      const ran = await handlers.intake({ id });
      if (!ran.ok) return ran;
      return fail('need-intake', '导演先确认几件事：答完（或选「全部用默认」）再开跑', { intake: ran.value.intake });
    }
    return fail('need-intake', '先答完导演这几个问题（或选「全部用默认」）', { intake: project.intake });
  }

  /** 后台跑，路由/工具立刻返回，面板靠 /state 轮询进度。 */
  function startPipeline(id, optionsForRun) {    if (jobs.has(id)) return null;
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
        // 长视频拉片：面板显示默认只拆多少秒。
        referenceMaxSeconds: Number(options.referenceMaxSeconds) || 0,
        referenceStartSeconds: Number(options.referenceStartSeconds) || 0,
        ffmpegPath: media.ffmpeg,
        stages: STAGES.map((stage) => ({ id: stage.id, label: stage.label, agent: stage.agent })),
        dimensions: SIX_DIMENSIONS,
        voices: VOICE_CATALOG,
        statuses: STAGE_STATUS,
      });
    },

    /** 环境自检：装完先跑一遍，缺什么、怎么补一条条列出来 */
    async doctor() {
      return ok(await runDoctor({
        options,
        dataRoot,
        projectRoot,
        promptsDir,
        // 模型不是固定的：每次自检都读宿主当前选择，并问它对不对得起“看图”这件事。
        probeModel: async () => {
          const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
          if (!selection?.provider || !selection?.model) return null;
          const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model).catch(() => null);
          return { provider: selection.provider, model: selection.model, inputModalities: info?.inputModalities ?? [] };
        },
      }));
    },

    /** 提示词模板：列出现有覆盖文件（没写就是内置写法），并把内置指令原文一并交出去。 */
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
        return { name, content, custom: Boolean(String(content).trim()), builtin: builtinPrompt(name) };
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
      // 两种记录都交回去：面板顶部按 kind 分开计数，用户能一眼看到「拉片记录」也算数据，
      // 不会出现「0 个项目但拉片台里还躺着东西」的错觉。
      return ok({
        projects: all,
        referenceCount: all.filter((row) => row.kind === 'reference').length,
      });
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
      startReferenceJob(project, { url, localPath, ...parseReferenceWindowInput(payload) });
      return ok({ id: project.id, started: true });
    },

    async referenceList() {
      const all = await store.list();
      return ok({ items: all.filter((row) => row.kind === 'reference').slice(0, 40) });
    },

    /** 拉片证据包：联系表 / 逐镜帧 / 台词 / 报告 / 复刻分镜。 */
    async referenceEvidence(payload) {
      const id = String(payload?.id ?? '');
      let project;
      try {
        project = await store.load(id);
      } catch {
        return fail('not-found', '这条拉片记录已经不存在了（可能已被删除），刷新一下列表');
      }
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
        error: ref.error ? compactMessage(ref.error, { max: 600 }) : null,
        url: ref.url ?? '',
        summary: ref.summary ?? null,
        shotTable: ref.shotTable ?? '',
        frames: ref.frames ?? [],
        contactSheet: Boolean(ref.contactSheet),
        transcriptLines: ref.transcriptLines ?? '',
        report,
        rea: ref.rea ?? null,
        reaError: ref.reaError ?? null,
        window: ref.window ?? null,
        originalDuration: ref.originalDuration ?? null,
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

    /**
     * 新建项目：一个想法、一段剧本，或者（老用法）一份产品画像。
     * 有原文的项目先不跑流水线：导演读一遍、问几句，答完再开工。
     */
    async create(payload) {
      const rawText = String(payload?.script ?? payload?.idea ?? payload?.text ?? '').trim();
      const brief = { ...(payload?.brief ?? {}) };
      const sourceKind = payload?.script ? 'script' : payload?.idea ? 'idea' : (payload?.sourceKind === 'script' ? 'script' : 'idea');
      if (!brief.productName && !rawText) return fail('bad-request', '给一句话想法、一段剧本，或至少一个产品名');
      const autoTitle = !String(payload?.title ?? '').trim();
      const project = newProject({
        title: String(payload?.title ?? '').trim() || brief.productName || titleFromText(rawText),
        platform: payload?.platform,
        targetSeconds: payload?.targetSeconds,
        aspect: payload?.aspect ?? options.aspectRatio,
        resolution: payload?.resolution ?? options.resolution,
        brief,
        source: rawText ? { kind: sourceKind, text: rawText } : null,
      });
      project.autoTitle = autoTitle;
      await store.save(project);
      event(project, {
        kind: 'create',
        text: rawText
          ? `项目已创建：读的是${sourceKind === 'script' ? '一段剧本' : '一句话想法'}（${rawText.length} 字），先让导演确认`
          : '项目已创建',
      });
      await store.save(project);
      return ok({ id: project.id, project });
    },

    /**
     * 导演确认：读项目里的想法/剧本，填能填的画像，返回最多 4 个带默认值的问题。
     * 幂等：再调一次就是「重新理解」，已有的问答记录不删（面板会提示会覆盖本轮问题）。
     */
    async intake(payload) {
      const id = String(payload?.id ?? '');
      if (!/^cs_[A-Za-z0-9_-]+$/.test(id)) return fail('bad-request', '项目 id 不合法');
      let project;
      try {
        project = await store.load(id);
      } catch {
        return fail('not-found', '项目不存在或已删除');
      }
      if (jobs.has(id)) return fail('busy', '这个项目正在跑，等它跑完再改方向');
      if (!project.source?.text) {
        return fail('not-ready', '这个项目里没有想法或剧本可读：新建时贴一段，或在「项目画像」里补一句再让导演读');
      }
      await store.update(id, (fresh) => {
        fresh.intake = { ...(fresh.intake ?? {}), status: 'running', error: null, at: Date.now(), questions: [] };
      });
      let raw;
      try {
        raw = await agents.intake({ project });
      } catch (error) {
        const reason = friendlyError(error, '导演没能读懂这段素材');
        await store.update(id, (fresh) => {
          fresh.intake = { ...(fresh.intake ?? {}), status: 'failed', error: reason, at: Date.now() };
          event(fresh, { kind: 'intake-error', text: `导演确认失败：${reason}` });
        });
        return fail('intake-failed', reason);
      }
      const result = normalizeIntakeResult(raw, project);
      const updated = await store.update(id, (fresh) => {
        fresh.brief = { ...fresh.brief, ...result.brief };
        if (result.projectPatch.targetSeconds) fresh.targetSeconds = result.projectPatch.targetSeconds;
        if (result.projectPatch.platform) fresh.platform = result.projectPatch.platform;
        if (result.projectPatch.aspect) fresh.aspect = result.projectPatch.aspect;
        if (result.kind === 'script' && fresh.source) {
          fresh.source = { ...fresh.source, kind: 'script' };
          // 剧本已经写好：创意发散没有意义，直接按原台词整理剧情。
          if (!fresh.stages.idea?.artifact) {
            fresh.stages.idea = { ...fresh.stages.idea, status: 'skipped', note: '已给剧本：跳过创意发散，按原台词整理剧情' };
          }
        }
        if (result.title && fresh.autoTitle) {
          fresh.title = result.title;
          fresh.autoTitle = false;
        }
        fresh.intake = {
          status: result.questions.length > 0 ? 'ready' : 'done',
          summary: result.summary,
          questions: result.questions,
          answers: [],
          at: Date.now(),
          error: null,
        };
        event(fresh, {
          kind: 'intake',
          text: result.questions.length > 0
            ? `导演读完了：${result.summary}（等你确认 ${result.questions.length} 件事）`
            : `导演读完了：${result.summary}（没有要问的，可以直接开跑）`,
        });
      });
      return ok({
        id,
        intake: updated.intake,
        questions: updated.intake?.questions ?? [],
        project: {
          id: updated.id,
          title: updated.title,
          brief: updated.brief,
          targetSeconds: updated.targetSeconds,
          platform: updated.platform,
          aspect: updated.aspect,
        },
      });
    },

    /** 逐条回答导演的问题；useDefaults 一次把剩下的都按推荐值收下。答完即解锁开跑。 */
    async intakeAnswer(payload) {
      const id = String(payload?.id ?? '');
      if (!/^cs_[A-Za-z0-9_-]+$/.test(id)) return fail('bad-request', '项目 id 不合法');
      const useDefaults = payload?.useDefaults === true;
      const incoming = Array.isArray(payload?.answers) ? payload.answers : [];
      let updated;
      try {
        updated = await store.update(id, (fresh) => {
          const intake = fresh.intake ?? { status: 'ready', questions: [], answers: [] };
          const remaining = [...(intake.questions ?? [])];
          const answers = [...(intake.answers ?? [])];
          const take = (question, value) => {
            if (!question) return;
            const resolved = String(value ?? '').trim() || question.default;
            if (!applyIntakeAnswer(fresh, question.field, resolved)) return;
            answers.push({ id: question.id, field: question.field, value: resolved, at: Date.now() });
          };
          if (useDefaults) {
            for (const question of remaining) take(question, question.default);
            remaining.length = 0;
          } else {
            for (const answer of incoming) {
              const index = remaining.findIndex((question) => question.id === String(answer?.id ?? ''));
              if (index < 0) continue;
              const [question] = remaining.splice(index, 1);
              take(question, answer?.value);
            }
          }
          intake.questions = remaining;
          intake.answers = answers;
          intake.at = Date.now();
          intake.status = remaining.length > 0 ? 'ready' : 'done';
          fresh.intake = intake;
          if (remaining.length === 0) event(fresh, { kind: 'intake-done', text: '导演确认完毕，可以开跑了' });
        });
      } catch {
        return fail('not-found', '项目不存在或已删除');
      }
      return ok({
        id,
        intake: updated.intake,
        project: {
          id: updated.id,
          title: updated.title,
          brief: updated.brief,
          targetSeconds: updated.targetSeconds,
          platform: updated.platform,
          aspect: updated.aspect,
        },
      });
    },

    async state(payload) {
      const id = String(payload?.id ?? '');
      if (!id) return fail('bad-request', '缺少项目 id');
      let project;
      try {
        project = await store.load(id);
      } catch {
        // 项目被删了 / 目录被人手动清了：这是一条可预期的结果，不该把 fs 报错糊到面板上。
        return fail('not-found', `项目不存在或已删除：${id}`);
      }
      const ref = project.reference ?? null;
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
          // 面板用 kind 判断「剧本模式」；原文不必整段传回，省得每次轮询都背几千字。
          source: project.source ? { kind: project.source.kind, at: project.source.at, chars: project.source.text.length } : null,
          intake: project.intake ?? null,
          stages: project.stages,
          chosenIdea: project.chosenIdea,
          pendingReview: project.pendingReview,
          running: project.running,
          reference: ref && !referenceJobs.has(id)
            && ['running', 'analyzing', 'fetching', 'framing', 'asr', 'rea', 'reviewing'].includes(ref.status)
            ? { ...ref, status: 'failed', error: '拉片已中断，请重新选择参考视频' }
            : ref
              // 老记录里可能存着整段上游日志：读的时候再压一次，面板只显示一句。
              ? { ...ref, error: ref.error ? compactMessage(ref.error, { max: 600 }) : null }
              : null,
          finalFile: project.finalFile ?? project.stages.edit?.finalFile ?? null,
          coverFile: project.coverFile ?? project.stages.edit?.coverFile ?? null,
          // 事件日志里的报错同样压一句：不然几百行的命令行会整段铺在面板上。
          events: (project.events ?? []).slice(-80).map((entry) => ({
            ...entry,
            text: entry.text ? compactMessage(entry.text, { max: 400 }) : entry.text,
          })),
          updatedAt: project.updatedAt,
        },
        artifacts,
        render,
        runtime: runtimeInfo(),
        dir: store.dirOf(project.id),
      });
    },

    async updateBrief(payload) {
      const id = String(payload?.id ?? '');
      const patch = payload?.brief ?? {};
      const project = await store.update(id, (fresh) => {
        fresh.brief = { ...fresh.brief, ...patch, hotspots: Array.isArray(patch.hotspots) ? patch.hotspots.slice(0, 30) : fresh.brief.hotspots };
        // 枚举字段在入口处归一，别让脏值进项目文件（tool 的 enum 只约束调用方）。
        if (patch.projectMode) fresh.brief.projectMode = patch.projectMode === 'story' ? 'story' : 'promotion';
        if (patch.audioMode) fresh.brief.audioMode = patch.audioMode === 'no-dialogue' ? 'no-dialogue' : 'dialogue';
        if (payload?.aspect) fresh.aspect = String(payload.aspect);
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
      startReferenceJob(project, {
        url,
        localPath,
        advanced: payload?.advanced !== false,
        ...parseReferenceWindowInput(payload),
      });
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
      let project = await store.load(id);
      if (jobs.has(id)) return fail('busy', '这个项目正在跑');
      const gate = await ensureIntake(project, { assumeDefaults: payload?.assumeDefaults === true });
      if (!gate.ok) return gate;
      // 确认过程会改画像/时长：重新读一次再开跑。
      project = await store.load(id);
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

    /**
     * 删项目：目录 + 关联记录（复核通知 / 运行队列）一起清。
     * 只删目录不动记录 = 项目没了但 inbox 里还留着它的复核条目，看起来就是「删了还有数据」。
     */
    async remove(payload) {
      const id = String(payload?.id ?? '');
      if (!/^cs_[A-Za-z0-9_-]+$/.test(id)) return fail('bad-request', '项目 id 不合法');
      if (jobs.has(id)) return fail('busy', '这个项目还在跑，等这一轮跑完再删');
      if (referenceJobs.has(id)) return fail('busy', '这条还在拉片，等它跑完再删');
      try {
        await store.remove(id);
      } catch (error) {
        log(`删除项目失败（${id}）：`, error);
        return fail('locked', friendlyError(error, '删除失败：文件可能正被别的程序占用'));
      }
      const purged = await traces.purge(id).catch((error) => {
        log(`清理关联记录失败（${id}）：${error.message}`);
        return { inbox: 0, queue: 0 };
      });
      log(`已删除项目 ${id}；清掉复核记录 ${purged.inbox} 条 / 队列 ${purged.queue} 条`);
      return ok({ removed: id, purged });
    },

    /** 一键清空：所有创意项目 + 拉片记录 + 关联队列。正在跑的项目跳过，不硬删。 */
    async removeAll() {
      const rows = await store.list();
      const removed = [];
      const skipped = [];
      for (const row of rows) {
        if (jobs.has(row.id) || referenceJobs.has(row.id)) {
          skipped.push({ id: row.id, title: row.title, reason: '正在跑，跑完再清' });
          continue;
        }
        try {
          await store.remove(row.id);
          removed.push(row.id);
        } catch (error) {
          log(`清空时删除失败（${row.id}）：`, error);
          skipped.push({ id: row.id, title: row.title, reason: friendlyError(error, '删除失败') });
        }
      }
      const purged = await traces.purge(removed).catch(() => ({ inbox: 0, queue: 0 }));
      // 没删掉的（被占用）留着它们的记录；顺带把指向「已经不存在的项目」的旧残留一起收掉。
      await traces.sweep(skipped.map((item) => item.id)).catch(() => {});
      log(`清空全部：删掉 ${removed.length} 个，跳过 ${skipped.length} 个；清掉复核 ${purged.inbox} 条 / 队列 ${purged.queue} 条`);
      return ok({ removed, skipped, purged });
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
      let project;
      try {
        project = await store.load(id);
      } catch {
        return fail('not-found', '项目不存在或已删除');
      }
      let file;
      if (kind === 'final') file = project.finalFile ?? project.stages.edit?.finalFile;
      else if (kind === 'cover') file = project.coverFile ?? project.stages.edit?.coverFile;
      else if (kind === 'segment') {
        const task = (project.stages.render?.artifact?.tasks ?? []).find((row) => String(row.segmentId) === String(payload?.segmentId));
        file = task?.file;
      } else if (kind === 'portrait') {
        const characters = await store.artifact(project, 'characters');
        file = (characters?.characters ?? []).find((row) => row.name === String(payload?.name))?.portrait?.file;
      } else if (kind === 'voice') {
        file = (project.stages.voice?.audio?.lines ?? []).find((row) => String(row.beatId) === String(payload?.beatId))?.file;
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
        // 项目目录被删掉（或被人手动清理）是常见情况：给一条能懂的 not-found，
        // 面板据此清掉选中项，而不是把 ENOENT 的原文怼在页面上。
        if (error?.code === 'ENOENT') {
          return sendJson(res, 404, fail('not-found', '项目不存在或已删除，刷新一下列表'));
        }
        log(`${endpoint} 失败：`, error);
        return sendJson(res, 500, fail('internal', friendlyError(error, '操作失败，请重试')));
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
        } else if (kind === 'voice') {
          const beatId = url.searchParams.get('beatId') ?? '';
          file = (project.stages.voice?.audio?.lines ?? []).find((row) => String(row.beatId) === beatId)?.file;
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
      '在创意工作台新建项目。最省事的用法：只给 idea（一句话想法）或 script（整段剧本），别的一概不用填。建好后会自动让导演读一遍，返回 1–4 个带默认值的问题；用 creative_studio_intake 逐条回答（或 useDefaults:true 全收），再 creative_studio_run 开跑。也可以直接给结构化画像字段。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        idea: { type: 'string', description: '一句话想法（最常用）：想拍什么、给谁看，说人话就行' },
        script: { type: 'string', description: '整段剧本原文：按场次/台词贴进来，剧情会按原样拍' },
        productName: { type: 'string', description: '产品名 / 作品名；有 idea 或 script 时可以省略（导演会读出来）' },
        title: { type: 'string', description: '项目名；省略则按想法首句自动生成' },
        category: { type: 'string', description: '品类，例如「地方小吃到店体验」' },
        audience: { type: 'string', description: '目标人群' },
        sellingPoints: { type: 'array', items: { type: 'string' }, description: '核心卖点，逐条写' },
        tone: { type: 'string', description: '调性，例如「克制的温情，不要叫卖」' },
        priceBand: { type: 'string', description: '价格带，例如「15–25 元」；会进创意与分镜提示词' },
        forbidden: { type: 'array', items: { type: 'string' }, description: '客户禁用词' },
        projectMode: { type: 'string', enum: ['promotion', 'story'], description: '制作类型：promotion 推广片（默认）/ story 剧情短片（不要求销售对象）' },
        audioMode: { type: 'string', enum: ['dialogue', 'no-dialogue'], description: '声音形式：dialogue 有台词（默认）/ no-dialogue 无台词（跳过配音方案）' },
        targetSeconds: { type: 'integer', minimum: 10, maximum: 180, description: '目标时长（秒），默认 45' },
        platform: { type: 'string', enum: ['douyin', 'shipinhao', 'xiaohongshu', 'bilibili'], description: '投放平台，默认 douyin' },
        aspect: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '4:5', '5:4'], description: '画幅；省略则用全局配置' },
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
    timeoutMs: 180_000,
    async execute(args) {
      const rawText = String(args.script ?? args.idea ?? '').trim();
      const sourceKind = args.script ? 'script' : 'idea';
      if (!rawText && !String(args.productName ?? '').trim()) {
        throw new Error('给一句话想法（idea）、一段剧本（script），或至少一个产品名');
      }
      const seconds = Number(args.targetSeconds) || 45;
      const title = String(args.title ?? '').trim()
        || String(args.productName ?? '').trim()
        || (rawText ? titleFromText(rawText) : `新项目 · ${seconds} 秒`);
      const project = newProject({
        title,
        platform: args.platform,
        targetSeconds: args.targetSeconds,
        aspect: args.aspect || options.aspectRatio,
        resolution: options.resolution,
        brief: {
          productName: args.productName,
          category: args.category,
          audience: args.audience,
          sellingPoints: args.sellingPoints,
          tone: args.tone,
          priceBand: args.priceBand,
          forbidden: args.forbidden,
          projectMode: args.projectMode,
          audioMode: args.audioMode,
          hotspots: (args.hotspots ?? []).map((hotspot) => ({ title: String(hotspot.title ?? ''), source: String(hotspot.source ?? '手动'), heat: hotspot.heat ?? null })),
        },
        source: rawText ? { kind: sourceKind, text: rawText } : null,
      });
      project.autoTitle = !String(args.title ?? '').trim();
      await store.save(project);
      event(project, { kind: 'create', text: rawText ? `项目已创建：读的是用户给的${sourceKind === 'script' ? '剧本' : '想法'}，先让导演确认` : '项目已创建（Agent）' });
      await store.save(project);

      // 有原文就直接让导演读：宿主拿到的不是一张空表，而是一组带默认值的问题。
      let intake = null;
      if (rawText) {
        const read = await handlers.intake({ id: project.id });
        if (read.ok) intake = read.value.intake;
        else intake = { status: 'failed', error: read.error.message, questions: [], summary: '' };
      }
      const fresh = await store.load(project.id).catch(() => project);
      return {
        id: project.id,
        dir: store.dirOf(project.id),
        title: fresh.title,
        targetSeconds: fresh.targetSeconds,
        sourceKind: rawText ? sourceKind : null,
        brief: fresh.brief,
        intake,
      };
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const lines = [`项目已建：${value.id}`, `目录：${value.dir}`];
        if (value.sourceKind === 'script') lines.push('模式：剧本（跳过创意发散，按原台词整理剧情）');
        const intake = value.intake;
        if (intake?.summary) lines.push(`导演理解：${intake.summary}`);
        if (intake?.status === 'failed') lines.push(`⚠ 导演没读懂：${intake.error}`);
        const questions = intake?.questions ?? [];
        if (questions.length > 0) {
          lines.push('', '需要你确认（每条都有推荐值，可以一句「都用默认」）：');
          for (const [index, question] of questions.entries()) {
            const options = (question.options ?? []).map((option) => (option.value === question.default ? `【${option.label}】` : option.label)).join(' / ');
            lines.push(`${index + 1}. ${question.question}${options ? `（${options}）` : ''} — 推荐：${question.default}`);
          }
          lines.push('', '下一步：creative_studio_intake（传 answers 或 useDefaults:true）→ creative_studio_run');
        } else if (intake && intake.status !== 'failed') {
          lines.push('', '导演没有要问的。下一步：creative_studio_run');
        } else if (intake?.status === 'failed') {
          lines.push('', '导演没读懂这段素材：可以让用户补一句，或直接 creative_studio_new 再给一版更具体的想法/剧本');
        } else {
          lines.push('', '下一步：creative_studio_run');
        }
        return textBlocks(lines.join('\n'));
      },
    },
  };

  const intakeTool = {
    name: 'creative_studio_intake',
    description:
      '查看或回答创意工作台的「导演确认」问题。不传 answers 就返回当前还待确认的问题；传 answers（[{id,value}]）逐条回答，或 useDefaults:true 一次收下所有推荐值。答完 creative_studio_run 才会开跑。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '项目 id' },
        answers: {
          type: 'array',
          description: '逐条回答：id 是问题 id，value 是选项 value 或自由文本；省略则沿用该问题的推荐值',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: { id: { type: 'string' }, value: { type: 'string' } },
          },
        },
        useDefaults: { type: 'boolean', description: 'true = 剩下所有问题都按推荐值收下' },
      },
    },
    timeoutMs: 180_000,
    async execute(args) {
      const id = String(args?.id ?? '');
      let project;
      try {
        project = await store.load(id);
      } catch {
        return { error: '项目不存在或已删除' };
      }
      let intake = project.intake;
      // 还没读过（或上次读失败）先让导演读一遍，别让调用方自己拼流程。
      if (project.source?.text && (!intake || intake.status === 'idle' || intake.status === 'failed')) {
        const read = await handlers.intake({ id });
        if (!read.ok) return { error: read.error.message, id };
        intake = read.value.intake;
      }
      if (Array.isArray(args?.answers) || args?.useDefaults === true) {
        const answered = await handlers.intakeAnswer({ id, answers: args.answers, useDefaults: args.useDefaults === true });
        if (!answered.ok) return { error: answered.error.message, id };
        intake = answered.value.intake;
      }
      const fresh = await store.load(id).catch(() => project);
      return {
        id,
        status: intake?.status ?? 'idle',
        summary: intake?.summary ?? '',
        questions: intake?.questions ?? [],
        brief: fresh.brief,
        targetSeconds: fresh.targetSeconds,
        platform: fresh.platform,
      };
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value.error) return textBlocks(`✗ ${value.error}`);
        const lines = [`${value.id}｜导演确认：${value.status}`];
        if (value.summary) lines.push(`理解：${value.summary}`);
        const questions = value.questions ?? [];
        if (questions.length === 0) {
          lines.push('没有待确认的问题了。下一步：creative_studio_run');
        } else {
          lines.push('', '还差这些（回答时把 id 一起带上）：');
          for (const [index, question] of questions.entries()) {
            const options = (question.options ?? []).map((option) => `${option.label}=${option.value}`).join(' / ');
            lines.push(`${index + 1}. [${question.id}] ${question.question}${options ? `（${options}）` : ''} — 推荐：${question.default}`);
          }
        }
        return textBlocks(lines.join('\n'));
      },
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
        return { projects: projects.slice(0, 10).map((row) => ({ id: row.id, title: row.title, doneStages: row.doneStages, totalStages: row.totalStages, pendingReview: row.pendingReview ? row.pendingReview.stageLabel : null, intakePending: row.intakePending ?? 0, running: row.running?.stage ?? null, updatedAt: row.updatedAt })) };
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
        sourceKind: project.source?.kind ?? null,
        // 还没确认完的项目：宿主和面板都要能直接看到还差哪几问。
        intake: project.source
          ? { status: project.intake?.status ?? 'idle', summary: project.intake?.summary ?? '', questions: project.intake?.questions ?? [] }
          : null,
        stages,
        pendingReview: project.pendingReview ?? null,
        finalFile: project.finalFile ?? project.stages.edit?.finalFile ?? null,
        runtime: runtimeInfo(),
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
          const lines = value.projects.map((row) => `${row.id}｜${row.title}｜${row.doneStages}/${row.totalStages} 阶段${row.running ? `｜正在跑 ${row.running}` : ''}${row.pendingReview ? `｜⚠ 待复核：${row.pendingReview}` : ''}${row.intakePending ? `｜⏳ 待确认 ${row.intakePending} 个问题` : ''}`);
          return textBlocks(lines.join('\n') || '还没有项目');
        }
        const lines = [`${value.title}（${value.id}）`];
        if (value.intake && value.intake.status !== 'done') {
          lines.push(`⏳ 导演确认：${value.intake.status}${value.intake.summary ? `｜${value.intake.summary}` : ''}`);
          for (const question of value.intake.questions ?? []) {
            const options = (question.options ?? []).map((option) => `${option.label}=${option.value}`).join(' / ');
            lines.push(`   [${question.id}] ${question.question}${options ? `（${options}）` : ''} — 推荐：${question.default}`);
          }
          if ((value.intake.questions ?? []).length > 0) lines.push('   先答完（creative_studio_intake），再 creative_studio_run');
        }
        for (const stage of value.stages ?? []) {
          const flag = stage.status === 'done' ? '✓' : stage.status === 'needs_review' ? '⚠' : stage.status === 'failed' ? '✗' : '·';
          lines.push(`${flag} ${stage.label}｜${stage.status}${stage.attempts > 1 ? `（第 ${stage.attempts} 版）` : ''}${stage.score !== null ? `｜审核 ${stage.score}` : ''}${stage.error ? `｜${stage.error}` : ''}`);
          for (const failure of stage.failures ?? []) lines.push(`   门禁：${failure}`);
          for (const issue of stage.issues ?? []) lines.push(`   待修：${issue}`);
        }
        if (value.pendingReview) lines.push(`⚠ 待人工复核：${value.pendingReview.stageLabel}｜${value.pendingReview.reason}`);
        if (value.runtime) {
          const llm = value.runtime.llm ? `${value.runtime.llm.provider} / ${value.runtime.llm.model}` : '（读不到）';
          lines.push(`使用：模型 ${llm}｜视频 ${value.runtime.video?.model ?? ''}｜生图 ${value.runtime.image?.backend ?? ''}`);
        }
        if (value.finalFile) lines.push(`成片：${value.finalFile}`);
        return textBlocks(lines.join('\n'));
      },
    },
  };

  const runTool = {
    name: 'creative_studio_run',
    description:
      '跑创意工作台的流水线。不传 stage 就从第一个未完成阶段往下跑（含出片与成片剪辑）；传 stage 就从该阶段重跑。项目有想法/剧本但导演还没确认完时，这里不会硬跑：会返回 needIntake 和待确认问题，先用 creative_studio_intake 回答（或传 assumeDefaults:true 全部收下）。生产、剪辑、审核三个 Agent 会自动串起来，质量不过自动打回重做；重试用完仍不过会停下来，把项目标成待人工复核。出片与剪辑是长任务，工具会等到这一轮跑完或停在待复核。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '项目 id' },
        stage: { type: 'string', enum: ['idea', 'story', 'storyboard', 'characters', 'voice', 'render', 'edit'], description: '从这个阶段开始跑；省略则从第一个未完成阶段开始' },
        note: { type: 'string', description: '给生产 Agent 的额外要求（例如「第三镜改成夜戏」）' },
        only: { type: 'boolean', description: '只跑 stage 这一个阶段就停（step-by-step 用）；省略则从该阶段一路跑到成片' },
        assumeDefaults: { type: 'boolean', description: '导演确认的问题全部按推荐值收下再开跑（省一轮对话）' },
        wait: { type: 'boolean', description: '为 false 时立刻返回，进度用 creative_studio_status 查（默认等）' },
      },
    },
    timeoutMs: 3_600_000,
    async execute(args) {
      const id = String(args.id);
      const project = await store.load(id);
      // 想法/剧本还没确认完：先把问题交回去，别一路跑到底。
      const gate = await ensureIntake(project, { assumeDefaults: args.assumeDefaults === true });
      if (!gate.ok) {
        const intake = gate.error.details?.intake ?? null;
        return {
          needIntake: true,
          id,
          title: project.title,
          message: gate.error.message,
          summary: intake?.summary ?? '',
          questions: intake?.questions ?? [],
        };
      }
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
        if (value.needIntake) {
          const lines = [`${value.title ?? ''}｜${value.id ?? ''}`, `要先确认才能开跑：${value.message}`];
          if (value.summary) lines.push(`导演理解：${value.summary}`);
          for (const [index, question] of (value.questions ?? []).entries()) {
            const options = (question.options ?? []).map((option) => `${option.label}=${option.value}`).join(' / ');
            lines.push(`${index + 1}. [${question.id}] ${question.question}${options ? `（${options}）` : ''} — 推荐：${question.default}`);
          }
          lines.push('', '用 creative_studio_intake 回答（或 assumeDefaults:true 全部收下）');
          return textBlocks(lines.join('\n'));
        }
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
      '（创意工作台内置）生成一张图并保存到本机，返回路径；可直接作为 h3_generate_video 的首帧/尾帧。默认走「生图工作台」里配置的接口（Base URL / Key / 图片模型），读不到时退回本机 Codex 的 image_generation，再退回插件自己配置的 OpenAI 兼容端点。',
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
        startSeconds: { type: 'integer', minimum: 0, description: '长视频从第几秒开始截高光段；省略用配置 referenceStartSeconds（默认 0）' },
        durationSeconds: { type: 'integer', minimum: 0, description: '只拆多少秒；省略用配置 referenceMaxSeconds（默认 120）。长视频会先截这一段再拆' },
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
      await runReferenceJob(project, { ...source, ...parseReferenceWindowInput(args) });
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
        window: ref.window ?? null,
        originalDuration: ref.originalDuration ?? null,
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
            value.window
              ? `原片 ${Math.round((value.originalDuration ?? 0) / 60)} 分钟，只拆了 ${Math.floor(value.window.start / 60)}:${String(value.window.start % 60).padStart(2, '0')} 起的 ${value.window.seconds} 秒`
              : '',
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
        priceBand: { type: 'string', description: '价格带，例如「15–25 元」' },
        forbidden: { type: 'array', items: { type: 'string' } },
        projectMode: { type: 'string', enum: ['promotion', 'story'], description: '制作类型：promotion 推广片 / story 剧情短片' },
        audioMode: { type: 'string', enum: ['dialogue', 'no-dialogue'], description: '声音形式：dialogue 有台词 / no-dialogue 无台词' },
        aspect: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '4:5', '5:4'], description: '画幅（项目级，不是 brief）' },
        extra: { type: 'string', description: '补充要求（会进创意与分镜的提示词）' },
      },
    },
    timeoutMs: 60_000,
    async execute(args) {
      const result = await handlers.updateBrief({
        id: args.id,
        title: args.title,
        targetSeconds: args.targetSeconds,
        aspect: args.aspect,
        brief: {
          productName: args.productName,
          category: args.category,
          audience: args.audience,
          sellingPoints: args.sellingPoints,
          tone: args.tone,
          priceBand: args.priceBand,
          forbidden: args.forbidden,
          projectMode: args.projectMode,
          audioMode: args.audioMode,
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
      ctx.tools.register(intakeTool),
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
