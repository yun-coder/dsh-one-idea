/**
 * 阶段指纹：判定「这一版产物是谁做的」——哪个模型、哪一版提示词。
 *
 * 为什么需要它：工作台每个阶段的产物（分镜 / 人物 / 剪辑清单）都是模型写的，而模型和
 * 提示词都会变。没有指纹的时候，换完模型再跑，前面那些「已完成」的阶段照样按 done 跳过，
 * 于是新模型接着用旧模型的判断往下做——错配不报错，只是结果悄悄变差。
 *
 * 指纹只做两件事：算一个短 hash，比一下对不对。两边任一不同，就认为旧产物该重做。
 *   · 提示词层：engine 里三个承载提示词/契约的文件内容 + 可选的 promptsDir 下的 *.md
 *   · 模型层：宿主当前默认模型（provider:model）
 *
 * 注意：**没有指纹的老项目按「不知道」处理，继续跳过**。宁可漏判一次，
 * 也不要因为一次升级把所有历史项目的阶段全部作废、让用户白花钱重跑。
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 承载提示词与门禁的文件：它们变了，产物的判定标准就变了。 */
const PROMPT_LAYER = ['agents.js', 'contracts.js', 'platform.js'];

/** 提示词层指纹（12 位十六进制）。读不到文件时退化成文件名，不会抛错。 */
export function promptLayerFingerprint(promptsDir = '') {
  const hash = createHash('sha1');
  for (const name of PROMPT_LAYER) {
    hash.update(`#${name}\n`);
    try {
      hash.update(readFileSync(join(HERE, name)));
    } catch {
      hash.update('missing');
    }
  }
  if (promptsDir) {
    try {
      for (const file of readdirSync(promptsDir).sort()) {
        if (!file.endsWith('.md')) continue;
        hash.update(`#${file}\n`);
        try {
          hash.update(readFileSync(join(promptsDir, file)));
        } catch {
          hash.update('missing');
        }
      }
    } catch {
      // 没有 promptsDir 属于正常情况（用内置提示词）
    }
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * 两个指纹是否一致。stamp 缺失一律视为「不知道」，返回 false——
 * 由调用方决定缺失时是跳过还是重跑（当前实现选择跳过，见 index.js）。
 */
export function matchesStamp(stamp, current) {
  if (!stamp || !current) return false;
  if (!stamp.model || !stamp.prompts) return false;
  return stamp.model === current.model && stamp.prompts === current.prompts;
}
