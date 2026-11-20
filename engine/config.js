/**
 * 配置解析：插件配置 → ~/.dsh/creative-studio/machine.json → 环境变量 → 默认值。
 * 单独放一个模块，是为了让 index.js（运行时）和 test/doctor.mjs（自检）用同一套解析，
 * 不会出现「插件能跑、doctor 说没配」的错位。
 */
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULTS = {
  projectDir: '',
  /** 独立出片任务与生图的数据目录 */
  dataDir: '',
  llmTimeoutMs: 300_000,
  llmMaxTokens: 8000,
  reviewThreshold: 80,
  /** strict：审核必须说 pass 且到阈值；balanced：门禁过、无 blocker、分数 ≥ 阈值-12 就带建议收下。 */
  reviewPolicy: 'balanced',
  maxRework: 2,
  aspectRatio: '9:16',
  resolution: '720p',
  seconds: 5,
  videoModel: 'minimax-h3-mini',
  videoProvider: 'auto',
  easyframeApiKey: '',
  easyframeBaseUrl: 'https://minimax.api.easyframe.cn',
  mnmxBaseUrl: 'https://www.runlive.top/mnmx',
  mnmxCardKey: '',
  promptOptimization: true,
  trimSubtitleBand: true,
  subtitleBandRatio: 0.18,
  imageBaseUrl: 'http://127.0.0.1:38650/v1',
  imageKey: '',
  imageModel: 'gpt-image-2',
  /** 生图后端：auto 有 Codex 就用 Codex，否则走 HTTP；也可强制 'codex' / 'http'。 */
  imageBackend: 'auto',
  /** Codex 命令行路径；留空自动找。 */
  codexCmd: '',
  ffmpegPath: '',
  bgmDir: '',
  outWidth: 1080,
  outHeight: 1920,
  skillDir: '',
  notifyWebhook: '',
  /** 参考爆款（拉片）用的脚本与解释器 */
  scriptsDir: '',
  nodePath: '',
  pythonPath: '',
  asrModel: 'medium',
  /** 可选：浏览器导出的 cookies.txt 路径（抖音「新鲜 cookie」）。 */
  cookiesFile: '',
  /** 可选：rea-video 可执行文件（逐镜判定 实拍/AI/代码 + 复刻路线）。留空就不跑。 */
  reaVideoCmd: '',
  reaVision: true,
  reaVisionShots: 12,
  reaVisionBy: 'dsh',
  finisher: 'auto',
  openfilmCmd: '',
  openfilmCheckouts: [],
  openfilmWorkers: 0,
  openfilmQuality: 'native',
  openfilmBitrate: 0,
  openfilmLook: true,
  /** 阶段提示词外置目录，默认 <dataDir>/prompts */
  promptsDir: '',
};

/** 本机覆盖文件：~/.dsh/creative-studio/machine.json（不要提交进仓库）。 */
export function machineFile() {
  return join(homedir(), '.dsh', 'creative-studio', 'machine.json');
}

export function loadMachineOverrides({ file = machineFile(), log = () => {} } = {}) {
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    log(`machine.json 读取失败（忽略）：${error.message}`);
    return {};
  }
}

/**
 * 解析成运行时选项。config 里写了的优先；留空的值一律视为没写，
 * 依次回落到 machine.json、环境变量、默认值。
 */
export function resolveConfig(config = {}, machine = loadMachineOverrides()) {
  const options = { ...DEFAULTS, ...(config ?? {}) };
  const fill = (key, envNames = []) => {
    if (options[key]) return;
    const fromFile = typeof machine[key] === 'string' ? machine[key].trim() : '';
    if (fromFile) {
      options[key] = fromFile;
      return;
    }
    for (const name of envNames) {
      if (process.env[name]) {
        options[key] = process.env[name];
        return;
      }
    }
  };
  fill('dataDir', ['CREATIVE_STUDIO_DATA']);
  fill('projectDir', ['CREATIVE_STUDIO_PROJECTS']);
  fill('easyframeApiKey', ['EASYFRAME_API_KEY']);
  fill('mnmxCardKey', ['MNMX_CARD_KEY']);
  fill('imageKey', ['IMAGE_API_KEY', 'OPENAI_API_KEY']);
  fill('imageBackend');
  fill('codexCmd', ['CODEX_BIN']);
  fill('ffmpegPath', ['FFMPEG_PATH']);
  fill('bgmDir');
  fill('skillDir', ['SHOT_CONTRACT_DIR']);
  fill('scriptsDir', ['DOUYIN_TEARDOWN_SCRIPTS']);
  fill('reaVideoCmd');
  fill('openfilmCmd', ['OPENFILM_BIN']);
  fill('promptsDir', ['CREATIVE_STUDIO_PROMPTS']);

  const dataRoot = options.dataDir || join(homedir(), '.dsh', 'creative-studio');
  // 技能目录留空就用 ~/.dsh/skills 下的标准位置，换机器不用改配置。
  if (!options.skillDir) options.skillDir = join(homedir(), '.dsh', 'skills', 'shot-contract');
  if (!options.scriptsDir) options.scriptsDir = join(homedir(), '.dsh', 'skills', 'douyin-teardown', 'scripts');

  const projectRoot = options.projectDir || join(dataRoot, 'projects');
  const promptsDir = options.promptsDir || join(dataRoot, 'prompts');
  return { options, dataRoot, projectRoot, promptsDir, machine };
}
