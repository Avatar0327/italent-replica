import { and, approvalNotifications, eq, grantMembership, tenantMemberships, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { json } from './AC-TRF-F481-s3a-support.js';
import { cmd, seedTenantWithMember } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import { EMPLOYEE_OBJECT, ESIGN, RECORD_OBJECT, s5World, type Receipt } from './AC-ESIGN-F505-s5-support.js';

const database = useTestDb();
const NOTICE = '/api/tenant/approval/notifications';
let w: Awaited<ReturnType<typeof s5World>>;
let template: Awaited<ReturnType<(typeof w)['template']>>;

beforeAll(async () => {
  w = await s5World(database().db);
  template = await w.template('ZZ_F505_纯文本正文', 'ZZ_F505_不可进通知的模板名');
});

it.each(['从未授权姓名', '人员范围外', '通知写入后撤姓名'] as const)(
  'AC-07/21 真实入职编辑撤销后，%s 的通知全文仍不含姓名',
  async (mode) => {
    const entry = await w.pending();
    const noName = { fields: { [EMPLOYEE_OBJECT]: ['code'] } };
    const outside = { scopes: { [EMPLOYEE_OBJECT]: EMPTY_SCOPE } };
    const restricted = mode === '从未授权姓名' ? noName : mode === '人员范围外' ? outside : {};
    const deny = ({ resource }: { resource?: string }) =>
      resource === RECORD_OBJECT || resource === 'TenantBase.ESignSettings';
    const canEdit = { ...restricted, deny };
    const readGrants = { ...(mode === '通知写入后撤姓名' ? noName : restricted), deny };
    const { taskId } = await json<Receipt>(await w.submit(entry, [template.id], uniqueSuffix(), canEdit), 201);
    await json(
      await w.restricted(canEdit)('PATCH', `/api/tenant/employment/pending-entries/${entry.id}`, {
        ifMatch: entry.revision,
        body: { effectiveDate: entry.effectiveDate, probation: true },
      }),
    );
    expect(await w.tasks(entry)).toMatchObject([{ status: 'revoked', revokeCause: 'source_changed' }]);

    const notice = await json<{ items: { businessId: string }[] }>(await w.restricted(readGrants)('GET', NOTICE));
    const full = JSON.stringify(notice);
    expect(full, '通知列表不能披露人员现名').not.toContain(entry.employee.name);
    expect(full).not.toContain(entry.employee.code);
    expect(full).not.toContain(template.name);
    const selected = notice.items.find((item) => item.businessId === taskId);
    expect(selected).toMatchObject({
      template: 'esign_revoked_initiator',
      sender: null,
      body: `入职电子签署任务（${taskId}）已撤销。`,
    });
    expect(selected).not.toHaveProperty('payload');
    const payloads = await withTenant(w.db, w.as.tenant, (tx) =>
      tx
        .select({ payload: approvalNotifications.payload })
        .from(approvalNotifications)
        .where(and(eq(approvalNotifications.tenantId, w.as.tenant), eq(approvalNotifications.businessId, taskId))),
    );
    expect(payloads).toEqual(Array.from({ length: 2 }, () => ({ payload: { scene: 'entry', taskNumber: taskId } })));

    const hidden = await w.restricted({ fields: { [RECORD_OBJECT]: ['status'] } })(
      'GET',
      `${ESIGN}/records/files?ids=${taskId}`,
    );
    await w.error(hidden.clone(), 403, 'FIELD_FORBIDDEN');
    expect(await hidden.text()).not.toContain(template.name);

    if (mode === '通知写入后撤姓名') {
      const other = await seedTenantWithMember(w.db, 'ZZ_F505_通知非收件人');
      await grantMembership(w.db, { tenantId: w.as.tenant, userId: other.user.id, expectedRevision: 0 }, cmd());
      await grantMembership(w.db, { tenantId: other.tenant.id, userId: w.as.user, expectedRevision: 0 }, cmd());
      expect(JSON.stringify(await json(await w.call('GET', NOTICE, { user: other.user.id })))).not.toContain(taskId);
      expect(JSON.stringify(await json(await w.call('GET', NOTICE, { tenant: other.tenant.id })))).not.toContain(
        taskId,
      );
      await withTenant(w.db, w.as.tenant, (tx) =>
        tx
          .update(tenantMemberships)
          .set({ status: 'revoked' })
          .where(and(eq(tenantMemberships.tenantId, w.as.tenant), eq(tenantMemberships.userId, w.as.user))),
      );
      try {
        await w.error(await w.call('GET', NOTICE), 403, 'TENANT_NOT_MEMBER');
      } finally {
        await withTenant(w.db, w.as.tenant, (tx) =>
          tx
            .update(tenantMemberships)
            .set({ status: 'active' })
            .where(and(eq(tenantMemberships.tenantId, w.as.tenant), eq(tenantMemberships.userId, w.as.user))),
        );
      }
    }
  },
);
