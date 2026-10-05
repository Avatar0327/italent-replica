/**
 * R1-T11 删除任职的范围夹具（PR #73 第二、三轮）：员工 9/1 入职 A（调出部门）、9/10 调入 B。操作人用组织关系范围
 * （如“B 的负责人”，DEC-168 organization 维度），由范围提供者注入；personIds 模拟该范围当前管辖的员工（DEC-177 ②），
 * all 为看全部。范围判定、字段裁剪与真实授权器走同一套代码。
 */
import type { Db } from '@italent/db';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

export const NOW = () => new Date('2026-10-01T01:00:00.000Z');
export const RECORD_FIELDS = [
  'id',
  'employeeId',
  'revision',
  'effectiveDate',
  'kind',
  'status',
  'departmentId',
  'staffId',
];

export async function scopedWorld(db: Db, label: string) {
  const w = await activationWorld(db, label);
  const b = await w.session.org('B部门', { establishedOn: '2026-01-01' });
  const c = await w.session.org('C部门', { establishedOn: '2026-01-01' });
  const subject = await w.hired('删除范围员工');
  async function addBusiness(body: Record<string, unknown>) {
    const employee = await w.session.getEmployee(subject.employee.id);
    return w.session.business(subject.employee.id, body, employee.revision);
  }
  const toB = await addBusiness({
    kind: 'transfer',
    mode: 'direct',
    effectiveDate: '2026-09-10',
    fields: { departmentId: b.id },
  });

  function operator(
    orgIds: readonly string[],
    fields: readonly string[] = RECORD_FIELDS,
    options: { personIds?: readonly string[]; all?: boolean } = {},
  ) {
    const authorize: Authorizer = () => true;
    const personIds = options.personIds ?? [];
    registerScopeProvider(authorize, {
      scope: async () =>
        options.all
          ? { ...EMPTY_SCOPE, all: true, hasDataPermission: true }
          : {
              ...EMPTY_SCOPE,
              orgIds,
              personIds,
              hasDataPermission: true,
              terms: [{ dimension: 'organization' as const, orgIds, personIds }],
            },
      authorize: async () => true,
      fields: async () => new Set(fields),
    });
    return tenantApi(w.db, { authorize, clock: NOW });
  }
  async function timeline() {
    return (await w.session.records(subject.employee.id)).map(({ id, stopDate }) => ({ id, stopDate }));
  }
  async function remove(api: ReturnType<typeof operator>, id: string) {
    return api.request('DELETE', `/api/tenant/employment/businesses/${id}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: (await w.business(id)).revision,
    });
  }
  return { ...w, a: w.from, b, c, subject, toB, addBusiness, operator, timeline, remove };
}
