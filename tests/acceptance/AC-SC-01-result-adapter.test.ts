/**
 * AC-SC-01 公共包装器可复用（R3-T05 A2，拆分方案 P3-1、审查第 1 轮）：`authorizeSuccessionResult` 不绑定继任记录——
 * B2a（人员范围、规则设置）、B3（计算 run）只需提供各自的结果对象适配器，统一出口不变：
 * - 适配器的读取 / 投影按调用方给的对象执行，ID 顺序与台账一致；
 * - 命令 ID 的审计足迹里的对象 ID 会并入复核（台账之外被同一命令动过的对象不可见 → 整体 404）；
 * - 适配器判定不可见（抛 404）或数量不符，一律 404，不返回任何结果。
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { recordAudit } from '../../apps/api/src/audit/record.js';
import { AppError } from '../../apps/api/src/errors.js';
import {
  authorizeSuccessionResult,
  type ResultAdapter,
  type ResultView,
  type StoredResult,
} from '../../apps/api/src/modules/succession/write-support.js';
import { type SuccessionWorld, successionWorld } from './AC-SC-support.js';

const testDb = useTestDb();

interface FakeView extends ResultView {
  readonly name: string;
}

describe('AC-SC-01 结果对象适配器（authorizeSuccessionResult 公共出口）', () => {
  let w: SuccessionWorld;
  beforeAll(async () => {
    w = await successionWorld(testDb().db, 'sc-adapter');
  });

  const ctx = () => ({ tenantId: w.tenant.id, userId: w.user.id, now: new Date(), timezone: 'Asia/Shanghai' });
  const deps = () => ({ db: w.db });
  const adapter = (visible: ReadonlySet<string>, seen: string[][] = []): ResultAdapter<FakeView> => ({
    object: 'riskResult',
    load: async (_tx, _deps, _ctx, ids) => {
      seen.push([...ids]);
      const found = ids.filter((id) => visible.has(id));
      if (found.length !== ids.length) throw new AppError('NOT_FOUND', '对象不存在');
      return {
        views: found.map((id) => ({ id, name: `n-${id.slice(0, 4)}` })),
        revisions: new Map(found.map((id) => [id, 3])),
      };
    },
    project: async (_deps, _ctx, views) => views.map((view) => ({ id: view.id })),
  });
  const run = (result: StoredResult, results: ResultAdapter<FakeView>) =>
    authorizeSuccessionResult(deps() as never, ctx() as never, result, results);

  it('按台账 ID 顺序返回，投影由适配器决定，revision 随结果返回', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const out = await run({ kind: 'records', ids: [b, a], commandId: randomUUID() }, adapter(new Set([a, b])));
    expect(out.items).toEqual([{ id: b }, { id: a }]);
    expect(out.revisions.get(a)).toBe(3);
  });

  it('适配器判定不可见 → 404，不返回任何结果', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await expect(
      run({ kind: 'records', ids: [a, b], commandId: randomUUID() }, adapter(new Set([a]))),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('命令 ID 的审计足迹里的对象并入复核：足迹对象不可见 → 整体 404', async () => {
    const [kept, hidden, commandId] = [randomUUID(), randomUUID(), randomUUID()];
    await withTenant(w.db, w.tenant.id, async (tx) => {
      for (const objectId of [kept, hidden]) {
        await recordAudit(tx, {
          tenantId: w.tenant.id,
          actorUserId: w.user.id,
          action: 'succession.risk-result.update',
          objectType: 'Succession.RiskResult',
          objectId,
          before: null,
          after: { levelId: null },
          commandId,
          occurredAt: new Date(),
        });
      }
    });
    const seen: string[][] = [];
    await expect(run({ kind: 'record', ids: [kept], commandId }, adapter(new Set([kept]), seen))).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    expect([...seen[0]!].sort()).toEqual([hidden, kept].sort());
    // 足迹里的对象都可见时正常返回，且只返回台账里的结果
    const ok = await run({ kind: 'record', ids: [kept], commandId }, adapter(new Set([kept, hidden])));
    expect(ok.items).toEqual([{ id: kept }]);
  });
});
