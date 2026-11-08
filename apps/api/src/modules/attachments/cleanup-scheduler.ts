/**
 * F-479 S3 清理调度器（设计 §2.5）：沿用合同 / 定时生效调度的写法——启动即跑一轮，之后按间隔再跑；
 * 一轮未结束时跳过新的一轮；stop() 等待在途轮次。多实例同时运行靠文件行 FOR UPDATE SKIP LOCKED 与状态复核去重。
 * 测试注入 clock，不依赖真实等待。
 */
import type { Db } from '@italent/db';
import { cleanupFailureReason, runAttachmentCleanup, type CleanupRun } from './cleanup.js';
import type { AttachmentBlobStore } from './blob-store.js';

export interface AttachmentCleanupScheduler {
  stop(): Promise<void>;
}

export function startAttachmentCleanupScheduler(
  db: Db,
  options: {
    readonly intervalMs?: number;
    readonly clock?: () => Date;
    readonly store?: AttachmentBlobStore;
    readonly onError?: (error: unknown) => void;
  } = {},
): AttachmentCleanupScheduler {
  const intervalMs = options.intervalMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000)
    throw new RangeError('附件清理间隔须为不小于 1000 的毫秒数');
  const clock = options.clock ?? (() => new Date());
  const onError = options.onError ?? ((error: unknown) => console.error('附件清理运行失败', error));
  const report = (runs: readonly CleanupRun[]) => {
    // 单文件失败已记入 attachment_cleanup_attempts 并会在下一轮重试；这里只上报，便于运维发现持续失败
    const failed = runs.flatMap((run) =>
      run.outcomes.filter((o) => o.state === 'failed').map((o) => ({ tenantId: run.tenantId, ...o })),
    );
    if (failed.length) onError(new Error(`附件清理失败 ${failed.length} 条：${JSON.stringify(failed)}`));
  };
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = runAttachmentCleanup({ db, clock, ...(options.store ? { store: options.store } : {}) })
      .then((result) => report(result.runs))
      // 整轮抛出的异常可能是带 SQL / 参数的驱动错误：只上报白名单码，不把原始异常交给日志
      .catch((error: unknown) => onError(new Error(`附件清理运行失败：${cleanupFailureReason(error)}`)))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
