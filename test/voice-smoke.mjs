/**
 * 配音落地层自测（不调模型、不花额度）：
 *   node test/voice-smoke.mjs
 *
 * 覆盖：
 *   - 音色表 → 真音色映射（12 个 id 一个都不能漏）
 *   - 语速百分比（音色 tint × 角色 rate）
 *   - 分镜 → 段/镜头的时间轴
 *   - 台词铺轨（段重排、裁头、真实段长、被剪掉的句子）
 *   - ffmpeg 混音：对白 + 原声（无 BGM）
 *   - OpenFilm film.html：对白是否真的写成了 <audio>
 *   - 可选：TTS_LIVE=1 时真跑一次 edge 合成
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VOICE_CATALOG } from '../engine/contracts.js';
import { VOICE_TTS, UNISOUND_VOICES, ttsRatePercent, unisoundSpeed, emotionEnum, planSegments, slotsOf, placeLines } from '../engine/voice.js';
import { createMedia } from '../engine/media.js';
import { createOpenFilmFinisher } from '../engine/openfilm.js';

const ffmpegPath = process.env.FFMPEG_PATH || 'C:\\Users\\dsh\\AppData\\Local\\EaselTools\\ffmpeg\\ffmpeg-9.0.2-essentials_build\\bin\\ffmpeg.exe';
const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (match, ext) => `ffprobe${ext ?? ''}`);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? `：${detail}` : ''}`);
  }
};

const dir = await mkdtemp(join(tmpdir(), 'voice-smoke-'));
const media = createMedia({ ffmpegPath });

const storyboard = {
  beats: [
    { id: 'B01', kind: 'line', speaker: '妈妈', text: '这么冷的天，你就穿这个出门？' },
    { id: 'B02', kind: 'line', speaker: '女儿', text: '妈，我赶时间。' },
    { id: 'B03', kind: 'line', speaker: '妈妈', text: '把围巾带上，面在锅里。' },
    { id: 'B04', kind: 'line', speaker: '旁白', text: '冬天最暖的，是有人记得你怕冷。' },
  ],
  shots: [
    { id: 'E01-SH01', segment: 'E01-01', durationSec: 3, claims: ['B01'] },
    { id: 'E01-SH02', segment: 'E01-01', durationSec: 3, claims: ['B02'] },
    { id: 'E01-SH03', segment: 'E01-02', durationSec: 3, claims: ['B03'] },
    { id: 'E01-SH04', segment: 'E01-02', durationSec: 3, claims: ['B04'] },
  ],
};

const lines = [
  { beatId: 'B01', segment: 'E01-01', shotId: 'E01-SH01', file: join(dir, 'B01.mp3'), seconds: 2.4, voiceId: 'v_f_warm', at: 0 },
  { beatId: 'B02', segment: 'E01-01', shotId: 'E01-SH02', file: join(dir, 'B02.mp3'), seconds: 1.4, voiceId: 'v_f_bright', at: 0 },
  { beatId: 'B03', segment: 'E01-02', shotId: 'E01-SH03', file: join(dir, 'B03.mp3'), seconds: 2.8, voiceId: 'v_f_warm', at: 0 },
  { beatId: 'B04', segment: 'E01-02', shotId: 'E01-SH04', file: join(dir, 'B04.mp3'), seconds: 3.4, voiceId: 'v_c_docu', at: 0 },
];

console.log('音色映射');
check('12 个音色 id 全部有真音色', VOICE_CATALOG.every((voice) => VOICE_TTS[voice.id]?.edge));
check('温软女声 ×1.0 = -2%', ttsRatePercent('v_f_warm', 1) === -2, String(ttsRatePercent('v_f_warm', 1)));
check('播音男声 ×1.1 = +10%', ttsRatePercent('v_m_anchor', 1.1) === 10, String(ttsRatePercent('v_m_anchor', 1.1)));
check('12 个音色都有云知声音色', VOICE_CATALOG.every((voice) => UNISOUND_VOICES[voice.id]));
check('原速 = 50', unisoundSpeed(1) === 50, String(unisoundSpeed(1)));
check('×1.3 = 65', unisoundSpeed(1.3) === 65, String(unisoundSpeed(1.3)));
check('情绪词能落到枚举', emotionEnum('心疼但压着') === 'depressed' && emotionEnum('轻快地' ) === 'happy' && emotionEnum('平静交代') === null);

console.log('时间轴');
check('分成 2 段', planSegments(storyboard).length === 2);
check('每段计划 6 秒', planSegments(storyboard).every((segment) => segment.planned === 6));
const slots = slotsOf(storyboard);
check('4 句台词落位', slots.length === 4);
check('B02 落在 E01-SH02', slots.find((slot) => slot.beatId === 'B02')?.shotId === 'E01-SH02');
check('镜头窗口 3 秒', slots.every((slot) => slot.slotSec === 3));

console.log('铺轨');
const edl = {
  order: [
    { segmentId: 'E01-02', trimStart: 0.4, trimEnd: null, transition: 'cut' },
    { segmentId: 'E01-01', trimStart: 0, trimEnd: 5.2, transition: 'cut' },
  ],
};
const tasks = [{ segmentId: 'E01-01', duration: 6 }, { segmentId: 'E01-02', duration: 6 }];
const placed = placeLines({ lines, storyboard, edl, tasks });
const byBeat = new Map(placed.lines.map((line) => [line.beatId, line]));
check('重排后 E01-02 在前：B04 落在开头附近', byBeat.get('B04')?.at < 3, String(byBeat.get('B04')?.at));
check('被裁头吃掉的 B03 被丢弃', placed.dropped.some((row) => row.beatId === 'B03'));
check('B01 从第二段开始铺', byBeat.get('B01')?.at >= 5.4, String(byBeat.get('B01')?.at));
check('总长 = 5.6 + 5.2', placed.duration === 10.8, String(placed.duration));
check('超窗的 B04 被记下来', placed.overflows.some((row) => row.beatId === 'B04' && row.overflowSec > 0.2), JSON.stringify(placed.overflows));
const sorted = [...placed.lines].sort((a, b) => a.at - b.at);
const overlap = sorted.some((line, index) => index > 0 && line.at < sorted[index - 1].at + sorted[index - 1].seconds - 0.01);
check('句子之间不重叠', !overlap);

// 收尾：最后一句拖出片尾时，裁到片尾而不是往回挪（往回挪会和上一句同时说话）
const tailStoryboard = {
  beats: [{ id: 'C01', kind: 'line', speaker: '旁白', text: '这一句比片子还长。' }],
  shots: [{ id: 'G1-S1', segment: 'G1', durationSec: 2, claims: ['C01'] }],
};
const tail = placeLines({
  lines: [{ beatId: 'C01', shotId: 'G1-S1', segment: 'G1', file: join(dir, 'B04.mp3'), seconds: 3 }],
  storyboard: tailStoryboard,
  edl: { order: [{ segmentId: 'G1' }] },
  tasks: [{ segmentId: 'G1', duration: 2 }],
});
check('拖出片尾的句子被裁短', tail.lines[0]?.trimmed === true && tail.lines[0].seconds < 2, JSON.stringify(tail.lines[0]));
check('裁短后不越界', tail.lines[0]?.at + tail.lines[0]?.seconds <= tail.duration + 0.01);

// 分镜台词改了但配音没重跑：旧音频不能铺上去
const stale = placeLines({
  lines: [{ beatId: 'B01', segment: 'E01-01', shotId: 'E01-SH01', file: join(dir, 'B01.mp3'), seconds: 2, text: '上一版台词' }],
  storyboard,
  edl: { order: [{ segmentId: 'E01-01' }] },
  tasks: [{ segmentId: 'E01-01', duration: 6 }],
});
check('台词改过就不铺旧音频', stale.dropped.some((row) => row.beatId === 'B01' && row.reason.includes('重跑')), JSON.stringify(stale.dropped));

console.log('ffmpeg 混音（对白 + 原声，无 BGM）');
const base = join(dir, 'base.mp4');
const tone = join(dir, 'tone.mp3');
const tone2 = join(dir, 'tone2.mp3');
await media.run(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x14161c:s=320x480:d=6:r=30',
  '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', base]);
await media.run(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', tone]);
await media.run(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1', tone2]);
const mixed = join(dir, 'mixed.mp4');
await media.mixAudio({ input: base, output: mixed, bgm: null, lufs: -14, lines: [{ file: tone, at: 0.5, seconds: 1 }, { file: tone2, at: 3, seconds: 1 }] });
const mixedInfo = existsSync(mixed) ? await media.probe(mixed) : { duration: 0 };
check('混出了带音频的成片', Math.abs(mixedInfo.duration - 6) < 0.4, `${mixedInfo.duration}s`);
check('混音结果有音轨', (mixedInfo.hasAudio ?? false) === true);

console.log('OpenFilm film.html');
const finisher = createOpenFilmFinisher({ config: { ffmpegPath }, log: () => {}, media });
const film = await finisher.writeFilm({
  projectDir: dir,
  clips: [base],
  entries: [{}],
  bgm: null,
  width: 320,
  height: 480,
  filmDir: dir,
  lines: [{ file: tone, at: 0.3, seconds: 1, volume: 1 }],
});
const html = await readFile(film.filmHtml, 'utf8');
check('film.html 写出了对白音轨', /id="vo01"/.test(html), html.slice(0, 200));
check('对白带时间点', /at="0\.300"/.test(html));
check('时间轴 6 秒', Math.abs(film.duration - 6) < 0.05, String(film.duration));

if (process.env.UNISOUND_LIVE === '1') {
  console.log('云知声真合成（UNISOUND_LIVE=1）');
  const { synthesizeLines } = await import('../engine/voice.js');
  const result = await synthesizeLines({
    storyboard,
    voice: { lines: [{ beatId: 'B02', speaker: '女儿', text: '妈，我赶时间。', voiceId: 'v_f_bright', emotion: '着急、不耐烦', rate: 1.05 }] },
    dir: join(dir, 'unisound'),
    python: process.env.TTS_PYTHON || 'D:\\Easel\\.venv\\Scripts\\python.exe',
    provider: 'unisound',
    adapter: fileURLToPath(new URL('../tools/unisound_tts.py', import.meta.url)),
    apiKey: process.env.UNISOUND_API_KEY || '',
    baseUrl: process.env.UNISOUND_BASE_URL || 'https://maas-api.hivoice.cn',
    ffprobe: ffprobePath,
    log: () => {},
  });
  check('云知声合成出 mp3', existsSync(result.lines[0]?.file ?? ''));
  check('云知声音频有时长', (result.lines[0]?.seconds ?? 0) > 0.3, String(result.lines[0]?.seconds));
}

if (process.env.TTS_LIVE === '1') {
  console.log('真合成（TTS_LIVE=1）');
  const { synthesizeLines } = await import('../engine/voice.js');
  const result = await synthesizeLines({
    storyboard,
    voice: { lines: [{ beatId: 'B02', speaker: '女儿', text: '妈，我赶时间。', voiceId: 'v_f_bright', emotion: '不耐烦', rate: 1.05 }] },
    dir: join(dir, 'live'),
    python: process.env.TTS_PYTHON || 'D:\\Easel\\.venv\\Scripts\\python.exe',
    script: process.env.TTS_SCRIPT || 'D:\\Easel\\skills\\shared\\scripts\\tts.py',
    ffprobe: ffprobePath,
    log: () => {},
  });
  check('合成出 mp3', existsSync(result.lines[0]?.file ?? ''));
  check('有时长', (result.lines[0]?.seconds ?? 0) > 0.3, String(result.lines[0]?.seconds));
}

await rm(dir, { recursive: true, force: true });
console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
