/**
 * 创意工作台的项目仓库：一个项目一个目录，所有阶段产物都是人可读的文件。
 *
 *   <projectDir>/<id>/project.json   项目与阶段状态（唯一真相）
 *   <projectDir>/<id>/01-idea.json   创意 idea
 *   <projectDir>/<id>/02-story.json  故事剧情
 *   <projectDir>/<id>/03-storyboard.json  分镜（shot-contract 结构）
 *   <projectDir>/<id>/04-characters.json  人物六维 + 定妆图
 *   <projectDir>/<id>/05-voice.json  配音方案
 *   <projectDir>/<id>/06-edl.json    剪辑清单（剪辑团队 Agent 产出）
 *   <projectDir>/<id>/07-final.mp4   成片
 *   <projectDir>/<id>/review/*.json  每次审核的完整记录
 *
 * 这里不 import 任何 DSH 包，也不碰 ctx，方便脱离 Harness 单测。
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 阶段定义：顺序就是流水线顺序。 */
export const STAGES = [
  { id: 'idea', file: '01-idea.json', label: '创意 idea', agent: 'producer' },
  { id: 'story', file: '02-story.json', label: '故事剧情', agent: 'producer' },
  { id: 'storyboard', file: '03-storyboard.json', label: '分镜脚本', agent: 'producer' },
  { id: 'characters', file: '04-characters.json', label: '人物形象六维', agent: 'producer' },
  { id: 'voice', file: '05-voice.json', label: '配音方案', agent: 'producer' },
  { id: 'render', file: null, label: '分段出片', agent: 'producer' },
  { id: 'edit', file: '06-edl.json', label: '成片剪辑', agent: 'editor' },
];
export const STAGE_IDS = STAGES.map((stage) => stage.id);
export const STAGE_BY_ID = Object.fromEntries(STAGES.map((stage) => [stage.id, stage]));

/** 阶段状态机。running / needs_review 是暂停点，其余可以继续往下走。 */
export const STAGE_STATUS = {
  empty: '未开始',
  running: '进行中',
  done: '已完成',
  rework: '打回重做中',
  needs_review: '待人工复核',
  failed: '失败',
  skipped: '已跳过',
  interrupted: '已中断',
};

const emptyStage = () => ({
  status: 'empty',
  attempts: 0,
  artifact: null,
  gate: null,
  review: null,
  error: null,
  note: null,
  updatedAt: null,
});

export function newProject(input = {}) {
  const now = Date.now();
  const id = `cs_${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}_${Math.random().toString(36).slice(2, 7)}`;
  const project = {
    version: 1,
    id,
    kind: input.kind === 'reference' ? 'reference' : 'studio',
    title: String(input.title ?? '未命名项目').trim() || '未命名项目',
    createdAt: now,
    updatedAt: now,
    platform: String(input.platform ?? 'douyin'),
    targetSeconds: Math.max(10, Math.min(180, Math.round(Number(input.targetSeconds) || 45))),
    aspect: String(input.aspect ?? '9:16'),
    resolution: String(input.resolution ?? '720p'),
    brief: {
      productName: String(input.brief?.productName ?? '').trim(),
      category: String(input.brief?.category ?? '').trim(),
      audience: String(input.brief?.audience ?? '').trim(),
      sellingPoints: Array.isArray(input.brief?.sellingPoints) ? input.brief.sellingPoints.map(String) : [],
      tone: String(input.brief?.tone ?? '').trim(),
      priceBand: String(input.brief?.priceBand ?? '').trim(),
      forbidden: Array.isArray(input.brief?.forbidden) ? input.brief.forbidden.map(String) : [],
      hotspots: Array.isArray(input.brief?.hotspots) ? input.brief.hotspots.slice(0, 30) : [],
      extra: String(input.brief?.extra ?? '').trim(),
      audioMode: input.brief?.audioMode === 'no-dialogue' ? 'no-dialogue' : 'dialogue',
      projectMode: input.brief?.projectMode === 'story' ? 'story' : 'promotion',
    },
    /**
     * 用户塞进来的原始素材：一句话想法，或一整段剧本。
     * 导演 Agent 从它读画像；剧本模式下流水线跳过创意发散，按原台词结构化。
     */
    source: input.source?.text
      ? {
        kind: input.source.kind === 'script' ? 'script' : 'idea',
        text: String(input.source.text),
        at: now,
      }
      : null,
    /** 导演确认：问题不清楚就不开跑，但问题必须带着默认值，让人一句话答完。 */
    intake: {
      status: 'idle', // idle | running | ready | done | failed
      summary: '',
      questions: [],
      answers: [],
      at: null,
      error: null,
    },
    chosenIdea: null,
    stages: Object.fromEntries(STAGE_IDS.map((stage) => [stage, emptyStage()])),
    pendingReview: null,
    running: null,
    events: [],
  };
  return project;
}

export function event(project, entry) {
  project.events.push({ at: Date.now(), ...entry });
  // 事件只留最近 400 条，避免 project.json 无限膨胀。
  if (project.events.length > 400) project.events = project.events.slice(-400);
  project.updatedAt = Date.now();
}

export function createStore({ root, isRunning = () => false }) {
  const dirOf = (id) => join(root, String(id));
  const projectFile = (id) => join(dirOf(id), 'project.json');
  /** id -> Promise，串行化同一项目的写入，避免两个路由同时改一份 project.json。 */
  const locks = new Map();

  const withLock = async (id, fn) => {
    const previous = locks.get(id) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    locks.set(id, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(id) === tail) locks.delete(id);
    }
  };

  /** 写文件先写临时名再 rename：中途崩掉不会留下半份 JSON。 */
  const writeJson = async (file, value) => {
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, file);
  };

  return {
    root,
    dirOf,
    projectFile,

    async ensure() {
      await mkdir(root, { recursive: true });
    },

    async load(id) {
      const text = await readFile(projectFile(id), 'utf8');
      const project = JSON.parse(text);
      // 老项目没有这两个字段：补上默认值，读的时候按「没确认过」处理。
      if (!project.intake) project.intake = { status: 'idle', summary: '', questions: [], answers: [], at: null, error: null };
      if (!project.source) project.source = null;
      if (isRunning(id)) return project;
      // 重启后不认「进行中」：交给用户或下一次运行重新推。
      for (const stage of STAGE_IDS) {
        const record = project.stages?.[stage];
        if (['running', 'rework'].includes(record?.status)) {
          record.status = 'failed';
          record.error = '进程重启，这次运行中断了';
        }
      }
      project.running = null;
      return project;
    },

    async save(project, { pipeline = false } = {}) {
      return withLock(project.id, async () => {
        if (pipeline) {
          const latest = await this.load(project.id);
          project.reference = latest.reference;
          project.brief = latest.brief;
          project.title = latest.title;
          project.targetSeconds = latest.targetSeconds;
          project.updatedAt = Math.max(project.updatedAt, latest.updatedAt);
          const events = [...latest.events, ...project.events];
          project.events = [...new Map(events.map((entry) => [JSON.stringify(entry), entry])).values()]
            .sort((a, b) => a.at - b.at).slice(-400);
        }
        await mkdir(dirOf(project.id), { recursive: true });
        await writeJson(projectFile(project.id), project);
        return project;
      });
    },

    /** 读-改-写整个项目，同一项目串行。 */
    async update(id, mutate) {
      return withLock(id, async () => {
        const project = await this.load(id);
        const result = await mutate(project);
        project.updatedAt = Date.now();
        await mkdir(dirOf(id), { recursive: true });
        await writeJson(projectFile(id), project);
        return result ?? project;
      });
    },

    async list() {
      await mkdir(root, { recursive: true });
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const rows = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        try {
          const project = JSON.parse(await readFile(join(root, entry.name, 'project.json'), 'utf8'));
          const done = STAGE_IDS.filter((stage) => project.stages?.[stage]?.status === 'done').length;
          rows.push({
            id: project.id,
            kind: project.kind ?? 'studio',
            title: project.title,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            platform: project.platform,
            targetSeconds: project.targetSeconds,
            doneStages: done,
            totalStages: STAGES.length,
            pendingReview: project.pendingReview ?? null,
            running: isRunning(project.id) ? project.running ?? null : null,
            finalFile: project.finalFile ?? null,
            // 面板据此在列表上标「等你确认」：有想法，但导演的问题还没答完。
            intakePending: project.source && project.intake?.status !== 'done'
              ? (project.intake?.questions ?? []).length
              : 0,
            sourceKind: project.source?.kind ?? null,
          });
        } catch {
          // 不是项目目录 / JSON 坏了：跳过，不阻塞列表
        }
      }
      rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      return rows;
    },

    async artifact(project, stage) {
      const definition = STAGE_BY_ID[stage];
      if (!definition?.file) return null;
      try {
        return JSON.parse(await readFile(join(dirOf(project.id), definition.file), 'utf8'));
      } catch {
        return null;
      }
    },

    async writeArtifact(project, stage, artifact) {
      const definition = STAGE_BY_ID[stage];
      if (!definition?.file) return null;
      const file = join(dirOf(project.id), definition.file);
      await mkdir(dirOf(project.id), { recursive: true });
      await writeJson(file, artifact);
      return file;
    },

    async saveReview(project, stage, attempt, record) {
      const dir = join(dirOf(project.id), 'review');
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${stage}-${attempt}.json`);
      await writeJson(file, record);
      return file;
    },

    async stat(id, relative) {
      return stat(join(dirOf(id), relative));
    },

    /**
     * 删项目目录。Windows 上刚播完的视频、刚退出的 ffmpeg/浏览器可能还占着句柄，
     * 一次失败就把半个目录留在盘上——这里退几步再重试，失败时把系统错误码原样抛出，
     * 由上层翻译成人话（别把 EPERM 的堆栈丢给面板）。
     */
    async remove(id) {
      const dir = dirOf(id);
      let lastError = null;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
          return dir;
        } catch (error) {
          lastError = error;
          if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE'].includes(error?.code ?? '')) throw error;
          await new Promise((resolve) => setTimeout(resolve, 180 * attempt));
        }
      }
      throw lastError;
    },
  };
}
