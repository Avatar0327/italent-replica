import { and, eq, esignTaskFiles, esignTasks, grantMembership, sql, withTenant, type Db } from '@italent/db';
import type { Authorizer } from '@italent/api';
import { expect } from 'vitest';
import { userOfPerson } from '../../apps/api/src/modules/approval/resolver.js';
import { insertAnchor, insertOffer, insertTask, rowsOf, type TaskSeed } from './AC-ESIGN-F505-support.js';
import { employmentSession } from './AC-EMP-support.js';
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
  const session = await employmentSession(db, `ZZ_F505_${label}`);
  session.setNow(START.toISOString());
  const tenantId = session.tenant.id;
  const userId = session.user.id;
  const as = { user: userId, tenant: tenantId };
  const from = await session.org('ZZ_F505_调出部门', { establishedOn: '2026-01-01' });
  const to = await session.org('ZZ_F505_调入部门', { establishedOn: '2026-01-01' });
  const hire = async (name: string, departmentId = from.id) => {
    const employee = await session.employee(name);
    const hire = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId },
      },
      employee.revision,
    );
    const user = await withTenant(db, tenantId, (tx) => userOfPerson(tx, tenantId, employee.id));
    expect(user).toBeTruthy();
    return { employeeId: employee.id, departmentId, hire, employeeUser: user! };
  };
  const person = await hire(`ZZ_F505_EMP_${label}`);
  const { employeeId, employeeUser } = person;
  let now = START;
  const restricted = (authorize?: Authorizer) => {
    const api = tenantApi(db, { clock: () => now, ...(authorize ? { authorize } : {}) });
    return (method: string, path: string, opts: RequestOptions = {}) =>
      api.request(method, path.startsWith('/api/') ? path : ESIGN + path, { ...as, ...opts });
  };
  const call = restricted();
  const template = (body = 'ZZ_F505_静态正文', name = 'ZZ_F505_签署模板') =>
    call('POST', '/templates', { body: { name, body, code: uniqueSuffix() } }).then((res) =>
      json<{ id: string; name: string; body: string }>(res, 201),
    );
  const source = async (scene: Scene, owner = person) => {
    if (scene === 'entry') return { scene, businessId: owner.hire.id, sourceRevision: owner.hire.revision };
    const offerId = await insertOffer(db, tenantId, userId, 'accepted');
    await insertAnchor(db, tenantId, offerId);
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
  type Selected = { id: string; name: string; body: string };
  const seedFiles = async (seed: TaskSeed, selected: Selected, owner = person, remind = false) => {
    const id = await insertTask(db, tenantId, userId, seed);
    await withTenant(db, tenantId, async (tx) => {
      await tx
        .update(esignTasks)
        .set({
          employeeSignerUserId: owner.employeeUser,
          ownerDepartmentId: owner.departmentId,
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
  const fixture = async (scene: Scene, selected: Selected, remind = false, owner = person) =>
    seedFiles({ ...(await source(scene, owner)), employeeId: owner.employeeId }, selected, owner, remind);
  const transferFixture = async (selected: Selected) => {
    const current = await session.getEmployee(employeeId);
    const business = await session.business(
      employeeId,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-10',
        fields: { departmentId: to.id },
      },
      current.revision,
    );
    return seedFiles({ scene: 'transfer', businessId: business.id, employeeId }, selected);
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
    db,
    session,
    tenantId,
    userId,
    as,
    from,
    to,
    hire,
    taskCount: () =>
      withTenant(db, tenantId, async (tx) => {
        const [row] = rowsOf<{ n: number }>(
          await tx.execute(sql`SELECT count(*)::int AS n FROM esign_tasks WHERE tenant_id=${tenantId}`),
        );
        return row!.n;
      }),
    transferFixture,
    call,
    restricted,
    template,
    source,
    taskRow,
    fixture,
    employeeId,
    employeeUser,
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
      timezone: session.tenant.timezone,
      expectedRevision: 0,
      commandId: uniqueSuffix(),
    }),
  };
}
