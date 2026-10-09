/**
 * 报告 PDF / 报表 PNG 的运行时保护（F-060 第 2 轮，PR #174 审查 P2-3 / P2-4；与版面无关，export-files.ts 再导出）：
 * - 字体覆盖：用 fontconfig 的 `fc-list` 查系统里有没有覆盖目标汉字的字体，不靠“比较缺字方框”（缺字方框里带各自的
 *   Unicode 编码，像素并不相同）。fc-list 与 sharp（librsvg + fontconfig）读同一套配置，隔离 FONTCONFIG_FILE 时同样隔离；
 *   命令不存在（镜像里没装 fontconfig）按缺字体处理。镜像需要安装 `fontconfig` 与 `fonts-noto-cjk`（或 `fonts-wqy-zenhei`），
 *   启动时 exportStartupCheck 记一条警告；
 * - 应用层并发准入：全局与同租户各一个上限，满了立即 503 EXPORT_BUSY（不排队，避免请求堆积占内存）；渲染超过超时 503
 *   EXPORT_TIMEOUT，同时经 AbortSignal 取消渲染（PDF 逐页检查，F-060 第 3 轮 P3）；名额一直占到底层渲染真正停下，
 *   超时不会让并发数悄悄超限，也不会让后台把整份文件继续生成完；
 * - 像素预算：PNG 长图渲染前按排版高度检查（export-files.ts 的 Layout 使用 pixelBudget）。
 * 上限值是开发方定的工程保护（规格没有），可用 configureExport 调整（测试与部署参数）。
 */
import { execFile } from 'node:child_process';
import { AppError } from '../../errors.js';

// ---- 字体 --------------------------------------------------------------------------------------------------------

/** 目标字符集：报告 / 报表里固定出现的汉字（版面标题、表头）。 */
const PROBE_CHARS = '中文报告评价得分';
const PROBE_CODEPOINTS = [...PROBE_CHARS].map((c) => c.codePointAt(0)!.toString(16)).join(' ');
export const FONT_INSTALL_HINT = 'fontconfig 与 fonts-noto-cjk（或 fonts-wqy-zenhei）';

type FcRun = (env: NodeJS.ProcessEnv) => Promise<string>;

const fcList: FcRun = (env) =>
  new Promise((resolve, reject) =>
    execFile(
      'fc-list',
      [`:charset=${PROBE_CODEPOINTS}`, 'file'],
      { env, timeout: 5000, maxBuffer: 1 << 20 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );

/** 系统里是否有覆盖目标汉字的字体：fc-list 有输出即有；空输出 / 命令不存在 / 超时 / 失败都按缺字体。 */
export async function probeFontCoverage(options: { env?: NodeJS.ProcessEnv; run?: FcRun } = {}): Promise<boolean> {
  try {
    return (await (options.run ?? fcList)(options.env ?? process.env)).trim().length > 0;
  } catch {
    return false;
  }
}

const PROBE_TTL_MS = 60_000;
let override: (() => Promise<boolean>) | undefined;
let cached: { at: number; value: Promise<boolean> } | undefined;

/** 测试与特殊部署用：固定探测结果（undefined 恢复真实探测）。 */
export function overrideFontProbe(fn: (() => Promise<boolean>) | undefined): void {
  override = fn;
  cached = undefined;
}

/** 缓存 1 分钟：装好字体后不必重启，也不会每个请求都起一次子进程。 */
export function exportFontReady(): Promise<boolean> {
  if (override) return override();
  const now = Date.now();
  if (!cached || now - cached.at > PROBE_TTL_MS) cached = { at: now, value: probeFontCoverage() };
  return cached.value;
}

export async function requireFont(): Promise<void> {
  if (!(await exportFontReady()))
    throw new AppError('SERVICE_UNAVAILABLE', '服务器缺少中文字体，暂时不能生成文件', {
      reason: 'EXPORT_FONT_UNAVAILABLE',
    });
}

/** 启动检查：缺字体时记一条警告（不阻止启动：其余功能不受影响），部署上线前据此补装。 */
export async function exportStartupCheck(log: (line: string) => void): Promise<void> {
  if (await exportFontReady()) return;
  log(
    `EXPORT_FONT_UNAVAILABLE：服务器没有覆盖简体中文的字体，360 报告 PDF / 报表 PNG 下载将返回 503；` +
      `请在运行镜像安装 ${FONT_INSTALL_HINT}。`,
  );
}

// ---- 配置与并发准入 -----------------------------------------------------------------------------------------------

export interface ExportConfig {
  /** 同时渲染的上限（进程内，所有租户合计）。 */
  globalLimit: number;
  /** 同一租户同时渲染的上限。 */
  tenantLimit: number;
  /** 单次渲染超时（毫秒）。 */
  timeoutMs: number;
  /** PNG 长图像素预算（栅格化后的像素数；libvips 默认上限 2.68 亿，这里取更保守的 4000 万）。 */
  pixelBudget: number;
}

const DEFAULTS: Readonly<ExportConfig> = { globalLimit: 3, tenantLimit: 2, timeoutMs: 60_000, pixelBudget: 40_000_000 };
let config: ExportConfig = { ...DEFAULTS };

export const exportConfig = (): Readonly<ExportConfig> => config;
export function configureExport(patch: Partial<ExportConfig>): void {
  config = { ...config, ...patch };
}
export function resetExport(): void {
  config = { ...DEFAULTS };
}

let active = 0;
const perTenant = new Map<string, number>();

const unavailable = (reason: 'EXPORT_BUSY' | 'EXPORT_TIMEOUT', message: string) =>
  new AppError('SERVICE_UNAVAILABLE', message, { reason });

/**
 * 并发准入 + 超时：名额满立即 EXPORT_BUSY；run 超时 EXPORT_TIMEOUT 并中止 signal（渲染在下一页前停下），名额保留到
 * run 真正结束。tenantKey 是租户标识，仅用于计数，不进入任何响应。
 */
export async function admitted<T>(tenantKey: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const mine = perTenant.get(tenantKey) ?? 0;
  if (active >= config.globalLimit || mine >= config.tenantLimit)
    throw unavailable('EXPORT_BUSY', '文件生成任务过多，请稍后重试');
  active += 1;
  perTenant.set(tenantKey, mine + 1);
  const release = () => {
    active -= 1;
    const left = (perTenant.get(tenantKey) ?? 1) - 1;
    if (left <= 0) perTenant.delete(tenantKey);
    else perTenant.set(tenantKey, left);
  };
  const controller = new AbortController();
  const task = new Promise<T>((resolve) => resolve(run(controller.signal)));
  void task.then(release, release);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const timeout = unavailable('EXPORT_TIMEOUT', '文件生成超时，请稍后重试');
          controller.abort(timeout);
          reject(timeout);
        }, config.timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
