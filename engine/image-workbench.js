/**
 * 读取「生图工作台」（dsh-plugin-image-workbench）里配置的接口。
 *
 * 不复制它的面板，也不改它的配置：只在出图时读一次 config.local.json，
 * 拿到 Base URL / Key / 图片模型，直接按 OpenAI 兼容协议调用。
 * 工作台换接口，这边下一次出图就跟着换。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 工作台的配置位置：显式文件 > 显式目录 > 环境变量 > 默认运行目录。 */
export function workbenchConfigFile({ serverDir = '', file = '' } = {}) {
  if (file) return file;
  if (serverDir) return join(serverDir, 'config.local.json');
  if (process.env.DSH_IMAGE_SERVER_DIR) return join(process.env.DSH_IMAGE_SERVER_DIR, 'config.local.json');
  return join(homedir(), '.dsh', 'image-workbench', 'server', 'config.local.json');
}

/** 读到就返回接口配置，读不到（没装工作台 / 没配接口）返回 null。 */
export function readWorkbenchImage(options = {}) {
  const file = workbenchConfigFile(options);
  if (!existsSync(file)) return null;
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const baseUrl = String(cfg?.api_base_url || cfg?.pool_base_url || '').trim().replace(/\/+$/, '');
  const apiKey = String(cfg?.api_key || '').trim();
  if (!baseUrl || !apiKey) return null;
  return {
    file,
    baseUrl,
    apiKey,
    model: String(cfg?.model_image || 'gpt-image-2'),
    providerName: String(cfg?.provider_name || '生图工作台'),
    responseFormat: String(cfg?.image_response_format || 'auto'),
    supportsEdits: cfg?.supports_edits !== false,
  };
}
