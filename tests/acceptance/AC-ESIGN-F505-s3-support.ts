import { and, eq, esignTaskFiles, esignTasks, sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { userOfPerson } from '../../apps/api/src/modules/approval/resolver.js';
import { insertAnchor, insertTask, rowsOf } from './AC-ESIGN-F505-support.js';
import { OF_NOW } from './AC-OF-BE14a-support.js';
import { fullSocial, syncWorld } from './AC-OF-BE14b2-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export const REJECT = { target: 'rejected', refusalTime: '2026-10-17', refusalReasonCode: 'personal' };
export const ESIGN = '/api/tenant/esign';
type Source = { offerId: string } | { businessId: string };
export type Task = typeof esignTasks.$inferSelect;

export async function ok<T = unknown>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return res.json() as Promise<T>;
}

export async function taskFixture(db: Db, tenantId: string, userId: string) {
  const api = tenantApi(db, { clock: () => OF_NOW });
  const query = async <T>(statement: ReturnType<typeof sql>) =>
    rowsOf<T>(await withTenant(db, tenantId, (tx) => tx.execute(statement)));
  const read = async (id: string) =>
    withTenant(db, tenantId, async (tx) => {
      const [task] = await tx
        .select()
        .from(esignTasks)
        .where(and(eq(esignTasks.tenantId, tenantId), eq(esignTasks.id, id)));
      expect(task).toBeDefined();
      return task!;
    });
  const seed = async (source: Source, employeeId: string, sourceRevision: number) => {
    const scene = 'offerId' in source ? 'offer' : 'entry';
    if ('offerId' in source) {
      const existing = await query(sql`SELECT 1 FROM esign_offer_sources WHERE offer_id=${source.offerId}::uuid`);
      if (!existing.length) await insertAnchor(db, tenantId, source.offerId);
    }
    const templateName = `ZZ_F505_签署模板_${uniqueSuffix()}`;
    const template = await ok<{ id: string }>(
      await api.request('POST', ESIGN + '/templates', {
        tenant: tenantId,
        user: userId,
        body: { code: uniqueSuffix(), name: templateName, body: 'ZZ_F505_签署正文' },
      }),
      201,
    );
    const id = await insertTask(db, tenantId, userId, { scene, ...source, employeeId, sourceRevision });
    await withTenant(db, tenantId, async (tx) => {
      const signer = await userOfPerson(tx, tenantId, employeeId);
      expect(signer).toBeTruthy();
      await tx
        .update(esignTasks)
        .set({
          employeeSignerUserId: signer,
          initiatedAt: OF_NOW,
          expiresAt: new Date(OF_NOW.getTime() + 2 * 86_400_000),
        })
        .where(and(eq(esignTasks.tenantId, tenantId), eq(esignTasks.id, id)));
      await tx.insert(esignTaskFiles).values({
        tenantId,
        taskId: id,
        seq: 1,
        templateId: template.id,
        templateName,
        content: 'ZZ_F505_签署正文',
      });
    });
    return read(id);
  };
  const sign = (task: Task, user: string, idempotencyKey = uniqueSuffix()) =>
    api.request('POST', `${ESIGN}/mine/${task.id}/sign`, {
      tenant: tenantId,
      user,
      body: { revision: task.revision },
      idempotencyKey,
    });
  const notices = (id: string) =>
    query<{ template: string; recipient: string; payload: unknown }>(sql`
    SELECT template_code AS template, recipient_user_id::text AS recipient, payload FROM approval_notifications
    WHERE business_type='esign_task' AND business_id=${id}::uuid ORDER BY template_code, recipient_user_id`);
  const revoked = async (task: Task, cause: Task['revokeCause']) => {
    expect(await read(task.id), '旧任务应撤销，且保留源绑定').toMatchObject({
      status: 'revoked',
      currentNode: null,
      revision: task.revision + 1,
      revokeCause: cause,
      revokedBy: userId,
      scene: task.scene,
      offerId: task.offerId,
      businessId: task.businessId,
    });
    expect(await notices(task.id)).toEqual([
      {
        template: 'esign_revoked_employee',
        recipient: task.employeeSignerUserId,
        payload: { scene: task.scene, taskNumber: task.id },
      },
      { template: 'esign_revoked_initiator', recipient: userId, payload: { scene: task.scene, taskNumber: task.id } },
    ]);
  };
  const files = (id: string) =>
    query(sql`SELECT template_name, content FROM esign_task_files WHERE task_id=${id}::uuid`);
  return { query, read, seed, sign, notices, revoked, files };
}

export async function lifecycleWorld(db: Db, label: string) {
  const w = await syncWorld(db, `ZZ_F505_${label}`);
  const tasks = await taskFixture(db, w.tenant.id, w.user.id);
  const offer = async (fields: Record<string, unknown> = {}) =>
    w.accepted(await fullSocial(w, { name: 'ZZ_F505_候选人', ...fields }));
  const pair = async (fields: Record<string, unknown> = {}) => {
    const source = await offer(fields);
    const entry = await w.entryOf(source);
    const offerTask = await tasks.seed({ offerId: source.id }, entry.employeeId, source.revision);
    const entryTask = await tasks.seed({ businessId: entry.id }, entry.employeeId, await w.businessRevision(entry.id));
    return { source, entry, offerTask, entryTask };
  };
  const editOffer = (source: { id: string; revision: number }, body: object) =>
    w.request('PUT', `/${source.id}`, { ifMatch: source.revision, body });
  const editEntry = async (id: string, body: object) =>
    w.employment('PATCH', `/pending-entries/${id}`, { ifMatch: await w.businessRevision(id), body });
  const deleteOffer = (source: { id: string; revision: number }, idempotencyKey?: string) =>
    w.request('DELETE', `/${source.id}`, { ifMatch: source.revision, ...(idempotencyKey ? { idempotencyKey } : {}) });
  const cancelEntry = async (id: string, idempotencyKey?: string) =>
    w.employment('POST', `/pending-entries/${id}/cancel`, {
      ifMatch: await w.businessRevision(id),
      body: {},
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  return { ...w, ...tasks, readOffer: w.read, offer, pair, editOffer, editEntry, deleteOffer, cancelEntry };
}
