import { randomUUID } from 'node:crypto';
import { tenantApi } from './support/tenant-api.js';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';

const database = useTestDb();
describe('DEC-163 任职信息待补全', () => {
  it('元数据独立于字段；未来日期不提醒，到期生成待办，7 天提醒且同日幂等，编辑后关闭', async () => {
    const w = await activationWorld(database().db, 'trf-completion');
    const { employee, hire } = await w.hired();
    const manager = await w.hired('合成补全经理');
    const response = await w.session.request('POST', `/transfers/employees/${employee.id}`, {
      ifMatch: hire.employeeRevision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'direct',
        effectiveDate: '2026-10-10',
        fields: { departmentId: w.to.id, directManagerId: null, dottedManagerId: null },
      },
    });
    expect(response.status).toBe(201);
    const business = (await response.json()) as { id: string; revision: number };
    async function events(type: string) {
      return withTenant(w.db, w.session.tenant.id, async (tx) => {
        const result = await tx.execute(sql`SELECT payload FROM employment_outbox
          WHERE tenant_id=${w.session.tenant.id} AND business_id=${business.id}::uuid AND event_type=${type}`);
        return Array.isArray(result) ? result : (result as { rows: { payload: Record<string, unknown> }[] }).rows;
      });
    }
    const created = await events('employment.record.create');
    expect(created[0]!.payload).toMatchObject({
      meta: { clearedFieldCodes: ['preset:positionId', 'preset:directManagerId', 'preset:dottedManagerId'] },
    });
    expect(created[0]!.payload.after as object).not.toHaveProperty('clearedFieldCodes');
    async function todos(at: string) {
      w.session.setNow(at);
      const result = await w.session.request('GET', '/completion-todos');
      expect(result.status).toBe(200);
      return ((await result.json()) as { items: { id: string; fieldCodes: string[] }[] }).items;
    }
    expect(await todos('2026-10-09T01:00:00Z')).toEqual([]);
    await w.runScheduler('2026-10-09T01:00:00Z');
    expect(await events('employment.completion.reminder')).toHaveLength(0);
    await w.runScheduler('2026-10-10T01:00:00Z');
    expect(await todos('2026-10-10T01:00:00Z')).toMatchObject([{ id: business.id }]);
    expect(await events('employment.completion.reminder')).toHaveLength(1);
    await w.runScheduler('2026-10-10T02:00:00Z');
    await w.runScheduler('2026-10-16T02:00:00Z');
    expect(await events('employment.completion.reminder')).toHaveLength(1);
    await w.runScheduler('2026-10-17T02:00:00Z');
    expect(await events('employment.completion.reminder')).toHaveLength(2);
    // 部分补全保持待办；剩余职位通过同一编辑任职入口补全后自动结束。
    const edited = await w.session.request('PATCH', `/records/${business.id}`, {
      ifMatch: business.revision,
      body: { fields: { directManagerId: manager.employee.id, dottedManagerId: manager.employee.id } },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect((await todos('2026-10-17T02:00:00Z'))[0]!.fieldCodes).toEqual(['preset:positionId']);
    const api = tenantApi(w.db, { clock: () => new Date('2026-10-17T02:00:00Z') });
    async function job(kind: string, fields: object = {}) {
      const response = await api.request('POST', `/api/tenant/job/${kind}`, {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: 0,
        body: { name: '合成补全职位', code: randomUUID(), startDate: '2026-01-01', ...fields },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as { id: string };
    }
    const post = await job('posts');
    const position = await job('positions', { postId: post.id, orgId: w.to.id });
    const current = (await edited.json()) as { revision: number };
    const completed = await w.session.request('PATCH', `/records/${business.id}`, {
      ifMatch: current.revision,
      body: { fields: { positionId: position.id } },
    });
    expect(completed.status, await completed.clone().text()).toBe(200);
    expect(await todos('2026-10-17T02:00:00Z')).toEqual([]);
    await w.runScheduler('2026-10-24T02:00:00Z');
    expect(await events('employment.completion.reminder')).toHaveLength(2);
  });
});
