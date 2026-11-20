/**
 * 出片后端：把两套已经验证过的接口收在同一个引擎后面。
 *
 * - easyframe：EasyFrame MiniMax-H3（文生 / 首帧 / 首尾帧 / 多参考），支持 9 种画幅与模型档位。
 * - mnmx：鼠鼠工具的 MiniMax H3 v2（文生），按积分计费。
 *
 * 默认 auto：先用 easyframe，遇到鉴权 / 额度 / 维护 / 网络这类「换一家还能试」的错误再退到 mnmx。
 * 提交成功之后不再换后端——同一段的查询和下载必须回到提交它的那一家。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

/**
 * 找本机 Codex 命令行（Codex 桌面版自带 codex.exe）。版本号会随更新变化，所以按前缀找最新的。
 * 也可以用 CODEX_BIN 或插件配置 codexCmd 指定。
 */
export function findCodex() {
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  // Codex 自己的配置里记着 CLI 的真实路径（版本号变了也不用改插件）。
  try {
    const cfg = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8');
    const match = /CODEX_CLI_PATH\s*=\s*(['"])(.+?)\1/.exec(cfg);
    if (match && existsSync(match[2])) return match[2];
  } catch {
    /* 没装 Codex 就是没有 */
  }
  // 再试 WindowsApps（这个目录通常不允许枚举，试一下不吃亏）。
  const base = 'C:\\Program Files\\WindowsApps';
  try {
    const dirs = readdirSync(base)
      .filter((name) => name.startsWith('OpenAI.Codex_'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const dir of dirs) {
      const exe = join(base, dir, 'app', 'resources', 'codex.exe');
      if (existsSync(exe)) return exe;
    }
  } catch {
    /* 没权限：交给 codexCmd 配置 */
  }
  return '';
}

const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '4:5', '5:4'];
/** 鼠鼠工具要整串画幅名，EasyFrame 要简写。 */
const MNMX_ASPECTS = {
  '16:9': '16:9 (Widescreen)',
  '9:16': '9:16 (Portrait Widescreen)',
  '1:1': '1:1 (Square)',
  '4:3': '4:3 (Standard)',
  '3:4': '3:4 (Portrait Standard)',
  '21:9': '21:9 (Ultrawide)',
};
const MNMX_RESOLUTIONS = { '480p': '0.4', '720p': '1', '1080p': '2' };
/** EasyFrame 公开单价（元/秒），只用于面板与工具估算。 */
const PRICES = {
  'minimax-h3-mini': { '480p': 0.04, '720p': 0.05 },
  'minimax-h3-fast': { '480p': 0.05, '720p': 0.05 },
  'minimax-h3-base': { '480p': 0.07, '720p': 0.07 },
};
const MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 带 .code 的错误：上层据此决定「换后端」还是「直接失败」。 */
function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function classify(status, body, fallback) {
  const message = String(
    body?.message ?? body?.error?.message ?? (typeof body?.error === 'string' ? body.error : '') ?? fallback ?? `HTTP ${status}`,
  ).slice(0, 400);
  if (status === 401 || status === 403) return providerError('auth', `鉴权失败（${status}）：${message}`);
  if (status === 402) return providerError('quota', `额度不足（402）：${message}`);
  if (status === 429) return providerError('rate', `限速或并发上限（429）：${message}`);
  if (status === 502 || status === 503 || status === 504) return providerError('maintenance', `上游不可用（${status}）：${message}`);
  if (status >= 500) return providerError('server', `上游错误（${status}）：${message}`);
  return providerError('bad-request', `请求被拒（${status}）：${message}`);
}

/** 通用 HTTP 请求（重定向、超时、二进制响应）。 */
function request(urlString, { method = 'GET', headers = {}, body, timeout = 120_000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          request(next, { method, headers, body, timeout, redirects: redirects - 1 }).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeout, () => req.destroy(providerError('network', `请求超时（${Math.round(timeout / 1000)}s）：${url.host}`)));
    req.on('error', (err) => reject(providerError('network', `连不上 ${url.host}：${err.message}`)));
    if (body) req.write(body);
    req.end();
  });
}

const parseJson = (buffer) => {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
};

function buildMultipart(fields, files) {
  const boundary = `----creative${randomBytes(6).toString('hex')}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  files.forEach((file, index) => {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="${file.name || `image${index + 1}.png`}"\r\nContent-Type: ${file.mime || 'image/png'}\r\n\r\n`,
        'utf8',
      ),
    );
    chunks.push(file.buffer);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  });
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}

/** 关键帧模式要放在提示词首行的对齐指令（EasyFrame 的硬要求）。 */
export function alignLine(mode, seconds) {
  const end = Number(seconds).toFixed(2);
  if (mode === 'i2va') return 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
  if (mode === 'fl2va') {
    return `How the reference pictures align with the target video — Picture 1 (from [Shot 1]) aligns with the 0.00-second mark of the target video; Picture 2 (from [Shot 1]) aligns with the ${end}-second mark of the target video.`;
  }
  if (mode === 'l2va') return `How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the ${end}-second mark of the target video.`;
  return '';
}

export function mimeOf(file) {
  const ext = String(file ?? '').slice(String(file ?? '').lastIndexOf('.')).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

export const priceOf = (model, resolution) => PRICES[model]?.[resolution] ?? 0.05;

/**
 * 独立出片任务的持久化索引（原来的 video-h3 面板与 h3_* 工具用的就是这套）。
 * 存在 <dataDir>/video-tasks.json；重载插件后历史任务和成品路径都还在。
 */
export function createVideoTaskStore({ file, log = () => {} }) {
  let loaded = null;
  const tasks = new Map();

  const load = async () => {
    if (loaded) return loaded;
    loaded = (async () => {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tasks) ? parsed.tasks : [];
        for (const record of list) {
          if (!record?.id) continue;
          // 重启后不知道上游还在不在跑：交给下一次 status 刷新判定。
          if (['queued', 'in_progress', 'processing'].includes(record.status)) record.status = 'unknown';
          tasks.set(record.id, record);
        }
      } catch {
        /* 没有索引就是空的 */
      }
      return true;
    })();
    return loaded;
  };

  const save = async () => {
    await mkdir(dirname(file), { recursive: true });
    const list = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
    await writeFile(file, JSON.stringify({ tasks: list }, null, 2), 'utf8');
  };

  return {
    file,
    load,
    save,
    get: (id) => tasks.get(String(id)),
    list: () => [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt),
    set: (record) => tasks.set(record.id, record),
    async upsert(record) {
      tasks.set(record.id, record);
      await save().catch((error) => log(`任务索引写入失败：${error.message}`));
      return record;
    },
  };
}

/** 面板/工具用的任务视图。 */
export function taskView(record) {
  return {
    id: record.id,
    prompt: record.prompt,
    mode: record.mode,
    model: record.model,
    resolution: record.resolution,
    seconds: record.seconds,
    aspectRatio: record.aspectRatio,
    status: record.status,
    progress: record.progress ?? null,
    error: record.error ?? null,
    file: record.file ?? null,
    bytes: record.bytes ?? null,
    cost: record.cost ?? null,
    provider: record.provider ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt ?? null,
  };
}

export function createVideoEngine({ config = {}, log = () => {} }) {
  const easyframe = {
    name: 'easyframe',
    label: 'EasyFrame MiniMax-H3',
    base: String(config.easyframeBaseUrl ?? 'https://minimax.api.easyframe.cn').replace(/\/+$/, ''),
    key: String(config.easyframeApiKey ?? ''),
  };
  const mnmx = {
    name: 'mnmx',
    label: '鼠鼠工具 MiniMax H3',
    base: String(config.mnmxBaseUrl ?? 'https://www.runlive.top/mnmx').replace(/\/+$/, ''),
    key: String(config.mnmxCardKey ?? ''),
  };

  const order = () => {
    const preferred = String(config.videoProvider ?? 'auto');
    if (preferred === 'easyframe') return [easyframe];
    if (preferred === 'mnmx') return [mnmx];
    return [easyframe, mnmx];
  };

  // ---- EasyFrame ----
  async function easyframeSubmit({ prompt, mode, seconds, resolution, aspect, model, images }) {
    if (!easyframe.key) throw providerError('auth', '没有配置 EasyFrame API Key（easyframeApiKey）');
    const optimize = mode === 't2va' || mode === 'ref2va' ? Boolean(config.promptOptimization ?? true) : false;
    const firstLine = alignLine(mode, seconds);
    const promptText = firstLine ? `${firstLine}\n\n${prompt}` : prompt;
    // JSON 通道要真正的布尔与数字；multipart 通道只能塞字符串（上游按字符串解析）。
    const jsonFields = {
      model: String(model || config.videoModel || 'minimax-h3-mini'),
      mode,
      resolution,
      seconds: Number(seconds),
      aspect_ratio: aspect,
      prompt: promptText,
      prompt_optimization: optimize,
    };
    const stringFields = Object.fromEntries(Object.entries(jsonFields).map(([key, value]) => [key, String(value)]));
    let response;
    if (images.length > 0) {
      const mp = buildMultipart(stringFields, images);
      response = await request(`${easyframe.base}/v1/videos`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${easyframe.key}`,
          'content-type': `multipart/form-data; boundary=${mp.boundary}`,
          'content-length': mp.body.length,
        },
        body: mp.body,
        timeout: 180_000,
      });
    } else {
      const body = Buffer.from(JSON.stringify(jsonFields), 'utf8');
      response = await request(`${easyframe.base}/v1/videos`, {
        method: 'POST',
        headers: { authorization: `Bearer ${easyframe.key}`, 'content-type': 'application/json; charset=utf-8', 'content-length': body.length },
        body,
        timeout: 120_000,
      });
    }
    const payload = parseJson(response.body);
    if (response.status >= 300 || !payload) throw classify(response.status, payload, response.body.toString('utf8').slice(0, 300));
    if (payload.code && !payload.id) throw providerError('bad-request', String(payload.message ?? payload.code));
    if (!payload.id) throw providerError('bad-request', '上游没有返回任务 ID');
    return { taskId: String(payload.id), provider: 'easyframe' };
  }

  async function easyframeStatus(taskId) {
    const response = await request(`${easyframe.base}/v1/videos/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${easyframe.key}` },
      timeout: 45_000,
    });
    const payload = parseJson(response.body);
    if (response.status >= 300 || !payload) throw classify(response.status, payload, '查询任务失败');
    const status = String(payload.status ?? 'unknown').toLowerCase();
    const rawError = payload.error?.message ?? payload.message ?? null;
    return {
      status,
      progress: typeof payload.progress === 'number' ? payload.progress : null,
      url: payload.url ?? payload.result_url ?? null,
      error: status === 'failed' ? String(rawError ?? '生成失败') : null,
    };
  }

  // ---- 鼠鼠工具 ----
  async function mnmxSubmit({ prompt, seconds, resolution, aspect }) {
    if (!mnmx.key) throw providerError('auth', '没有配置鼠鼠工具卡密钥（mnmxCardKey）');
    if (!MNMX_ASPECTS[aspect]) throw providerError('bad-request', `鼠鼠工具不支持画幅 ${aspect}`);
    const form = new FormData();
    form.append('task_name', 'minimax_h3_v2');
    form.append('prompt', prompt);
    form.append('resolution', MNMX_RESOLUTIONS[resolution] ?? '1');
    form.append('duration', String(seconds));
    form.append('aspect_ratio', MNMX_ASPECTS[aspect]);
    const response = await fetch(`${mnmx.base}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'X-Card-Key': mnmx.key },
      body: form,
    });
    const payload = parseJson(Buffer.from(await response.arrayBuffer()));
    if (response.status !== 202 && response.status !== 200) throw classify(response.status, payload, '提交失败');
    const taskId = payload?.data?.task_id;
    if (!taskId) throw providerError('bad-request', '提交响应里没有 task_id');
    return { taskId: String(taskId), provider: 'mnmx' };
  }

  async function mnmxStatus(taskId) {
    const response = await fetch(`${mnmx.base}/api/v1/tasks/${encodeURIComponent(taskId)}`, { headers: { 'X-Card-Key': mnmx.key } });
    if (response.status === 404) return { status: 'failed', progress: null, url: null, error: '任务不存在或不属于这张卡' };
    const payload = parseJson(Buffer.from(await response.arrayBuffer()));
    if (response.status !== 200 || !payload) throw classify(response.status, payload, '查询任务失败');
    const data = payload.data ?? {};
    const raw = data.error ?? data.message ?? null;
    const error = raw === null ? null : typeof raw === 'string' ? raw : String(raw?.message ?? JSON.stringify(raw));
    return { status: String(data.status ?? 'unknown'), progress: data.progress ?? null, url: null, error };
  }

  const PROVIDERS = {
    easyframe: { info: easyframe, submit: easyframeSubmit, status: easyframeStatus, download: async (taskId) => {
      const response = await request(`${easyframe.base}/v1/videos/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${easyframe.key}` },
        timeout: 45_000,
      });
      const payload = parseJson(response.body);
      const url = payload?.url ?? payload?.result_url;
      if (!url) throw providerError('bad-request', '这一条还没给出下载地址');
      return url;
    } },
    mnmx: { info: mnmx, submit: mnmxSubmit, status: async (taskId) => {
      const state = await mnmxStatus(taskId);
      if (state.status === 'completed') {
        const response = await fetch(`${mnmx.base}/api/v1/tasks/${encodeURIComponent(taskId)}/file-url`, { headers: { 'X-Card-Key': mnmx.key } });
        const payload = parseJson(Buffer.from(await response.arrayBuffer()));
        state.url = payload?.data?.url ?? null;
      }
      return state;
    }, download: async (taskId) => {
      const response = await fetch(`${mnmx.base}/api/v1/tasks/${encodeURIComponent(taskId)}/file-url`, { headers: { 'X-Card-Key': mnmx.key } });
      const payload = parseJson(Buffer.from(await response.arrayBuffer()));
      const url = payload?.data?.url;
      if (!url) throw providerError('bad-request', '拿下载直链失败');
      // 鼠鼠工具需要 download=1 才返回文件体。
      return `${url}${url.includes('?') ? '&' : '?'}download=1`;
    } },
  };

  const isSwitchable = (error) => ['auth', 'quota', 'maintenance', 'network', 'rate', 'server'].includes(String(error?.code));

  return {
    providers: () => order().map((provider) => provider.name),
    hasImage: Boolean(config.imageKey) || Boolean(config.codexCmd || findCodex()),

    /** 提交一段。auto 模式下按顺序换后端，但只在「换一家还有救」的错误上换。 */
    async submit({ prompt, mode = 't2va', seconds = 5, resolution = '720p', aspect = '9:16', model, images = [] }) {
      const candidates = order();
      const failures = [];
      for (const candidate of candidates) {
        if (!candidate.key) {
          failures.push(`${candidate.label}：没有配置密钥`);
          continue;
        }
        try {
          const result = await PROVIDERS[candidate.name].submit({ prompt, mode, seconds, resolution, aspect, model, images });
          log(`[video] ${candidate.name} 受理 ${result.taskId}（${mode}/${seconds}s/${resolution}/${aspect}）`);
          return { ...result, label: candidate.label };
        } catch (error) {
          failures.push(`${candidate.label}：${error.message}`);
          log(`[video] ${candidate.name} 提交失败：${error.message}`);
          if (!isSwitchable(error)) {
            throw providerError(error.code ?? 'bad-request', failures.join('；'));
          }
        }
      }
      throw providerError('all-failed', failures.join('；') || '没有可用的出片后端');
    },

    async status({ taskId, provider }) {
      const impl = PROVIDERS[provider];
      if (!impl) throw providerError('bad-request', `未知后端 ${provider}`);
      return impl.status(taskId);
    },

    /** 等到一个任务出结果；completed 时顺手拿到下载地址。 */
    async wait({ taskId, provider, deadline = 30 * 60 * 1000, onTick = () => {} }) {
      const started = Date.now();
      let last = { status: 'queued', progress: null, url: null, error: null };
      while (Date.now() - started < deadline) {
        await sleep(8000);
        try {
          last = await this.status({ taskId, provider });
        } catch (error) {
          // 轮询失败不当成任务失败：记一 tick 继续等。
          last = { ...last, error: error.message };
          onTick(last);
          continue;
        }
        onTick(last);
        if (['completed', 'failed', 'cancelled'].includes(String(last.status))) return last;
      }
      return { ...last, error: last.error ?? '等待超时（30 分钟）' };
    },

    /** 把成品落到本地；返回文件路径与字节数。直链原样取，签名 URL 不能加参数。 */
    async download({ taskId, provider, dir, filename }) {
      const impl = PROVIDERS[provider];
      if (!impl) throw providerError('bad-request', `未知后端 ${provider}`);
      const url = await impl.download(taskId);
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw providerError('network', `下载失败 HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) throw providerError('network', '下载到 0 字节');
      await mkdir(dir, { recursive: true });
      const file = join(dir, filename || `${taskId}.mp4`);
      await writeFile(file, bytes);
      return { file, bytes: bytes.length };
    },

    /**
     * 人物定妆图。两条后端：
     *  - codex：调用本机 Codex 的 image_generation（桌面版自带 codex.exe），按它的额度计费、单张约 40k tokens；
     *  - http：任意 OpenAI 兼容的 /images/generations（原来的号池）。
     * imageBackend: auto 有 Codex 就用 Codex，否则用 http。失败不算致命，人物阶段会记录并继续。
     */
    async generateImage({ prompt, model, size, dir, filename }) {
      const backend = String(config.imageBackend ?? 'auto');
      const codexCmd = config.codexCmd || findCodex();
      const useCodex = backend === 'codex' || (backend === 'auto' && codexCmd);
      if (useCodex) return codexImage({ prompt, dir, filename, cmd: codexCmd || config.codexCmd });
      if (!config.imageKey) throw providerError('auth', '没有配置生图 Key（imageKey），也没有可用的 Codex 命令行');
      const base = String(config.imageBaseUrl ?? '').replace(/\/+$/, '');
      if (!base) throw providerError('auth', '没有配置生图端点（imageBaseUrl）');
      const body = Buffer.from(JSON.stringify({ model: model || config.imageModel || 'gpt-image-2', prompt, size: size || config.imageSize || 'auto', n: 1 }), 'utf8');
      const response = await request(`${base}/images/generations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.imageKey}`, 'content-type': 'application/json; charset=utf-8', 'content-length': body.length },
        body,
        timeout: 300_000,
      });
      const payload = parseJson(response.body);
      if (response.status >= 300 || !payload) throw classify(response.status, payload, '生图失败');
      const item = Array.isArray(payload.data) ? payload.data[0] : null;
      if (!item) throw providerError('bad-request', '上游没有返回图片数据');
      await mkdir(dir, { recursive: true });
      const file = join(dir, filename || `img_${Date.now()}.png`);
      if (item.b64_json) await writeFile(file, Buffer.from(String(item.b64_json), 'base64'));
      else if (item.url) {
        const download = await fetch(String(item.url));
        if (!download.ok) throw providerError('network', `下载图片失败 HTTP ${download.status}`);
        await writeFile(file, Buffer.from(await download.arrayBuffer()));
      } else throw providerError('bad-request', '图片数据为空');
      return { file, model: model || config.imageModel };
    },
  };
}

/** 用本机 Codex 的 image_generation 生成一张图，落到目标路径。 */
async function codexImage({ prompt, dir, filename, cmd }) {
  const exe = cmd || findCodex();
  if (!exe) throw providerError('auth', '没找到 Codex 命令行：装好 Codex 桌面版，或配置 codexCmd');
  if (!existsSync(exe)) throw providerError('auth', `codexCmd 指向的文件不存在：${exe}`);
  await mkdir(dir, { recursive: true });
  const target = join(dir, filename || `img_${Date.now()}.png`);
  const startedAt = Date.now();
  const instruction = [
    `用 image_generation 工具生成这张图：${String(prompt ?? '').trim()}`,
    `生成后把 PNG 复制到 ${target}（覆盖同名文件），确认文件大小 > 10KB，然后只输出这个路径。`,
    '不要做其它任何事，不要读别的文件。',
  ].join('\n');
  await new Promise((resolvePromise, reject) => {
    // 提示词走 stdin（`-`），不用命令行参数：参数里带换行/中文时 Codex 容易误判成「还要读 stdin」。
    const child = spawn(exe, ['exec', '--skip-git-repo-check', '-C', dir, '-s', 'workspace-write', '-'], {
      cwd: dir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
      reject(providerError('server', 'Codex 生图超时（14 分钟）'));
    }, 840_000);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(providerError('server', `跑不了 Codex（${exe}）：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else reject(providerError('server', `Codex 生图失败（exit ${code}）：${String(stderr || stdout).slice(-400)}`));
    });
    child.stdin?.write(instruction);
    child.stdin?.end();
  });
  if (existsSync(target) && readFileStat(target) > 10 * 1024) return { file: target, model: 'codex-image-generation' };
  // 兜底：Codex 没照抄到目标路径时，从它的生成目录里找这次新出的 PNG。
  const found = newestCodexImage(startedAt);
  if (found) {
    await mkdir(dir, { recursive: true });
    await writeFile(target, await readFile(found));
    return { file: target, model: 'codex-image-generation' };
  }
  throw providerError('server', 'Codex 没有产出图片：检查 Codex 是否登录、image_generation 是否可用');
}

function readFileStat(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** 在 ~/.codex/generated_images 下找 startedAt 之后生成的最新 PNG。 */
function newestCodexImage(startedAt) {
  const root = join(process.env.USERPROFILE || '', '.codex', 'generated_images');
  if (!existsSync(root)) return '';
  let best = '';
  let bestTime = startedAt - 5_000;
  try {
    for (const session of readdirSync(root)) {
      const dir = join(root, session);
      for (const name of readdirSync(dir)) {
        if (!/\.png$/i.test(name)) continue;
        const file = join(dir, name);
        const time = statSync(file).mtimeMs;
        if (time >= bestTime && lookBig(file)) {
          best = file;
          bestTime = time;
        }
      }
    }
  } catch {
    return best;
  }
  return best;
}

function lookBig(file) {
  try {
    return statSync(file).size > 10 * 1024;
  } catch {
    return false;
  }
}

export { ASPECTS };
