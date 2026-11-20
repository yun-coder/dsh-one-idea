/**
 * 门禁评测集：改提示词 / 改门禁之后跑一遍，确认「该过的还过、该拦的还拦」。
 *   node test/eval.mjs
 *
 * 不调模型、不花额度；用固定样例把每个阶段的确定性门禁钉住。
 * 输出一行一条，最后给出通过率；有回归就退出码 1。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  gateIdea, gateStory, gateStoryboard, gateCharacters, gateVoice, gateEdit,
  loadShotContract, dialogueOf,
} from '../engine/contracts.js';

const skillDir = process.env.SHOT_CONTRACT_DIR || 'C:\\Users\\dsh\\.dsh\\skills\\shot-contract';
const shotContract = await loadShotContract(skillDir);
const sample = JSON.parse(await readFile(join(skillDir, 'examples', 'noodle-shop.json'), 'utf8'));

const project = {
  targetSeconds: 45,
  brief: { hotspots: [{ title: '年轻人开始报复性熬夜' }, { title: '深夜食堂复兴' }], forbidden: ['最好', '第一'] },
};

const ideas = {
  ideas: [
    { id: 'A', title: '最后一碗面', oneLiner: '打烊前的一碗面，卖给一个不肯回家的人', hook: '她把卷帘门拉到一半，一只湿透的手伸进来挡住', structure: ['钩子', '转折', '落点'], emotion: '温情', whyNow: '报复性熬夜', hotspotLinks: ['年轻人开始报复性熬夜'], score: { hook: 8, fit: 9, feasible: 7 }, risk: '过于安静' },
    { id: 'B', title: '凌晨菜单', oneLiner: '只写三个字的菜单，藏着三十年的老规矩', hook: '手写的菜单被翻过来，背面只有三个字', structure: ['钩子', '转折', '落点'], emotion: '好奇', whyNow: '深夜食堂复兴', hotspotLinks: ['深夜食堂复兴'], score: { hook: 9, fit: 7, feasible: 8 }, risk: '信息不平' },
    { id: 'C', title: '同一个座位', oneLiner: '每天同一个座位的人，今天换成了另一个', hook: '空座位上放着一双没人收的筷子', structure: ['钩子', '转折', '落点'], emotion: '认同', whyNow: '深夜食堂复兴', hotspotLinks: ['深夜食堂复兴'], score: { hook: 7, fit: 8, feasible: 9 }, risk: '容易被读成惊悚' },
  ],
  recommended: { id: 'A', reason: '温情方向最贴品类，钩子可拍性也最高，两个热点都能挂上' },
};

const story = {
  title: '最后一碗面',
  logline: '打烊前，一个湿透的男人要一碗清汤面，老板娘看出他在躲什么',
  theme: '深夜给成年人的体面',
  premise: '打烊前的最后十分钟，是这条街上最难熬的时候',
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

const characters = {
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

const lines = dialogueOf(sample);
const voice = {
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

const edl = {
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

const cases = [
  // 创意
  ['idea', 'good', ideas, project],
  ['idea', 'bad: 只有两个方向', { ...ideas, ideas: ideas.ideas.slice(0, 2) }, project],
  ['idea', 'bad: 引用假热点', { ...ideas, ideas: [{ ...ideas.ideas[0], hotspotLinks: ['不存在的热搜'] }, ...ideas.ideas.slice(1)] }, project],
  ['idea', 'bad: 禁用词', { ...ideas, ideas: [{ ...ideas.ideas[0], oneLiner: '全网最好的第一碗面' }, ...ideas.ideas.slice(1)] }, project],
  // 剧情
  ['story', 'good', story, { targetSeconds: 45 }],
  ['story', 'bad: 缺落点', { ...story, punchline: '' }, { targetSeconds: 45 }],
  ['story', 'bad: 缺 ending', { ...story, ending: '' }, { targetSeconds: 45 }],
  // 分镜
  ['storyboard', 'good: shot-contract 官方样例', sample, { targetSeconds: 15, shotContract }],
  ['storyboard', 'bad: 提示词太短', { ...sample, shots: sample.shots.map((shot, index) => index === 0 ? { ...shot, prompt: '一个镜头' } : shot) }, { targetSeconds: 15, shotContract }],
  // 人物
  ['characters', 'good', characters, { storyboard: sample }],
  ['characters', 'bad: 六维用了占位词', { ...characters, characters: [{ ...characters.characters[0], dims: { ...characters.characters[0].dims, hair: '同上' } }] }, {}],
  // 配音
  ['voice', 'good', voice, { storyboard: sample, characters }],
  ['voice', 'bad: 漏台词', { ...voice, lines: voice.lines.slice(0, 2) }, { storyboard: sample }],
  ['voice', 'bad: 假音色', { ...voice, characters: [{ ...voice.characters[0], voiceId: 'v_fake' }, voice.characters[1]] }, { storyboard: sample }],
  // 剪辑
  ['edit', 'good', edl, { render }],
  ['edit', 'bad: 漏段', { ...edl, order: [edl.order[0]] }, { render }],
  ['edit', 'bad: 坏转场', { ...edl, order: [{ ...edl.order[0], transition: 'zoom' }, edl.order[1]] }, { render }],
];

const gates = { idea: gateIdea, story: gateStory, storyboard: gateStoryboard, characters: gateCharacters, voice: gateVoice, edit: gateEdit };

let pass = 0;
let failed = 0;
console.log(`\n门禁评测集（${cases.length} 条）\n`);
for (const [stage, label, doc, context] of cases) {
  const gate = gates[stage];
  const result = stage === 'storyboard' ? gate(doc, context, shotContract) : gate(doc, context);
  const expectOk = label.startsWith('good');
  const ok = result.ok === expectOk;
  if (ok) pass += 1;
  else failed += 1;
  const mark = ok ? '✓' : '✗';
  const detail = result.ok ? '' : ` · 首个原因：${(result.failures ?? [])[0] ?? ''}`;
  console.log(`  ${mark} ${stage.padEnd(11)} ${label}${ok ? '' : `${detail}（实际 ok=${result.ok}）`}`);
}
console.log(`\n结果：${pass} 通过，${failed} 失败\n`);
if (failed > 0) process.exit(1);
