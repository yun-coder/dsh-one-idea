/**
 * 示例项目：把 demo/ 里的媒体复制到目标项目目录，替换模板里的占位路径。
 * 单独成模块，便于测试（不需要起插件），也让 index.js 里的 createDemo 保持很薄。
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @param {object} input
 * @param {string} input.demoDir  包里的 demo 目录
 * @param {string} input.dir      目标项目目录（<projectDir>/<id>）
 * @returns {Promise<{ template: object, files: Record<string, string> }>}
 */
export async function materializeDemo({ demoDir, dir }) {
  const template = JSON.parse(await readFile(join(demoDir, 'project.template.json'), 'utf8'));
  const files = {
    __SEG_1__: join(dir, 'segments', 'demo-01.mp4'),
    __SEG_2__: join(dir, 'segments', 'demo-02.mp4'),
    __FINAL__: join(dir, '07-final.mp4'),
    __COVER__: join(dir, 'cover.jpg'),
  };
  await mkdir(join(dir, 'segments'), { recursive: true });
  await copyFile(join(demoDir, 'segments', 'demo-01.mp4'), files.__SEG_1__);
  await copyFile(join(demoDir, 'segments', 'demo-02.mp4'), files.__SEG_2__);
  await copyFile(join(demoDir, '07-final.mp4'), files.__FINAL__);
  await copyFile(join(demoDir, 'cover.jpg'), files.__COVER__);

  // 递归替换占位路径：不走 JSON 字符串替换，免得 Windows 反斜杠把 JSON 弄坏。
  const fill = (value) => {
    if (typeof value === 'string') return files[value] ?? value;
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fill(entry)]));
    }
    return value;
  };
  return { template: fill(template), files };
}
