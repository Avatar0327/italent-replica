/**
 * 证据门禁族的文件级超时（F-501，同时覆盖 F-488）。
 *
 * 为什么需要：每个测试文件是独立进程，真实源码的依赖闭包解析（逐文件 TypeScript 解析、全表求闭包 / 登记）无法跨文件共享，
 * 文件里第一个碰真实登记的用例要付一次冷启动代价；断言本身与耗时无关。实测（本机 load 10～18）冷启动约 6～16 秒、
 * 单条最慢约 15～24 秒，负载 30+ 或 CI 分片（约 2～3 倍慢）下越过全局 30 秒用例 / 60 秒钩子上限。
 *
 * 取值依据：已知最大用时 30.5 秒（F-488，run 42176928417 shard 2/5）× 4 ≈ 120 秒。只对调用的文件生效
 * （`vi.setConfig` 只作用于当前测试文件），不动 vitest.config.ts 的全局上限；个别用例自己写了更长超时的，仍以自己的为准。
 */
import { vi } from 'vitest';

export const EVIDENCE_SCAN_TIMEOUT_MS = 120_000;

/** 在测试文件顶层（所有 describe / it / beforeAll 之前）调用一次：本文件的用例与钩子超时放宽到 120 秒。 */
export function allowEvidenceScan(): void {
  vi.setConfig({ testTimeout: EVIDENCE_SCAN_TIMEOUT_MS, hookTimeout: EVIDENCE_SCAN_TIMEOUT_MS });
}
