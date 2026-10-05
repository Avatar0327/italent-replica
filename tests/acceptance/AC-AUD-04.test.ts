/**
 * AC-AUD-04（docs/02_业务建模/20 §2、§5 第 1 条；REQ-AUD-001 R4）：定时任务修改数据，
 * 数据变更日志的操作人记为“系统”、来源动作为“定时任务”（原站已证），不冒用任何真实用户。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';
import { auditApi } from './AC-AUD-support.js';

const testDb = useTestDb();

describe('AC-AUD-04 定时任务修改数据', () => {
  it('定时生效写入的任职记录：操作人“系统”、来源动作“定时任务”；人工审批的操作仍记真实用户', async () => {
    const w = await activationWorld(testDb().db, 'aud04-scheduled');
    const { employee } = await w.hired();
    const reviewing = await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id, place: '定时地点' });
    const approved = await w.approve(reviewing, '2026-10-02T02:00:00Z');
    expect(approved.status).toBe('approved');
    const run = await w.runScheduler('2026-10-04T17:15:00Z');
    expect(run.activated).toEqual([approved.id]);

    const audit = auditApi(w.db, '2026-10-05T01:00:00.000Z');
    const as = { user: w.session.user.id, tenant: w.session.tenant.id };
    const { items } = await audit.dataChanges(as, { objectId: approved.id, limit: '100' });
    const created = items.find((item) => item.action === 'employment.record.create');
    expect(created).toMatchObject({
      operation: 'create',
      operator: { userId: null, name: '系统' },
      sourceAction: '定时任务',
      occurredAt: '2026-10-04T17:15:00.000Z',
      ip: null,
    });
    expect(created!.content).toContain('部门:从【】修改为【调入部门】');

    const manual = items.filter((item) => item.operator.userId !== null);
    expect(manual.length).toBeGreaterThan(0);
    expect(manual.every((item) => item.sourceAction !== '定时任务')).toBe(true);

    const bySystem = await audit.dataChanges(as, { objectId: approved.id, sourceAction: '定时任务', limit: '100' });
    expect(bySystem.items.length).toBeGreaterThan(0);
    expect(bySystem.items.every((item) => item.operator.name === '系统')).toBe(true);
  });
});
