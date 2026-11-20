/**
 * 创意工作台的契约层：人物六维、配音音色表、每个阶段的确定性质量门。
 *
 * 这里不 import 任何 DSH 包，也不碰 ctx：门禁是纯函数，可以脱离 Harness 单测。
 * 分镜阶段不重写门禁：直接 import shot-contract 技能的 check.mjs（见 loadShotContract），
 * 保证「技能说能过」和「工作台说能过」是同一份判定。
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/** 人物形象的六个维度：缺一维就不算一个能被生成的「人」。 */
export const SIX_DIMENSIONS = [
  { key: 'face', label: '骨相与脸型', hint: '脸型、骨相、年龄感、面部比例' },
  { key: 'features', label: '五官与妆容', hint: '眼睛、眉毛、鼻子、嘴唇、妆感与肤色' },
  { key: 'hair', label: '发型与发色', hint: '长度、结构、颜色、蓬松度、发质' },
  { key: 'costume', label: '服装与配饰', hint: '上装、下装、材质、颜色、配饰与鞋' },
  { key: 'posture', label: '体态与动作习惯', hint: '身高体型、站姿、手势、习惯小动作' },
  { key: 'motif', label: '气质与记忆点', hint: '气场、说话方式、标志物、惯用光影' },
];
export const DIMENSION_KEYS = SIX_DIMENSIONS.map((dimension) => dimension.key);

/** 配音音色表：id 稳定，配音阶段只能从这里选，避免写出不存在的音色。 */
export const VOICE_CATALOG = [
  { id: 'v_f_warm', name: '温软女声', gender: '女', age: '25-30', tone: '轻声、气声多', use: '情绪铺垫、生活流' },
  { id: 'v_f_bright', name: '明亮女声', gender: '女', age: '20-26', tone: '语速偏快、尾音上扬', use: '种草、口播' },
  { id: 'v_f_calm', name: '从容女声', gender: '女', age: '30-38', tone: '低音稳、断句清楚', use: '专业解读、品牌片' },
  { id: 'v_f_salt', name: '清冷女声', gender: '女', age: '22-30', tone: '平直、少起伏', use: '悬疑、高级感' },
  { id: 'v_f_playful', name: '俏皮女声', gender: '女', age: '18-24', tone: '跳脱、语气词多', use: '搞笑、反转' },
  { id: 'v_m_steady', name: '沉稳男声', gender: '男', age: '30-40', tone: '中低音、慢', use: '叙事、纪录片' },
  { id: 'v_m_bright', name: '清亮男声', gender: '男', age: '22-28', tone: '中高音、干净', use: '科技、数码' },
  { id: 'v_m_rough', name: '粗砂男声', gender: '男', age: '35-50', tone: '沙哑、有颗粒', use: '硬核、江湖气' },
  { id: 'v_m_young', name: '少年男声', gender: '男', age: '16-22', tone: '轻、略紧', use: '青春、校园' },
  { id: 'v_m_anchor', name: '播音男声', gender: '男', age: '28-35', tone: '字正腔圆', use: '新闻体、权威' },
  { id: 'v_c_elder', name: '长者声', gender: '中性', age: '55+', tone: '慢、气息厚', use: '回忆、传承' },
  { id: 'v_c_docu', name: '纪录片旁白', gender: '中性', age: '30-45', tone: '克制、留白', use: '旁白' },
];
export const VOICE_IDS = new Set(VOICE_CATALOG.map((voice) => voice.id));

export const PLACEHOLDERS = ['默认', '随意', '待定', '同上', '照旧', '无', '——', '—', '?', '？', 'tbd', 'todo'];
/** 禁用词：空话形容词/成语/肌肉清单，和 shot-contract 的 G11 同一套取向。 */
export const BANNED = ['电影感', '高级感', '大片感', '超写实', '杰作', '获奖', '4k', '8k', '脸沉下来', '嘴角勾起', '五味杂陈', '气氛凝固'];

const blank = (value) => typeof value !== 'string' || value.trim() === '' || PLACEHOLDERS.includes(value.trim().toLowerCase()) || PLACEHOLDERS.includes(value.trim());
const chars = (value) => (typeof value === 'string' ? [...value.replace(/\s+/g, '')].length : 0);
const asArray = (value) => (Array.isArray(value) ? value : []);

const ok = (failures) => ({ ok: failures.length === 0, failures });
const push = (failures, message) => failures.push(String(message));

export function bannedHits(text) {
  const body = String(text ?? '');
  return BANNED.filter((word) => body.toLowerCase().includes(word.toLowerCase()));
}

/** 门禁结果转成给模型看的一段话（打回重做时塞进提示词）。 */
export function describeFailures(result) {
  return asArray(result?.failures).map((failure) => (typeof failure === 'string' ? failure : failure.message)).join('；');
}

// ---------------------------------------------------------------------------
// 阶段一：创意 idea
// ---------------------------------------------------------------------------
export function gateIdea(doc, project = {}) {
  const failures = [];
  const ideas = asArray(doc?.ideas);
  // 复刻模式：项目带着参考片的拆解报告时，创意的依据是「参考片结构」，不是热点清单。
  const referenceMode = Boolean(project?.reference?.report);
  if (ideas.length < 3) push(failures, `至少要 3 个创意方向，现在只有 ${ideas.length} 个`);
  const ids = new Set();
  const hotspotTitles = asArray(project?.brief?.hotspots).map((hotspot) => String(hotspot?.title ?? '').trim()).filter(Boolean);
  const forbidden = asArray(project?.brief?.forbidden).map(String).filter(Boolean);
  for (const idea of ideas) {
    const id = String(idea?.id ?? '').trim();
    if (!id) push(failures, '有创意方向缺少 id');
    else if (ids.has(id)) push(failures, `创意 id 重复：${id}`);
    else ids.add(id);
    if (blank(idea?.title)) push(failures, `创意 ${id || '?'} 缺少标题`);
    if (chars(idea?.hook) < 8) push(failures, `创意 ${id || '?'} 的前 3 秒钩子太短（至少 8 字）`);
    if (chars(idea?.oneLiner) < 10) push(failures, `创意 ${id || '?'} 缺少一句话卖点`);
    const structure = asArray(idea?.structure);
    if (structure.length < 3) push(failures, `创意 ${id || '?'} 的节奏结构少于 3 拍`);
    if (blank(idea?.emotion)) push(failures, `创意 ${id || '?'} 没有标注主情绪`);
    const score = idea?.score ?? {};
    const scoreLabels = { hook: '钩子力', fit: '画像契合', feasible: '可拍性' };
    for (const key of ['hook', 'fit', 'feasible']) {
      const value = Number(score[key]);
      if (!Number.isFinite(value) || value < 0 || value > 10) push(failures, `创意 ${id || '?'} 的${scoreLabels[key]}评分必须是 0–10`);
    }
    const text = JSON.stringify(idea);
    for (const word of forbidden) {
      if (text.includes(word)) {
        push(failures, `创意 ${id || '?'} 出现了客户禁用词「${word}」${word.length === 1 ? '（按字面匹配；如果这是「最后」这类中性词，把禁用词写完整，例如「最好」）' : ''}`);
      }
    }
    for (const hit of bannedHits(JSON.stringify({ hook: idea?.hook, oneLiner: idea?.oneLiner }))) push(failures, `创意 ${id || '?'} 出现空话词「${hit}」`);
    const links = asArray(idea?.hotspotLinks);
    if (referenceMode) {
      if (chars(idea?.borrowedFrom) < 8) push(failures, `创意 ${id || '?'} 没写 borrowedFrom：要说清借了参考片的哪一段结构（钩子/节奏/情绪弧）`);
      if (chars(idea?.swapped) < 8) push(failures, `创意 ${id || '?'} 没写 swapped：要说清换掉了什么人物、场景、台词或产品`);
    } else {
      if (hotspotTitles.length > 0 && links.length === 0) push(failures, `创意 ${id || '?'} 没有挂任何热点依据`);
      for (const link of links) {
        const found = hotspotTitles.some((title) => title.includes(String(link)) || String(link).includes(title));
        if (!found) push(failures, `创意 ${id || '?'} 引用了不在热点清单里的「${link}」`);
      }
    }
  }
  const recommendedId = String(doc?.recommended?.id ?? '').trim();
  if (!recommendedId) push(failures, '没有给出 recommended.id');
  else if (!ids.has(recommendedId)) push(failures, `recommended.id「${recommendedId}」不在 ideas 里`);
  if (chars(doc?.recommended?.reason) < 10) push(failures, 'recommended.reason 太短：要说清为什么是这个方向');
  return ok(failures);
}

// ---------------------------------------------------------------------------
// 阶段二：故事剧情
// ---------------------------------------------------------------------------
export function gateStory(doc, project = {}) {
  const failures = [];
  if (chars(doc?.logline) < 12) push(failures, 'logline 太短：一句话要说清谁、想要什么、卡在哪');
  if (blank(doc?.title)) push(failures, '故事缺少标题');
  // 可理解性：观众不看标题也要知道「冲突从哪来」和「最后怎么收的」。
  if (chars(doc?.premise) < 8) push(failures, '缺少 premise：一句把前因说清的话（为什么会有这个冲突），观众不看标题也得懂');
  if (chars(doc?.punchline) < 4) push(failures, '缺少 punchline：落点的那句台词');
  else {
    const allText = asArray(doc?.acts).flatMap((act) => asArray(act?.beats)).map((beat) => String(beat?.action ?? '')).join('\n');
    const ending = String(doc?.ending ?? '');
    if (!allText.includes(doc.punchline.trim()) && !ending.includes(doc.punchline.trim())) {
      push(failures, `punchline「${doc.punchline}」没有出现在任何一拍或结局里：落点台词必须真的演出/说出`);
    }
  }
  const acts = asArray(doc?.acts);
  if (acts.length < 3) push(failures, `故事至少要 3 幕，现在只有 ${acts.length} 幕`);
  let beats = 0;
  let seconds = 0;
  for (const act of acts) {
    const list = asArray(act?.beats);
    if (blank(act?.name)) push(failures, '有幕缺少 name');
    if (list.length < 2) push(failures, `第「${act?.name ?? '?'}」幕只有 ${list.length} 拍，至少 2 拍`);
    for (const beat of list) {
      beats += 1;
      if (chars(beat?.action) < 6) push(failures, `「${act?.name ?? '?'}」第 ${beats} 拍没有具体动作`);
      if (!Number.isFinite(Number(beat?.durationSec)) || Number(beat.durationSec) <= 0) push(failures, `「${act?.name ?? '?'}」第 ${beats} 拍缺少 durationSec`);
      else seconds += Number(beat.durationSec);
    }
  }
  if (beats < 6) push(failures, `整条故事只有 ${beats} 拍，太薄（至少 6 拍）`);
  const target = Number(project?.targetSeconds) || 45;
  if (seconds > 0 && Math.abs(seconds - target) / target > 0.45) {
    push(failures, `节拍合计 ${Math.round(seconds)} 秒，和目标 ${target} 秒差太远（允许 ±45%）`);
  }
  const names = new Set(asArray(doc?.characters).map((character) => String(character?.name ?? '').trim()));
  if (names.size === 0) push(failures, '没有列出人物');
  for (const character of asArray(doc?.characters)) {
    if (blank(character?.name)) push(failures, '有人物缺少 name');
    if (chars(character?.want) < 4) push(failures, `人物「${character?.name ?? '?'}」缺少他想要什么（want）`);
  }
  if (chars(doc?.ending) < 8) push(failures, 'ending 太短：结局要落一句话');
  const text = JSON.stringify(doc);
  for (const hit of bannedHits(text)) push(failures, `故事出现空话词「${hit}」`);
  return ok(failures);
}

// ---------------------------------------------------------------------------
// 阶段三：分镜脚本（shot-contract 13 道门 + 工作台附加门）
// ---------------------------------------------------------------------------
export async function loadShotContract(skillDir) {
  const file = join(skillDir, 'scripts', 'check.mjs');
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.validate !== 'function') throw new Error(`${file} 没有导出 validate()`);
  return { validate: mod.validate, buildLock: mod.buildLock, renderTable: mod.renderTable, renderLocks: mod.renderLocks, GATES: mod.GATES ?? [] };
}

/**
 * 锁行：和 shot-contract 的 buildLock 逐字一致。
 * 技能里明确说「锁行不要手写，用脚本生成后逐字贴进去」，所以宿主在这里代劳——
 * 这不是绕过门禁，而是按技能规定的做法生成锁行。
 */
export function buildLockLine(shot, buildLock) {
  if (typeof buildLock === 'function') {
    const line = buildLock(shot);
    return typeof line === 'string' ? line : '';
  }
  const camera = shot?.camera ?? {};
  const people = Array.isArray(shot?.inFrame) ? shot.inFrame : [];
  if (blank(shot?.light) || blank(camera.side) || blank(camera.size) || people.length === 0) return '';
  const who = people.map((person) => (blank(person?.who) || blank(person?.pos) || blank(person?.facing) ? null : `${person.who}在${person.pos}，${person.facing}`)).filter(Boolean);
  if (who.length !== people.length) return '';
  return `光：${shot.light}。${who.join('；')}。机位在${camera.side}，${camera.size}。`;
}

/** 给每镜补上锁行（已包含就跳过），返回改动了几条。 */
export function applyLocks(doc, buildLock) {
  let changed = 0;
  for (const shot of Array.isArray(doc?.shots) ? doc.shots : []) {
    const line = buildLockLine(shot, buildLock);
    if (!line) continue;
    const prompt = String(shot?.prompt ?? '').trim();
    if (prompt.includes(line)) continue;
    shot.prompt = prompt ? `${prompt}\n${line}` : line;
    changed += 1;
  }
  return { doc, changed };
}

export function gateStoryboard(doc, project = {}, shotContract = null) {
  const failures = [];
  const extra = [];
  const shots = asArray(doc?.shots);
  if (shots.length === 0) push(extra, '分镜里没有镜头');
  for (const shot of shots) {
    const id = String(shot?.id ?? '?');
    if (chars(shot?.prompt) < 60) push(extra, `镜 ${id} 的提示词太短（至少 60 字），模型只能靠它出画面`);
    const action = String(shot?.action ?? '');
    for (const word of ['然后', '接着', '随后']) if (action.includes(word)) push(extra, `镜 ${id} 的动作里出现「${word}」：一镜只做一件事`);
  }
  const segments = segmentsOf(doc);
  for (const segment of segments) {
    if (segment.seconds > 15) push(extra, `段 ${segment.id} 合计 ${segment.seconds} 秒，超过单段 15 秒上限`);
    if (!segment.prompt) push(extra, `段 ${segment.id} 没有可用提示词`);
  }
  if (segments.length === 0 && shots.length > 0) push(extra, '没有可提交的段：检查 shot.segment 字段');

  // 可理解性：台词要真的把它讲出来——开头有一条立前提，结尾有一条交付落点。
  const lines = dialogueOf(doc);
  if (lines.length === 0) push(extra, '整条片子没有一句台词：观众只能看画面猜，通常看不明白');
  else {
    const totalSec = shots.reduce((sum, shot) => sum + (Number(shot?.durationSec) || 0), 0) || 1;
    const startOf = (shotId) => {
      let acc = 0;
      for (const shot of shots) {
        if (String(shot?.id) === String(shotId)) return acc;
        acc += Number(shot?.durationSec) || 0;
      }
      return acc;
    };
    const first = lines[0];
    const last = lines[lines.length - 1];
    const firstAt = startOf(first.shotId) / totalSec;
    const lastAt = startOf(last.shotId) / totalSec;
    if (firstAt > 0.4) push(extra, `第一句台词出现在 ${Math.round(firstAt * 100)}% 处：前提要在前 40% 内交代，否则观众不知道发生了什么`);
    if (lastAt < 0.55) push(extra, `最后一句台词出现在 ${Math.round(lastAt * 100)}% 处：落点要放在后半段，否则片子没有结尾`);
  }
  const target = Number(doc?.targetSeconds) || Number(project?.targetSeconds) || 0;
  const total = segments.reduce((sum, segment) => sum + segment.seconds, 0);
  if (target > 0 && total > 0 && Math.abs(total - target) / target > 0.35) {
    push(extra, `分镜合计 ${Math.round(total)} 秒，和目标 ${target} 秒差太远（允许 ±35%）`);
  }
  if (!shotContract?.validate) {
    push(extra, '没有找到 shot-contract 技能，13 道结构门没能跑');
    return { ok: false, failures: extra, gates: [], note: 'skill-missing' };
  }
  const report = shotContract.validate(doc);
  const gates = report.results.map((gate) => ({ id: gate.id, name: gate.name, failures: gate.failures }));
  for (const gate of gates) {
    for (const message of gate.failures.slice(0, 4)) failures.push(`${gate.id} ${gate.name}：${message}`);
  }
  return { ok: failures.length === 0 && extra.length === 0, failures: [...failures, ...extra], gates };
}

/** 把分镜切成「段」：一段 = 一次生成任务。 */
export function segmentsOf(doc) {
  const shots = asArray(doc?.shots);
  const order = [];
  const groups = new Map();
  for (const shot of shots) {
    const id = String(shot?.segment ?? shot?.scene ?? 'seg');
    if (!groups.has(id)) {
      groups.set(id, []);
      order.push(id);
    }
    groups.get(id).push(shot);
  }
  return order.map((id) => {
    const list = groups.get(id);
    const seconds = list.reduce((sum, shot) => sum + (Number(shot?.durationSec) || 0), 0);
    const people = [];
    for (const shot of list) {
      for (const person of asArray(shot?.inFrame)) {
        const who = String(person?.who ?? '').trim();
        if (who && !people.includes(who)) people.push(who);
      }
    }
    return {
      id,
      seconds: Math.round(seconds * 10) / 10,
      // MiniMax-H3 两套接口的下限都是 5 秒：低于 5 秒会被上游直接拒单。
      duration: Math.min(15, Math.max(5, Math.round(seconds) || 5)),
      shots: list,
      startShot: list[0],
      people,
      prompt: list.map((shot) => String(shot?.prompt ?? '').trim()).filter(Boolean).join('\n'),
    };
  });
}

/** 台词：从节拍里取 line，再按 claims 落到镜头上。 */
export function dialogueOf(doc) {
  const beats = asArray(doc?.beats);
  const beatById = new Map(beats.map((beat) => [String(beat?.id), beat]));
  const lines = [];
  for (const shot of asArray(doc?.shots)) {
    for (const claim of asArray(shot?.claims)) {
      const beat = beatById.get(String(claim));
      if (beat?.kind !== 'line') continue;
      lines.push({
        beatId: String(beat.id),
        shotId: String(shot?.id ?? ''),
        segment: String(shot?.segment ?? shot?.scene ?? ''),
        speaker: String(beat?.speaker ?? ''),
        text: String(beat?.text ?? ''),
        durationSec: Number(beat?.durationSec) || 0,
      });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 阶段四：人物形象六维
// ---------------------------------------------------------------------------
export function gateCharacters(doc, { storyboard = null } = {}) {
  const failures = [];
  const characters = asArray(doc?.characters);
  if (characters.length === 0) push(failures, '没有人物档案');
  const names = new Set();
  for (const character of characters) {
    const name = String(character?.name ?? '').trim();
    if (!name) push(failures, '有人物缺少 name');
    else if (names.has(name)) push(failures, `人物重名：${name}`);
    else names.add(name);
    const dims = character?.dims ?? {};
    for (const dimension of SIX_DIMENSIONS) {
      const value = dims[dimension.key];
      if (blank(value)) push(failures, `人物「${name || '?'}」的「${dimension.label}」是空的`);
      else if (chars(value) < 8) push(failures, `人物「${name || '?'}」的「${dimension.label}」太笼统（至少 8 字，要写到能画出来）`);
    }
    if (blank(character?.prompt)) push(failures, `人物「${name || '?'}」没有定妆提示词`);
    else {
      // 提示词要真的把六维写进去：每维取 2 字以上的关键片段，命中就算覆盖。
      const tokensOf = (value) => String(value ?? '').split(/[，,、；;。/\s]+/).map((token) => token.trim()).filter((token) => [...token].length >= 2);
      const covered = DIMENSION_KEYS.filter((key) => tokensOf(dims[key]).some((token) => String(character.prompt).includes(token))).length;
      if (covered < 4) push(failures, `人物「${name || '?'}」的定妆提示词没有把六维写进去（${covered}/6 维，至少要覆盖 4 维）`);
    }
    for (const hit of bannedHits(String(character?.prompt ?? ''))) push(failures, `人物「${name || '?'}」的定妆提示词出现空话词「${hit}」`);
  }
  if (storyboard) {
    const onScreen = new Set();
    for (const shot of asArray(storyboard?.shots)) for (const person of asArray(shot?.inFrame)) {
      const who = String(person?.who ?? '').trim();
      if (who) onScreen.add(who);
    }
    for (const who of onScreen) if (!names.has(who)) push(failures, `分镜里出场的「${who}」没有人物六维档案`);
  }
  return ok(failures);
}

// ---------------------------------------------------------------------------
// 阶段五：配音方案
// ---------------------------------------------------------------------------
export function gateVoice(doc, { storyboard = null, characters = null } = {}) {
  const failures = [];
  const lines = asArray(doc?.lines);
  if (storyboard) {
    const expected = dialogueOf(storyboard);
    const got = new Set(lines.map((line) => String(line?.beatId ?? '')));
    for (const line of expected) {
      if (!got.has(line.beatId)) push(failures, `台词 ${line.beatId}（${line.speaker}）没有配音条目`);
    }
    const allowed = new Set(expected.map((line) => line.beatId));
    for (const line of lines) if (!allowed.has(String(line?.beatId ?? ''))) push(failures, `配音条目 ${line?.beatId ?? '?'} 不在这份分镜的台词里`);
    const speakers = new Set(expected.map((line) => line.speaker).filter(Boolean));
    const assigned = new Map(asArray(doc?.characters).map((row) => [String(row?.name ?? ''), String(row?.voiceId ?? '')]));
    for (const speaker of speakers) {
      const voiceId = assigned.get(speaker);
      if (!voiceId) push(failures, `说话人「${speaker}」没有指定音色`);
      else if (!VOICE_IDS.has(voiceId)) push(failures, `说话人「${speaker}」用的音色 ${voiceId} 不在音色表里`);
    }
  }
  for (const line of lines) {
    const voiceId = String(line?.voiceId ?? '');
    if (!VOICE_IDS.has(voiceId)) push(failures, `台词 ${line?.beatId ?? '?'} 的音色 ${voiceId || '（空）'} 不在音色表里`);
    if (blank(line?.emotion)) push(failures, `台词 ${line?.beatId ?? '?'} 没有标注情绪`);
    if (blank(line?.text)) push(failures, `台词 ${line?.beatId ?? '?'} 没有文本`);
  }
  if (doc?.bgm?.enabled !== false && blank(doc?.bgm?.recommended)) push(failures, '没有推荐 BGM 情绪或曲目');
  if (characters) {
    const known = new Set(asArray(characters?.characters).map((character) => String(character?.name ?? '')));
    for (const row of asArray(doc?.characters)) {
      const name = String(row?.name ?? '');
      if (name && !known.has(name)) push(failures, `配音方案里的人物「${name}」不在人物档案里`);
    }
  }
  return ok(failures);
}

// ---------------------------------------------------------------------------
// 阶段六：出片
// ---------------------------------------------------------------------------
export function gateRender(render, { storyboard = null } = {}) {
  const failures = [];
  const tasks = asArray(render?.tasks);
  if (tasks.length === 0) push(failures, '没有出片任务');
  const expected = storyboard ? segmentsOf(storyboard).map((segment) => segment.id) : [];
  const got = new Set(tasks.map((task) => String(task?.segmentId ?? '')));
  for (const id of expected) if (!got.has(id)) push(failures, `段 ${id} 没有生成结果`);
  for (const task of tasks) {
    if (task?.status !== 'completed') push(failures, `段 ${task?.segmentId ?? '?'} 状态是 ${task?.status ?? '未知'}${task?.error ? `：${task.error}` : ''}`);
    else if (blank(task?.file)) push(failures, `段 ${task?.segmentId ?? '?'} 完成了但没有落盘`);
    const duration = Number(task?.duration);
    // 上游返回的时长会有零点几秒的漂移（要 15s 给 15.1s），按 0.5 秒容差判，不误杀。
    if (Number.isFinite(duration) && (duration < 4.5 || duration > 15.5)) push(failures, `段 ${task?.segmentId ?? '?'} 时长 ${duration} 秒，超出 5–15 秒`);
  }
  return ok(failures);
}

// ---------------------------------------------------------------------------
// 阶段七：成片剪辑
// ---------------------------------------------------------------------------
export function gateEdit(edl, { render = null, project = null } = {}) {
  const failures = [];
  const order = asArray(edl?.order);
  if (order.length === 0) push(failures, '剪辑清单没有 order');
  const expected = asArray(render?.tasks).filter((task) => task?.status === 'completed').map((task) => String(task.segmentId));
  const seen = new Set();
  for (const entry of order) {
    const id = String(entry?.segmentId ?? '');
    if (!id) push(failures, '剪辑清单里有空 segmentId');
    else if (seen.has(id)) push(failures, `段 ${id} 在剪辑清单里出现多次`);
    else seen.add(id);
    const transition = String(entry?.transition ?? 'cut');
    if (!['cut', 'fade'].includes(transition)) push(failures, `段 ${id} 的转场 ${transition} 不支持（只有 cut / fade）`);
    if (Number(entry?.trimStart ?? 0) < 0) push(failures, `段 ${id} 的 trimStart 不能是负数`);
    if (entry?.trimEnd !== null && entry?.trimEnd !== undefined && Number(entry.trimEnd) <= Number(entry?.trimStart ?? 0)) {
      push(failures, `段 ${id} 的 trimEnd 必须大于 trimStart`);
    }
  }
  for (const id of expected) if (!seen.has(id)) push(failures, `段 ${id} 没有进剪辑清单`);
  // 时长对账：成片长度是硬要求，不能靠「看着差不多」。
  const target = Number(project?.targetSeconds) || 0;
  const byId = new Map(asArray(render?.tasks).map((task) => [String(task?.segmentId), task]));
  let total = 0;
  let complete = order.length > 0;
  for (const entry of order) {
    const task = byId.get(String(entry?.segmentId));
    const available = Number(task?.duration) || 0;
    if (!available) {
      complete = false;
      continue;
    }
    const start = Math.max(0, Number(entry?.trimStart) || 0);
    const end = entry?.trimEnd === null || entry?.trimEnd === undefined ? available : Math.min(Number(entry.trimEnd), available);
    total += Math.max(0, end - start);
  }
  if (target > 0 && complete && Math.abs(total - target) / target > 0.1) {
    push(failures, `成片总长 ${total.toFixed(1)} 秒，和目标 ${target} 秒差超过 10%：按每段真实可用时长重排 trim 后重新提交`);
  }
  const lufs = Number(edl?.audio?.lufs);
  if (!Number.isFinite(lufs) || lufs < -20 || lufs > -8) push(failures, `响度目标 ${edl?.audio?.lufs ?? '（空）'} 不合理（短视频建议 -16 到 -12 LUFS）`);
  if (chars(edl?.packaging?.title) < 6) push(failures, '发布包缺少标题（packaging.title，至少 6 字）');
  if (asArray(edl?.packaging?.hashtags).length < 2) push(failures, '发布包缺少至少 2 个话题标签');
  return ok(failures);
}

/** 各阶段门禁的调度表。 */
export const GATES = {
  idea: (artifact, context) => ({ ...gateIdea(artifact, context?.project), summary: '创意契约' }),
  story: (artifact, context) => ({ ...gateStory(artifact, context?.project), summary: '剧情契约' }),
  storyboard: (artifact, context) => gateStoryboard(artifact, context?.project, context?.shotContract),
  characters: (artifact, context) => ({ ...gateCharacters(artifact, { storyboard: context?.storyboard }), summary: '六维契约' }),
  voice: (artifact, context) => ({
    ...gateVoice(artifact, { storyboard: context?.storyboard, characters: context?.characters }),
    summary: '配音契约',
  }),
  render: (artifact, context) => ({ ...gateRender(artifact, { storyboard: context?.storyboard }), summary: '出片契约' }),
  edit: (artifact, context) => ({ ...gateEdit(artifact, { render: context?.render, project: context?.project }), summary: '剪辑契约' }),
};

/** 项目当前进度：给面板和 Agent 用的一句话。 */
export function progressOf(project) {
  const stages = project?.stages ?? {};
  const done = [];
  let current = null;
  for (const stage of STAGES) {
    const status = stages[stage.id]?.status ?? 'empty';
    if (status === 'done') done.push(stage.id);
    else if (!current && status !== 'skipped') current = { id: stage.id, status };
  }
  return { done, current };
}
