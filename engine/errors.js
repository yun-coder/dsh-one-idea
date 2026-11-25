/**
 * 报错文案：面板上只该出现一句能看懂的话。
 *
 * 底层错误（execFile / fs / 上游接口）经常带着命令行、堆栈、成百上千行日志。
 * 原样塞进 project.json、再显示到面板上，用户看到的就是一堵红字，既看不懂也不知道下一步。
 * 这里统一压成一句：去掉噪音行、去掉重复行、优先保留中文提示、按需截断。
 */

/** 这些行对用户没有信息量，直接丢掉。 */
const NOISE = [
  /^Command failed:/i,
  /^node:internal\b/,
  /^Node\.js v\d/i,
  /^\s*at\s+\S+\s+\(/,          // 堆栈
  /^\s*at\s+\S+:\d+:\d+/,       // 堆栈（无括号）
  /^\s*\.\.\.\s*\d+\s+lines?\s+omitted/i,
  /^\s*\^+\s*$/,                // 报错上下文里用来指位置的那一行
];

/** 常见系统错误码的一句话解释。 */
const SYSTEM = {
  ENOENT: '文件或目录已经不在了',
  EACCES: '没有权限访问',
  EPERM: '文件被占用或没有权限',
  EBUSY: '文件正被其他程序占用',
  ENOTEMPTY: '目录还没清空',
  ENOSPC: '磁盘空间不足',
  EMFILE: '同时打开的文件太多',
  ETIMEDOUT: '等待超时',
  ECONNREFUSED: '连接被拒绝（服务没开？）',
  ECONNRESET: '连接被对方断开',
};

const CJK = /[\u4e00-\u9fa5]/;

/**
 * 把一段可能是「几百行日志」的文本压成一句话。
 *
 * - 丢掉命令行、堆栈、省略号这类噪音，去重；
 * - 有中文提示就只留中文行（脚本自己写的中文提示最有用）；
 * - 没有中文就留最后几行（错误的现场通常在末尾）；
 * - 最后按 max 截断，并带一个省略号表示「还有更多」。
 */
export function compactMessage(input, { max = 240 } = {}) {
  const raw = String(input ?? '').replace(/\r/g, '').trim();
  if (!raw) return '';
  const seen = new Set();
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !NOISE.some((rule) => rule.test(line)))
    .map((line) => line.replace(/[ \t]+/g, ' '))
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });

  const source = lines.length > 0 ? lines : [raw.replace(/\s+/g, ' ')];
  const hints = source.filter((line) => CJK.test(line));
  const picked = hints.length > 0 ? hints : source.slice(-3);

  let out = '';
  for (const line of picked) {
    const next = out ? `${out} ${line}` : line;
    if (next.length > max) {
      if (!out) out = next.slice(0, max);
      break;
    }
    out = next;
  }
  if (!out) out = picked.join(' ').slice(0, max);
  if (out.length < picked.join(' ').length) out = `${out.replace(/[\s，、；,;]+$/, '')}…`;
  return out;
}

/**
 * 错误对象 → 一句人话。系统错误码优先翻译（并带上出问题的路径），
 * 其余交给 compactMessage，实在没有信息就用 fallback。
 */
export function friendlyError(error, fallback = '操作失败') {
  const raw = String(error instanceof Error ? error.message : error ?? '').trim();
  if (!raw) return fallback;
  const code = typeof error?.code === 'string' && SYSTEM[error.code]
    ? error.code
    : /\b(E[A-Z]{3,})\b/.exec(raw)?.[1] ?? '';
  if (SYSTEM[code]) {
    const path = /(?:open|stat|lstat|unlink|rm|rmdir|scandir|rename|copyfile|mkdir) '([^']+)'/i.exec(raw)?.[1]
      ?? /'([^']+)'/.exec(raw)?.[1];
    return `${SYSTEM[code]}${path ? `：${path}` : ''}`;
  }
  return compactMessage(raw, { max: 240 }) || fallback;
}
