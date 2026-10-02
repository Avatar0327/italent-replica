import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { forwardFixture } from './AC-FWD-support.js';

const testDb = useTestDb();

describe('AC-FWD-08~11 导入开关和编辑入口矩阵', () => {
  it.each(['否', '是', '', null, undefined] as const)(
    'AC-FWD-08 新增导入开关 %s 仅否阻止传播',
    async (updateLaterEmployment) => {
      const { session, employee, hired } = await forwardFixture(testDb().db, `fwd08-${updateLaterEmployment}`);
      const later = await session.business(
        employee.id,
        {
          kind: 'regularization',
          mode: 'direct',
          effectiveDate: '2026-09-20',
        },
        hired.employeeRevision,
      );
      const response = await session.request('POST', `/employees/${employee.id}/import`, {
        ifMatch: later.employeeRevision,
        body: {
          updateLaterEmployment,
          items: [
            {
              operation: 'create',
              business: {
                kind: 'transfer',
                mode: 'direct',
                effectiveDate: '2026-09-10',
                fields: { place: '导入地点' },
              },
            },
          ],
        },
      });
      expect(response.status).toBe(200);
      expect((await session.record(later.id)).fields.place).toBe(
        updateLaterEmployment === '否' ? '原地点' : '导入地点',
      );
      expect(await session.records(employee.id)).toHaveLength(3);
    },
  );

  it('AC-FWD-09 批量编辑入口可修改源记录，但不传播到未来记录', async () => {
    const { db } = testDb();
    const { session, employee, hired } = await forwardFixture(db, 'fwd09');
    const later = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-11-01',
      },
      hired.employeeRevision,
    );
    const { editEmploymentRecord } = await import('../../apps/api/src/modules/employment/record-edit.js');
    await withTenant(db, session.tenant.id, (tx) =>
      editEmploymentRecord(
        tx,
        {
          tenantId: session.tenant.id,
          userId: session.user.id,
          timezone: session.tenant.timezone,
          now: new Date('2026-10-01T01:00:00.000Z'),
          commandId: randomUUID(),
          expectedRevision: hired.revision,
        },
        hired.id,
        { fields: { place: '批量编辑地点' } },
        'batch_edit',
      ),
    );
    expect((await session.record(hired.id)).fields.place).toBe('批量编辑地点');
    expect((await session.record(later.id)).fields.place).toBe('原地点');
  });

  it('AC-FWD-10 编辑导入即使开关为否也传播，同键重放不追加版本', async () => {
    const { session, employee, hired } = await forwardFixture(testDb().db, 'fwd10');
    const later = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-11-01',
      },
      hired.employeeRevision,
    );
    const options = {
      ifMatch: later.employeeRevision,
      idempotencyKey: randomUUID(),
      body: {
        updateLaterEmployment: '否',
        items: [
          { operation: 'edit', id: hired.id, revision: hired.revision, patch: { fields: { place: '编辑导入地点' } } },
        ],
      },
    };
    const response = await session.request('POST', `/employees/${employee.id}/import`, options);
    expect(response.status).toBe(200);
    const first = await response.json();
    expect((await session.record(hired.id)).fields.place).toBe('编辑导入地点');
    expect((await session.record(later.id)).fields.place).toBe('编辑导入地点');
    const revision = (await session.getEmployee(employee.id)).revision;
    const replay = await session.request('POST', `/employees/${employee.id}/import`, options);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(first);
    expect((await session.getEmployee(employee.id)).revision).toBe(revision);
  });

  it('AC-FWD-10 单条接口编辑当前或未来主职传播，编辑历史主职不传播', async () => {
    const { session, employee, hired } = await forwardFixture(testDb().db, 'fwd10-api');
    const current = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-20',
      },
      hired.employeeRevision,
    );
    const future = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-11-01',
      },
      current.employeeRevision,
    );
    const historyEdit = await session.request('PATCH', `/records/${hired.id}`, {
      ifMatch: hired.revision,
      body: { fields: { place: '历史编辑地点' } },
    });
    expect(historyEdit.status).toBe(200);
    expect((await session.record(current.id)).fields.place).toBe('原地点');
    expect((await session.record(future.id)).fields.place).toBe('原地点');
    const currentEdit = await session.request('PATCH', `/records/${current.id}`, {
      ifMatch: current.revision,
      body: { fields: { place: '当前编辑地点' } },
    });
    expect(currentEdit.status).toBe(200);
    expect((await session.record(future.id)).fields.place).toBe('当前编辑地点');
  });

  it('AC-FWD-10 编辑和导入路径可在落库前预览向后更新', async () => {
    const { session, employee, hired } = await forwardFixture(testDb().db, 'fwd10-edit-import-preview');
    const later = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-01' },
      hired.employeeRevision,
    );
    const editPreview = await session.request('POST', `/records/${hired.id}/forward-update-preview`, {
      body: { fields: { place: '预览编辑地点' } },
    });
    expect(editPreview.status).toBe(200);
    expect(JSON.stringify(await editPreview.json())).toContain(later.id);
    const importPreview = await session.request('POST', `/employees/${employee.id}/import/forward-update-preview`, {
      body: {
        updateLaterEmployment: '否',
        items: [
          { operation: 'edit', id: hired.id, revision: hired.revision, patch: { fields: { place: '导入预览地点' } } },
        ],
      },
    });
    expect(importPreview.status).toBe(200);
    expect(JSON.stringify(await importPreview.json())).toContain(later.id);
    expect((await session.record(later.id)).fields.place).toBe('原地点');
  });

  it('AC-FWD-11 core only：兼职生命周期未建设，核心入口守卫明确禁止兼职传播', async () => {
    const { isForwardEditSupported } = await import('../../apps/api/src/modules/employment/forward-rules.js');
    for (const entry of ['page', 'employee', 'intern', 'import', 'api', 'handover'] as const) {
      const input = {
        entry,
        serviceType: 'primary',
        isCurrent: true,
        effectiveDate: '2026-09-01',
        today: '2026-10-01',
      } as const;
      expect(isForwardEditSupported(input)).toBe(true);
      expect(isForwardEditSupported({ ...input, serviceType: 'secondary' })).toBe(false);
      expect(isForwardEditSupported({ ...input, isCurrent: false })).toBe(false);
      expect(isForwardEditSupported({ ...input, isCurrent: false, effectiveDate: '2026-11-01' })).toBe(true);
    }
    expect(
      isForwardEditSupported({
        entry: 'batch_edit',
        serviceType: 'primary',
        isCurrent: true,
        effectiveDate: '2026-09-01',
        today: '2026-10-01',
      }),
    ).toBe(false);
  });
});
