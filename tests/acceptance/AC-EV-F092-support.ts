/** F-092（DEC-416⑦）：真实 HTTP、租户时钟、评审组与离职夹具，数据均为合成数据。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { loginEmailOf } from './AC-EMP-support.js';
import { CANDIDATES, GROUPS, reviewWorld, type Employee, type GroupView } from './AC-EV-review-support.js';
import { EV_BASE, ok } from './AC-EV-support.js';
import { tenantApi } from './support/tenant-api.js';
import { runReviewGroupExits } from '../../apps/api/src/modules/evaluation/review-group-exit-worker.js';
import { uniqueSuffix } from './support/unique.js';

const EMP_BASE = '/api/tenant/employment';
export const EXIT_HANDLER = 'review_group_exit';
export const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

export async function exitWorld(db: Db) {
  const w = await reviewWorld(db);
  let now = new Date('2026-10-10T16:00:00Z'); // 上海 10-11 零点
  const api = tenantApi(db, { clock: () => now });
  const permissionApi = tenantApi(db, { clock: () => now, authorize: undefined });
  const request = (method: string, path: string, extra: Parameters<typeof api.request>[2] = {}) =>
    api.request(method, path, { ...w.asAdmin, ...extra });
  const setTime = (at: string) => {
    now = new Date(at);
  };
  const employee = (id: string) =>
    request('GET', `${EMP_BASE}/employees/${id}`).then((r) => ok<{ id: string; revision: number; status: string }>(r));
  const group = (id: string) => request('GET', `${EV_BASE}${GROUPS}/${id}`).then((r) => ok<GroupView>(r));
  const members = (...people: Employee[]) =>
    people.map((person, index) => ({ employeeId: person.id, isLeader: index === 0 }));
  const createGroup = (people: Employee[], enabled = true, ownerOrgId = w.orgA) =>
    request('POST', `${EV_BASE}${GROUPS}`, {
      ifMatch: 0,
      body: { name: `离职评审组${uniqueSuffix()}`, ownerOrgId, enabled, members: members(...people) },
    }).then((r) => ok<GroupView>(r, 201));
  const edit = (g: GroupView, body: Record<string, unknown>, key: string = randomUUID()) =>
    request('PATCH', `${EV_BASE}${GROUPS}/${g.id}`, { ifMatch: g.revision, body, idempotencyKey: key });
  async function leave(person: Employee, lastWorkDate: string, key: string = randomUUID()) {
    const current = await employee(person.id);
    return request('POST', `${EMP_BASE}/employees/${person.id}/businesses`, {
      ifMatch: current.revision,
      idempotencyKey: key,
      body: { kind: 'leave', mode: 'direct', lastWorkDate, fields: {} },
    });
  }
  async function rehire(person: Employee, effectiveDate: string) {
    const current = await employee(person.id);
    return ok<{ id: string; revision: number }>(
      await request('POST', `${EMP_BASE}/employees/${person.id}/businesses`, {
        ifMatch: current.revision,
        body: {
          kind: 'rehire',
          mode: 'direct',
          effectiveDate,
          fields: { departmentId: w.orgA },
          loginEmail: loginEmailOf(person.id),
        },
      }),
      201,
    );
  }
  const undo = (id: string, revision = 1) => request('DELETE', `${EMP_BASE}/businesses/${id}`, { ifMatch: revision });
  const candidates = (query = '?pageSize=100') =>
    request('GET', `${EV_BASE}${CANDIDATES}${query}`).then((r) =>
      ok<{ items: { id: string; name: string; code: string }[] }>(r),
    );
  const audits = (id: string) =>
    withTenant(db, w.tenant.id, async (tx) =>
      rowsOf<{
        before: GroupView & { members: { employeeId: string; employeeName: string; isLeader: boolean }[] };
        after: GroupView;
        commandId: string;
        actorUserId: string | null;
        changes: { field: string }[];
      }>(
        await tx.execute(sql`SELECT "before", "after", command_id AS "commandId",
      actor_user_id AS "actorUserId", changes
    FROM audit_events WHERE tenant_id=${w.tenant.id} AND object_id=${id}
      AND action='evaluation.review-group.update'
    ORDER BY occurred_at, id`),
      ),
    );
  const queue = (id: string) =>
    withTenant(db, w.tenant.id, async (tx) =>
      rowsOf<{
        state: string;
        reason: string | null;
        attempts: number;
      }>(
        await tx.execute(sql`SELECT state, reason, attempts FROM ev_sync_queue
    WHERE tenant_id=${w.tenant.id} AND handler=${EXIT_HANDLER} AND record_id=${id}::uuid`),
      ),
    );
  const run = () => runReviewGroupExits(db, w.tenant.id, { clock: () => now });
  async function savedLeave(person: Employee, lastWorkDate: string, key?: string) {
    return ok<{ id: string; revision: number }>(await leave(person, lastWorkDate, key), 201);
  }
  const expectMembers = async (id: string, people: Employee[]) => {
    expect((await group(id)).members.map((m) => m.employeeId)).toEqual(people.map((p) => p.id));
  };
  return {
    ...w,
    api: permissionApi,
    review: { ...w, api: permissionApi },
    db,
    request,
    setTime,
    employee,
    group,
    members,
    createGroup,
    edit,
    leave,
    savedLeave,
    rehire,
    undo,
    candidates,
    audits,
    queue,
    run,
    expectMembers,
  };
}

export type ExitWorld = Awaited<ReturnType<typeof exitWorld>>;
