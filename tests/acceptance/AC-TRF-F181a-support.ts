/**
 * F-181a 验收夹具：定时生效世界里的一名在职员工，HR 通过 /transfers/employees/:id 暂存，
 * 读口 / 清除 / 单据状态 / 槽位的直连查询，以及同租户的第二名经办人。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { addMember } from './AC-PRM-support.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

export const D = '2026-10-10';
export const BASE = '/api/tenant/employment';
export const clock = () => new Date('2026-10-01T01:00:00.000Z');

export interface DraftMeta {
  readonly id: string;
  readonly employeeId: string;
  readonly revision: number;
  readonly transferTypeCode: string;
  readonly reasonCode: string | null;
  readonly withEstablishment: boolean;
  readonly formId: string;
  readonly effectiveDate: string;
}

export async function slotWorld(db: Db, label: string) {
  const w = await activationWorld(db, label);
  const person = await w.hired('暂存员工');
  const tenantId = w.session.tenant.id;
  const employeeId = person.employee.id;
  const rows = async <T>(query: ReturnType<typeof sql>) =>
    withTenant(w.db, tenantId, async (tx) => {
      const result = await tx.execute(query);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
    });
  const second = { api: tenantApi(w.db, { clock }) };
  /** user 缺省为夹具租户的管理员；传入同租户另一用户时走第二个 api。 */
  const request = (method: string, path: string, options: RequestOptions = {}, user?: string) =>
    user
      ? second.api.request(method, `${BASE}${path}`, { ...options, user, tenant: tenantId })
      : w.session.request(method, path, options);
  const stashBody = (body: Record<string, unknown> = {}) => ({
    initiator: 'hr',
    transferTypeCode: 'cross_department',
    mode: 'application',
    submit: false,
    effectiveDate: D,
    fields: { departmentId: w.to.id },
    ...body,
  });
  const employeeRevision = async () => (await w.session.getEmployee(employeeId)).revision;
  /** 暂存（submit=false）；传 submit:true 即直接提交。 */
  const save = async (body: Record<string, unknown> = {}, user?: string, key: string = randomUUID()) =>
    request(
      'POST',
      `/transfers/employees/${employeeId}`,
      { ifMatch: await employeeRevision(), idempotencyKey: key, body: stashBody(body) },
      user,
    );
  const draft = async (user?: string) => {
    const response = await request('GET', `/transfers/employees/${employeeId}/draft`, {}, user);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { draft: DraftMeta | null }).draft;
  };
  /** 清除：绑定读口给的单号与 revision。 */
  const clear = (businessId: string, revision: number, key: string = randomUUID(), user?: string) =>
    request(
      'DELETE',
      `/transfers/employees/${employeeId}/draft/${businessId}`,
      { ifMatch: revision, idempotencyKey: key },
      user,
    );
  const businessState = async (id: string) =>
    (
      await rows<{ state: string }>(sql`SELECT state FROM employment_state_events
        WHERE tenant_id=${tenantId} AND business_id=${id}::uuid ORDER BY event_no DESC LIMIT 1`)
    )[0]?.state;
  const liveDrafts = async () =>
    rows<{ id: string }>(sql`SELECT o.id FROM employment_business_objects o
      JOIN transfer_requests r ON r.tenant_id=o.tenant_id AND r.business_id=o.id
      WHERE o.tenant_id=${tenantId} AND o.employee_id=${employeeId}::uuid
        AND (SELECT s.state FROM employment_state_events s WHERE s.tenant_id=o.tenant_id AND s.business_id=o.id
             ORDER BY s.event_no DESC LIMIT 1)='draft'
      ORDER BY o.created_at, o.id`);
  const slots = async () =>
    rows<{ userId: string; businessId: string }>(sql`SELECT user_id AS "userId", business_id AS "businessId"
      FROM transfer_draft_slots WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid ORDER BY user_id`);
  const colleague = () => addMember({ db: w.db, tenant: w.session.tenant } as Parameters<typeof addMember>[0], '同事');
  return {
    w,
    person,
    tenantId,
    employeeId,
    colleague,
    save,
    draft,
    clear,
    businessState,
    liveDrafts,
    slots,
    request,
    rows,
  };
}
export type SlotWorld = Awaited<ReturnType<typeof slotWorld>>;

export async function saved(response: Response) {
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; revision: number };
}

/** 等 n 个请求都卡在员工行锁上（pg_stat_activity 观察），确认并发交错真的发生。 */
export async function waitForLockWaiters(db: Db, count: number) {
  for (let i = 0; i < 400; i++) {
    const result = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%employment_employees%'`);
    const found = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
    if (found[0]!.n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`没有 ${count} 个请求同时卡在员工行锁上`);
}
