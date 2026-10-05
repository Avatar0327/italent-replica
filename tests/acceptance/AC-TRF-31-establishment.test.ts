import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import * as linkage from '../../apps/api/src/modules/employment/transfer-linkage.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
async function fixture(label: string, capacity = 1, occupancyRanges = [{ employmentType: 'internal' }]) {
  const w = await activationWorld(database().db, label);
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  async function request(method: string, path: string, body: object, revision = 0) {
    return api.request(method, `/api/tenant/establishment${path}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: revision,
      body,
    });
  }
  const schemeResponse = await request('POST', '/schemes', {
    name: '合成严格控编方案',
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2026-01-01',
    occupancyRanges,
  });
  expect(schemeResponse.status).toBe(201);
  const scheme = (await schemeResponse.json()) as { id: string };
  const capacityResponse = await request('POST', '/capacities', {
    orgId: w.to.id,
    schemeId: scheme.id,
    periodStart: '2026-01-01',
    localCapacity: capacity,
    strictControl: true,
  });
  expect(capacityResponse.status).toBe(201);
  const cap = (await capacityResponse.json()) as { id: string; revision: number };
  return { ...w, request, cap };
}

describe('AC-TRF-31 / DEC-145 真实任职人员与严格编制', () => {
  it.each(['direct', 'application'])('P2-1 先存 10-20 直接调入，再存 10-05 %s 调入不能绕过严格编制', async (mode) => {
    const w = await fixture(`trf-est-order-${mode}`);
    const first = await w.hired('晚调入');
    const second = await w.hired('早调入');
    const save = (person: typeof first, date: string, mode: string) =>
      w.session.request('POST', `/transfers/employees/${person.employee.id}`, {
        ifMatch: person.hire.employeeRevision,
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          mode,
          submit: mode === 'application',
          effectiveDate: date,
          fields: { departmentId: w.to.id },
        },
      });
    expect((await save(first, '2026-10-20', 'direct')).status).toBe(201);
    const blocked = await save(second, '2026-10-05', mode);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
  });

  it.each([1, 2])('P2-1 同人多笔未来任职只计一人，周期末调出仍保留期间峰值（编制 %i）', async (capacity) => {
    const w = await fixture(`trf-est-peak-${capacity}`, capacity);
    const first = await w.hired('未来多单');
    for (const [date, departmentId] of [
      ['2026-10-20', w.to.id],
      ['2026-10-22', w.to.id],
      ['2026-10-25', w.from.id],
    ]) {
      const current = await w.session.getEmployee(first.employee.id);
      await w.session.business(
        first.employee.id,
        { kind: 'transfer', mode: 'direct', effectiveDate: date!, fields: { departmentId: departmentId! } },
        current.revision,
      );
    }
    const second = await w.hired('较早调入');
    const response = await w.session.request('POST', `/transfers/employees/${second.employee.id}`, {
      ifMatch: second.hire.employeeRevision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'direct',
        effectiveDate: '2026-10-05',
        fields: { departmentId: w.to.id },
      },
    });
    expect(response.status, await response.clone().text()).toBe(capacity === 1 ? 409 : 201);
  });

  it('P2-1 周期内已落地的未来入职也计入，不仅限于直接调动', async () => {
    const w = await fixture('trf-est-future-hire');
    const first = await w.session.employee('未来入职');
    await w.session.business(
      first.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-10-20', fields: { departmentId: w.to.id } },
      first.revision,
    );
    const second = await w.hired('较早调入');
    const response = await w.session.request('POST', `/transfers/employees/${second.employee.id}`, {
      ifMatch: second.hire.employeeRevision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'direct',
        effectiveDate: '2026-10-05',
        fields: { departmentId: w.to.id },
      },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
  });

  it('P3-1 草稿保存后容量被占满，提交时重新检查', async () => {
    const w = await fixture('trf-est-submit');
    const { employee, hire } = await w.hired();
    const draft = await w.session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
      hire.employeeRevision,
    );
    const first = await w.hired('占编');
    await w.session.business(
      first.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-20', fields: { departmentId: w.to.id } },
      first.hire.employeeRevision,
    );
    const submitted = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(submitted.status).toBe(409);
    expect(await submitted.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
    expect((await w.business(draft.id)).status).toBe('draft');
  });

  it.each(['capacity', 'disabled'])(
    'DEC-173 无联动直接调动到期复查 %s：只提醒、不改变任职、不挂起后序',
    async (cause) => {
      const w = await fixture(`trf-direct-recheck-${cause}`);
      const { employee, hire } = await w.hired();
      const direct = await w.session.business(
        employee.id,
        { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
        hire.employeeRevision,
      );
      const later = await w.approve(
        await w.apply(employee.id, '2026-10-06', { departmentId: w.from.id }),
        '2026-10-02T01:00:00Z',
      );
      if (cause === 'capacity') {
        expect(
          (
            await w.request(
              'PATCH',
              `/capacities/${w.cap.id}`,
              { localCapacity: 0, effectiveDate: '2026-10-04' },
              w.cap.revision,
            )
          ).status,
        ).toBe(200);
      } else {
        // 已排定 10-09 调出，满足 DEC-129 停用时组织无人；10-05 的整段复查仍须发现 10-10 停用。
        const current = await w.session.getEmployee(employee.id);
        await w.session.business(
          employee.id,
          { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-09', fields: { departmentId: w.from.id } },
          current.revision,
        );
        const disabled = await tenantApi(w.db, { clock: () => new Date('2026-10-03T01:00:00Z') }).request(
          'PATCH',
          `/api/tenant/org/organizations/${w.to.id}`,
          {
            user: w.session.user.id,
            tenant: w.session.tenant.id,
            ifMatch: w.to.revision,
            body: { enabled: false, effectiveDate: '2026-10-10' },
          },
        );
        expect(disabled.status, await disabled.clone().text()).toBe(200);
      }
      const before = await w.session.records(employee.id, '2026-10-05');
      expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({
        failed: [direct.id],
        suspended: [],
        errors: [],
      });
      expect(await w.session.records(employee.id, '2026-10-05')).toEqual(before);
      expect(await w.business(direct.id)).toMatchObject({ status: 'effective', activation: { status: 'failed' } });
      expect(await w.todos()).toMatchObject([{ id: direct.id }]);
      expect(
        (await w.outboxEvents(direct.id)).filter((e) => e.eventType === 'employment.activation.failed'),
      ).toHaveLength(1);
      expect(await w.runScheduler('2026-10-06T01:00:00Z')).toMatchObject({
        activated: [later.id],
        failed: [],
        suspended: [],
        errors: [],
      });
      expect((await w.business(later.id)).status).toBe('effective');
      expect((await w.business(direct.id)).activation?.failureCount).toBe(1);
    },
  );

  it('DEC-173 PR-A 已保存且没有新排队事件的未来直接调动也会复查', async () => {
    const w = await fixture('trf-recheck-existing');
    const { employee, hire } = await w.hired();
    // 模拟 PR-A 只落地任职、没有 PR-B 新事件的存量记录；不改写历史数据。
    const queue = vi.spyOn(linkage, 'queueTransferLinkage').mockResolvedValue(undefined);
    let direct;
    try {
      direct = await w.session.business(
        employee.id,
        { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
        hire.employeeRevision,
      );
    } finally {
      queue.mockRestore();
    }
    expect((await w.outboxEvents(direct.id)).some((e) => e.eventType.endsWith('.pending'))).toBe(false);
    expect(
      (
        await w.request(
          'PATCH',
          `/capacities/${w.cap.id}`,
          { localCapacity: 0, effectiveDate: '2026-10-04' },
          w.cap.revision,
        )
      ).status,
    ).toBe(200);
    expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({
      failed: [direct.id],
      suspended: [],
      errors: [],
    });
    expect(await w.todos()).toMatchObject([{ id: direct.id }]);
  });

  it('P3-4 带编调动明确拒绝且不写业务', async () => {
    const w = await fixture('trf-with-establishment');
    const { employee, hire } = await w.hired();
    const response = await w.session.request('POST', `/transfers/employees/${employee.id}`, {
      ifMatch: hire.employeeRevision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'direct',
        effectiveDate: '2026-10-05',
        fields: { departmentId: w.to.id },
        withEstablishment: true,
      },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'WITH_ESTABLISHMENT_UNAVAILABLE' } } });
    expect((await w.session.records(employee.id, '2026-10-05')).map((r) => r.id)).toEqual([hire.id]);
  });

  it('保存时已满编拒绝，非占编人员与外部人员不拦截', async () => {
    const w = await fixture('trf-est-save', 0);
    const { employee, hire } = await w.hired();
    const blocked = await w.session.request('POST', `/transfers/employees/${employee.id}`, {
      ifMatch: hire.employeeRevision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'direct',
        effectiveDate: '2026-10-01',
        fields: { departmentId: w.to.id },
      },
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
    for (const employType of ['intern', 'external']) {
      const person = await w.session.employee(`合成${employType}`);
      const hired = await w.session.business(
        person.id,
        { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: w.from.id, employType } },
        person.revision,
      );
      const response = await w.session.request('POST', `/transfers/employees/${person.id}`, {
        ifMatch: hired.employeeRevision,
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          mode: 'direct',
          effectiveDate: '2026-10-01',
          fields: { departmentId: w.to.id },
        },
      });
      expect(response.status, await response.clone().text()).toBe(201);
    }
  });

  it('DEC-015 任职批量导入超编只警告，仍写入任职与审计', async () => {
    const w = await fixture('trf-est-import', 0);
    const { employee, hire } = await w.hired();
    const response = await w.session.request('POST', `/employees/${employee.id}/import`, {
      ifMatch: hire.employeeRevision,
      body: {
        items: [
          {
            operation: 'create',
            business: {
              kind: 'transfer',
              mode: 'direct',
              effectiveDate: '2026-10-01',
              fields: { departmentId: w.to.id },
            },
          },
        ],
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ status: 'effective' }],
      warnings: [{ reason: 'ESTABLISHMENT_EXCEEDED' }],
    });
  });

  it('Q-M0-15 同条件字段且/同字段值或/多条件并集，与雇佣关系匹配', async () => {
    const ranges = [
      { employmentType: 'internal', conditions: { employmentForm: ['full', 'part'], employmentType: ['engineer'] } },
      { employmentType: 'intern', conditions: { employmentSource: ['campus'] } },
    ];
    const w = await fixture('trf-est-ranges', 0, ranges);
    const { employee, hire } = await w.hired();
    const create = (fields: object) =>
      w.session.request('POST', `/transfers/employees/${employee.id}`, {
        ifMatch: hire.employeeRevision,
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          mode: 'application',
          effectiveDate: '2026-10-01',
          fields: { departmentId: w.to.id, ...fields },
        },
      });
    expect((await create({ employmentForm: 'part', employmentType: 'engineer' })).status).toBe(409);
    expect((await create({ employmentForm: 'contract', employmentType: 'engineer' })).status).toBe(201);
  });

  it('申请通过后真实满编 → 到期失败 → 调整编制 → 按原日重试，幂等关闭待办', async () => {
    const w = await fixture('trf-est-retry');
    const { employee } = await w.hired();
    const application = await w.apply(employee.id, '2026-10-10', { departmentId: w.to.id });
    await w.approve(application, '2026-10-02T01:00:00Z');
    const occupant = await w.session.employee('合成占编人员');
    await w.session.business(
      occupant.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-10-03', fields: { departmentId: w.to.id } },
      occupant.revision,
    );
    const failed = await w.runScheduler('2026-10-10T01:00:00Z');
    expect(failed.failed).toEqual([application.id]);
    expect(await w.business(application.id)).toMatchObject({
      status: 'approved',
      record: null,
      activation: { failureReason: 'ESTABLISHMENT_EXCEEDED', failureCount: 1 },
    });
    expect(await w.todos()).toHaveLength(1);
    const adjusted = await w.request(
      'PATCH',
      `/capacities/${w.cap.id}`,
      {
        localCapacity: 2,
        effectiveDate: '2026-10-11',
      },
      w.cap.revision,
    );
    expect(adjusted.status, await adjusted.clone().text()).toBe(200);
    const retried = await w.retry(application, '2026-10-11T01:00:00Z', 'est-retry');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(await w.business(application.id)).toMatchObject({ status: 'effective', effectiveDate: '2026-10-10' });
    expect(await w.todos()).toEqual([]);
    expect((await w.runScheduler('2026-10-11T02:00:00Z')).activated).toEqual([]);
    expect(
      (await w.outboxEvents(application.id)).filter((e) => e.eventType === 'employment.record.create'),
    ).toHaveLength(1);
  });
});

it('F-017 编辑已生效任职不能绕过严格编制，拒绝后任职不变', async () => {
  const w = await fixture('f017-edit-capacity', 0);
  const person = await w.hired();
  const response = await w.session.request('PATCH', `/records/${person.hire.id}`, {
    ifMatch: person.hire.revision,
    body: { fields: { departmentId: w.to.id } },
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
  expect((await w.business(person.hire.id)).fields.departmentId).toBe(w.from.id);
});

it('F-017 本次只占编到实际调出日，与后来调入的人不重叠即可保存', async () => {
  const w = await fixture('f017-interval', 1);
  const first = await w.hired('晚调入');
  const second = await w.hired('早调入早调出');
  await w.session.business(
    first.employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-20', fields: { departmentId: w.to.id } },
    first.hire.employeeRevision,
  );
  const exit = await w.session.org('不匹配的后续部门', { establishedOn: '2026-01-01' });
  const later = await w.session.business(
    second.employee.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-10',
      fields: { departmentId: exit.id, positionId: null },
    },
    second.hire.employeeRevision,
  );
  const response = await w.session.request('POST', `/employees/${second.employee.id}/businesses`, {
    ifMatch: later.employeeRevision,
    body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
  });
  expect(response.status, await response.clone().text()).toBe(201);
});
