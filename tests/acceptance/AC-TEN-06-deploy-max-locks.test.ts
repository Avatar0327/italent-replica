/**
 * AC-TEN-06 补（F-093，DEC-424②）：整库迁移 / 恢复保持单事务，部署目标的
 * max_locks_per_transaction 须至少为 256；看不到有效参数值时同样失败。
 * 模拟 SHOW 结果，不修改共享 PostgreSQL 集群配置；三个阶段均验证该部署前置条件。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDeployTarget, PHASES, type Query, readCodeMigrations } from '../../scripts/check-deploy-target.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const MIGRATIONS = readCodeMigrations(REPO);
const CHECK = 'PostgreSQL max_locks_per_transaction ≥ 256';
const SHOW = 'SHOW max_locks_per_transaction';

/** 其他部署前置条件均满足，仅替换目标库当前生效参数的 SHOW 回执。 */
function targetQuery(setting: () => ReturnType<Query>, observed: string[]): Query {
  return async (text) => {
    observed.push(text);
    if (text === SHOW) return setting();
    if (text.includes('pg_read_all_stats')) return [{ super: true, bypass: true, stats: true }];
    if (text.includes('to_regclass')) return [{ found: true }];
    if (text.includes('drizzle.__drizzle_migrations')) return [{ n: MIGRATIONS.count, last: MIGRATIONS.last }];
    if (text.includes('count(*)')) return [{ n: 0 }];
    throw new Error(`测试未定义查询：${text}`);
  };
}

describe.each(PHASES)('AC-TEN-06 部署锁容量（%s，DEC-424②）', (phase) => {
  const run = async (setting: () => ReturnType<Query>) => {
    const observed: string[] = [];
    const result = await checkDeployTarget({
      phase,
      query: targetQuery(setting, observed),
      codeRoot: REPO,
      appRole: 'italent_app',
      sessions: async () => ({ marked: 0, unmarked: 0 }),
    });
    return { result, observed, capacity: result.results.find((entry) => entry.name === CHECK) };
  };

  it.each(['256', '512'])('AC-TEN-06 参数 %s 足够 → 通过，并确认读取了当前生效值', async (value) => {
    const { result, observed, capacity } = await run(async () => [{ max_locks_per_transaction: value }]);
    expect(result.ok).toBe(true);
    expect(capacity).toEqual({ name: CHECK, ok: true, detail: '' });
    expect(observed.filter((text) => text === SHOW)).toEqual([SHOW]);
    expect(observed.every((text) => /^(SELECT|SHOW)\b/.test(text))).toBe(true);
  });

  it.each(['64', '255'])('AC-TEN-06 参数 %s 不足 → 失败，报告当前值与部署门槛', async (value) => {
    const { result, capacity } = await run(async () => [{ max_locks_per_transaction: value }]);
    expect(result.ok).toBe(false);
    expect(result.results.filter((entry) => !entry.ok)).toEqual([capacity]);
    expect(capacity).toMatchObject({ name: CHECK, ok: false });
    expect(capacity!.detail).toContain(value);
    expect(capacity!.detail).toContain('256');
    expect(capacity!.detail).toContain('重启');
  });

  it.each([
    { reason: '无行', rows: [] },
    { reason: '缺少参数列', rows: [{}] },
    { reason: '参数值不可见', rows: [{ max_locks_per_transaction: null }] },
    { reason: '空字符串', rows: [{ max_locks_per_transaction: '' }] },
    { reason: '带非法后缀', rows: [{ max_locks_per_transaction: '256locks' }] },
    { reason: '小数', rows: [{ max_locks_per_transaction: '256.5' }] },
    { reason: '超过安全整数', rows: [{ max_locks_per_transaction: '9007199254740992' }] },
    { reason: '多行回执', rows: [{ max_locks_per_transaction: '256' }, { max_locks_per_transaction: '64' }] },
  ])('AC-TEN-06 SHOW $reason → 失败，不把看不全当成满足', async ({ rows }) => {
    const { result, capacity } = await run(async () => rows);
    expect(result.ok).toBe(false);
    expect(result.results.filter((entry) => !entry.ok)).toEqual([capacity]);
    expect(capacity).toMatchObject({ name: CHECK, ok: false });
    expect(capacity!.detail).toContain('无法确认');
  });

  it('AC-TEN-06 SHOW 读取被拒绝 → 失败，保留具体错误且继续报告其余检查', async () => {
    const { result, capacity } = await run(async () => {
      throw new Error('无法读取 max_locks_per_transaction');
    });
    expect(result.ok).toBe(false);
    expect(capacity).toEqual({ name: CHECK, ok: false, detail: '无法读取 max_locks_per_transaction' });
    expect(result.results.some((entry) => entry.name.includes('迁移') && entry.ok)).toBe(true);
  });
});
