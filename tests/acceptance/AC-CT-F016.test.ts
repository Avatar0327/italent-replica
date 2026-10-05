/** F-016 / F-014：PR #64 astra 校准问题的行为回归。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { APPROVAL_TYPES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld, type ContractView } from './AC-CT-support.js';
import { tenantApi, allowAll } from './support/tenant-api.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';
import { contractAdapter } from '../../apps/api/src/modules/contracts/adapter.js';
import { runContractJobs } from '../../apps/api/src/modules/contracts/scheduler.js';
import { generateContractForBusiness, changeContractForTransfer } from '../../apps/api/src/modules/contracts/ports.js';
import { requireResubmitRight } from '../../apps/api/src/modules/approval/access.js';

const database = useTestDb();
type World = Awaited<ReturnType<typeof contractWorld>>;
const clock = () => new Date('2026-10-01T01:00:00Z');
const ctx = (w: World) => ({
  tenantId: w.session.tenant.id,
  userId: w.session.user.id,
  timezone: 'Asia/Shanghai',
  now: clock(),
  commandId: randomUUID(),
  expectedRevision: 0,
});
async function world(label: string) {
  return contractWorld(database().db, `f016-${label}`);
}
async function pending(w: World, fields: object = {}, mode = 'direct') {
  return w.request('POST', '/commands', {
    ifMatch: 0,
    body: {
      operation: 'create',
      mode,
      employeeId: w.employee.id,
      fields: { ...w.fields, effectiveDate: '2026-11-01', endDate: '2027-10-31', ...fields },
    },
  });
}
async function edit(w: World, c: ContractView, fields: object) {
  return w.request('POST', '/imports', {
    ifMatch: 0,
    body: {
      mode: 'edit',
      rows: [{ employeeId: w.employee.id, revision: c.revision, fields: { number: c.number, ...fields } }],
    },
  });
}
async function expired(w: World) {
  const c = await w.create();
  const r = await w.change(c, 'terminate', { actualTerminationDate: '2026-09-30' });
  expect(r.status).toBe(201);
  return (await r.json()) as ContractView;
}
async function leave(w: World, effectiveDate: string) {
  const e = await w.session.getEmployee(w.employee.id);
  return w.session.business(
    e.id,
    {
      kind: 'leave',
      mode: 'direct',
      effectiveDate,
      lastWorkDate: effectiveDate === '2026-10-10' ? '2026-10-09' : '2026-09-30',
      fields: {},
    },
    e.revision,
  );
}

describe('AC-CT F-016 字段与日期', () => {
  it('P1-1 空 customFields 不删除未提交字段；显式 null 必须鉴权', async () => {
    const w = await world('custom');
    const d = await w.session.request('POST', '/custom-fields', {
      ifMatch: 0,
      body: { name: '保密备注', objectType: 'contract', valueType: 'text' },
    });
    const { id } = (await d.json()) as { id: string };
    const original = await w.create({ customFields: { [id]: '保留' } });
    const api = tenantApi(w.db, {
      clock,
      authorize: (r) => !(r.action === 'object.update' && r.fields?.includes(`custom:${id}`)),
    });
    const send = (customFields: object) =>
      api.request('POST', '/api/tenant/contracts/commands', {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: 1,
        body: {
          operation: 'change',
          mode: 'direct',
          employeeId: w.employee.id,
          targetId: original.id,
          fields: { customFields },
        },
      });
    expect((await send({ [id]: null })).status).toBe(403);
    const response = await send({});
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ customFields: { [id]: '保留' } });
  });
  it('P1-1 旧申请删除字段时 changedFields 包含旧键，触发盲审检查', async () => {
    const w = await world('deleted-snapshot');
    const d = await w.session.request('POST', '/custom-fields', {
      ifMatch: 0,
      body: { name: '历史备注', objectType: 'contract', valueType: 'text' },
    });
    const { id } = (await d.json()) as { id: string };
    const original = await w.create({ customFields: { [id]: '旧值' } });
    const response = await w.change(original, 'change', { effectiveDate: '2026-11-01', endDate: '2027-10-31' });
    const request = (await response.json()) as { id: string };
    await withTenant(w.db, w.session.tenant.id, async (tx) => {
      await tx.execute(sql`UPDATE contract_requests SET custom_fields='{}'::jsonb WHERE id=${request.id}::uuid`);
      const snapshot = await contractAdapter.snapshot(tx, ctx(w), request.id);
      expect(snapshot.changedFields).toContain(`custom:${id}`);
    });
  });
  it.each(['direct', 'import', 'port'])('P2-5 CT-R18a %s：过期日期按租户今天补齐', async (entry) => {
    const w = await world(`date-${entry}`);
    w.setNow('2026-09-30T16:30:00Z');
    let result: unknown;
    if (entry === 'direct') result = await w.create();
    else if (entry === 'import') {
      const response = await w.request('POST', '/imports', {
        ifMatch: 0,
        body: { mode: 'add', rows: [{ employeeId: w.employee.id, fields: w.fields }] },
      });
      expect(response.status).toBe(200);
      result = ((await response.json()) as { items: unknown[] }).items[0];
    } else
      result = await withTenant(w.db, w.session.tenant.id, (tx) =>
        generateContractForBusiness(
          tx,
          { ...ctx(w), now: new Date('2026-09-30T16:30:00Z') },
          { employeeId: w.employee.id, fields: { ...w.fields, termType: 'fixed' } },
        ),
      );
    expect(result).toMatchObject({ actualTerminationDate: '2026-09-30' });
  });
  it('P2-5 未来合同及调动端口清空实际终止日', async () => {
    const w = await world('future-actual');
    const p = await pending(w, { actualTerminationDate: '2026-11-10' });
    expect(await p.json()).toMatchObject({ actualTerminationDate: null });
    const c = await w.create({ typeId: w.otherType.id, endDate: '2027-09-30' });
    const result = await withTenant(w.db, w.session.tenant.id, (tx) =>
      changeContractForTransfer(tx, ctx(w), {
        employeeId: w.employee.id,
        targetId: c.id,
        revision: c.revision,
        fields: { effectiveDate: '2026-11-01', actualTerminationDate: '2026-11-10' },
      }),
    );
    expect(result).toMatchObject({ actualTerminationDate: null });
  });
  it('CT-R18a 延迟到期后的激活按实际租户日期补实际终止日', async () => {
    const w = await world('late-activation');
    const request = await pending(w, { effectiveDate: '2026-10-02', endDate: '2026-10-03' });
    expect(request.status).toBe(201);
    await runContractJobs(
      w.db,
      { tenantId: w.session.tenant.id },
      {
        clock: () => new Date('2026-10-03T16:30:00Z'),
        authorize: allowAll,
      },
    );
    expect(await w.list()).toEqual([expect.objectContaining({ actualTerminationDate: '2026-10-03' })]);
  });
  it('P3 格式错误行仍可下载 CSV，行号准确且不回显原值', async () => {
    const w = await world('csv');
    const response = await w.request('POST', '/imports/errors', {
      ifMatch: 0,
      body: { mode: 'add', rows: [{ employeeId: w.employee.id, fields: { ...w.fields, endDate: 'secret-bad-date' } }] },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    const csv = await response.text();
    expect(csv).toContain('"1","VALIDATION_FAILED"');
    expect(csv).not.toContain('secret-bad-date');
  });
});

describe('AC-CT-03 F-016 计数与在途', () => {
  it.each(['direct', 'application'])('P2-2 %s 在途合同阻止同员工同类型再次提交', async (mode) => {
    const w = await world(`flight-${mode}`);
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
    await w.create();
    const first = await pending(w, {}, mode);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ signingCount: 2 });
    const second = await pending(w, { effectiveDate: '2026-12-01' });
    expect(second.status).toBe(409);
    expect(await second.text()).toContain('在途');
    expect((await pending(w, { typeId: w.otherType.id })).status).toBe(201);
  });
  it('P2-3 逆序补录后的自动续签次数与期限来自同一计算', async () => {
    const w = await world('backfill');
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
    await w.create({ effectiveDate: '2026-01-01', endDate: '2026-10-02' });
    await w.create({ effectiveDate: '2025-01-01', endDate: '2025-12-31' });
    await w.settings({ autoRenew: true });
    expect(
      (
        await w.request('POST', '/rules', {
          ifMatch: 0,
          body: {
            name: '续签',
            priority: 1,
            orgIds: [w.org.id],
            personIds: [],
            details: [
              { typeId: w.type.id, months: 12, initiatorId: w.session.user.id, daysBefore: 10, skipTypeIds: [] },
            ],
          },
        })
      ).status,
    ).toBe(201);
    await runContractJobs(w.db, { tenantId: w.session.tenant.id }, { clock, authorize: allowAll });
    expect(await w.list('in_review')).toEqual([
      expect.objectContaining({ signingCount: 3, termType: 'indefinite', endDate: null }),
    ]);
  });
});

describe('AC-CT-11 F-014 恢复护栏', () => {
  it.each(['rehired', 'future'])('离职后重聘 / 未来已保存离职：%s 不允许跨离职恢复', async (scenario) => {
    const w = await world(`restore-${scenario}`);
    const c = await expired(w);
    await leave(w, scenario === 'future' ? '2026-10-10' : '2026-10-01');
    if (scenario === 'rehired') {
      const e = await w.session.getEmployee(w.employee.id);
      await w.session.business(
        e.id,
        { kind: 'rehire', mode: 'direct', effectiveDate: '2026-10-01', fields: { departmentId: w.org.id } },
        e.revision,
      );
    }
    const response = await edit(w, c, { endDate: '2026-12-31' });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('CONTRACT_EMPLOYEE_DEPARTED');
  });
  it('同类型新建审批在途阻止重叠恢复', async () => {
    const w = await world('restore-pending');
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
    const c = await expired(w);
    expect((await pending(w, {}, 'application')).status).toBe(201);
    const response = await edit(w, c, { endDate: '2026-12-31' });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('CONTRACT_SUPERSEDED_BY_RENEWAL');
  });
  it('有空档且延期后不重叠的后续合同允许恢复', async () => {
    const w = await world('restore-gap');
    const c = await expired(w);
    await w.create({ effectiveDate: '2026-10-01', endDate: '2026-12-31' });
    // 用历史操作时钟模拟旧合同在后续合同之前延期，验证区间判定而非一律拦截。
    w.setNow('2026-09-15T01:00:00Z');
    const response = await edit(w, c, { endDate: '2026-09-30' });
    // 原终止日须确实改晚：另一个较早到期的合同用于实际恢复。
    expect(response.status).toBe(200);
    const old = await w.create({ effectiveDate: '2025-01-01', endDate: '2026-08-31' });
    const termination = await w.change(old, 'terminate', { actualTerminationDate: '2026-08-31' });
    const ended = (await termination.json()) as ContractView;
    const restored = await edit(w, ended, { endDate: '2026-09-29' });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ items: [{ status: 'valid' }] });
  });
  it('P2-6 删除离职记录后入职缺失仍包含当前在职员工', async () => {
    const w = await world('missing');
    const exit = await leave(w, '2026-10-01');
    const deleted = await w.session.request('DELETE', `/businesses/${exit.id}`, { ifMatch: exit.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await w.list('missing')).toEqual([expect.objectContaining({ employeeId: w.employee.id })]);
  });
});

describe('AC-CT F-016 审批与失败退出', () => {
  it('P2-4 终止申请重提仅复核实际载荷及更正字段', async () => {
    const w = await world('resubmit');
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
    const c = await w.create();
    const response = await w.request('POST', '/commands', {
      ifMatch: 1,
      body: {
        operation: 'terminate',
        mode: 'application',
        employeeId: w.employee.id,
        targetId: c.id,
        fields: { actualTerminationDate: '2026-09-30' },
      },
    });
    expect(response.status).toBe(201);
    const request = (await response.json()) as { id: string };
    const instance = await withTenant(
      w.db,
      w.session.tenant.id,
      async (tx) =>
        rowsOf<{ id: string }>(
          await tx.execute(sql`SELECT id FROM approval_instances WHERE business_id=${request.id}::uuid`),
        )[0]!,
    );
    const deps = {
      db: w.db,
      clock,
      authorize: (r: Parameters<typeof allowAll>[0]) =>
        !(r.action === 'object.update' && r.fields?.some((f) => f !== 'actualTerminationDate')),
    };
    await expect(
      requireResubmitRight(deps as Parameters<typeof requireResubmitRight>[0], ctx(w), instance.id),
    ).resolves.toBeUndefined();
    const api = tenantApi(w.db, { clock });
    const task = await withTenant(
      w.db,
      w.session.tenant.id,
      async (tx) =>
        rowsOf<{ id: string; userId: string; revision: number }>(
          await tx.execute(sql`
        SELECT t.id,t.assignee_user_id AS "userId",i.revision FROM approval_tasks t
        JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
        WHERE t.instance_id=${instance.id}::uuid AND t.status='pending'`),
        )[0]!,
    );
    const rejected = await api.request('POST', `/api/tenant/approval/tasks/${task.id}/reject`, {
      tenant: w.session.tenant.id,
      user: task.userId,
      ifMatch: task.revision,
      body: {},
    });
    expect(rejected.status).toBe(200);
    const [returned] = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rowsOf<{ revision: number }>(
        await tx.execute(sql`SELECT revision FROM approval_instances
        WHERE id=${instance.id}::uuid`),
      ),
    );
    const restricted = tenantApi(w.db, { clock, authorize: deps.authorize });
    const endpoint = `/api/tenant/approval/instances/${instance.id}/resubmit`;
    const identity = { tenant: w.session.tenant.id, user: w.session.user.id, ifMatch: returned!.revision };
    expect(
      (await restricted.request('POST', endpoint, { ...identity, body: { fields: { regularSalary: '123' } } })).status,
    ).toBe(403);
    const resubmitted = await restricted.request('POST', endpoint, { ...identity, body: {} });
    expect(resubmitted.status, await resubmitted.clone().text()).toBe(200);
  });
  it('P2-9 条件目录中的每个字段必须存在于实际快照', async () => {
    const w = await world('conditions');
    const r = await pending(w);
    const request = (await r.json()) as { id: string };
    await withTenant(w.db, w.session.tenant.id, async (tx) => {
      const snap = await contractAdapter.snapshot(tx, ctx(w), request.id);
      for (const field of APPROVAL_TYPES.contract_create.conditionFields)
        expect(Object.hasOwn(snap.conditionValues, field.path), field.path).toBe(true);
    });
  });
  it('DEC-180③ 到期失败申请可校验版本撤销，审计与释放在途一致', async () => {
    const w = await world('cancel-failed');
    const c = await w.create({ endDate: '2027-01-01' });
    const r = await w.change(c, 'change', { effectiveDate: '2026-10-02' });
    const request = (await r.json()) as { id: string; revision: number };
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      tx.execute(sql`UPDATE contract_records SET revision=revision+1
      WHERE id=${c.id}::uuid`),
    );
    w.setNow('2026-10-02T01:00:00Z');
    await runContractJobs(
      w.db,
      { tenantId: w.session.tenant.id },
      {
        clock: () => new Date('2026-10-02T01:00:00Z'),
        authorize: allowAll,
      },
    );
    const cancel = (revision: number) =>
      w.request('POST', `/requests/${request.id}/cancel`, {
        ifMatch: revision,
        body: {},
      });
    const noButton = tenantApi(w.db, {
      clock: () => new Date('2026-10-02T01:00:00Z'),
      authorize: (r) => r.action !== 'object.button',
    });
    const denied = await noButton.request('POST', `/api/tenant/contracts/requests/${request.id}/cancel`, {
      tenant: w.session.tenant.id,
      user: w.session.user.id,
      ifMatch: request.revision,
      body: {},
    });
    expect(denied.status).toBe(403);
    expect((await cancel(0)).status).toBe(409);
    const response = await cancel(request.revision);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'withdrawn' });
    expect(await (await w.request('GET', '/failures')).json()).toMatchObject({ items: [] });
    const retry = await w.change({ ...c, revision: c.revision + 1 }, 'change', { effectiveDate: '2026-10-03' });
    expect(retry.status, await retry.clone().text()).toBe(201);
    expect((await cancel(request.revision)).status).toBe(409);
    await withTenant(w.db, w.session.tenant.id, async (tx) => {
      expect(
        rowsOf(
          await tx.execute(sql`SELECT id FROM audit_events WHERE object_id=${request.id}
        AND action='contract.request.cancel'`),
        ),
      ).toHaveLength(1);
    });
  });
  it('P3 租户复合外键阻止跨租户 previous/root/employment/result 引用', async () => {
    const w = await world('fk');
    const other = await world('fk-other');
    const c = await w.create();
    const foreign = await other.create();
    // 申请可变列避免版本不可覆盖触发器掩盖缺少外键的问题。
    await expect(
      withTenant(w.db, w.session.tenant.id, (tx) =>
        tx.execute(sql`UPDATE contract_requests
      SET result_id=${foreign.id}::uuid WHERE result_id=${c.id}::uuid`),
      ),
    ).rejects.toThrow();
    await withTenant(w.db, w.session.tenant.id, async (tx) => {
      const fks = rowsOf<{ columns: string }>(
        await tx.execute(sql`SELECT pg_get_constraintdef(oid) AS columns
        FROM pg_constraint WHERE contype='f'
          AND conrelid IN ('contract_records'::regclass,'contract_requests'::regclass)`),
      );
      for (const column of ['previous_contract_id', 'root_contract_id', 'employment_record_id', 'result_id'])
        expect(
          fks.some((f) => f.columns.includes(`tenant_id, ${column}`)),
          column,
        ).toBe(true);
    });
  });
});
