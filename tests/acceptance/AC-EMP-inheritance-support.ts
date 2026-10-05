import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { employmentSession, type EmploymentBusiness, type EmploymentSession } from './AC-EMP-support.js';
import { saveTransferForm } from '../../apps/api/src/modules/transfer/configuration.js';

export interface CustomField {
  readonly id: string;
  readonly code: string;
  readonly revision: number;
  readonly inherit: boolean;
}

export async function customField(session: EmploymentSession, inherit = true): Promise<CustomField> {
  const response = await session.request('POST', '/custom-fields', {
    ifMatch: 0,
    body: { name: '合成继承字段', valueType: 'text', objectType: 'employment' },
  });
  expect(response.status).toBe(201);
  const field = (await response.json()) as CustomField;
  expect(field.inherit).toBe(true);
  expect(field.code).toMatch(/^ext_/);
  if (inherit) return field;
  const configured = await session.request('PUT', `/custom-fields/${field.id}/inheritance`, {
    ifMatch: field.revision,
    body: { inherit: false },
  });
  expect(configured.status).toBe(200);
  const changed = (await configured.json()) as CustomField;
  expect(changed).toMatchObject({ id: field.id, inherit: false, revision: field.revision + 1 });
  return changed;
}

export async function inheritanceFixture(db: Db, label: string, inherit = true, employType = 'internal') {
  const session = await employmentSession(db, label);
  const field = await customField(session, inherit);
  // R1-T09：用真实租户表单配置覆盖 R1-T05 原测试表单矩阵，禁止生产魔法 ID 后门。
  await db.transaction(async (tx) => {
    for (const [id, mode] of [
      ['readonly-custom', 'readonly'],
      ['hidden-custom', 'hidden'],
      ['omitted-custom', 'absent'],
      ['ungrouped-custom', 'editable'],
    ] as const) {
      await saveTransferForm(
        tx,
        {
          tenantId: session.tenant.id,
          userId: session.user.id,
          timezone: session.tenant.timezone,
          now: new Date('2026-10-01T01:00:00Z'),
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        {
          id,
          name: `合成${id}`,
          group: id === 'ungrouped-custom' ? null : 'transfer',
          fieldModes: { [`custom:${field.id}`]: mode },
        },
      );
    }
  });
  const employee = await session.employee();
  const department = await session.org('合成继承部门', { establishedOn: '2026-01-01' });
  const hired = await session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-01-01',
      formId: 'standard',
      fields: {
        departmentId: department.id,
        place: '上一任职工作地',
        remarks: '上一任职备注',
        isKeyPerson: true,
        employType,
      },
      customFields: { [field.id]: '上一任职字段值' },
    },
    employee.revision,
  );
  expect(hired.record?.customFields[field.id]).toBe('上一任职字段值');
  return { ...session, employee, field, hired };
}

export async function trustedTransition(
  db: Db,
  session: Pick<EmploymentSession, 'tenant' | 'user'>,
  business: EmploymentBusiness,
  action: 'approve' | 'activate',
  now: string,
): Promise<EmploymentBusiness> {
  // 仅在首次 HTTP 业务成功后加载，首轮红测须暴露真实缺失路由。
  const service = await import('../../apps/api/src/modules/employment/transitions.js');
  const result = await service.runEmploymentTransition(
    db,
    {
      tenantId: session.tenant.id,
      userId: session.user.id,
      timezone: session.tenant.timezone,
      now: new Date(now),
      commandId: randomUUID(),
      expectedRevision: business.revision,
    },
    { id: business.id, action },
  );
  expect(result.status).toBe(200);
  return result.body as EmploymentBusiness;
}
