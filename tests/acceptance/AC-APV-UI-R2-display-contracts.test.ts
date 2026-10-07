/** P3-6：最小显示元数据来自实例绑定节点与租户上下文，不读取完整流程配置。 */
import { eq, tenants, withPlatform } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  grantFieldAccess,
  permissionAdmin,
  transferScene,
  type InstanceView,
} from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';
interface DisplayView extends InstanceView {
  readonly timezone: string;
  readonly addSignTypes: readonly string[];
}

describe('AC-APV-UI-02 / 03：显示元数据只读契约', () => {
  it.each([
    { kind: 'single' as const, types: ['before', 'after'] },
    { kind: 'countersign' as const, types: ['before', 'parallel'] },
  ])('$kind 加签类型按本人的在办节点披露；非行动者没有类型，不暴露流程配置', async ({ kind, types }) => {
    const w = await approvalWorld(database().db, `apv-ui-display-${kind}`);
    const s = await transferScene(w);
    await withPlatform(w.db, (tx) =>
      tx.update(tenants).set({ timezone: 'America/New_York' }).where(eq(tenants.id, w.tenant.id)),
    );
    const world = await permissionAdmin(w);
    await grantFieldAccess(world, s.outHead.userId, { view: ['id', 'departmentId', 'effectiveDate', 'place'] });
    await w.publishedProcess({
      nodes: [
        {
          key: 'manager',
          kind,
          ...(kind === 'single'
            ? { approver: 'latest_record_department_head' as const }
            : { approvers: ['latest_record_department_head' as const] }),
          actions: { addSign: true },
        },
      ],
    });
    const instance = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
    const view = await w.json<DisplayView>(
      await api.request('GET', `${BASE}/instances/${instance.id}`, w.as(s.outHead.userId)),
    );
    expect(view.actions).toContain('addSign');
    expect(view).toMatchObject({ timezone: 'America/New_York', addSignTypes: types });
    for (const config of ['nodes', 'conditions', 'transitionRule', 'approver', 'approvers'])
      expect(view).not.toHaveProperty(config);
    const initiator = await w.json<DisplayView>(
      await api.request('GET', `${BASE}/instances/${instance.id}`, w.as(w.hr.id)),
    );
    expect(initiator.addSignTypes).toEqual([]);
    for (const url of ['/todos', '/instances?role=initiated', `/instances/${instance.id}/logs`]) {
      const envelope = await w.json<{ timezone: string; items: unknown[] }>(
        await api.request('GET', `${BASE}${url}`, w.as(s.outHead.userId)),
      );
      expect(envelope.timezone).toBe('America/New_York');
    }
  });
});
