/**
 * F-181a：调动暂存服务端按人一份（DEC-511 / DEC-596；#350 第 1 轮审查遗留）。
 * 同一经办人对同一员工只保留一份“他人调动申请”暂存单：再暂存覆盖、提交释放、清除删单，并提供元数据读口。
 * 读口：GET /transfers/employees/:id/draft；清除：DELETE /transfers/employees/:id/draft（If-Match = 暂存单 revision）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { addMember } from './AC-PRM-support.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const D = '2026-10-10';

interface DraftMeta {
  readonly businessId: string;
  readonly employeeId: string;
  readonly revision: number;
  readonly transferTypeCode: string;
  readonly reasonCode: string | null;
  readonly withEstablishment: boolean;
  readonly formId: string;
  readonly effectiveDate: string;
}

async function slotWorld(label: string) {
  const w = await activationWorld(database().db, label);
  const person = await w.hired('暂存员工');
  const rows = async <T>(query: ReturnType<typeof sql>) =>
    withTenant(w.db, w.session.tenant.id, async (tx) => {
      const result = await tx.execute(query);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
    });
  const save = async (body: Record<string, unknown> = {}, user?: string) => {
    const current = (await w.session.getEmployee(person.employee.id)).revision;
    return request(
      'POST',
      `/transfers/employees/${person.employee.id}`,
      {
        ifMatch: current,
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          mode: 'application',
          submit: false,
          effectiveDate: D,
          fields: { departmentId: w.to.id },
          ...body,
        },
      },
      user,
    );
  };
  const other = { api: tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00.000Z') }) };
  const request = (
    method: string,
    path: string,
    options: Parameters<typeof w.session.request>[2] = {},
    user?: string,
  ) =>
    user
      ? other.api.request(method, `/api/tenant/employment${path}`, { ...options, user, tenant: w.session.tenant.id })
      : w.session.request(method, path, options);
  const draft = async (user?: string) => {
    const response = await request('GET', `/transfers/employees/${person.employee.id}/draft`, {}, user);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { draft: DraftMeta | null }).draft;
  };
  const clear = (revision: number, key = randomUUID(), user?: string) =>
    request(
      'DELETE',
      `/transfers/employees/${person.employee.id}/draft`,
      { ifMatch: revision, idempotencyKey: key },
      user,
    );
  const businessState = async (id: string) =>
    (
      await rows<{ state: string }>(sql`SELECT state FROM employment_state_events
        WHERE tenant_id=${w.session.tenant.id} AND business_id=${id}::uuid ORDER BY event_no DESC LIMIT 1`)
    )[0]?.state;
  const liveDrafts = async () =>
    rows<{ id: string }>(sql`SELECT o.id FROM employment_business_objects o
      JOIN transfer_requests r ON r.tenant_id=o.tenant_id AND r.business_id=o.id
      WHERE o.tenant_id=${w.session.tenant.id} AND o.employee_id=${person.employee.id}::uuid
        AND (SELECT s.state FROM employment_state_events s WHERE s.tenant_id=o.tenant_id AND s.business_id=o.id
             ORDER BY s.event_no DESC LIMIT 1)='draft'`);
  const colleague = () => addMember({ db: w.db, tenant: w.session.tenant } as Parameters<typeof addMember>[0], '同事');
  return { w, person, colleague, save, draft, clear, businessState, liveDrafts, request };
}

async function saved(response: Response) {
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; revision: number };
}

describe('AC-TRF-F181a 调动暂存服务端按人一份', () => {
  it('①暂存后读口返回暂存单元数据（异动类型、原因、编制、表单、生效日）', async () => {
    const s = await slotWorld('f181a-meta');
    expect(await s.draft()).toBeNull();
    const first = await saved(await s.save({ reasonCode: undefined }));
    expect(await s.draft()).toMatchObject({
      businessId: first.id,
      employeeId: s.person.employee.id,
      revision: first.revision,
      transferTypeCode: 'cross_department',
      reasonCode: null,
      withEstablishment: false,
      effectiveDate: D,
    });
  });

  it('②同一人再暂存覆盖：读口指向新单，旧暂存单被删除，草稿恰好一份', async () => {
    const s = await slotWorld('f181a-overwrite');
    const first = await saved(await s.save());
    const second = await saved(await s.save({ effectiveDate: '2026-10-12' }));
    expect(second.id).not.toBe(first.id);
    expect(await s.draft()).toMatchObject({ businessId: second.id, effectiveDate: '2026-10-12' });
    expect(await s.businessState(first.id)).toBe('deleted');
    expect((await s.liveDrafts()).map((row) => row.id)).toEqual([second.id]);
  });

  it('③不同经办人各留一份，互相看不到也覆盖不了', async () => {
    const s = await slotWorld('f181a-owners');
    const colleague = await s.colleague();
    const mine = await saved(await s.save());
    const theirs = await saved(await s.save({ effectiveDate: '2026-10-15' }, colleague.id));
    expect(await s.draft()).toMatchObject({ businessId: mine.id });
    expect(await s.draft(colleague.id)).toMatchObject({ businessId: theirs.id });
    expect(await s.businessState(mine.id)).toBe('draft');
    // 同事清除只清自己的那份，我的暂存单不受影响
    expect((await s.clear(theirs.revision, randomUUID(), colleague.id)).status).toBe(200);
    expect(await s.draft(colleague.id)).toBeNull();
    expect(await s.draft()).toMatchObject({ businessId: mine.id });
    expect(await s.businessState(mine.id)).toBe('draft');
  });

  it('④提交（含由暂存带出后提交）释放暂存：旧暂存单删除，读口为空', async () => {
    const s = await slotWorld('f181a-submit');
    const first = await saved(await s.save());
    await saved(await s.save({ submit: true }));
    expect(await s.draft()).toBeNull();
    expect(await s.businessState(first.id)).toBe('deleted');
  });

  it('⑤撤回回到草稿的申请不是暂存单：读口为空，再暂存也不会删它', async () => {
    const s = await slotWorld('f181a-withdrawn');
    const submitted = await saved(await s.save({ submit: true }));
    const withdraw = await s.request('POST', `/businesses/${submitted.id}/withdraw`, { ifMatch: submitted.revision });
    expect(withdraw.status, await withdraw.clone().text()).toBe(200);
    expect(await s.businessState(submitted.id)).toBe('draft');
    expect(await s.draft()).toBeNull();
    const stash = await saved(await s.save({ effectiveDate: '2026-10-20' }));
    expect(await s.businessState(submitted.id)).toBe('draft');
    expect(await s.draft()).toMatchObject({ businessId: stash.id });
  });

  it('⑥清除：删除暂存单并清空读口；同命令 ID 重放得到原结果，过期 revision 409，无暂存 404', async () => {
    const s = await slotWorld('f181a-clear');
    const first = await saved(await s.save());
    expect((await s.clear(first.revision + 1)).status).toBe(409);
    expect(await s.draft()).toMatchObject({ businessId: first.id });
    const key = randomUUID();
    const cleared = await s.clear(first.revision, key);
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(await cleared.json()).toMatchObject({ businessId: first.id, cleared: true });
    expect(await s.draft()).toBeNull();
    expect(await s.businessState(first.id)).toBe('deleted');
    const replay = await s.clear(first.revision, key);
    expect(replay.status).toBe(200);
    const none = await s.clear(first.revision);
    expect(none.status).toBe(404);
    // 清除后可以再暂存
    const again = await saved(await s.save());
    expect(await s.draft()).toMatchObject({ businessId: again.id });
  });

  it('⑦只能清除自己的暂存：他人没有暂存时 404，不泄露别人的暂存单', async () => {
    const s = await slotWorld('f181a-foreign');
    const colleague = await s.colleague();
    const mine = await saved(await s.save());
    expect((await s.clear(mine.revision, randomUUID(), colleague.id)).status).toBe(404);
    expect(await s.draft(colleague.id)).toBeNull();
    expect(await s.businessState(mine.id)).toBe('draft');
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-TRF-F181a 真实 PG 并发', () => {
  it('⑧同一员工两次暂存并发：至多一笔成功之外的必须 409，最终恰好一份暂存单且读口一致', async () => {
    const s = await slotWorld('f181a-race');
    const revision = (await s.w.session.getEmployee(s.person.employee.id)).revision;
    const send = (effectiveDate: string) =>
      s.request('POST', `/transfers/employees/${s.person.employee.id}`, {
        ifMatch: revision,
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          mode: 'application',
          submit: false,
          effectiveDate,
          fields: { departmentId: s.w.to.id },
        },
      });
    const responses = await Promise.all([send('2026-10-11'), send('2026-10-12')]);
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses[0]).toBe(201);
    for (const status of statuses.slice(1)) expect([201, 409]).toContain(status);
    const winners = responses.filter((r) => r.status === 201);
    const live = await s.liveDrafts();
    expect(live.length).toBe(1);
    const meta = await s.draft();
    expect(meta?.businessId).toBe(live[0]!.id);
    expect(winners.length).toBeGreaterThanOrEqual(1);
  });

  it('⑨并发下一次暂存与一次清除：读口与草稿一致（要么都在，要么都无）', async () => {
    const s = await slotWorld('f181a-race-clear');
    const first = await saved(await s.save());
    const revision = (await s.w.session.getEmployee(s.person.employee.id)).revision;
    const [stash, clear] = await Promise.all([
      s.request('POST', `/transfers/employees/${s.person.employee.id}`, {
        ifMatch: revision,
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          mode: 'application',
          submit: false,
          effectiveDate: '2026-10-13',
          fields: { departmentId: s.w.to.id },
        },
      }),
      s.clear(first.revision),
    ]);
    expect([201, 409]).toContain(stash.status);
    expect([200, 404, 409]).toContain(clear.status);
    const live = await s.liveDrafts();
    const meta = await s.draft();
    expect(live.length).toBeLessThanOrEqual(1);
    expect(meta?.businessId ?? null).toBe(live[0]?.id ?? null);
  });
});
