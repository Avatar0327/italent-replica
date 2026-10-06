import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { buttonResource, CONTRACT_OBJECT, MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld, type ContractView } from './AC-CT-support.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { allowAll, tenantApi } from './support/tenant-api.js';
import { runContractJobs } from '../../apps/api/src/modules/contracts/scheduler.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';
import { changeContractForTransfer, generateContractForBusiness } from '../../apps/api/src/modules/contracts/ports.js';

const testDb = useTestDb();
type World = Awaited<ReturnType<typeof contractWorld>>;
const now = new Date('2026-10-01T01:00:00Z');
const identity = (w: World) => ({ tenant: w.session.tenant.id, user: w.session.user.id });
const context = (w: World) => ({
  tenantId: w.session.tenant.id,
  userId: w.session.user.id,
  timezone: 'Asia/Shanghai',
  now,
  commandId: randomUUID(),
  expectedRevision: 0,
});
async function rule(w: World, orgIds = [w.org.id], priority = 1, typeId = w.type.id) {
  const response = await w.request('POST', '/rules', {
    ifMatch: 0,
    body: {
      name: `规则${priority}`,
      priority,
      orgIds,
      personIds: [],
      details: [{ typeId, months: 12, initiatorId: w.session.user.id, daysBefore: 10, skipTypeIds: [] }],
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
}
const sweep = (w: World, limit = 100) =>
  runContractJobs(
    w.db,
    { tenantId: w.session.tenant.id, limit },
    {
      clock: () => now,
      authorize: allowAll,
    },
  );
async function application(w: World, operation = 'renew') {
  const source = await w.create();
  const response = await w.request('POST', '/commands', {
    ifMatch: 1,
    body: {
      operation,
      mode: 'application',
      employeeId: w.employee.id,
      targetId: source.id,
      fields: { effectiveDate: '2026-10-01', endDate: '2027-09-30' },
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string };
}
async function reject(w: World, requestId: string) {
  const [task] = await withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{
      id: string;
      userId: string;
      instanceId: string;
      revision: number;
    }>(
      await tx.execute(sql`SELECT t.id,t.assignee_user_id AS "userId",i.id AS "instanceId",i.revision
    FROM approval_tasks t JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
    WHERE i.business_id=${requestId}::uuid AND t.status='pending'`),
    ),
  );
  const api = tenantApi(w.db, { clock: () => now });
  const response = await api.request('POST', '/api/tenant/contracts/todos/batch', {
    ...identity(w),
    user: task!.userId,
    ifMatch: 0,
    body: { action: 'reject', items: [{ id: task!.id, revision: task!.revision }] },
  });
  expect(await response.json()).toMatchObject({ items: [{ status: 200 }] });
  const [instance] = await withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{ id: string; revision: number }>(
      await tx.execute(sql`SELECT id,revision FROM approval_instances WHERE id=${task!.instanceId}::uuid`),
    ),
  );
  return instance!;
}

describe('PR #64 第二轮 P2 / DEC-164 回归', () => {
  it('P2-1 / AC-CT-04 父组织含下级，整个人只使用最高优先级规则', async () => {
    const w = await contractWorld(testDb().db, 'ctr2org');
    const child = await w.session.org('下级部门', {
      establishedOn: '2025-01-01',
      parents: { admin: { parentId: w.org.id } },
    });
    const employee = await w.session.getEmployee(w.employee.id);
    await w.session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: child.id },
      },
      employee.revision,
    );
    await w.create({ endDate: '2026-10-05' });
    await w.create({ typeId: w.otherType.id, endDate: '2026-10-05' });
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
    await w.settings({ autoRenew: true });
    await rule(w, [w.org.id], 1);
    await rule(w, [child.id], 2, w.otherType.id);
    await sweep(w);
    expect(await w.list('in_review')).toMatchObject([{ typeId: w.type.id }]);
  });

  it.each(['terminate', 'change'])('P2-2 已终止合同拒绝 %s，保留原实际终止日', async (operation) => {
    const w = await contractWorld(testDb().db, `ctr2${operation}`);
    const source = await w.create();
    const terminated = (await (
      await w.change(source, 'terminate', { actualTerminationDate: '2026-09-20' })
    ).json()) as ContractView;
    const response = await w.change(
      terminated,
      operation,
      operation === 'terminate' ? { actualTerminationDate: '2026-09-30' } : { effectiveDate: '2025-02-01' },
    );
    expect(response.status).toBe(409);
    expect(await (await w.request('GET', `/records/${source.id}`)).json()).toMatchObject({
      status: 'terminated',
      actualTerminationDate: '2026-09-20',
      revision: 2,
    });
    expect((await w.change(terminated, 'renew', { effectiveDate: '2026-10-01', endDate: '2027-09-30' })).status).toBe(
      201,
    );
  });

  it.each(['create', 'renew', 'change', 'terminate'])('P2-3 %s 申请与直接权限分离（单条及批量）', async (operation) => {
    const w = await contractWorld(testDb().db, `ctr2mode${operation}`);
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
    const source = await w.create();
    const place = operation === 'create' ? 'list' : 'detail';
    const applicationButton = buttonResource(CONTRACT_OBJECT, `${operation}Application`, place);
    const api = tenantApi(w.db, {
      clock: () => now,
      authorize: (r) => r.action !== 'object.button' || r.resource === applicationButton,
    });
    const body = {
      operation,
      mode: 'application',
      employeeId: w.employee.id,
      ...(operation === 'create' ? {} : { targetId: source.id }),
      fields: operation === 'terminate' ? { actualTerminationDate: '2026-09-30' } : w.fields,
    };
    const revision = operation === 'create' ? 0 : 1;
    for (const path of ['commands', 'batch']) {
      const response = await api.request('POST', `/api/tenant/contracts/${path}`, {
        ...identity(w),
        ifMatch: path === 'batch' ? 0 : revision,
        body:
          path === 'batch'
            ? { items: [{ revision, command: { ...body, mode: 'direct' } }] }
            : { ...body, mode: 'direct' },
      });
      expect(response.status).toBe(403);
    }
    const submitted = await api.request('POST', '/api/tenant/contracts/commands', {
      ...identity(w),
      ifMatch: revision,
      body,
    });
    expect(submitted.status, await submitted.clone().text()).toBe(201);
    expect(JSON.stringify(MODULE_OBJECTS.contract)).toContain(`${operation}Application`);
    // 只持直接按钮也不能走申请，批量入口逐条检查 mode。
    const directOnly = tenantApi(w.db, {
      authorize: (r) =>
        r.action !== 'object.button' || r.resource === buttonResource(CONTRACT_OBJECT, operation, place),
    });
    expect(
      (
        await directOnly.request('POST', '/api/tenant/contracts/batch', {
          ...identity(w),
          ifMatch: 0,
          body: { items: [{ revision, command: body }] },
        })
      ).status,
    ).toBe(403);
  });

  it('P2-4 DEC-113 撤销原申请按钮后，审批中心及合并待办重提都拒绝', async () => {
    const w = await contractWorld(testDb().db, 'ctr2resubmit');
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
    const request = await application(w);
    const instance = await reject(w, request.id);
    let permitted = false;
    const api = tenantApi(w.db, {
      clock: () => now,
      authorize: (r) =>
        permitted ||
        !(r.action === 'object.button' && r.resource === buttonResource(CONTRACT_OBJECT, 'renewApplication', 'detail')),
    });
    const single = () =>
      api.request('POST', `/api/tenant/approval/instances/${instance.id}/resubmit`, {
        ...identity(w),
        ifMatch: instance.revision,
        body: {},
      });
    expect((await single()).status).toBe(403);
    expect(
      await (
        await api.request('POST', '/api/tenant/contracts/todos/batch', {
          ...identity(w),
          ifMatch: 0,
          body: { action: 'resubmit', items: [instance] },
        })
      ).json(),
    ).toMatchObject({ items: [{ status: 403 }] });
    permitted = true;
    expect((await single()).status).toBe(200);
  });

  it('P2-5 变更链只判最新版本，连续续签后不列出被替代的原合同', async () => {
    const w = await contractWorld(testDb().db, 'ctr2view');
    const a = await w.create({ endDate: '2026-12-31' });
    const b = (await (
      await w.change(a, 'change', { effectiveDate: '2026-03-01', endDate: '2026-10-31' })
    ).json()) as ContractView;
    w.setNow('2027-01-02T01:00:00Z');
    expect((await w.list('expired_unrenewed')).map((c) => c.id)).toEqual([b.id]);
    expect((await w.change(b, 'renew', { effectiveDate: '2026-11-01', endDate: '2029-10-31' })).status).toBe(201);
    expect(await w.list('expired_unrenewed')).toEqual([]);
  });

  it('DEC-164② 提前终止排除，续签有空档仍列出', async () => {
    const w = await contractWorld(testDb().db, 'ctr2gap');
    const early = await w.create();
    await w.change(early, 'terminate', { actualTerminationDate: '2026-09-20' });
    const gap = await w.create();
    w.setNow('2026-10-03T01:00:00Z');
    await w.change(gap, 'renew', { effectiveDate: '2026-10-02', endDate: '2027-10-01' });
    expect((await w.list('expired_unrenewed')).map((c) => c.id)).toEqual([gap.id]);
  });

  it('P2-6 未到续签窗口不占扫描量，生效与到期终止优先且无游标可继续推进', async () => {
    const w = await contractWorld(testDb().db, 'ctr2due');
    await w.create({ endDate: '2028-09-30' });
    await w.create({ endDate: '2028-10-31' });
    const expired = await w.create();
    await w.settings({ autoRenew: true, autoTerminate: true });
    await rule(w);
    // 人为固定末尾 UUID 只影响排序；申请通过公开命令创建，仍由生产调度生效。
    const future = await w.create({ effectiveDate: '2026-10-02', endDate: '2027-10-01' });
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      tx.execute(sql`UPDATE contract_requests
      SET id='ffffffff-ffff-4fff-bfff-ffffffffffff',effective_date='2026-10-01' WHERE id=${future.id}::uuid`),
    );
    const first = await sweep(w, 1);
    expect(first.runs[0]?.outcomes).toMatchObject([{ kind: 'activate', state: 'succeeded' }]);
    const second = await sweep(w, 1);
    expect(second.runs[0]?.outcomes).toMatchObject([{ id: expired.id, kind: 'expire', state: 'succeeded' }]);
    expect((await sweep(w, 1)).runs[0]?.outcomes).toEqual([]);
  });

  it('P2-6 无游标重复调用越过 skipped 候选，继续处理其他到期合同', async () => {
    const w = await contractWorld(testDb().db, 'ctr2rotation');
    const sources = [
      await w.create({ endDate: '2026-10-01' }),
      await w.create({ typeId: w.otherType.id, endDate: '2026-10-01' }),
    ].sort((a, b) => a.id.localeCompare(b.id));
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
    await w.settings({ autoRenew: true });
    await rule(w, [w.org.id], 1, sources[1]!.typeId);
    expect((await sweep(w, 1)).runs[0]?.outcomes).toMatchObject([{ id: sources[0]!.id, state: 'skipped' }]);
    expect((await sweep(w, 1)).runs[0]?.outcomes).toMatchObject([{ id: sources[1]!.id, state: 'succeeded' }]);
    expect(await w.list('in_review')).toHaveLength(1);
  });

  it.each(['direct', 'import'])('DEC-164① 离职员工可通过 %s 补录最后工作日及之前的合同，之后受限', async (mode) => {
    const w = await contractWorld(testDb().db, `ctr2exit${mode}`);
    const employee = await w.session.getEmployee(w.employee.id);
    await w.session.business(
      employee.id,
      { kind: 'leave', mode: 'direct', effectiveDate: '2026-10-01', lastWorkDate: '2026-09-30', fields: {} },
      employee.revision,
    );
    for (const effectiveDate of ['2026-09-29', '2026-09-30', '2026-10-01']) {
      const fields = { ...w.fields, effectiveDate, endDate: '2027-09-30' };
      const response = await w.request('POST', mode === 'direct' ? '/commands' : '/imports', {
        ifMatch: 0,
        body:
          mode === 'direct'
            ? { operation: 'create', mode: 'direct', employeeId: w.employee.id, fields }
            : { mode: 'add', rows: [{ employeeId: w.employee.id, fields }] },
      });
      expect(response.status, await response.clone().text()).toBe(
        effectiveDate > '2026-09-30' ? 400 : mode === 'direct' ? 201 : 200,
      );
    }
  });

  it('DEC-164③ AC-CT-06 变更旧合同止于新合同生效日前一天', async () => {
    const w = await contractWorld(testDb().db, 'ctr2end');
    const source = await w.create();
    expect((await w.change(source, 'change', { effectiveDate: '2026-03-01' })).status).toBe(201);
    expect(await (await w.request('GET', `/records/${source.id}`)).json()).toMatchObject({
      actualTerminationDate: '2026-02-28',
    });
  });
});

describe('PR #64 第二轮可落实的 P3', () => {
  it('人工续签在途时自动续签跳过，不产生失败记录', async () => {
    const w = await contractWorld(testDb().db, 'ctr2pending');
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
    await application(w);
    await w.settings({ autoRenew: true });
    await rule(w);
    expect((await sweep(w)).runs[0]?.outcomes.every((o) => o.state === 'skipped')).toBe(true);
    expect(await (await w.request('GET', '/failures')).json()).toMatchObject({ items: [] });
  });

  it('续签不继承签订日与试用起止日期', async () => {
    const w = await contractWorld(testDb().db, 'ctr2inherit');
    const source = await w.create({ probationStartDate: '2025-01-01', probationEndDate: '2025-03-31' });
    expect(
      await (await w.change(source, 'renew', { effectiveDate: '2026-10-01', endDate: '2027-09-30' })).json(),
    ).toMatchObject({ signingDate: null, probationStartDate: null, probationEndDate: null });
  });

  it('调动端口显式接收合同 revision，编号冲突是可机读错误且事务回滚', async () => {
    const w = await contractWorld(testDb().db, 'ctr2port');
    const source = await w.create({ number: 'DUPLICATE' });
    const input = {
      employeeId: w.employee.id,
      targetId: source.id,
      revision: source.revision,
      fields: { effectiveDate: '2025-02-01' },
    };
    const result = await withTenant(w.db, w.session.tenant.id, (tx) =>
      changeContractForTransfer(tx, context(w), input),
    );
    expect(result).toMatchObject({ previousContractId: source.id });
    await expect(
      withTenant(w.db, w.session.tenant.id, (tx) =>
        generateContractForBusiness(tx, context(w), {
          employeeId: w.employee.id,
          fields: { ...w.fields, termType: 'fixed', number: 'DUPLICATE' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('批量与初始化导入接受大小写混合 UUID 并使用同一员工版本', async () => {
    const w = await contractWorld(testDb().db, 'ctr2uuid');
    const source = await w.create();
    const response = await w.request('POST', '/batch', {
      ifMatch: 0,
      body: {
        items: [
          {
            revision: 1,
            command: {
              operation: 'terminate',
              mode: 'direct',
              employeeId: w.employee.id.toUpperCase(),
              targetId: source.id.toUpperCase(),
              fields: { actualTerminationDate: '2026-09-30' },
            },
          },
        ],
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const version = (await (await w.request('GET', `/employees/${w.employee.id}/revision`)).json()) as {
      revision: number;
    };
    const imported = await w.request('POST', '/imports', {
      ifMatch: 0,
      body: {
        mode: 'initialize',
        rows: [{ employeeId: w.employee.id.toUpperCase(), fields: w.fields }],
        revisions: { [w.employee.id]: version.revision },
      },
    });
    expect(imported.status, await imported.clone().text()).toBe(200);
  });
});
