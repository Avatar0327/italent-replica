/** 审计物理重排回归：只重排测试库，不改审计内容，HTTP 写入与读取都使用普通租户上下文。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import {
  actionsOf,
  audits,
  autoAt,
  create,
  draftOk,
  editVariable,
  newVersion,
  peopleOf,
  publishWith,
  s4World,
  specified,
  varRow,
} from './AC-APV-F326-S7a-support.js';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';

const database = useTestDb();

it('AC-APV-F326-S7a 审计同一时间戳、物理顺序改变后，仍按对象变更顺序核对发布审计', async () => {
  const w = await s4World(database().db, 'audit-order');
  const other = await w.person('合成手工改选人', w.staff);
  const node = (userId: string) => ({ key: 'n1', name: '合成节点', approver: specified(userId) });
  const published = await w.publish(await create(w, [node(w.near.userId)]));
  const x = await autoAt(w, published.id, 'n1');
  const saved = await draftOk(w, await newVersion(w, published), [node(w.head.userId)]);
  const edited = await editVariable(w, x, { defaultValue: other.userId });
  expect(edited.status, await edited.clone().text()).toBe(200);
  const current = await varRow(w, x.id);
  expect(peopleOf(current)).toEqual([other.userId]);
  const done = await publishWith(w, saved, {
    pendingResolutions: [{ variableId: x.id, revision: current.revision, choice: 'designer' }],
  });
  expect(done.status, await done.clone().text()).toBe(200);
  expect(peopleOf(await varRow(w, x.id))).toEqual([w.head.userId]);

  await withTenant(w.db, w.tenant.id, async (tx) => {
    const timestamps = rowsOf<{ n: number }>(
      await tx.execute(sql`SELECT count(DISTINCT occurred_at)::int AS n FROM audit_events
        WHERE tenant_id=${w.tenant.id} AND object_id=${x.id}`),
    );
    expect(timestamps).toEqual([{ n: 1 }]);
  });
  // 仅表维护使用建库角色（PG 为 app_owner）；不关闭 RLS，不修改审计内容。
  // 该索引按 action 重排：auto_update 排在手改 update 前，证明 ctid 不是业务写入序号。
  await w.db.execute(sql`CLUSTER audit_events USING audit_events_scope_creator_lookup`);
  await withTenant(w.db, w.tenant.id, async (tx) => {
    const physical = rowsOf<{ action: string }>(
      await tx.execute(sql`SELECT action FROM audit_events
        WHERE tenant_id=${w.tenant.id} AND object_id=${x.id} ORDER BY ctid`),
    );
    expect(physical.map((row) => row.action)).toEqual([
      'approval.public_variable.auto_create',
      'approval.public_variable.auto_update',
      'approval.public_variable.update',
    ]);
  });

  const trail = await audits(w, x.id);
  expect(trail.at(-1)!.action).toBe('approval.public_variable.auto_update');
  expect(actionsOf(trail)).toEqual(['auto_create', 'update', 'auto_update']);
  expect(trail[2]).toMatchObject({
    action: 'approval.public_variable.auto_update',
    actor: w.hr.id,
    before: { defaultValue: other.userId },
    after: {
      defaultValue: w.head.userId,
      trigger: { kind: 'publish', versionId: saved.latestVersion.id, resolution: 'designer' },
    },
  });
  expect(trail[2]!.after).not.toHaveProperty('resolution');
});
