/**
 * 继任定时任务的进程登记位（R3-T05 设计 §4.6；DEC-343①）：server.ts 启动本调度，任务随 PR 追加到 SUCCESSION_JOBS——
 * PR-A 离职自动结束的夜间 sweep（exit_sweep），PR-B 职位风险与组织统计（position_risk / org_stats）。
 * 每个任务自己按租户时区与幂等键去重（AGENTS §10「定时任务」），这里只负责按间隔串行触发：同一进程上一轮未结束时
 * 不叠加新一轮；一个任务失败只上报，不影响其他任务。没有任务时不起定时器。
 */
import type { Db } from '@italent/db';

export type SuccessionJobKind = 'exit_sweep' | 'position_risk' | 'org_stats';

export interface SuccessionJob {
  readonly kind: SuccessionJobKind;
  run(db: Db, now: Date): Promise<void>;
}

export const SUCCESSION_JOBS: readonly SuccessionJob[] = [];

export interface SuccessionScheduler {
  stop(): Promise<void>;
}

export function startSuccessionScheduler(
  db: Db,
  options: {
    readonly intervalMs?: number;
    readonly jobs?: readonly SuccessionJob[];
    readonly clock?: () => Date;
    readonly onError?: (kind: SuccessionJobKind, error: unknown) => void;
  } = {},
): SuccessionScheduler {
  const jobs = options.jobs ?? SUCCESSION_JOBS;
  if (!jobs.length) return { stop: async () => undefined };
  const intervalMs = options.intervalMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000)
    throw new RangeError('继任定时任务间隔须为不小于 1000 的毫秒数');
  const clock = options.clock ?? (() => new Date());
  const onError = options.onError ?? ((kind, error) => console.error(`继任定时任务 ${kind} 运行失败`, error));
  let running: Promise<void> | null = null;
  const runAll = async () => {
    for (const job of jobs) await job.run(db, clock()).catch((error: unknown) => onError(job.kind, error));
  };
  const tick = () => {
    if (running) return;
    running = runAll().finally(() => {
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
