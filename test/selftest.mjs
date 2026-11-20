/**
 * 自测：不调用模型、不花额度。
 *   node test/selftest.mjs
 *
 * 覆盖：门禁契约（含 shot-contract 真实样例）、分镜切段、JSON 提取、项目仓库、
 * 以及 ffmpeg 剪辑管线（用合成片段跑一遍归一/拼接/混音/抽帧）。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GATES,
  gateIdea, gateStory, gateStoryboard, gateCharacters, gateVoice, gateEdit,
  loadShotContract, segmentsOf, dialogueOf, SIX_DIMENSIONS, patchStoryboard,
} from '../engine/contracts.js';
import { extractJson } from '../engine/agents.js';
import { createAgents } from '../engine/agents.js';
import { resolveConfig } from '../engine/config.js';
import { runDoctor } from '../engine/doctor.js';
import { materializeDemo } from '../engine/demo.js';
import { platformOf, checkPlatform, platformBrief } from '../engine/platform.js';
import { glyphFraction, overlapScore, verdictOf, sampleTimes, detectBurnedCaptions } from '../engine/burned-captions.js';
import { matchesStamp, promptLayerFingerprint } from '../engine/fingerprint.js';
import { createStore, newProject, event } from '../engine/store.js';
import { createMedia } from '../engine/media.js';

const ffmpegPath = process.env.FFMPEG_PATH || 'C:\\Users\\dsh\\AppData\\Local\\EaselTools\\ffmpeg\\ffmpeg-9.0.2-essentials_build\\bin\\ffmpeg.exe';
const skillDir = process.env.SHOT_CONTRACT_DIR || 'C:\\Users\\dsh\\.dsh\\skills\\shot-contract';

let pass = 0;
let failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `：${detail}` : ''}`);
  }
};

// ---------------------------------------------------------------------------
console.log('\n[1] 分镜：shot-contract 官方样例必须全绿');
const sample = JSON.parse(await readFile(join(skillDir, 'examples', 'noodle-shop.json'), 'utf8'));
const shotContract = await loadShotContract(skillDir);
const sampleGate = gateStoryboard(sample, { targetSeconds: 15 }, shotContract);
check('样例过 13 道门', sampleGate.gates.every((gate) => gate.failures.length === 0), JSON.stringify(sampleGate.gates.filter((gate) => gate.failures.length).slice(0, 2)));
check('附加门也过', sampleGate.ok, (sampleGate.failures ?? []).slice(0, 3).join(' / '));

const segments = segmentsOf(sample);
check('切成 2 段', segments.length === 2, JSON.stringify(segments.map((segment) => segment.id)));
check('每段都在 5–15 秒', segments.every((segment) => segment.duration >= 5 && segment.duration <= 15), JSON.stringify(segments.map((segment) => segment.duration)));
check('每段有提示词', segments.every((segment) => segment.prompt.length > 20));

const lines = dialogueOf(sample);
check('抽出 4 句台词', lines.length === 4, String(lines.length));

const broken = JSON.parse(JSON.stringify(sample));
broken.shots[0].action = '她码碗，然后按下柜门';
broken.shots[0].lastFrame = '她走出画面';
const brokenGate = gateStoryboard(broken, { targetSeconds: 15 }, shotContract);
check('坏分镜被拦下', !brokenGate.ok && brokenGate.failures.length >= 2, JSON.stringify(brokenGate.failures.slice(0, 3)));

// ---------------------------------------------------------------------------
console.log('\n[2] 创意 / 剧情 / 人物 / 配音 门禁');
const project = { targetSeconds: 45, brief: { hotspots: [{ title: '年轻人开始报复性熬夜' }, { title: '深夜食堂复兴' }], forbidden: ['最好', '第一'] } };
const goodIdeas = {
  ideas: [
    { id: 'A', title: '最后一碗面', oneLiner: '打烊前的一碗面，卖给一个不肯回家的人', hook: '她把卷帘门拉到一半，一只湿透的手伸进来挡住', structure: ['钩子', '转折', '落点'], emotion: '温情', whyNow: '报复性熬夜', hotspotLinks: ['年轻人开始报复性熬夜'], score: { hook: 8, fit: 9, feasible: 7 }, risk: '过于安静' },
    { id: 'B', title: '凌晨菜单', oneLiner: '只写三个字的菜单，藏着三十年的老规矩', hook: '手写的菜单被翻过来，背面只有三个字', structure: ['钩子', '转折', '落点'], emotion: '好奇', whyNow: '深夜食堂复兴', hotspotLinks: ['深夜食堂复兴'], score: { hook: 9, fit: 7, feasible: 8 }, risk: '信息不平' },
    { id: 'C', title: '同一个座位', oneLiner: '每天同一个座位的人，今天换成了另一个', hook: '空座位上放着一双没人收的筷子', structure: ['钩子', '转折', '落点'], emotion: '认同', whyNow: '深夜食堂复兴', hotspotLinks: ['深夜食堂复兴'], score: { hook: 7, fit: 8, feasible: 9 }, risk: '容易被读成惊悚' },
  ],
  recommended: { id: 'A', reason: '温情方向最贴品类，钩子可拍性也最高，两个热点都能挂上' },
};
check('好创意过门', gateIdea(goodIdeas, project).ok, gateIdea(goodIdeas, project).failures.join(' / '));
check('两个方向过不了', !gateIdea({ ...goodIdeas, ideas: goodIdeas.ideas.slice(0, 2) }, project).ok);
check('引用假热点被拦', !gateIdea({ ...goodIdeas, ideas: [{ ...goodIdeas.ideas[0], hotspotLinks: ['不存在的热搜'] }, ...goodIdeas.ideas.slice(1)] }, project).ok);
check('没挂热点被拦', !gateIdea({ ...goodIdeas, ideas: goodIdeas.ideas.map((idea) => ({ ...idea, hotspotLinks: [] })) }, project).ok);
check('门禁调度把项目上下文传下去', !GATES.idea({ ...goodIdeas, ideas: goodIdeas.ideas.map((idea) => ({ ...idea, hotspotLinks: [] })) }, { project }).ok);
check('门禁调度在无热点时放行', GATES.idea({ ...goodIdeas, ideas: goodIdeas.ideas.map((idea) => ({ ...idea, hotspotLinks: [] })) }, { project: { brief: {} } }).ok);
check('禁用词被拦', !gateIdea({ ...goodIdeas, ideas: [{ ...goodIdeas.ideas[0], oneLiner: '全网最好的第一碗面' }, ...goodIdeas.ideas.slice(1)] }, project).ok);
const goodStory = {
  title: '最后一碗面',
  logline: '打烊前，一个湿透的男人要一碗清汤面，老板娘看出他在躲什么',
  theme: '深夜给成年人的体面',
  premise: '我妈那种勤快，是会把东西收到你永远想不到的地方的那种勤快',
  punchline: '明天我还来',
  characters: [
    { name: '老板娘', role: '面馆老板', age: '45', want: '早点打烊回家', obstacle: '门口的人不走' },
    { name: '男人', role: '夜班工人', age: '35', want: '吃碗面再走', obstacle: '没带够钱' },
  ],
  acts: [
    { name: '钩子', goal: '让人停下', beats: [{ t: 0, action: '卷帘门拉到一半，一只手伸进来', emotion: '意外', durationSec: 3 }, { t: 3, action: '她把卷帘门又推上去', emotion: '好奇', durationSec: 4 }] },
    { name: '转折', goal: '把冲突摊开', beats: [{ t: 7, action: '他摸遍口袋只摸出十块钱', emotion: '窘迫', durationSec: 6 }, { t: 13, action: '她转身抽出一把面抖散', emotion: '平静', durationSec: 8 }, { t: 21, action: '他把钱压在碗底推回去', emotion: '倔', durationSec: 9 }] },
    { name: '落点', goal: '收住', beats: [{ t: 30, action: '她把十块钱压回他手心', emotion: '酸', durationSec: 8 }, { t: 38, action: '他把伞留在了门口，说明天我还来', emotion: '暖', durationSec: 7 }] },
  ],
  ending: '门关上，伞还滴着水',
  dialogueDensity: 'medium',
};
check('好剧情过门', gateStory(goodStory, { targetSeconds: 45 }).ok, gateStory(goodStory, { targetSeconds: 45 }).failures.join(' / '));
check('缺 ending 被拦', !gateStory({ ...goodStory, ending: '' }, { targetSeconds: 45 }).ok);

const goodCharacters = {
  style: '冷调夜景，白炽灯暖点，浅景深',
  characters: [
    {
      name: '老板娘', role: '面馆老板', voiceHint: '低、稳、话少',
      dims: {
        face: '圆脸，颧骨不高，四十多岁的法令纹',
        features: '单眼皮，眉毛淡，嘴唇干裂，几乎不化妆',
        hair: '齐肩短发，发尾外翻，鬓角有几根白',
        costume: '深蓝棉布围裙，袖口卷到小臂，右手腕一副旧表',
        posture: '肩背略驼，站着时重心偏左脚，擦手用围裙下摆',
        motif: '白炽灯管下的侧脸，说话前先停半秒',
      },
      prompt: '圆脸，颧骨不高，四十多岁的法令纹，齐肩短发发尾外翻，深蓝棉布围裙，袖口卷到小臂，白炽灯管下的侧脸',
      negative: '不要浓妆',
    },
    {
      name: '男人', role: '夜班工人', voiceHint: '沙、闷',
      dims: {
        face: '长脸，下颌线硬，眼窝深',
        features: '双眼皮，鼻梁有旧疤，胡茬没刮干净',
        hair: '短寸头，被雨压塌',
        costume: '深灰雨衣，内搭洗白的工装外套，手里一把黑伞',
        posture: '站着时微微前倾，双手插在雨衣口袋里',
        motif: '雨水顺帽檐往下滴，说话时看着碗不看人',
      },
      prompt: '长脸，下颌线硬，深灰雨衣，短寸头被雨压塌，雨水顺帽檐往下滴，双手插在口袋里',
      negative: '不要胡子太长',
    },
  ],
};
check('好人物过门', gateCharacters(goodCharacters, { storyboard: sample }).ok, gateCharacters(goodCharacters, { storyboard: sample }).failures.join(' / '));
const badCharacters = JSON.parse(JSON.stringify(goodCharacters));
badCharacters.characters[0].dims.hair = '同上';
check('占位词被拦', !gateCharacters(badCharacters, { storyboard: sample }).ok);
check('六维缺一被拦', !gateCharacters({ ...goodCharacters, characters: [{ ...goodCharacters.characters[0], dims: { ...goodCharacters.characters[0].dims, motif: '' } }] }, {}).ok);

const goodVoice = {
  narration: { enabled: false, voiceId: '', rate: 1, emotion: '' },
  characters: [
    { name: '老板娘', voiceId: 'v_f_calm', rate: 0.95, pitch: '偏低', style: '话少、断句短' },
    { name: '男人', voiceId: 'v_m_rough', rate: 0.9, pitch: '低', style: '闷着说' },
  ],
  lines: lines.map((line) => ({
    beatId: line.beatId, speaker: line.speaker, text: line.text,
    voiceId: line.speaker === '老板娘' ? 'v_f_calm' : 'v_m_rough', emotion: '克制', rate: 0.95,
  })),
  bgm: { enabled: true, mood: '安静、留白', recommended: '低保真钢琴 + 雨声', bpm: 88, note: '' },
  mix: { dialogueDb: 0, musicDb: -18 },
};
check('好配音过门', gateVoice(goodVoice, { storyboard: sample, characters: goodCharacters }).ok, gateVoice(goodVoice, { storyboard: sample, characters: goodCharacters }).failures.join(' / '));
check('漏台词被拦', !gateVoice({ ...goodVoice, lines: goodVoice.lines.slice(0, 2) }, { storyboard: sample }).ok);
check('假音色被拦', !gateVoice({ ...goodVoice, characters: [{ ...goodVoice.characters[0], voiceId: 'v_fake' }, goodVoice.characters[1]] }, { storyboard: sample }).ok);

// ---------------------------------------------------------------------------
console.log('\n[3] 剪辑清单门禁');
const goodEdl = {
  order: [
    { segmentId: 'E01-01', trimStart: 0, trimEnd: null, transition: 'cut', transitionSec: 0.25, reason: '钩子最直接的放在第一' },
    { segmentId: 'E01-02', trimStart: 0, trimEnd: null, transition: 'fade', transitionSec: 0.25, reason: '收尾收在碗上' },
  ],
  audio: { bgm: '低保真钢琴', gainDb: -18, duck: true, lufs: -14 },
  subtitles: { enabled: false, note: '' },
  packaging: { title: '打烊前的那碗面', hook: '她本来要关门', description: '一个不肯回家的男人和一碗清汤面', hashtags: ['#深夜食堂', '#城市故事'] },
  notes: ['把第二段的开头剪掉 0.3 秒'],
  rationale: '把最强的画面前置，收尾落在碗上，声音只留雨和钢琴',
};
const render = { tasks: [{ segmentId: 'E01-01', status: 'completed' }, { segmentId: 'E01-02', status: 'completed' }] };
check('好剪辑清单过门', gateEdit(goodEdl, { render }).ok, gateEdit(goodEdl, { render }).failures.join(' / '));
check('漏段被拦', !gateEdit({ ...goodEdl, order: [goodEdl.order[0]] }, { render }).ok);
check('坏转场被拦', !gateEdit({ ...goodEdl, order: [{ ...goodEdl.order[0], transition: 'zoom' }, goodEdl.order[1]] }, { render }).ok);
const timedRender = { tasks: [{ segmentId: 'E01-01', status: 'completed', duration: 5 }, { segmentId: 'E01-02', status: 'completed', duration: 8 }] };
check('成片超时长被拦', !gateEdit(goodEdl, { render: timedRender, project: { targetSeconds: 5 } }).ok);
check('成片时长吻合放行', gateEdit(goodEdl, { render: timedRender, project: { targetSeconds: 13 } }).ok);

// ---------------------------------------------------------------------------
console.log('\n[4] JSON 提取');
check('裸 JSON', extractJson('{"a":1}').a === 1);
check('带围栏', extractJson('```json\n{"a":2}\n```').a === 2);
check('带前言尾话', extractJson('好的，如下：\n{"a":3}\n希望有用').a === 3);
check('尾逗号容错', extractJson('{"a":4,}').a === 4);
let threw = false;
try {
  extractJson('没有 JSON');
} catch {
  threw = true;
}
check('无 JSON 抛错', threw);

// ---------------------------------------------------------------------------
console.log('\n[5] 项目仓库');
const root = await mkdtemp(join(tmpdir(), 'creative-store-'));
const store = createStore({ root });
const fresh = newProject({ title: '测试项目', targetSeconds: 30, brief: { productName: '清汤面', sellingPoints: ['一碗面'] } });
await store.save(fresh);
const loaded = await store.load(fresh.id);
check('落盘后读回', loaded.title === '测试项目' && loaded.brief.productName === '清汤面');
await store.writeArtifact(loaded, 'idea', { ideas: [{ id: 'A' }] });
const idea = await store.artifact(loaded, 'idea');
check('产物读写', idea.ideas[0].id === 'A');
await store.update(fresh.id, (row) => {
  event(row, { kind: 'test', text: 'hello' });
  row.stages.idea.status = 'done';
});
const listed = await store.list();
check('列表带阶段进度', listed.length === 1 && listed[0].doneStages === 1, JSON.stringify(listed[0]));
await store.remove(fresh.id);
check('删除干净', (await store.list()).length === 0);

// ---------------------------------------------------------------------------
console.log('\n[6] ffmpeg 剪辑管线（合成片段）');
const media = createMedia({ ffmpegPath });
const work = await mkdtemp(join(tmpdir(), 'creative-media-'));
const clipA = join(work, 'a.mp4');
const clipB = join(work, 'b.mp4');
try {
  await media.run(media.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', clipA]);
  await media.run(media.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', clipB]);
  const probeA = await media.probe(clipA);
  check('probe 读到时长', Math.abs(probeA.duration - 3) < 0.4, JSON.stringify(probeA));

  const normA = join(work, 'norm-a.mp4');
  const normB = join(work, 'norm-b.mp4');
  await media.normalize({ input: clipA, output: normA, width: 540, height: 960, trimStart: 0.2, trimEnd: 1.8 });
  await media.normalize({ input: clipB, output: normB, width: 540, height: 960, fade: true });
  const probeNorm = await media.probe(normA);
  check('归一后尺寸正确', probeNorm.width === 540 && probeNorm.height === 960, JSON.stringify(probeNorm));
  check('裁切生效', probeNorm.duration > 1.2 && probeNorm.duration < 2.2, String(probeNorm.duration));

  const joined = join(work, 'joined.mp4');
  await media.concatCopy({ files: [normA, normB], output: joined });
  const probeJoin = await media.probe(joined);
  check('拼接后时长相加', probeJoin.duration > 4 && probeJoin.duration < 7, String(probeJoin.duration));

  const finalFile = join(work, 'final.mp4');
  await media.mixAudio({ input: joined, output: finalFile, bgm: null, lufs: -14 });
  const probeFinal = await media.probe(finalFile);
  check('响度归一后成片可读', probeFinal.duration > 4 && probeFinal.hasAudio);

  const cover = join(work, 'cover.jpg');
  await media.frame({ input: finalFile, output: cover, at: 0.5 });
  check('抽帧成功', (await media.probe(cover)).width === 540);
} finally {
  await rm(work, { recursive: true, force: true });
}
await rm(root, { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log('\n[9] 分镜局部编辑：改一镜/一句，不重生成整条');
{
  const doc = structuredClone(sample);
  const shot = doc.shots[0];
  const beatLine = (doc.beats ?? []).find((beat) => beat.kind === 'line');
  const patched = patchStoryboard(structuredClone(doc), {
    shot: { id: shot.id, prompt: `${shot.prompt} 加一句补充。`, durationSec: 2.5 },
    beat: beatLine ? { id: beatLine.id, text: '这是改过的一句台词' } : null,
  });
  const nextShot = patched.doc.shots.find((item) => item.id === shot.id);
  check('改了提示词与时长', nextShot.prompt.endsWith('加一句补充。') && nextShot.durationSec === 2.5, JSON.stringify(nextShot.durationSec));
  check('改动了台词', !beatLine || patched.doc.beats.find((item) => item.id === beatLine.id).text === '这是改过的一句台词');
  check('返回改动条数', patched.changed >= 2, String(patched.changed));

  let threw = false;
  try {
    patchStoryboard(structuredClone(doc), { shot: { id: 'NOPE', prompt: 'x' } });
  } catch {
    threw = true;
  }
  check('未知镜头会报错', threw);

  threw = false;
  try {
    patchStoryboard(structuredClone(doc), { shot: { id: shot.id, durationSec: -1 } });
  } catch {
    threw = true;
  }
  check('负时长会报错', threw);

  const edited = patchStoryboard(structuredClone(doc), { shot: { id: shot.id, prompt: shot.prompt } });
  check('没变化时 changed 为 0', edited.changed === 0, String(edited.changed));

  // 改台词要同步改认领该节拍的镜头提示词，否则 G10 逐字对不上。
  const lineBeat = (doc.beats ?? []).find((beat) => beat.kind === 'line'
    && (doc.shots ?? []).some((item) => (item.claims ?? []).includes(beat.id) && String(item.prompt ?? '').includes(beat.text)));
  if (lineBeat) {
    const next = patchStoryboard(structuredClone(doc), { beat: { id: lineBeat.id, text: `${lineBeat.text}（改）` } });
    const synced = next.doc.shots.filter((item) => (item.claims ?? []).includes(lineBeat.id))
      .every((item) => item.prompt.includes(`${lineBeat.text}（改）`));
    check('改台词同步进提示词', synced);
  } else {
    check('改台词同步进提示词（样例没有可对上的台词镜，跳过）', true);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[10] 平台策略：时长/画幅/响度按平台判，偏好只提示不否决');
check('平台表取得到抖音', platformOf({ platform: 'douyin' })?.label === '抖音');
check('未知平台不假装有约束', platformOf({ platform: 'weibo' }) === null);
check('没填平台按抖音兜底', platformOf({})?.id === 'douyin');

const douyinLandscape = checkPlatform({ platform: 'douyin', aspect: '16:9' });
check('抖音横版被拦（hard）', douyinLandscape.failures.length > 0 && douyinLandscape.failures[0].includes('横版'), douyinLandscape.failures.join(' / '));
const douyinLong = checkPlatform({ platform: 'douyin', aspect: '9:16' }, { seconds: 240 });
check('抖音 240 秒只提示不拦', douyinLong.failures.length === 0 && douyinLong.advisories.some((line) => line.includes('常见区间')), douyinLong.advisories.join(' / '));
const douyinOverCap = checkPlatform({ platform: 'douyin' }, { seconds: 1000 });
check('抖音超硬上限被拦', douyinOverCap.failures.some((line) => line.includes('硬上限')), douyinOverCap.failures.join(' / '));
const douyinNormal = checkPlatform({ platform: 'douyin', aspect: '9:16' }, { seconds: 20 });
check('抖音 9:16 / 20 秒零提示', douyinNormal.failures.length === 0 && douyinNormal.advisories.length === 0, douyinNormal.advisories.join(' / '));
const biliPortrait = checkPlatform({ platform: 'bilibili', aspect: '9:16' }, { seconds: 60 });
check('B站竖版只提示不拦', biliPortrait.failures.length === 0 && biliPortrait.advisories.length > 0);

const samplePlatformGate = gateStoryboard(sample, { platform: 'douyin', targetSeconds: 15 }, shotContract);
check('真实样例在抖音策略下仍过门', samplePlatformGate.ok, (samplePlatformGate.failures ?? []).slice(0, 2).join(' / '));
check('门禁结果带上平台与提示数组', samplePlatformGate.platform === 'douyin' && Array.isArray(samplePlatformGate.advisories));
const badAspectGate = gateStoryboard(sample, { platform: 'douyin', aspect: '16:9', targetSeconds: 15 }, shotContract);
check('分镜在抖音横版下被拦', !badAspectGate.ok && badAspectGate.failures.some((line) => line.includes('横版')), badAspectGate.failures.slice(0, 2).join(' / '));

const loudEdl = gateEdit({ ...goodEdl, audio: { ...goodEdl.audio, lufs: -25 } }, { render: timedRender, project: { platform: 'douyin', targetSeconds: 13 } });
check('响度按平台报错且带平台名', !loudEdl.ok && loudEdl.failures.some((line) => line.includes('抖音')), loudEdl.failures.join(' / '));
check('平台合规的响度过门', gateEdit(goodEdl, { render: timedRender, project: { platform: 'douyin', targetSeconds: 13 } }).ok);
const biliLoud = gateEdit({ ...goodEdl, audio: { ...goodEdl.audio, lufs: -17 } }, { render: timedRender, project: { platform: 'bilibili', targetSeconds: 13 } });
check('B站响度区间更宽', biliLoud.ok, biliLoud.failures.join(' / '));
check('提示词带上平台常见时长', platformBrief({ platform: 'douyin', aspect: '9:16', targetSeconds: 45 }).includes('常见 15–90 秒'));

// ---------------------------------------------------------------------------
console.log('\n[10] 提示词外置覆盖');
{
  const dir = await mkdtemp(join(tmpdir(), 'cs-prompts-'));
  await writeFile(join(dir, 'story.md'), '这是自定义剧情要求：必须出现一只猫。', 'utf8');
  let captured = '';
  const agents = createAgents({
    callModel: async ({ user }) => {
      captured = user;
      return '{"title":"t","logline":"l","premise":"p","punchline":"q","characters":[],"acts":[],"ending":"e"}';
    },
    config: { promptsDir: dir },
  });
  await agents.produce({
    stage: 'story',
    project: { title: '测试', targetSeconds: 30, brief: { productName: '面' } },
    context: {},
  });
  check('自定义阶段指令进了提示词', captured.includes('这是自定义剧情要求'));
  let plain = '';
  const bare = createAgents({
    callModel: async ({ user }) => {
      plain = user;
      return '{"title":"t"}';
    },
    config: {},
  });
  await bare.produce({ stage: 'story', project: { title: '测试', targetSeconds: 30, brief: {} }, context: {} });
  check('没有覆盖文件时不出现自定义段落', !plain.includes('自定义阶段指令（story.md）'));
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log('\n[11] 烧字检测：三带扫描，静态台标不算字幕');
const lineCanvas = (() => {
  const width = 40;
  const height = 40;
  const gray = new Uint8Array(width * height);
  for (let x = 8; x < 32; x += 1) gray[20 * width + x] = 255; // 中间一条亮线
  return { gray, width, height };
})();
check('带内亮像素+暗边算成字形', glyphFraction(lineCanvas.gray, lineCanvas.width, lineCanvas.height, 0.4, 0.6) > 0);
check('带外没有字', glyphFraction(lineCanvas.gray, lineCanvas.width, lineCanvas.height, 0.7, 0.9) === 0);
check('掩码与自身完全重合', overlapScore([1, 2, 3], [1, 2, 3]) === 1);
check('不相交的掩码重合度为 0', overlapScore([1, 2, 3], [4, 5, 6]) === 0);
const movingText = Array.from({ length: 8 }, (_, index) => ({ fraction: 0.02, mask: [index * 100, index * 100 + 1] }));
check('逐帧变化的文字判成烧字', verdictOf(movingText).detected, JSON.stringify(verdictOf(movingText)));
const staticLogo = Array.from({ length: 8 }, () => ({ fraction: 0.02, mask: [1, 2, 3, 4] }));
check('静态台标不判成烧字', !verdictOf(staticLogo).detected);
const occasional = [{ fraction: 0.02, mask: [1] }, ...Array.from({ length: 7 }, () => ({ fraction: 0, mask: [] }))];
check('零星出现不算持续文字', !verdictOf(occasional).detected);
const burnTimes = sampleTimes(100, 5);
check('取样点落在片头片尾之间', burnTimes[0] === 8 && burnTimes[burnTimes.length - 1] === 92 && burnTimes.every((time) => time >= 8 && time <= 92) && burnTimes.length === 5, JSON.stringify(burnTimes));
check('没有时长时不出采样点', sampleTimes(null, 5).length === 0);

const burnedProject = { platform: 'douyin', targetSeconds: 13, reference: { burnedCaption: { detected: true, band: [0.42, 0.72] } } };
const bothSubtitles = gateEdit({ ...goodEdl, subtitles: { enabled: true, note: '' } }, { render: timedRender, project: burnedProject });
check('素材有烧字还开字幕被拦', !bothSubtitles.ok && bothSubtitles.failures.some((line) => line.includes('双字幕')), bothSubtitles.failures.join(' / '));
const noSubtitles = gateEdit({ ...goodEdl, subtitles: { enabled: false, note: '' } }, { render: timedRender, project: burnedProject });
check('关掉字幕放行并提示原烧字仍在', noSubtitles.ok && noSubtitles.advisories.some((line) => line.includes('烧字')), noSubtitles.advisories.join(' / '));
check('没有参考素材时这条门不触发', gateEdit(goodEdl, { render: timedRender, project: { platform: 'douyin', targetSeconds: 13 } }).ok);

const burnedSample = 'D:/智贸/04-素材/autoclip-实测/01-被四人围堵-76s.mp4';
if (existsSync(burnedSample)) {
  const detected = await detectBurnedCaptions({ video: burnedSample, seconds: 76.65, ffmpegPath, samples: 6 });
  check('真实带烧字素材被检出（中置带）', detected.detected === true && detected.bandName === 'middle', JSON.stringify(detected.bands));
  check('检出结果带可用区间', Array.isArray(detected.band) && detected.band.length === 2, JSON.stringify(detected.band));
} else {
  check('真实带烧字素材被检出（本机没有样例，跳过）', true);
  check('检出结果带可用区间（跳过）', true);
}

// ---------------------------------------------------------------------------
console.log('\n[12] 阶段指纹：模型或提示词变了，旧产物就该失效');
const fingerprint = promptLayerFingerprint();
check('指纹稳定且是 12 位十六进制', fingerprint === promptLayerFingerprint() && /^[0-9a-f]{12}$/.test(fingerprint), fingerprint);
const promptDir = await mkdtemp(join(tmpdir(), 'fp-'));
await writeFile(join(promptDir, 'storyboard.md'), '自定义分镜指令', 'utf8');
const withOverride = promptLayerFingerprint(promptDir);
check('外置提示词参与指纹', withOverride !== fingerprint, `${fingerprint} vs ${withOverride}`);
await writeFile(join(promptDir, 'storyboard.md'), '改过一句话的自定义分镜指令', 'utf8');
check('提示词内容一改指纹就变', promptLayerFingerprint(promptDir) !== withOverride);
await rm(promptDir, { recursive: true, force: true });

const stamp = { model: 'deepseek:deepseek-chat', prompts: fingerprint };
check('模型与提示词都一致才叫同一版', matchesStamp(stamp, { model: 'deepseek:deepseek-chat', prompts: fingerprint }));
check('换了模型就不算同一版', !matchesStamp(stamp, { model: 'qwen:qwen3', prompts: fingerprint }));
check('改了提示词就不算同一版', !matchesStamp(stamp, { model: 'deepseek:deepseek-chat', prompts: 'ffffffffffff' }));
check('没有指纹的老项目不当作一致', !matchesStamp(null, { model: 'deepseek:deepseek-chat', prompts: fingerprint }));

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
console.log('\n[11] 环境自检');
{
  const dir = await mkdtemp(join(tmpdir(), 'cs-doctor-'));
  const resolved = resolveConfig({
    dataDir: join(dir, 'data'),
    projectDir: join(dir, 'projects'),
    skillDir: join(dir, 'no-skill'),
    scriptsDir: join(dir, 'no-scripts'),
    ffmpegPath,
  });
  const report = runDoctor(resolved);
  check('doctor 找出缺 shot-contract', report.items.some((item) => item.status === 'fail' && item.name.includes('shot-contract')));
  check('doctor 汇总可信', report.summary.ok > 0 && report.summary.fail >= 1 && report.ok === false);
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log('\n[12] 示例项目');
{
  const demoDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo');
  const dir = await mkdtemp(join(tmpdir(), 'cs-demo-'));
  const { template } = await materializeDemo({ demoDir, dir });
  check('示例成片已复制', existsSync(template.finalFile), template.finalFile);
  check('分段路径已替换', template.stages.render.artifact.tasks.every((task) => existsSync(task.file)));
  check('没有残留占位符', !JSON.stringify(template).includes('__SEG_') && !JSON.stringify(template).includes('__FINAL__'));
  check('示例成片有内容', (await readFile(template.finalFile)).length > 100 * 1024);
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);