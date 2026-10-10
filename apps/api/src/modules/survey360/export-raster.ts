/**
 * 报告 PDF / 报表 PNG 的栅格化执行（F-080，#174 第 3 轮 P3-1 遗留）：
 * - sharp / libvips 的一次原生渲染无法从 JS 里中止，它自带的超时只有整秒精度，应用层超时（EXPORT_TIMEOUT）之后底层
 *   还要再跑约 1.5 秒才停下并释放并发名额。现在栅格化放在单独的子进程里（assets/raster-worker.mjs）：signal 中止
 *   （超时）时直接 SIGKILL 子进程，等它真正退出后才返回，所以并发名额在超时后立即释放，也不会留下残余进程；
 * - 一份文件（PNG 一页、PDF 多页）共用一个子进程，逐页发请求；结束或出错都关闭子进程；
 * - 子进程的环境只有 PATH 与内置字体的 fontconfig 配置（export-fonts.ts），不继承服务进程的环境变量；
 * - 子进程由本进程的 IPC 通道看管：本进程退出时子进程随之退出。
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppError } from '../../errors.js';
import { exportFontEnv } from './export-fonts.js';

const WORKER = fileURLToPath(new URL('../../../assets/raster-worker.mjs', import.meta.url));

export interface RasterRequest {
  readonly svg: string;
  readonly density: number;
  readonly limitInputPixels: number;
  /** libvips 自带超时（整秒），作为兜底；真正的取消靠终止子进程。 */
  readonly timeoutSeconds: number;
  /** png：编码好的 PNG；raw：RGB 原始像素（PDF 位图页）。 */
  readonly format: 'png' | 'raw';
}

export interface Raster {
  readonly data: Buffer;
  readonly width?: number;
  readonly height?: number;
}

export interface RasterSession {
  render(request: RasterRequest): Promise<Raster>;
  /** 终止子进程并等它退出（幂等）。 */
  close(): Promise<void>;
}

interface Reply {
  readonly id: number;
  readonly ok: boolean;
  readonly message?: string;
  readonly data?: Uint8Array;
  readonly width?: number;
  readonly height?: number;
}
interface Pending {
  readonly resolve: (raster: Raster) => void;
  readonly reject: (error: unknown) => void;
}

let active = 0;
/** 当前存活的栅格化子进程数（测试与监控用：取消后必须回到 0）。 */
export const activeRasterProcesses = (): number => active;

const renderFailed = (detail: string) =>
  new AppError('SERVICE_UNAVAILABLE', '文件生成失败，请稍后重试', { reason: 'EXPORT_RENDER_FAILED', detail });

/** 启动栅格化会话；signal 已中止时不启动子进程，运行中中止则终止子进程，等待中的请求以 signal.reason 失败。 */
export async function openRaster(signal?: AbortSignal): Promise<RasterSession> {
  const env = await exportFontEnv();
  signal?.throwIfAborted();
  const child = fork(WORKER, [], {
    execArgv: [],
    env,
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  active += 1;
  const pending = new Map<number, Pending>();
  let aborted: unknown;
  let nextId = 0;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      active -= 1;
      for (const waiter of pending.values()) waiter.reject(aborted ?? renderFailed('栅格化进程意外退出'));
      pending.clear();
      resolve();
    });
  });
  child.on('error', () => child.kill('SIGKILL'));
  child.on('message', (reply: Reply) => {
    const waiter = pending.get(reply.id);
    pending.delete(reply.id);
    if (!waiter) return;
    if (reply.ok) {
      const { data = new Uint8Array(), width, height } = reply;
      waiter.resolve({ data: Buffer.from(data.buffer, data.byteOffset, data.byteLength), width, height });
    } else waiter.reject(new Error(reply.message ?? '栅格化失败'));
  });
  const onAbort = () => {
    aborted = signal!.reason;
    child.kill('SIGKILL');
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return {
    render: (request) =>
      new Promise<Raster>((resolve, reject) => {
        if (aborted !== undefined || child.exitCode !== null || child.signalCode !== null)
          return reject(aborted ?? renderFailed('栅格化进程已退出'));
        const id = (nextId += 1);
        pending.set(id, { resolve, reject });
        child.send({ id, ...request }, (error) => {
          if (error && pending.delete(id)) reject(renderFailed('无法向栅格化进程发送请求'));
        });
      }),
    close: async () => {
      signal?.removeEventListener('abort', onAbort);
      child.kill('SIGKILL');
      await exited;
    },
  };
}
