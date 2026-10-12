/**
 * AC-360-06 / F-088 大租户性能后补：显式 F088_PERFORMANCE=1 才运行，不进入 CI 关键路径。
 * 合成 10,000 名当前下级（含完整任职链）；仅报告 HTTP 命令耗时，不把机器速度设成 CI 门禁。
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boundedScene, useBoundedDb } from './AC-360-F088-support.js';

describe.skipIf(process.env.F088_PERFORMANCE !== '1')('AC-360-06 / F-088 10,000 名下级性能', () => {
  const testDb = useBoundedDb();
  it('添加 1 名与末位范围候选：每次锁 1 人，候选每页最多 100 人', async () => {
    const s = await boundedScene(testDb().db, 'f088perf', 10_000);
    const measurements = [];
    for (const restricted of [false, true]) {
      if (restricted)
        s.access.scope = {
          ...s.access.scope,
          all: false,
          personIds: [s.manager.id, s.id(10_000)],
          terms: [{ dimension: 'reporting', orgIds: [], personIds: [s.manager.id, s.id(10_000)] }],
        };
      s.observations.length = 0;
      const started = performance.now();
      const response = await s.auto();
      const result = (await response.json()) as { added: unknown[] };
      const elapsed = performance.now() - started;
      expect(response.status).toBe(200);
      expect(result.added).toHaveLength(1);
      expect(s.locks().flatMap((o) => o.ids)).toHaveLength(1);
      expect(s.pages()).toHaveLength(1);
      expect(s.pages()[0]!.ids.length).toBeLessThanOrEqual(100);
      const measurement = {
        employees: 10_000,
        restricted,
        elapsedMs: Math.round(elapsed),
        candidateRows: s.pages()[0]!.ids.length,
        employeeLocks: s.locks()[0]!.ids.length,
      };
      measurements.push(measurement);
      process.stdout.write(`${JSON.stringify(measurement)}\n`);
    }
    const report = process.env.F088_PERFORMANCE_REPORT;
    if (report) writeFileSync(report, JSON.stringify({ generatedEmployees: 10_000, seedEmployees: 2, measurements }));
  }, 600_000);
});
