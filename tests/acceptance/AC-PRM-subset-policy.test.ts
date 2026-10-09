/**
 * R3-T02 P0 契约 ②（拆分方案第 3 节；设计 §1.3、§4.1）：人员子集按子集登记的两类策略检查。
 * - 自助申请准入 beforeRequest：首次提交（createChange 锁人后、写申请前）与同单重提（resubmitChangeInTransaction，
 *   在“空修正且申请仍待审批”的提前返回之前）都调用；拒绝时整单回滚——没有申请行、没有审批实例、没有申请审计，
 *   同单重提拒绝后申请状态、revision、版本都不变；审批中心以 {} 重提同样被拦；
 * - 落地前复核 beforeSave：HR 子集写入（新增 / 修改 / 删除）、自助审批通过后的落地、信息采集都经 saveSubset 一处调用；
 *   source.type 区分三个入口；拒绝时子集数据不变、不写审计；
 * - 未登记的子集两类检查都不调用，行为不变；同一子集不能重复登记，撤销登记后恢复原样。
 * 测试用合成数据，策略登记在 education 子集上（真实的 qualification 策略由 C1-1 登记）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { PERSONNEL_REQUEST_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/errors.js';
import { saveInformationCollection } from '../../apps/api/src/modules/personnel/integrations.js';
import type * as SubsetPolicy from '../../apps/api/src/modules/personnel/subset-policy.js';
import { approvalWorld, transferScene, type InstanceView } from './AC-APV-support.js';

const database = useTestDb();
const APPROVAL = '/api/tenant/approval';
const REQUESTS = '/api/tenant/personnel/change-requests';

// 动态路径：实现落地前用例因模块缺失而逐条失败，而不是整个文件无法加载。
const policyModule = async () =>
  (await import('../../apps/api/src/modules/personnel/subset-policy.js')) as typeof SubsetPolicy;

interface Call {
  readonly hook: 'beforeRequest' | 'beforeSave';
  readonly input: Record<string, unknown>;
}

/** 测试策略：记录每次调用；deny 打开时抛 403（模拟 C1-1 的“自助不开放”）。 */
async function testPolicy(kind = 'education') {
  const calls: Call[] = [];
  const state = { denyRequest: false, denySave: false };
  const { registerSubsetPolicy } = await policyModule();
  const dispose = registerSubsetPolicy(kind as never, {
    beforeRequest: async (_tx, _ctx, input) => {
      calls.push({ hook: 'beforeRequest', input: input as unknown as Record<string, unknown> });
      if (state.denyRequest) throw new AppError('FORBIDDEN', '测试策略：不允许自助申请');
    },
    beforeSave: async (_tx, _ctx, input) => {
      calls.push({ hook: 'beforeSave', input: input as unknown as Record<string, unknown> });
      if (state.denySave) throw new AppError('FORBIDDEN', '测试策略：不允许写入');
    },
  });
  return { calls, state, dispose };
}

const rowsOf = <T>(value: unknown): T[] => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

async function scene(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  const settings = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
    ifMatch: 0,
    body: { value: { education: ['school'], family: ['name'] } },
  });
  expect(settings.status).toBe(200);
  for (const [priority, subset, field] of [
    [1, 'education', 'school'],
    [2, 'family', 'name'],
  ] as const) {
    await w.publishedProcess({
      approvalType: 'personnel_change',
      priority,
      conditions: { items: [{ no: 1, field: 'request.subset', operator: 'eq', value: subset }] },
      nodes: [{ key: 'head', approver: 'latest_record_department_head', formFields: [field] }],
    });
  }
  const path = (kind: string) => `/api/tenant/personnel/employees/${s.subject.employeeId}/subsets/${kind}`;
  const addRecord = async () =>
    w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', path('education'), {
        ifMatch: 0,
        body: { school: '甲校', educationLevel: '本科' },
      }),
      201,
    );
  const submit = (values: Record<string, unknown>, target?: { id: string; revision: number }, kind = 'education') =>
    w.request(s.subject.userId, 'POST', REQUESTS, {
      ifMatch: 0,
      body: {
        employeeId: s.subject.employeeId,
        subset: kind,
        ...(target ? { recordId: target.id, targetRevision: target.revision } : {}),
        values,
      },
    });
  const submitted = async (values: Record<string, unknown>, target?: { id: string; revision: number }) => {
    const response = await submit(values, target);
    expect(response.status, await response.clone().text()).toBe(201);
    const created = (await response.json()) as { id: string };
    return w.instanceOf(created.id, s.subject.userId);
  };
  const tx = <T>(work: Parameters<typeof withTenant<T>>[2]) => withTenant(w.db, w.tenant.id, work);
  /** 申请、审批实例与申请审计的条数（拒绝后应与之前完全相同）。 */
  const footprint = () =>
    tx(async (t) => {
      const count = async (query: ReturnType<typeof sql>) =>
        Number(rowsOf<{ n: number }>(await t.execute(query))[0]!.n);
      return {
        requests: await count(sql`SELECT count(*)::int AS n FROM personnel_change_requests`),
        versions: await count(sql`SELECT count(*)::int AS n FROM personnel_change_request_versions`),
        instances: await count(sql`SELECT count(*)::int AS n FROM approval_instances`),
        requestAudits: await count(
          sql`SELECT count(*)::int AS n FROM audit_events WHERE object_type = ${PERSONNEL_REQUEST_OBJECT}`,
        ),
      };
    });
  const request = (id: string) =>
    tx(async (t) => {
      const [row] = rowsOf<{ status: string; revision: number }>(
        await t.execute(sql`SELECT status, revision FROM personnel_change_requests WHERE id = ${id}::uuid`),
      );
      return row!;
    });
  const subsetRows = (kind: string) =>
    tx(async (t) =>
      rowsOf<{ id: string; school?: string; deleted: boolean; revision: number }>(
        await t.execute(
          sql`SELECT * FROM ${sql.identifier(`personnel_${kind}`)}
            WHERE employee_id = ${s.subject.employeeId}::uuid ORDER BY created_at, id`,
        ),
      ),
    );
  return { w, s, path, addRecord, submit, submitted, footprint, request, subsetRows, tx };
}

describe('AC-PRM-subset-policy P0 ②：自助申请准入 beforeRequest（DEC-099 同单重提、DEC-365③）', () => {
  it('首次提交：钩子在写申请前被调用（带员工、记录与载荷）；拒绝后不留申请、审批实例与申请审计', async () => {
    const { s, addRecord, submit, footprint, subsetRows } = await scene('sp-request-first');
    const record = await addRecord();
    const policy = await testPolicy();
    try {
      policy.state.denyRequest = true;
      const before = await footprint();
      const denied = await submit({ school: '乙校' }, record);
      expect(denied.status, await denied.clone().text()).toBe(403);
      expect(await footprint()).toEqual(before);
      expect((await subsetRows('education')).map((row) => row.school)).toEqual(['甲校']);
      expect(policy.calls.filter((call) => call.hook === 'beforeRequest').at(-1)!.input).toMatchObject({
        employeeId: s.subject.employeeId,
        recordId: record.id,
        values: { school: '乙校' },
      });

      policy.state.denyRequest = false;
      const allowed = await submit({ school: '乙校' }, record);
      expect(allowed.status, await allowed.clone().text()).toBe(201);
      const after = await footprint();
      expect(after.requests).toBe(before.requests + 1);
      expect(after.instances).toBe(before.instances + 1);
    } finally {
      policy.dispose();
    }
  });

  it('同单重提（带修正）：拒绝后申请状态、revision、版本与审计都不变，实例仍可再处理', async () => {
    const { w, s, submitted, footprint, request } = await scene('sp-request-correct');
    const policy = await testPolicy();
    try {
      const view = await submitted({ school: '错别字大学' });
      const returned = await w.json<InstanceView>(
        await w.taskAction(s.outHead.userId, current(view).id, 'reject', view.revision, { comment: '有误' }),
      );
      expect(returned.status).toBe('returned');
      policy.state.denyRequest = true;
      const before = { footprint: await footprint(), request: await request(view.businessId) };
      const denied = await w.request(s.subject.userId, 'POST', `${APPROVAL}/instances/${view.id}/resubmit`, {
        ifMatch: returned.revision,
        body: { fields: { school: '正确大学' } },
      });
      expect(denied.status, await denied.clone().text()).toBe(403);
      expect({ footprint: await footprint(), request: await request(view.businessId) }).toEqual(before);
      expect((await w.detail(view.id, s.subject.userId)).status).toBe('returned');
    } finally {
      policy.dispose();
    }
  });

  it('审批中心以 {} 重提待审批申请：钩子在空修正的提前返回之前，拒绝 403 且申请不变', async () => {
    const { w, s, submitted, footprint, request } = await scene('sp-request-empty');
    const policy = await testPolicy();
    try {
      const view = await submitted({ school: '乙校' });
      const returned = await w.json<InstanceView>(
        await w.taskAction(s.outHead.userId, current(view).id, 'reject', view.revision, { comment: '再看看' }),
      );
      expect(returned.status).toBe('returned');
      // 驳回到发起人：申请仍是待审批（DEC-053），空修正原本会直接返回
      expect((await request(view.businessId)).status).toBe('pending_approval');
      policy.state.denyRequest = true;
      const calls = policy.calls.length;
      const before = { footprint: await footprint(), request: await request(view.businessId) };
      const denied = await w.request(s.subject.userId, 'POST', `${APPROVAL}/instances/${view.id}/resubmit`, {
        ifMatch: returned.revision,
        body: { fields: {} },
      });
      expect(denied.status, await denied.clone().text()).toBe(403);
      expect(policy.calls.slice(calls).map((call) => call.hook)).toContain('beforeRequest');
      expect({ footprint: await footprint(), request: await request(view.businessId) }).toEqual(before);

      policy.state.denyRequest = false;
      const resubmitted = await w.json<InstanceView>(
        await w.request(s.subject.userId, 'POST', `${APPROVAL}/instances/${view.id}/resubmit`, {
          ifMatch: returned.revision,
          body: { fields: {} },
        }),
      );
      expect(resubmitted.status).toBe('running');
    } finally {
      policy.dispose();
    }
  });
});

describe('AC-PRM-subset-policy P0 ②：落地前复核 beforeSave（三个入口一处覆盖，DEC-087 信息采集）', () => {
  it('HR 子集新增 / 修改 / 删除：source = hr_direct；拒绝时子集与审计都不变', async () => {
    const { w, path, addRecord, subsetRows, tx } = await scene('sp-save-hr');
    const record = await addRecord();
    const policy = await testPolicy();
    try {
      const patched = await w.request(w.hr.id, 'PATCH', `${path('education')}/${record.id}`, {
        ifMatch: record.revision,
        body: { school: '乙校' },
      });
      expect(patched.status, await patched.clone().text()).toBe(200);
      const save = policy.calls.filter((call) => call.hook === 'beforeSave').at(-1)!.input;
      expect(save).toMatchObject({
        deleted: false,
        source: { type: 'hr_direct', id: null },
        before: { id: record.id, school: '甲校' },
        row: { id: record.id, school: '乙校' },
      });

      policy.state.denySave = true;
      const auditCount = () =>
        tx(async (t) =>
          Number(
            rowsOf<{ n: number }>(
              await t.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE object_id = ${record.id}`),
            )[0]!.n,
          ),
        );
      const audits = await auditCount();
      const rowsBefore = await subsetRows('education');
      const denied = [
        await w.request(w.hr.id, 'POST', path('education'), { ifMatch: 0, body: { school: '丙校' } }),
        await w.request(w.hr.id, 'PATCH', `${path('education')}/${record.id}`, {
          ifMatch: record.revision + 1,
          body: { school: '丁校' },
        }),
        await w.request(w.hr.id, 'DELETE', `${path('education')}/${record.id}`, { ifMatch: record.revision + 1 }),
      ];
      expect(denied.map((response) => response.status)).toEqual([403, 403, 403]);
      expect(await subsetRows('education')).toEqual(rowsBefore);
      expect(await auditCount()).toBe(audits);
      expect(policy.calls.filter((call) => call.hook === 'beforeSave').at(-1)!.input).toMatchObject({
        deleted: true,
        source: { type: 'hr_direct' },
      });
    } finally {
      policy.dispose();
    }
  });

  it('自助审批通过后的落地：source = self_service（申请编号）；准入之后开关变化时落地被第二道复核拦下', async () => {
    const { w, s, addRecord, submitted, subsetRows, request } = await scene('sp-save-self');
    const record = await addRecord();
    const policy = await testPolicy();
    try {
      const first = await submitted({ school: '乙校' }, record);
      const approved = await w.json<InstanceView>(
        await w.taskAction(s.outHead.userId, current(first).id, 'approve', first.revision),
      );
      expect(approved.status).toBe('approved');
      expect(policy.calls.filter((call) => call.hook === 'beforeSave').at(-1)!.input).toMatchObject({
        source: { type: 'self_service', id: first.businessId },
        row: { id: record.id, school: '乙校' },
      });

      const latest = (await subsetRows('education'))[0]!;
      const second = await submitted({ school: '丙校' }, { id: latest.id, revision: latest.revision });
      policy.state.denySave = true;
      const denied = await w.taskAction(s.outHead.userId, current(second).id, 'approve', second.revision);
      expect(denied.status, await denied.clone().text()).toBe(403);
      expect((await subsetRows('education')).map((row) => row.school)).toEqual(['乙校']);
      expect((await request(second.businessId)).status).toBe('pending_approval');
    } finally {
      policy.dispose();
    }
  });

  it('信息采集入口：source = info_collection；拒绝时整笔不写', async () => {
    const { w, s, subsetRows, tx } = await scene('sp-save-collect');
    const policy = await testPolicy();
    const ctx = () => ({
      tenantId: w.tenant.id,
      userId: w.hr.id,
      timezone: 'Asia/Shanghai',
      now: new Date('2026-10-01T00:00:00Z'),
      commandId: randomUUID(),
      expectedRevision: 0,
    });
    try {
      const sourceId = randomUUID();
      const saved = await tx((t) =>
        saveInformationCollection(t, ctx(), s.subject.employeeId, 'education', sourceId, { school: '采集学校' }),
      );
      expect(saved).toMatchObject({ sourceType: 'info_collection', sourceId });
      expect(policy.calls.at(-1)).toMatchObject({
        hook: 'beforeSave',
        input: { source: { type: 'info_collection', id: sourceId }, before: null },
      });
      policy.state.denySave = true;
      await expect(
        tx((t) =>
          saveInformationCollection(t, ctx(), s.subject.employeeId, 'education', randomUUID(), { school: '拒绝' }),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await subsetRows('education')).map((row) => row.school)).toEqual(['采集学校']);
    } finally {
      policy.dispose();
    }
  });
});

describe('AC-PRM-subset-policy P0 ②：未登记的子集行为不变；登记表规则（DEC-365③）', () => {
  it('只对登记的子集调用：family 的 HR 写入与自助申请不经过 education 的策略', async () => {
    const { w, path, submit } = await scene('sp-unregistered');
    const policy = await testPolicy();
    try {
      policy.state.denyRequest = true;
      policy.state.denySave = true;
      const created = await w.request(w.hr.id, 'POST', path('family'), { ifMatch: 0, body: { name: '合成家属' } });
      expect(created.status, await created.clone().text()).toBe(201);
      const requested = await submit({ name: '合成家属二' }, undefined, 'family');
      expect(requested.status, await requested.clone().text()).toBe(201);
      expect(policy.calls).toEqual([]);
    } finally {
      policy.dispose();
    }
  });

  it('同一子集不能重复登记；撤销登记后不再调用', async () => {
    const { w, path, addRecord } = await scene('sp-dispose');
    const policy = await testPolicy();
    const { registerSubsetPolicy } = await policyModule();
    expect(() => registerSubsetPolicy('education' as never, {})).toThrow();
    policy.dispose();
    policy.state.denySave = true;
    const record = await addRecord();
    const patched = await w.request(w.hr.id, 'PATCH', `${path('education')}/${record.id}`, {
      ifMatch: record.revision,
      body: { school: '乙校' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect(policy.calls).toEqual([]);
  });
});
