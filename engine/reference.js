/**
 * 参考爆款：把一条已有的抖音视频拆成证据（视频 / 元数据 / 镜表 / 逐镜帧 / 联系表 / 台词）。
 *
 * 这里不重写拉片逻辑：直接调用 douyin-teardown 技能里已经验证过的三个脚本，
 * 和「分镜阶段直接用 shot-contract 的 check.mjs」是同一个思路——技能是唯一真相。
 *
 *   fetch.mjs  "<分享文案或链接>" "<目录>"   → video.mp4 / meta.json
 *   frames.mjs "<video.mp4>" "<目录>"        → shots.json / frames/*.jpg / contact-sheet.jpg / audio.wav
 *   asr.py     "<audio.wav>" "<transcript.json>" --model medium
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { compactMessage } from './errors.js';

const exec = (bin, argv, { timeout = 600_000, env } = {}) =>
  new Promise((resolve, reject) => {
    execFile(bin, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      if (error) {
        // 脚本自己会在输出里写中文的下一步（比如抖音要新鲜 cookie）：
        // 这里只把那几句带回来，别把整段命令行和上游日志塞进项目文件。
        const detail = compactMessage(`${stdout ?? ''}\n${stderr ?? ''}`, { max: 360 });
        reject(new Error(`${basename(bin)} 执行失败${detail ? `：${detail}` : `：${error.message}`}`));
        return;
      }
      resolve(String(stdout ?? ''));
    });
  });

const safeRead = async (file, fallback = null) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const clockText = (seconds) => {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  return `${String(minutes).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
};

export function createReference({ scriptsDir, nodePath, pythonPath, asrModel = 'medium', log = () => {} }) {
  const node = nodePath || process.execPath || 'node';
  const scripts = {
    fetch: join(scriptsDir, 'fetch.mjs'),
    frames: join(scriptsDir, 'frames.mjs'),
    asr: join(scriptsDir, 'asr.py'),
  };

  return {
    scriptsDir,
    available: () => existsSync(scripts.fetch) && existsSync(scripts.frames),

    /**
     * 长视频先截一段再拆：整片解码（尤其 AV1 1080p）会让切点扫描自己就跑满十分钟。
     * 直接重编码成 720p H.264，后面的切点/抽帧/转写都只处理这一小段。
     */
    async trim({ video, out, start = 0, seconds, ffmpegPath, onStage = () => {} }) {
      const from = Math.max(0, Number(start) || 0);
      const length = Number(seconds);
      if (!Number.isFinite(length) || length <= 0) throw new Error('截取时长必须大于 0 秒');
      if (!existsSync(video)) throw new Error(`找不到要截取的视频：${video}`);
      const ffmpeg = ffmpegPath || 'ffmpeg';
      onStage('trimming', `先截高光段 ${clockText(from)}–${clockText(from + length)}`);
      // 输入侧 -ss 走索引定位（AV1 也很快），只解码这一段。
      await exec(ffmpeg, [
        '-y', '-hide_banner', '-v', 'error',
        '-ss', String(from), '-i', video, '-t', String(length),
        // 只降不升：360p 的源不放大到 720p，白花编码时间。
        '-vf', 'scale=-2:min(720\\,ih)',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
        out,
      ], { timeout: 300_000 });
      if (!existsSync(out)) throw new Error('截取高光段失败：ffmpeg 没有生成文件');
      log(`[reference] 已截取高光段 ${clockText(from)}–${clockText(from + length)} → ${out}`);
      return { file: out, start: from, seconds: length };
    },

    /** 链接 → video.mp4 + meta.json。抖音可能要求新鲜 cookie，失败时把脚本的提示原样带回去。 */
    async fetch({ url, dir, onStage = () => {}, env }) {
      if (!existsSync(scripts.fetch)) throw new Error(`找不到拉片脚本：${scripts.fetch}`);
      onStage('fetching', '下载视频');
      const output = await exec(node, [scripts.fetch, String(url), dir], { timeout: 300_000, env });
      const meta = await safeRead(join(dir, 'meta.json'), {});
      const video = join(dir, 'video.mp4');
      if (!existsSync(video)) throw new Error(`下载完成但没有 video.mp4。脚本输出：${compactMessage(output, { max: 200 })}`);
      log(`[reference] 下载完成：${meta.title ?? url}`);
      return { video, meta };
    },

    /** 视频 → 切点 / 逐镜关键帧 / 12 格联系表 / 16k 音频。 */
    async frames({ video, dir, onStage = () => {} }) {
      if (!existsSync(scripts.frames)) throw new Error(`找不到切点脚本：${scripts.frames}`);
      onStage('framing', '切点并抽帧');
      await exec(node, [scripts.frames, video, dir], { timeout: 600_000 });
      const shots = await safeRead(join(dir, 'shots.json'), { shots: [] });
      return {
        shots,
        shotCount: shots.shotCount ?? (shots.shots ?? []).length,
        duration: shots.duration ?? null,
        contactSheet: existsSync(join(dir, 'contact-sheet.jpg')) ? join(dir, 'contact-sheet.jpg') : null,
        audio: existsSync(join(dir, 'audio.wav')) ? join(dir, 'audio.wav') : null,
      };
    },

    /** 台词转写。没装 faster-whisper 时不是致命错误：报告只依据画面与元数据。 */
    async asr({ audio, dir, onStage = () => {} }) {
      if (!audio || !existsSync(scripts.asr)) return null;
      onStage('asr', '语音转写');
      const out = join(dir, 'transcript.json');
      try {
        await exec(pythonPath || 'python', [scripts.asr, audio, out, '--model', String(asrModel)], { timeout: 900_000 });
        const transcript = await safeRead(out, null);
        const lines = (transcript?.segments ?? []).map((segment) => `[${Number(segment.start).toFixed(1)}-${Number(segment.end).toFixed(1)}] ${segment.text}`).join('\n');
        return { transcript, lines };
      } catch (error) {
        log(`[reference] 语音转写失败（不影响继续）：${error.message}`);
        return { error: error.message };
      }
    },

    /** 高级拆解：调用 rea-video（装了才跑）。逐镜判定实拍/AI/代码，并给出复刻路线。 */
    async rea({ video, dir, cmd, lang = 'zh', onStage = () => {} }) {
      if (!cmd) throw new Error('没有配置 rea-video 命令');
      const out = join(dir, 'rea');
      await mkdir(out, { recursive: true });
      onStage('rea', '高级拆解（逐镜判定 实拍/AI/代码）');
      // Windows 中文环境：Python 默认用 cp936 解码子进程输出，ffprobe 的 UTF-8 JSON 会解坏，
      // 所以强制 UTF-8 模式跑，否则 decompose 第一步就读不到视频信息。
      const pythonEnv = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
      // --no-packaging 跳过字幕/花字包装层，省时间；我们要的是逐镜判定与复刻路线。
      await exec(cmd, ['decompose', video, '-o', out, '--lang', lang, '--no-packaging'], { timeout: 1_500_000, env: pythonEnv });
      let summary = '';
      try {
        summary = await exec(cmd, ['summary', join(out, 'breakdown.json')], { timeout: 120_000, env: pythonEnv });
      } catch (error) {
        summary = `（summary 读取失败：${error.message}）`;
      }
      const videoMdPath = join(out, 'VIDEO.md');
      const videoMd = existsSync(videoMdPath) ? (await readFile(videoMdPath, 'utf8')).slice(0, 16000) : '';
      // 一行一镜的时间线：切点、时长、画面怎么做的、复刻路线。比 VIDEO.md 更适合喂提示词。
      const timelinePath = join(out, 'video', 'timeline.md');
      const timeline = existsSync(timelinePath) ? (await readFile(timelinePath, 'utf8')).slice(0, 14000) : '';
      const reportHtml = existsSync(join(out, 'report.html')) ? join(out, 'report.html') : null;
      log(`[reference] rea-video 拆解完成：${out}`);
      return { ok: true, out, summary: summary.trim().slice(0, 8000), videoMd, timeline, reportHtml };
    },

    /** 看图复核任务：生成 review_tasks.json / review_answers.json（由能看图的模型填）。 */
    async reaReview({ out, cmd, env }) {
      const pythonEnv = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(env ?? {}) };
      await exec(cmd, ['review', out], { timeout: 300_000, env: pythonEnv });
      const tasks = await safeRead(join(out, 'review_tasks.json'), null);
      const answers = await safeRead(join(out, 'review_answers.json'), null);
      if (!tasks || !answers) throw new Error('review 没有生成任务/答案文件');
      return { tasks, answers };
    },

    /** 把填好的答案并回结论，重写报告。 */
    async reaApplyReview({ out, cmd, env, by = 'dsh' }) {
      const pythonEnv = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(env ?? {}) };
      await exec(cmd, ['apply-review', out, '--by', by], { timeout: 300_000, env: pythonEnv });
      let summary = '';
      try {
        summary = await exec(cmd, ['summary', join(out, 'breakdown.json')], { timeout: 120_000, env: pythonEnv });
      } catch {
        summary = '';
      }
      const timelinePath = join(out, 'video', 'timeline.md');
      const timeline = existsSync(timelinePath) ? (await readFile(timelinePath, 'utf8')).slice(0, 14000) : '';
      return { summary: summary.trim().slice(0, 8000), timeline };
    },

    /** 组装给分析用的证据包。 */
    async evidence(dir) {
      const meta = await safeRead(join(dir, 'meta.json'), {});
      const shots = await safeRead(join(dir, 'shots.json'), { shots: [] });
      const transcript = await safeRead(join(dir, 'transcript.json'), null);
      const lines = (transcript?.segments ?? []).map((segment) => `[${Number(segment.start).toFixed(1)}-${Number(segment.end).toFixed(1)}] ${segment.text}`).join('\n');
      const shotTable = (shots.shots ?? [])
        .map((shot) => `#${shot.index} ${shot.start}-${shot.end}s（${shot.seconds}s）`)
        .join('\n');
      const frames = (await readdir(join(dir, 'frames')).catch(() => []))
        .filter((name) => /\.(jpg|jpeg|png)$/i.test(name))
        .sort();
      return {
        meta,
        shots,
        transcript,
        lines,
        shotTable,
        frames,
        contactSheet: existsSync(join(dir, 'contact-sheet.jpg')) ? 'contact-sheet.jpg' : null,
        replicate: await safeRead(join(dir, 'replicate.json'), null),
        summary: {
          title: String(meta?.title ?? ''),
          uploader: String(meta?.uploader ?? meta?.channel ?? ''),
          duration: Number(meta?.duration ?? shots.duration ?? 0) || null,
          likeCount: meta?.like_count ?? null,
          commentCount: meta?.comment_count ?? null,
          shotCount: shots.shotCount ?? (shots.shots ?? []).length,
          avgShotSeconds: shots.avgShotSeconds ?? null,
          music: meta?.music ?? null,
        },
      };
    },
  };
}
