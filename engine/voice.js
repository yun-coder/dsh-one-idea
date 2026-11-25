/**
 * 配音落地层：把「配音方案」变成真音频，并算出它在成片上的位置。
 *
 * 方案层（05-voice.json）只说「谁用什么音色、什么情绪」；听到声音还差两步：
 *   1. synthesizeLines：逐句调用 TTS（默认 Easel 的 skills/shared/scripts/tts.py），
 *      合成后按镜头时长做一次「时长门」——太长先自动加速，加速到上限还装不下就报 hard；
 *   2. placeLines：拿到剪辑清单和每段真实时长后，把每句铺到成片时间轴上（跟着段重排/裁剪走）。
 *
 * 这里不 import 任何 DSH 包，可以脱离 Harness 单测（见 test/voice-smoke.mjs）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dialogueOf } from './contracts.js';

/**
 * 音色表（contracts.js VOICE_CATALOG）→ 真 TTS 音色。
 *
 * tint 是音色自身的语速微调（和角色 rate 相乘）：edge 免费只有 6 个大陆中文音色，
 * 靠它把同音色的不同人设稍微拉开。closed 是闭源 provider 的音色 id（A 阶段不启用）。
 */
export const VOICE_TTS = {
  v_f_warm:    { edge: 'zh-CN-XiaoxiaoNeural', tint: -0.02, closed: 'FunAudioLLM/CosyVoice2-0.5B:anna' },
  v_f_bright:  { edge: 'zh-CN-XiaoyiNeural',   tint: +0.08, closed: 'FunAudioLLM/CosyVoice2-0.5B:diana' },
  v_f_calm:    { edge: 'zh-CN-XiaoxiaoNeural', tint: -0.08, closed: 'FunAudioLLM/CosyVoice2-0.5B:claire' },
  v_f_salt:    { edge: 'zh-CN-XiaoxiaoNeural', tint: -0.14, closed: 'FunAudioLLM/CosyVoice2-0.5B:fiona' },
  v_f_playful: { edge: 'zh-CN-XiaoyiNeural',   tint: +0.14, closed: 'FunAudioLLM/CosyVoice2-0.5B:diana' },  v_m_steady:  { edge: 'zh-CN-YunxiNeural',    tint: -0.08, closed: 'FunAudioLLM/CosyVoice2-0.5B:alex' },
  v_m_bright:  { edge: 'zh-CN-YunxiNeural',    tint: +0.06, closed: 'FunAudioLLM/CosyVoice2-0.5B:benjamin' },
  v_m_rough:   { edge: 'zh-CN-YunjianNeural',  tint: -0.06, closed: 'FunAudioLLM/CosyVoice2-0.5B:charles' },
  v_m_young:   { edge: 'zh-CN-YunxiaNeural',   tint: +0.02, closed: 'FunAudioLLM/CosyVoice2-0.5B:david' },
  v_m_anchor:  { edge: 'zh-CN-YunyangNeural',  tint: 0,     closed: 'FunAudioLLM/CosyVoice2-0.5B:eric' },
  v_c_elder:   { edge: 'zh-CN-YunjianNeural',  tint: -0.16, closed: 'FunAudioLLM/CosyVoice2-0.5B:frank' },
  v_c_docu:    { edge: 'zh-CN-YunxiNeural',    tint: -0.12, closed: 'FunAudioLLM/CosyVoice2-0.5B:alex' },
};

/** 自动加速的上限：再快就听得出「赶」。 */
export const DEFAULT_MAX_RATE = 1.3;
/** 台词比镜头长这么多，就不算「挤一挤能过」了。 */
export const DEFAULT_TOLERANCE = 0.15;
/** 自动加速到上限之后还超这么久，就是硬问题（要改台词或加长镜头）。 */
export const HARD_OVERFLOW_SEC = 0.6;

/**
 * 云知声 MaaS（U2-TTS）音色：官网系统音色里挑的 12 个，和内置音色表一一对应。
 * 比 edge 强的地方是有「苍老 / 沉稳 / 知性 / 温暖」这些真·音色区分，不用靠语速硬凑。
 */
export const UNISOUND_VOICES = {
  v_f_warm:    'cn_female_xiaodi_warm',          // 晓迪温暖（偏低，温软）
  v_f_bright:  'cn_female_shasha',               // 莎莎 清朗
  v_f_calm:    'cn_female_ruolin',               // 若琳 成熟
  v_f_salt:    'cn_female_xiaodi_warm',          // 晓迪温暖（给长辈/夫人，配 pitch=偏低 压年龄）
  v_f_playful: 'cn_female_jiajia',               // 佳佳（年轻、轻）
  v_m_steady:  'cn_male_chenyu_steady',          // 晨宇沉稳
  v_m_bright:  'cn_male_jingming',               // 景明 清朗
  v_m_rough:   'cn_male_chenyu',                 // 晨宇（没有粗砂，靠语速/低音压）
  v_m_young:   'cn_male_chenyu_fluent',          // 晨宇流利
  v_m_anchor:  'cn_male_chenyu',                 // 晨宇（普通话基准）
  v_c_elder:   'cn_male_chenyu_elderly',         // 晨宇苍老
  v_c_docu:    'cn_male_chenyu_steady',          // 晨宇沉稳
};

/** 中文情绪 → 云知声的 emotion 枚举；认不出来的不发，让音色用自己的默认语气。 */
export function emotionEnum(text) {
  const body = String(text ?? '');
  if (!body) return null;
  if (/(开心|轻快|笑|喜悦|雀跃|欢快)/.test(body)) return 'happy';
  if (/(生气|怒|凶|质问|火大)/.test(body)) return 'angry';
  if (/(难过|悲|低落|心疼|失落|沉)/.test(body)) return 'depressed';
  if (/(小声|耳语|气声|呢喃|压低)/.test(body)) return 'whisper';
  if (/(大声|喊|激动|亢奋|拔高)/.test(body)) return 'loudly';
  return null;
}

/** 角色语速（1.0 = 原速）→ 云知声的 0–100（50 = 原速）。 */
export function unisoundSpeed(rate = 1) {
  return Math.max(20, Math.min(100, Math.round(50 * (Number(rate) || 1))));
}

const round = (value) => Math.round(Number(value) * 100) / 100;
const safeName = (value) => String(value ?? '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'line';

/** 音色 + 角色语速 → 传给 edge-tts 的百分比（四舍五入到整数）。 */
export function ttsRatePercent(voiceId, rate = 1) {
  const tint = VOICE_TTS[String(voiceId ?? '')]?.tint ?? 0;
  const factor = (Number(rate) || 1) * (1 + tint);
  return Math.round((factor - 1) * 100);
}

/** 分镜 → 段 → 镜头（顺序即分镜顺序）。 */
export function planSegments(storyboard) {
  const segments = [];
  for (const shot of Array.isArray(storyboard?.shots) ? storyboard.shots : []) {
    const id = String(shot?.segment ?? shot?.scene ?? 'seg');
    let segment = segments.find((item) => item.id === id);
    if (!segment) {
      segment = { id, planned: 0, shots: [] };
      segments.push(segment);
    }
    const seconds = Number(shot?.durationSec) || 0;
    segment.shots.push({ id: String(shot?.id ?? ''), seconds });
    segment.planned += seconds;
  }
  return segments;
}

/** 每句台词落在哪个镜头、该镜头计划多少秒。 */
export function slotsOf(storyboard) {
  const rows = dialogueOf(storyboard);
  const segments = planSegments(storyboard);
  const shotSeconds = new Map();
  const segmentOfShot = new Map();
  for (const segment of segments) {
    for (const shot of segment.shots) {
      shotSeconds.set(shot.id, shot.seconds);
      segmentOfShot.set(shot.id, segment.id);
    }
  }
  return rows.map((row) => ({
    beatId: row.beatId,
    shotId: row.shotId,
    segment: row.segment || segmentOfShot.get(row.shotId) || '',
    speaker: row.speaker,
    text: row.text,
    slotSec: round(shotSeconds.get(row.shotId) ?? 0),
  }));
}

function probeSeconds(ffprobe, file) {
  const result = spawnSync(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', file], { encoding: 'utf8', windowsHide: true });
  try {
    return Number(JSON.parse(result.stdout).format.duration) || 0;
  } catch {
    return 0;
  }
}

async function loadManifest(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 逐句合成。返回的 lines 已经是「能直接铺轨」的形态（带 file / seconds / shotId / segment）。
 *
 * @param {object} input
 * @param {object} input.storyboard 分镜（03-storyboard.json）
 * @param {object} input.voice      配音方案（05-voice.json）
 * @param {string} input.dir        音频落盘目录（<项目>/voice）
 * @param {string} input.python     Python 解释器
 * @param {string} input.script     edge 走 tts.py 的路径
 * @param {string} [input.provider] edge（默认）/ unisound（云知声 U2-TTS）
 * @param {string} [input.adapter]  unisound 适配器路径（tools/unisound_tts.py）
 * @param {string} [input.apiKey]   unisound 的 API key
 * @param {string} [input.baseUrl]  unisound 接口地址
 * @param {number} [input.maxRate]  自动加速上限
 * @param {string} [input.ffprobe]  ffprobe 路径
 */
export async function synthesizeLines({
  storyboard, voice, dir, python, script, provider = 'edge', adapter = '', apiKey = '', baseUrl = '',
  engine = 'edge', maxRate = DEFAULT_MAX_RATE, tolerance = DEFAULT_TOLERANCE, ffprobe = 'ffprobe', log = () => {},
} = {}) {
  const slots = slotsOf(storyboard);
  const byBeat = new Map(slots.map((slot) => [slot.beatId, slot]));
  const manifestFile = join(dir, 'manifest.json');
  const cache = await loadManifest(manifestFile);
  const lines = Array.isArray(voice?.lines) ? voice.lines : [];
  const mode = String(provider || engine || 'edge').toLowerCase();
  // 人物音高：长辈压低、少女抬高。同一个音色靠 pitch 再拉开一点，避免「夫人和二娘一个嗓子」。
  const pitchBySpeaker = new Map((Array.isArray(voice?.characters) ? voice.characters : [])
    .map((character) => [String(character?.name ?? ''), String(character?.pitch ?? '')]));
  const pitchOf = (speaker) => {
    const hint = pitchBySpeaker.get(String(speaker ?? '')) ?? '';
    if (/偏低/.test(hint)) return 40;
    if (/偏高/.test(hint)) return 60;
    return 50;
  };

  if (lines.length === 0) {
    return { engine: mode, python, script, lines: [], warnings: [], hard: [], skipped: 'no-dialogue' };
  }
  if (mode === 'unisound') {
    if (!adapter || !existsSync(adapter)) throw new Error(`找不到云知声适配器：${adapter || '（空）'}（tools/unisound_tts.py）`);
    if (!String(apiKey).trim()) throw new Error('云知声配音缺少 API key：在 machine.json 里配 ttsApiKey');
  } else if (!script || !existsSync(script)) {
    throw new Error(`找不到 TTS 脚本：${script || '（空）'}（在 machine.json 里配 ttsScript，指向 Easel 的 skills/shared/scripts/tts.py）`);
  }

  await mkdir(dir, { recursive: true });
  const out = [];
  const warnings = [];
  const hard = [];

  for (const line of lines) {
    const beatId = String(line?.beatId ?? '');
    const slot = byBeat.get(beatId);
    const text = String(line?.text ?? '').trim();
    const voiceId = String(line?.voiceId ?? '');
    const baseRate = Number(line?.rate) || 1;
    if (!text) continue;

    const file = join(dir, `${safeName(beatId)}.mp3`);
    const signature = [mode, text, voiceId, baseRate, engine, UNISOUND_VOICES[voiceId] ?? '', pitchOf(line?.speaker)].join('|');
    const cached = cache[beatId];
    const slotSec = Number(slot?.slotSec) || 0;
    let seconds = 0;
    let rate = baseRate;
    const reusable = cached?.signature === signature && cached?.file === file && existsSync(file);
    if (reusable) {
      seconds = Number(cached.seconds) || probeSeconds(ffprobe, file);
      rate = Number(cached.rate) || baseRate;
    }
    // 缓存里的音长是按当时的镜头窗口算的：镜头缩短后要重新加速，不能直接复用。
    const fits = slotSec <= 0 || seconds <= slotSec + tolerance;
    if (!reusable || (!fits && rate < maxRate)) {
      const spawn = (useRate) => {
        let args;
        if (mode === 'unisound') {
          args = [adapter, '--text', text, '-o', file,
            '--voice-id', UNISOUND_VOICES[voiceId] ?? 'cn_male_chenyu',
            '--speed', String(unisoundSpeed(useRate)),
            '--pitch', String(pitchOf(line?.speaker))];
          if (String(apiKey).trim()) args.push('--key', String(apiKey).trim());
          if (baseUrl) args.push('--base-url', String(baseUrl));
          const emotion = emotionEnum(line?.emotion);
          if (emotion) args.push('--emotion', emotion);
        } else {
          const percent = ttsRatePercent(voiceId, useRate);
          args = [script, 'speak', '--engine', engine, '--voice', VOICE_TTS[voiceId]?.edge ?? 'zh-CN-XiaoxiaoNeural', '--text', text, '-o', file];
          // tts.py 的参数用等号形式，负百分比不会被 argparse 当成选项。
          if (percent !== 0) args.push(`--rate=${percent > 0 ? '+' : ''}${percent}%`);
        }
        const result = spawnSync(python, args, { encoding: 'utf8', windowsHide: true, timeout: 300_000 });
        if (result.status !== 0 || !existsSync(file)) {
          throw new Error(`合成失败（${beatId}）：${(result.stderr || result.stdout || '').slice(-400)}`);
        }
        return probeSeconds(ffprobe, file);
      };

      seconds = spawn(baseRate);
      rate = baseRate;
      // 时长门第一段：装不下就按比例加速，最多到 maxRate。
      if (slotSec > 0 && seconds > slotSec + tolerance && baseRate < maxRate) {
        const needed = (baseRate * seconds) / Math.max(0.5, slotSec);
        const next = Math.min(maxRate, Math.max(baseRate + 0.05, needed));
        if (next > baseRate + 0.03) {
          const fitted = spawn(next);
          if (fitted > 0 && fitted < seconds) {
            seconds = fitted;
            rate = next;
          }
        }
      }
      cache[beatId] = { signature, file, seconds, rate, at: Date.now() };
      await writeFile(manifestFile, JSON.stringify(cache, null, 2), 'utf8');
    }

    const overflowSec = slotSec > 0 ? Math.max(0, seconds - slotSec) : 0;
    if (!(seconds > 0.05)) {
      throw new Error(`量不出音频时长（${beatId}）：检查 ffprobe 是否可用（当前 ${ffprobe}）`);
    }
    const entry = {
      beatId,
      speaker: String(line?.speaker ?? slot?.speaker ?? ''),
      text,
      voiceId,
      emotion: String(line?.emotion ?? ''),
      rate: round(rate),
      file,
      seconds: round(seconds),
      slotSec: round(slotSec),
      overflowSec: round(overflowSec),
      shotId: slot?.shotId ?? '',
      segment: slot?.segment ?? '',
    };
    if (slotSec > 0 && overflowSec > tolerance) {
      const row = { beatId, seconds: entry.seconds, slotSec, overflowSec, rate: entry.rate, text };
      if (overflowSec > HARD_OVERFLOW_SEC) hard.push(row);
      else warnings.push(row);
    }
    log(`[voice] ${beatId} ${entries(entry)}`);
    out.push(entry);
  }

  return { engine: mode, python, script, lines: out, warnings, hard, at: Date.now() };
}

const entries = (entry) => `${entry.seconds}s / 窗口 ${entry.slotSec}s${entry.overflowSec ? ` / 超 ${entry.overflowSec}s` : ''}`;

/**
 * 把合成好的台词铺到成片时间轴上：跟着 EDL 的段重排、裁剪和真实段长走。
 *
 * @param {object} input
 * @param {Array} input.lines        synthesizeLines 的产物
 * @param {object} input.storyboard  分镜
 * @param {object} input.edl         剪辑清单
 * @param {Array} input.tasks        出片任务（带 segmentId / duration）
 */
export function placeLines({ lines = [], storyboard, edl, tasks = [] } = {}) {
  const segments = planSegments(storyboard);
  // 台词被改过但配音没重跑时，音频和字已经对不上了：宁可丢掉，也不要让观众听到上一版台词。
  const beatText = new Map(dialogueOf(storyboard).map((row) => [String(row.beatId), String(row.text ?? '').trim()]));
  const actual = new Map();
  for (const task of tasks) {
    if (task?.segmentId) actual.set(String(task.segmentId), Number(task.duration) || 0);
  }
  const order = Array.isArray(edl?.order) ? edl.order : [];
  const placed = [];
  const overflows = [];
  const dropped = [];
  let cursor = 0;

  for (const entry of order) {
    const segmentId = String(entry?.segmentId ?? '');
    const segment = segments.find((item) => item.id === segmentId);
    if (!segment) continue;
    const real = actual.get(segmentId) || segment.planned || 1;
    const scale = segment.planned > 0 ? real / segment.planned : 1;
    const trimStart = Math.min(real, Math.max(0, Number(entry?.trimStart) || 0));
    const trimEnd = entry?.trimEnd === null || entry?.trimEnd === undefined
      ? real
      : Math.min(real, Math.max(trimStart, Number(entry.trimEnd) || 0));
    const length = Math.max(0.1, trimEnd - trimStart);
    const rows = lines.filter((line) => String(line.segment) === segmentId);

    let offset = 0;
    for (const shot of segment.shots) {
      const shotLength = shot.seconds * scale;
      for (const line of rows.filter((item) => String(item.shotId) === shot.id)) {
        const rel = offset + 0.05; // 句头留 50ms，别和上一句的尾巴贴死
        const current = beatText.get(String(line.beatId));
        const recorded = String(line.text ?? '').trim();
        if (recorded && current !== undefined && recorded !== current) {
          dropped.push({ beatId: line.beatId, reason: '台词改过，配音要重跑' });
          continue;
        }
        if (rel < trimStart - 0.05 || rel > trimEnd + 0.05) {
          dropped.push({ beatId: line.beatId, reason: '这一镜被剪掉了' });
        } else {
          // 上一句如果已经压到了这里，就从上一句的尾巴接上——宁可这句短，也不要两个人同时说话。
          const previousEnd = placed.length > 0 ? placed[placed.length - 1].at + placed[placed.length - 1].seconds : cursor;
          const start = Math.max(cursor, previousEnd, cursor + rel - trimStart);
          const available = cursor + length - start;
          const overflowSec = Math.max(0, Number(line.seconds) - available);
          placed.push({ ...line, at: round(start), seconds: round(Number(line.seconds)), overflowSec: round(overflowSec) });
          if (overflowSec > 0.05) overflows.push({ beatId: line.beatId, overflowSec: round(overflowSec) });
        }
      }
      offset += shotLength;
    }
    cursor += length;
  }

  // 收尾：最后一句可能拖出成片尾巴。把它裁到片尾（不挪位置，避免和上一句叠在一起），
  // 并在 overflows 里记一笔——该由人决定是缩短台词还是加长这一镜。
  const total = cursor;
  for (const line of placed) {
    if (line.at + line.seconds > total && total > 0) {
      const room = Math.max(0.2, round(total - line.at));
      line.seconds = room;
      line.overflowSec = round(Math.max(0, line.overflowSec + (line.at + line.seconds - total)));
      line.trimmed = true;
    }
  }
  return { lines: placed, overflows, dropped, duration: round(cursor) };
}
