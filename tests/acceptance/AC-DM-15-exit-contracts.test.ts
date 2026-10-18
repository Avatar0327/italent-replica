/**
 * R2-T03 B3-2 / AC-DM-15：合同端口接入离职生效（设计 §5.4 步骤 4、§10.2 F-014③）。
 * 覆盖 B-04（合同实际终止日 = L）、B-13、B-68、B-74（AC-CT-11 补例）与 B-8（Q-M0-100 取“生效时终止”）。
 * 只经内部编排器入口 activateExit 验证（§18.1 五个关口保持关闭）。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { downstreamWorld, type DownstreamWorld } from './AC-EXIT-downstream-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => downstreamWorld(database().db, label, TODAY);

async function setPostExitTypes(x: DownstreamWorld, typeIds: string[]) {
  const current = (await (await x.contracts('GET', '/settings')).json()) as { revision: number };
  const response = await x.contracts('PUT', '/settings', {
    ifMatch: current.revision,
    body: { postExitTypeIds: typeIds },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** 按“申请”模式提交一条合同新签申请（in_review，有审批实例），再按需强置状态。 */
async function request(x: DownstreamWorld, typeId: string, extra: Record<string, unknown>, status?: string) {
  const created = await x.createContract(typeId, extra, 'application');
  if (status)
    await x.sqlRows(sql`UPDATE contract_requests SET status=${status}
      WHERE tenant_id=${x.session.tenant.id} AND id=${created.id}::uuid`);
  return created.id;
}

describe('AC-DM-15 步骤 4：合同端口', () => {
  it('B-04 / B-68 生效时终止有效合同（实际终止日 = L′、原因 exit）、软删除起始日晚于 L′ 的合同、保留“离职后可签类型”与已结束合同', async () => {
    const x = await world('b68');
    const [labor, nda, ended, kept] = [
      await x.contractType('劳动合同'),
      await x.contractType('保密协议'),
      await x.contractType('旧合同'),
      await x.contractType('离职后可签类型'),
    ];
    await setPostExitTypes(x, [kept]);
    const valid = await x.createContract(labor);
    const future = await x.createContract(nda, { effectiveDate: TODAY, endDate: '2027-10-05' });
    const old = await x.createContract(ended, { effectiveDate: '2025-01-01', endDate: '2026-09-30' });
    const retained = await x.createContract(kept);
    const leave = await x.directLeave('2026-10-05');
    const untouched = (await x.contractRows()).filter((row) => [old.id, retained.id].includes(row.id));

    // B-8：生效前不动合同（Q-M0-100 取“生效时终止”）
    expect((await x.contractRows()).filter((row) => [valid.id, future.id, retained.id].includes(row.id))).toEqual(
      [valid, future, retained].map(() => expect.objectContaining({ status: 'valid', deleted: false })),
    );
    expect(await x.activate(leave.id, TODAY)).toMatchObject({ outcome: 'effective', lastWorkDate: '2026-10-05' });

    const rows = new Map((await x.contractRows()).map((row) => [row.id, row]));
    expect(rows.get(valid.id)).toMatchObject({ status: 'terminated', actual: '2026-10-05', reason: 'exit' });
    expect(rows.get(future.id)).toMatchObject({ deleted: true });
    expect([rows.get(old.id), rows.get(retained.id)].sort((a, b) => a!.id.localeCompare(b!.id))).toEqual(untouched);
    const effects = (await x.effects(leave.id)).filter((row) => row.kind.startsWith('contract_'));
    expect(effects.map((row) => [row.phase, row.kind, row.target_id])).toEqual(
      [
        ['effective', 'contract_deleted', future.id],
        ['effective', 'contract_terminated', valid.id],
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    );
    expect(effects.find((row) => row.kind === 'contract_terminated')!.detail).toMatchObject({
      lastWorkDate: '2026-10-05',
    });
  });

  it('B-13 在途合同申请（in_review / returned / approved，生效日早于与晚于 L′）全部撤回，不按日期区分；离职后可签类型的申请保留', async () => {
    const x = await world('b13');
    const [a, b, c, kept] = [
      await x.contractType('类型甲'),
      await x.contractType('类型乙'),
      await x.contractType('类型丙'),
      await x.contractType('离职后可签类型'),
    ];
    await setPostExitTypes(x, [kept]);
    const later = await request(x, a, { effectiveDate: '2026-10-10', endDate: '2027-10-09' });
    const earlier = await request(x, b, { effectiveDate: '2026-01-01', endDate: '2026-09-30' }, 'returned');
    const approved = await request(
      x,
      c,
      { effectiveDate: '2026-10-20', endDate: null, termType: 'indefinite' },
      'approved',
    );
    const stays = await request(x, kept, {});
    const leave = await x.directLeave('2026-10-05');
    const instances = await Promise.all([later, earlier, approved, stays].map((id) => x.instanceOf(id)));

    await x.activate(leave.id, TODAY);

    const rows = new Map((await x.requestRows()).map((row) => [row.id, row.status]));
    expect([later, earlier, approved].map((id) => rows.get(id))).toEqual(['withdrawn', 'withdrawn', 'withdrawn']);
    expect(rows.get(stays)).toBe('in_review');
    expect(
      (await Promise.all([later, earlier, approved, stays].map((id) => x.instanceOf(id)))).map((i) => i!.status),
    ).toEqual(['cancelled', 'cancelled', 'cancelled', instances[3]!.status]);
    for (const id of [later, earlier, approved]) {
      const [event] = await x.sqlRows<{ n: number }>(sql`SELECT count(*) AS n FROM audit_events
        WHERE tenant_id=${x.session.tenant.id} AND object_id=${id} AND action='contract.request.exit_delete'`);
      expect(Number(event!.n)).toBe(1);
    }
    expect(
      (await x.effects(leave.id))
        .filter((row) => row.kind === 'contract_request_withdrawn')
        .map((row) => row.target_id)
        .sort(),
    ).toEqual([later, earlier, approved].sort());
    for (const instance of instances.slice(0, 3))
      expect(await x.notices(instance!.id)).toEqual([
        { recipient: x.session.user.id, template: 'contract_request_voided_by_exit', kind: 'message' },
      ]);
  });

  it('B-02a 合同端口之后的步骤失败时整单回滚：合同终止 / 删除、申请撤回、任职申请作废都保持原状，修正后重试成功', async () => {
    const x = await world('port-rollback');
    const [labor, nda] = [await x.contractType('劳动合同'), await x.contractType('保密协议')];
    const valid = await x.createContract(labor);
    const pending = await request(x, nda, {});
    const leave = await x.directLeave('2026-10-05');
    const review = await x.transferIn('in_review', '2026-10-20');
    const { exitPostEffectHooks } = await import('../../apps/api/src/modules/employment/exit-confirmation.js');
    const { AppError } = await import('../../apps/api/src/errors.js');
    let fail = true;
    exitPostEffectHooks.onEffective(async () => {
      if (fail) throw new AppError('CONFLICT', '后续任务失败', { reason: 'DOWNSTREAM_FAILED' });
    });
    const before = await x.stateOf(x.employee.id);
    expect(await x.activate(leave.id, TODAY)).toMatchObject({ outcome: 'failed' });
    const after = await x.stateOf(x.employee.id);
    for (const key of ['timeline', 'contracts', 'instances', 'effects', 'approvalLogs'] as const)
      expect(after[key], key).toEqual(before[key]);
    expect(await x.stateOfBusiness(review.id)).toBe('in_review');
    expect((await x.requestRows()).find((row) => row.id === pending)!.status).toBe('in_review');
    fail = false;
    expect(await x.activate(leave.id, TODAY)).toMatchObject({ outcome: 'effective' });
    expect((await x.contractRows()).find((row) => row.id === valid.id)).toMatchObject({ status: 'terminated' });
    expect((await x.requestRows()).find((row) => row.id === pending)!.status).toBe('withdrawn');
  });
});

describe('B-74 F-014③：未生效离职与合同延期恢复（AC-CT-11 补例）', () => {
  it('生效失败仍为 approved、载荷生效日已过的离职：到期终止合同延期恢复 409 CONTRACT_EMPLOYEE_DEPARTED；离职作废后恢复成功', async () => {
    const x = await world('b74');
    const labor = await x.contractType('劳动合同');
    const source = await x.createContract(labor, { effectiveDate: '2026-01-01', endDate: '2026-09-30' });
    const terminated = await x.contracts('POST', '/commands', {
      ifMatch: source.revision,
      body: {
        operation: 'terminate',
        mode: 'direct',
        employeeId: x.employee.id,
        targetId: source.id,
        fields: { actualTerminationDate: '2026-09-30' },
      },
    });
    expect(terminated.status, await terminated.clone().text()).toBe(201);
    // L = 昨天 → 计划生效日 = 今天，不满足“生效日 > 今天”，旧条件会漏掉这类离职
    const leave = await x.directLeave('2026-10-05');
    const edit = async () => {
      const record = (await (await x.contracts('GET', `/records/${source.id}`)).json()) as {
        revision: number;
        number: string;
      };
      return x.contracts('POST', '/imports', {
        ifMatch: 0,
        body: {
          mode: 'edit',
          rows: [
            {
              employeeId: x.employee.id,
              revision: record.revision,
              fields: { number: record.number, endDate: '2026-12-31' },
            },
          ],
        },
      });
    };
    const blocked = await edit();
    expect(blocked.status, await blocked.clone().text()).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { details: { errors: [{ details: { reason: 'CONTRACT_EMPLOYEE_DEPARTED' } }] } },
    });

    // 撤销（作废）该离职后可以恢复
    await withTenant(database().db, x.session.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO employment_state_events(tenant_id,employee_id,business_id,payload_version_id,state,
          event_no,command_id)
        SELECT tenant_id,employee_id,business_id,payload_version_id,'voided',event_no+1,'test-void'
        FROM employment_state_events WHERE tenant_id=${x.session.tenant.id} AND business_id=${leave.id}::uuid
        ORDER BY event_no DESC LIMIT 1`),
    );
    const restored = await edit();
    expect(restored.status, await restored.clone().text()).toBe(200);
  });
});
