import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { contractWorld, type ContractView } from './AC-CT-support.js';
import { allowAll } from './support/tenant-api.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';
import { runContractJobs } from '../../apps/api/src/modules/contracts/scheduler.js';
import {
  changeContractForTransfer,
  generateContractForBusiness,
  handleContractsOnExit,
} from '../../apps/api/src/modules/contracts/ports.js';
import * as hierarchy from '../../apps/api/src/modules/org/hierarchy-reader.js';

const testDb = useTestDb();
type World = Awaited<ReturnType<typeof contractWorld>>;
const now = new Date('2026-10-01T01:00:00Z');
const context = (w: World) => ({
  tenantId: w.session.tenant.id,
  userId: w.session.user.id,
  timezone: 'Asia/Shanghai',
  now,
  commandId: randomUUID(),
  expectedRevision: 7,
});
const sweep = (w: World, date = now) =>
  runContractJobs(w.db, { tenantId: w.session.tenant.id }, { clock: () => date, authorize: allowAll });
const record = async (w: World, id: string) =>
  (await (await w.request('GET', `/records/${id}`)).json()) as ContractView;
function editBody(w: World, source: ContractView, fields: Record<string, unknown>) {
  return {
    mode: 'edit',
    rows: [{ employeeId: w.employee.id, revision: source.revision, fields: { number: source.number, ...fields } }],
  };
}
async function edit(w: World, source: ContractView, fields: Record<string, unknown>) {
  const response = await w.request('POST', '/imports', { ifMatch: 0, body: editBody(w, source, fields) });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ContractView[] }).items[0]!;
}
async function terminate(w: World, reason: 'expiry' | 'auto' | 'exit' | 'early') {
  const source = await w.create();
  if (reason === 'auto') {
    await w.settings({ autoTerminate: true });
    await sweep(w);
  } else if (reason === 'exit') {
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      handleContractsOnExit(tx, context(w), { employeeId: w.employee.id, lastWorkDate: '2026-09-20' }),
    );
  } else {
    expect(
      (
        await w.change(source, 'terminate', {
          actualTerminationDate: reason === 'expiry' ? '2026-09-30' : '2026-09-20',
        })
      ).status,
    ).toBe(201);
  }
  return record(w, source.id);
}
async function rule(w: World, priority = 1) {
  const response = await w.request('POST', '/rules', {
    ifMatch: 0,
    body: {
      name: `规则${priority}`,
      priority,
      orgIds: [w.org.id],
      personIds: [],
      details: [{ typeId: w.type.id, months: 12, initiatorId: w.session.user.id, daysBefore: 10, skipTypeIds: [] }],
    },
  });
  expect(response.status).toBe(201);
}
async function attempts(w: World) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{ state: string; attempt_count: number; error: string | null }>(
      await tx.execute(sql`SELECT * FROM contract_job_attempts WHERE tenant_id=${w.session.tenant.id}`),
    ),
  );
}

describe('AC-CT-11 / DEC-167 编辑导入终止原因护栏', () => {
  it.each(['expiry', 'auto'] as const)(
    '%s 到期终止延期恢复有效，预览不写入、版本/次数/审计/outbox 一致',
    async (reason) => {
      const w = await contractWorld(testDb().db, `f013${reason}`);
      const source = await terminate(w, reason);
      const body = editBody(w, source, { endDate: '2026-12-31' });
      const preview = await w.request('POST', '/imports/preview', { ifMatch: 0, body });
      expect(await preview.json()).toMatchObject({ valid: true, errors: [] });
      expect(await record(w, source.id)).toMatchObject({ status: 'terminated', revision: source.revision });
      const result = await edit(w, source, { endDate: '2026-12-31' });
      expect(result).toMatchObject({
        status: 'valid',
        actualTerminationDate: null,
        endDate: '2026-12-31',
        signingCount: source.signingCount,
        previousContractId: source.id,
      });
      expect(await record(w, source.id)).toMatchObject({ status: 'void' });
      await withTenant(w.db, w.session.tenant.id, async (tx) => {
        const [request] = rowsOf(
          await tx.execute(sql`SELECT operation FROM contract_requests
        WHERE tenant_id=${w.session.tenant.id} AND result_id=${result.id}::uuid`),
        );
        expect(request).toMatchObject({ operation: 'edit' });
        const events = rowsOf(
          await tx.execute(sql`SELECT a.action, o.event_type FROM audit_events a
        JOIN contract_outbox o ON o.tenant_id=a.tenant_id AND o.command_id=a.command_id
          AND o.object_id::text=a.object_id
        WHERE a.tenant_id=${w.session.tenant.id} AND a.object_id=${result.id}`),
        );
        expect(events).toContainEqual({ action: 'contract.create', event_type: 'contract.create' });
      });
    },
  );

  it.each(['expiry', 'auto'] as const)(
    'DEC-167④ %s 到期后员工已离职，延期复活 409，日期更正仍可保持终止',
    async (reason) => {
      const w = await contractWorld(testDb().db, `f013departed${reason}`);
      const source = await terminate(w, reason);
      const employee = await w.session.getEmployee(w.employee.id);
      await w.session.business(
        employee.id,
        {
          kind: 'leave',
          mode: 'direct',
          effectiveDate: '2026-10-01',
          lastWorkDate: '2026-09-30',
          fields: {},
        },
        employee.revision,
      );
      const body = editBody(w, source, { endDate: '2026-12-31' });
      const response = await w.request('POST', '/imports', { ifMatch: 0, body });
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'CONFLICT',
          details: {
            errors: [{ details: { reason: 'CONTRACT_EMPLOYEE_DEPARTED' } }],
          },
        },
      });
      expect(await record(w, source.id)).toMatchObject({ status: 'terminated', revision: source.revision });
      expect((await w.list()).filter((c) => c.status === 'valid')).toHaveLength(0);
      const corrected = await edit(w, source, { endDate: '2026-10-01' });
      expect(corrected).toMatchObject({ status: 'terminated', actualTerminationDate: '2026-09-30' });
    },
  );

  it.each(['2026-10-01', '2025-01-01'])(
    'DEC-167⑤ 已续签（生效日 %s）不得复活旧合同，提示修改续签合同',
    async (effectiveDate) => {
      const w = await contractWorld(testDb().db, `f013renewed${effectiveDate}`);
      const source = await terminate(w, 'expiry');
      const renewedResponse = await w.change(source, 'renew', { effectiveDate, endDate: '2027-09-30' });
      expect(renewedResponse.status, await renewedResponse.clone().text()).toBe(201);
      const renewed = (await renewedResponse.json()) as ContractView;
      const response = await w.request('POST', '/imports', {
        ifMatch: 0,
        body: editBody(w, source, { endDate: '2026-12-31' }),
      });
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'CONFLICT',
          details: {
            errors: [
              {
                message: expect.stringContaining('续签'),
                details: {
                  reason: 'CONTRACT_SUPERSEDED_BY_RENEWAL',
                  contractId: renewed.id,
                },
              },
            ],
          },
        },
      });
      expect(await record(w, source.id)).toMatchObject({ status: 'terminated', revision: source.revision });
      expect((await w.list()).filter((c) => c.status === 'valid').map((c) => c.id)).toEqual([renewed.id]);
      const corrected = await edit(w, source, { endDate: '2026-10-01' });
      expect(corrected).toMatchObject({ status: 'terminated', actualTerminationDate: '2026-09-30' });
      // 更正产生新版本后仍不能绕过已续签护栏。
      const retry = await w.request('POST', '/imports', {
        ifMatch: 0,
        body: editBody(w, corrected, { endDate: '2026-12-31' }),
      });
      expect(retry.status).toBe(409);
    },
  );

  it('DEC-167⑤ 不把其他类型的新合同当作同类型续签', async () => {
    const w = await contractWorld(testDb().db, 'f013othertype');
    const source = await terminate(w, 'expiry');
    await w.create({ typeId: w.otherType.id, effectiveDate: '2026-10-01', endDate: '2027-09-30' });
    expect(await edit(w, source, { endDate: '2026-12-31' })).toMatchObject({ status: 'valid' });
  });

  it('不晚于租户今天的延期保持终止，再次延期仍能识别原到期原因', async () => {
    const w = await contractWorld(testDb().db, 'f013past');
    const source = await terminate(w, 'expiry');
    w.setNow('2026-10-04T16:30:00Z'); // 上海已是 10-05。
    let result = await edit(w, source, { endDate: '2026-10-04' });
    expect(result).toMatchObject({ status: 'terminated', actualTerminationDate: '2026-09-30' });
    result = await edit(w, result, { endDate: '2026-10-05' });
    expect(result).toMatchObject({ status: 'terminated', actualTerminationDate: '2026-09-30' });
    result = await edit(w, result, { endDate: '2026-10-06' });
    expect(result).toMatchObject({ status: 'valid', actualTerminationDate: null, signingCount: source.signingCount });
  });

  it.each(['exit', 'early'] as const)('%s 终止拒绝延期复活与清空实际终止日（409 + 原因），整批回滚', async (reason) => {
    const w = await contractWorld(testDb().db, `f013deny${reason}`);
    const source = await terminate(w, reason);
    const other = await w.create({ number: 'UNCHANGED' });
    for (const fields of [{ endDate: '2026-12-31' }, { actualTerminationDate: null }]) {
      const body = editBody(w, source, fields);
      body.rows.unshift(editBody(w, other, { regularSalary: '8000' }).rows[0]!);
      const response = await w.request('POST', '/imports', { ifMatch: 0, body });
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'CONFLICT',
          details: {
            errors: [
              {
                row: 2,
                code: 'CONFLICT',
                details: { reason: 'CONTRACT_TERMINATION_PROTECTED', terminationReason: reason },
              },
            ],
          },
        },
      });
      expect(await record(w, source.id)).toMatchObject({ status: 'terminated', revision: source.revision });
      expect(await record(w, other.id)).toMatchObject({ status: 'valid', revision: other.revision });
    }
  });

  it.each(['expiry', 'exit', 'early'] as const)('%s 终止允许非状态字段更正，保留实际终止日及次数', async (reason) => {
    const w = await contractWorld(testDb().db, `f013other${reason}`);
    const source = await terminate(w, reason);
    const result = await edit(w, source, { regularSalary: '9000' });
    expect(result).toMatchObject({
      status: 'terminated',
      actualTerminationDate: reason === 'expiry' ? '2026-09-30' : '2026-09-20',
      signingCount: source.signingCount,
      regularSalary: '9000',
    });
  });

  it('到期终止不得通过只清空实际终止日或缩短终止日期复活', async () => {
    const w = await contractWorld(testDb().db, 'f013bypass');
    const source = await terminate(w, 'expiry');
    for (const fields of [{ actualTerminationDate: null }, { endDate: '2026-09-29', actualTerminationDate: null }]) {
      const response = await w.request('POST', '/imports', { ifMatch: 0, body: editBody(w, source, fields) });
      expect(response.status).toBe(409);
    }
  });

  it('编辑导入过期 revision 拒绝，跨租户唯一键无法命中', async () => {
    const w = await contractWorld(testDb().db, 'f013revision');
    const source = await terminate(w, 'expiry');
    const result = await edit(w, source, { regularSalary: '9000' });
    const stale = await w.request('POST', '/imports', {
      ifMatch: 0,
      body: editBody(w, { ...result, revision: 9 }, {}),
    });
    expect(await stale.json()).toMatchObject({ error: { details: { errors: [{ code: 'REVISION_CONFLICT' }] } } });
    const other = await contractWorld(testDb().db, 'f013tenant');
    const cross = await other.request('POST', '/imports/preview', { ifMatch: 0, body: editBody(other, result, {}) });
    expect(await cross.json()).toMatchObject({ valid: false });
  });
});

describe('F-013 调度与端口回归（AC-CT-02 / 04 / 05）', () => {
  it('未命中规则的候选连续多轮只保留一行最近尝试及累计次数', async () => {
    const w = await contractWorld(testDb().db, 'f013bounded');
    await w.create({ typeId: w.otherType.id, endDate: '2026-10-01' });
    await w.settings({ autoRenew: true });
    await rule(w);
    for (let i = 0; i < 4; i++) await sweep(w);
    expect(await attempts(w)).toEqual([expect.objectContaining({ state: 'skipped', attempt_count: 4, error: null })]);
  });

  it('失败重试后成功替换最近尝试并清空错误，后续调度不再追加', async () => {
    const w = await contractWorld(testDb().db, 'f013retry');
    await w.create({ endDate: '2026-10-01' });
    await w.settings({ autoRenew: true });
    await rule(w);
    await sweep(w);
    await sweep(w);
    expect(await attempts(w)).toEqual([expect.objectContaining({ state: 'failed', attempt_count: 2 })]);
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
    await sweep(w);
    await sweep(w);
    expect(await attempts(w)).toEqual([expect.objectContaining({ state: 'succeeded', attempt_count: 3, error: null })]);
  });

  it('同轮多个候选与重叠规则只展开一次组织，下轮重新读取', async () => {
    const w = await contractWorld(testDb().db, 'f013expand');
    await w.create({ endDate: '2026-10-01' });
    await w.create({ typeId: w.otherType.id, endDate: '2026-10-01' });
    await w.settings({ autoRenew: true });
    await rule(w);
    await rule(w, 2);
    const spy = vi.spyOn(hierarchy, 'listOrgDescendantsInTransaction');
    try {
      await sweep(w);
      expect(spy).toHaveBeenCalledTimes(1);
      await sweep(w);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('生成端口忽略调用方业务 revision，显式按新合同 revision 0 创建', async () => {
    const w = await contractWorld(testDb().db, 'f013generate');
    const result = await withTenant(w.db, w.session.tenant.id, (tx) =>
      generateContractForBusiness(tx, context(w), {
        employeeId: w.employee.id,
        fields: { ...w.fields, termType: 'fixed' },
      }),
    );
    expect(result).toMatchObject({ status: 'valid', revision: 1 });
  });

  it.each(['constraint', 'constraint_name'])(
    '端口只映射合同编号约束（驱动字段 %s），其他唯一冲突原样抛出',
    async (key) => {
      const w = await contractWorld(testDb().db, `f013constraint${key}`);
      const input = { employeeId: w.employee.id, targetId: randomUUID(), revision: 1, fields: {} };
      for (const constraint of ['contract_records_number', 'contract_records_pkey']) {
        const error = new Error('database error', { cause: { code: '23505', [key]: constraint } });
        const tx = {
          transaction: async () => {
            throw error;
          },
        } as unknown as Tx;
        const promise = changeContractForTransfer(tx, context(w), input);
        if (constraint === 'contract_records_number') {
          await expect(promise).rejects.toMatchObject({ code: 'CONFLICT', message: '合同编号已存在' });
        } else {
          await expect(promise).rejects.toBe(error);
        }
      }
    },
  );

  it('真实编号冲突回滚保存点后调用方事务仍可用，原合同不变', async () => {
    const w = await contractWorld(testDb().db, 'f013savepoint');
    await w.settings({ autoNumber: false });
    const source = await w.create({ number: 'SOURCE' });
    await w.create({ number: 'TAKEN' });
    await withTenant(w.db, w.session.tenant.id, async (tx) => {
      await expect(
        changeContractForTransfer(tx, context(w), {
          employeeId: w.employee.id,
          targetId: source.id,
          revision: source.revision,
          fields: { number: 'TAKEN', effectiveDate: '2026-03-01' },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: '合同编号已存在' });
      expect(
        rowsOf(await tx.execute(sql`SELECT status,revision FROM contract_records WHERE id=${source.id}::uuid`)),
      ).toEqual([{ status: 'valid', revision: 1 }]);
    });
  });
});
