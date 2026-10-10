/**
 * 报告 PDF / 报表 PNG 的运行时保护（F-060 第 2 轮，PR #174 审查 P2-3 / P2-4；F-080 改字体方案；与版面无关，
 * export-files.ts 再导出）：
 * - 字体：用项目内置的中文字体（export-fonts.ts），不依赖服务器安装的字体，不再探测系统字体、不再有“缺字体 503”；
 *   内置字体缺失 / 被改动是启动期错误（exportStartupCheck 抛错，进程拒绝启动）；
 * - 应用层并发准入：全局与同租户各一个上限，满了立即 503 EXPORT_BUSY（不排队，避免请求堆积占内存）；渲染超过超时 503
 *   EXPORT_TIMEOUT，同时经 AbortSignal 取消渲染——栅格化在可终止的子进程里（export-raster.ts），超时即终止子进程，
 *   名额随即释放，没有残余进程（F-080，#174 第 3 轮 P3-1）；
 * - 像素预算：PNG 长图渲染前按排版高度检查（export-files.ts 的 Layout 使用 pixelBudget）。
 * 上限值是开发方定的工程保护（规格没有），可用 configureExport 调整（测试与部署参数）。
 */
import { AppError } from '../../errors.js';
import { exportFontDirectory, verifyExportFonts } from './export-fonts.js';

// ---- 字体 --------------------------------------------------------------------------------------------------------

/** 启动检查：内置字体缺失 / 被改动时抛错（启动失败）；通过时记一行已校验的字体清单。directory 仅测试使用。 */
export async function exportStartupCheck(
  log: (line: string) => void,
  directory = exportFontDirectory(),
): Promise<void> {
  const files = await verifyExportFonts(directory);
  log(`内置中文字体已校验（${files.map((f) => f.file).join('、')}）`);
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
