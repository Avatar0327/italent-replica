import { and, eq, esignTaskFiles, esignTasks, sql, withTenant, type Db } from '@italent/db';
import type { Authorizer } from '@italent/api';
import { expect } from 'vitest';
import { userOfPerson } from '../../apps/api/src/modules/approval/resolver.js';
import { sourceWorld, rowsOf } from './AC-ESIGN-F505-support.js';
import { json } from './AC-TRF-F481-s3a-support.js';
import { cmd, seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export const SCENES = ['offer', 'entry'] as const;
export type Scene = (typeof SCENES)[number];
export const ESIGN = '/api/tenant/esign';
export const NOTICE = '/api/tenant/approval/notifications';
export const START = new Date('2026-10-10T01:00:00Z');
export const DAY = 86_400_000;
export type Task = typeof esignTasks.$inferSelect;

export async function sharedWorld(db: Db, label: string) {
  const w = await sourceWorld(db, label);
  const { tenantId, userId } = w;
  const employeeId = w.person.employee.id;
  const employeeUser = await withTenant(db, tenantId, (tx) => userOfPerson(tx, tenantId, employeeId));
  expect(employeeUser).toBeTruthy();
  let now = START;
  const restricted = (authorize?: Authorizer) => {
    const api = tenantApi(db, { clock: () => now, ...(authorize ? { authorize } : {}) });
    return (method: string, path: string, opts: RequestOptions = {}) =>
      api.request(method, path.startsWith('/api/') ? path : ESIGN + path, { ...w.as, ...opts });
  };
  const call = restricted();
  const template = (body = 'ZZ_F505_静态正文', name = 'ZZ_F505_签署模板') =>
    call('POST', '/templates', { body: { name, body, code: uniqueSuffix() } }).then((res) =>
      json<{ id: string; name: string; body: string }>(res, 201),
    );
  const source = async (scene: Scene) => {
    if (scene === 'entry') return { scene, businessId: w.entryBusinessId, sourceRevision: w.person.hire.revision };
    const offerId = await w.offer();
    await w.anchor(offerId);
    return { scene, offerId, sourceRevision: 1 };
  };
  const taskRow = (id: string) =>
    withTenant(db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(esignTasks)
        .where(and(eq(esignTasks.id, id), eq(esignTasks.tenantId, tenantId)));
      return row!;
    });
  const fixture = async (scene: Scene, selected: { id: string; name: string; body: string }, remind = false) => {
    const resolved = await source(scene);
    const id = await w.task({ ...resolved, employeeId });
    await withTenant(db, tenantId, async (tx) => {
      await tx
        .update(esignTasks)
        .set({
          employeeSignerUserId: employeeUser,
          ownerDepartmentId: w.from.id,
          initiatedAt: now,
          expiresAt: new Date(now.getTime() + 2 * DAY),
          remindBeforeExpiry: remind,
        })
        .where(and(eq(esignTasks.id, id), eq(esignTasks.tenantId, tenantId)));
      await tx.insert(esignTaskFiles).values({
        tenantId,
        taskId: id,
        seq: 1,
        templateId: selected.id,
        templateName: selected.name,
        content: selected.body,
      });
    });
    return taskRow(id);
  };
  const sign = (user: string, task: Pick<Task, 'id' | 'revision'>, idempotencyKey = uniqueSuffix()) =>
    call('POST', `/mine/${task.id}/sign`, { user, body: { revision: task.revision }, idempotencyKey });
  const action = (
    verb: 'revoke' | 'remind',
    { id, revision }: Pick<Task, 'id' | 'revision'>,
    idempotencyKey = uniqueSuffix(),
  ) => call('POST', `/records/${verb}`, { body: { items: [{ id, revision }] }, idempotencyKey });
  const member = async () => {
    const other = await seedTenantWithMember(db, 'ZZ_F505_OTHER');
    const { grantMembership } = await import('@italent/db');
    await grantMembership(db, { tenantId, userId: other.user.id, expectedRevision: 0 }, cmd());
    return other;
  };
  const notices = () =>
    withTenant(db, tenantId, async (tx) =>
      rowsOf<{
        template: string;
        recipient: string;
        taskId: string;
        payload: unknown;
      }>(
        await tx.execute(sql`
    SELECT template_code AS template, recipient_user_id AS recipient, business_id AS "taskId", payload
    FROM approval_notifications WHERE tenant_id=${tenantId} AND business_type='esign_task'
    ORDER BY template_code, recipient_user_id
  `),
      ),
    );
  const business = (task: Task) =>
    withTenant(db, tenantId, async (tx) =>
      task.offerId
        ? rowsOf(await tx.execute(sql`SELECT * FROM offers WHERE tenant_id=${tenantId} AND id=${task.offerId}::uuid`))
        : rowsOf(
            await tx.execute(sql`
      SELECT b.* FROM employment_business_objects b WHERE tenant_id=${tenantId} AND id=${task.businessId}::uuid
    `),
          ),
    );
  return {
    ...w,
    db,
    call,
    restricted,
    template,
    source,
    taskRow,
    fixture,
    employeeId,
    employeeUser: employeeUser!,
    sign,
    action,
    member,
    notices,
    business,
    setNow: (at: Date) => {
      now = at;
    },
    ctx: () => ({
      tenantId,
      userId,
      now,
      timezone: w.session.tenant.timezone,
      expectedRevision: 0,
      commandId: uniqueSuffix(),
    }),
  };
}
