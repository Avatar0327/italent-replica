/**
 * F-429 ② 离职预览补合同与兼职：生效时将终止 / 删除的合同、将撤回的在途合同申请、将结束的兼职、将作废的兼职申请。
 * 预览 = 执行（同一选择函数）：预览列出的集合必须与离职生效后实际被处理的集合逐项相同。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { downstreamWorld, type DownstreamWorld } from './AC-EXIT-downstream-support.js';
import { insertPartTimeRequest } from './AC-PT-support.js';
import { setExitTermination } from './support/exit-termination.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const LAST_WORK_DATE = '2026-10-05';

interface Item {
  action: string;
  targetType: string;
  targetId: string;
}
interface Warning {
  reason: string;
  items: Item[];
  hiddenCount: number;
}

async function previewWarnings(x: DownstreamWorld) {
  const response = await x.session.request('POST', `/exits/employees/${x.employee.id}/preview`, {
    body: { lastWorkDate: LAST_WORK_DATE },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { warnings: Warning[] }).warnings;
}
const pick = (warnings: Warning[], reason: string) => warnings.find((warning) => warning.reason === reason);
const pairs = (warning: Warning | undefined) =>
  (warning?.items ?? []).map((item) => `${item.action}:${item.targetId}`).sort();

async function setPostExitTypes(x: DownstreamWorld, typeIds: string[]) {
  const current = (await (await x.contracts('GET', '/settings')).json()) as { revision: number };
  const response = await x.contracts('PUT', '/settings', {
    ifMatch: current.revision,
    body: { postExitTypeIds: typeIds },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

describe('F-429 ② 预览列出将被处理的合同', () => {
  it('终止 / 删除 / 撤回逐项列出，离职后可签类型与已结束合同不列；生效后实际处理的集合与预览相同', async () => {
    const x = await downstreamWorld(database().db, 'f429-preview-contract', TODAY);
    await setExitTermination(database().db, x.session.tenant.id, x.session.user.id, { contract_create: true });
    const [labor, nda, ended, kept, applying] = [
      await x.contractType('劳动合同'),
      await x.contractType('保密协议'),
      await x.contractType('旧合同'),
      await x.contractType('离职后可签类型'),
      await x.contractType('新签申请类型'),
    ];
    await setPostExitTypes(x, [kept]);
    const valid = await x.createContract(labor);
    const future = await x.createContract(nda, { effectiveDate: TODAY, endDate: '2027-10-05' });
    await x.createContract(ended, { effectiveDate: '2025-01-01', endDate: '2026-09-30' });
    await x.createContract(kept);
    const pending = await x.createContract(applying, {}, 'application');
    const keptRequest = await x.createContract(kept, {}, 'application');

    const warning = pick(await previewWarnings(x), 'EXIT_CONTRACTS_TO_HANDLE');
    expect(pairs(warning)).toEqual([`terminate:${valid.id}`, `delete:${future.id}`, `withdraw:${pending.id}`].sort());
    expect(warning).toMatchObject({ hiddenCount: 0 });
    expect(pairs(warning)).not.toContain(`withdraw:${keptRequest.id}`);

    const leave = await x.directLeave(LAST_WORK_DATE);
    await x.activate(leave.id, TODAY);
    const verbs: Record<string, string> = {
      contract_terminated: 'terminate',
      contract_deleted: 'delete',
      contract_request_withdrawn: 'withdraw',
    };
    const executed = (await x.effects(leave.id))
      .filter((row) => row.kind.startsWith('contract_'))
      .map((row) => `${verbs[row.kind]}:${row.target_id}`)
      .sort();
    expect(pairs(warning)).toEqual(executed);
  });

  it('没有将被处理的合同时不追加该 warning', async () => {
    const x = await downstreamWorld(database().db, 'f429-preview-contract-none', TODAY);
    expect(pick(await previewWarnings(x), 'EXIT_CONTRACTS_TO_HANDLE')).toBeUndefined();
  });

  it('预览只读：不改合同、申请与台账', async () => {
    const x = await downstreamWorld(database().db, 'f429-preview-readonly', TODAY);
    const labor = await x.contractType('劳动合同');
    await x.createContract(labor);
    const snapshot = async () => ({ contracts: await x.contractRows(), requests: await x.requestRows() });
    const before = await snapshot();
    await previewWarnings(x);
    expect(await snapshot()).toEqual(before);
    const [count] = await x.sqlRows<{ n: number }>(sql`SELECT count(*)::int AS n FROM exit_effects
      WHERE tenant_id=${x.session.tenant.id}`);
    expect(count!.n).toBe(0);
  });
});

describe('F-429 ② 预览列出将被处理的兼职', () => {
  it('将结束的兼职与将作废的申请逐项列出，已更早结束的兼职不列；生效后与期限链 source=exit 的集合相同', async () => {
    const x = await downstreamWorld(database().db, 'f429-preview-pt', TODAY);
    const org = await x.session.org('兼职部门', { establishedOn: '2025-01-01' });
    const make = async (endDate: string | null) => {
      const response = await x.session.request('POST', `/employees/${x.employee.id}/part-times`, {
        body: {
          partTimeType: 'part_time',
          startDate: '2026-09-01',
          ...(endDate ? { endDate } : {}),
          fields: { departmentId: org.id },
        },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as { id: string };
    };
    const open = await make(null);
    const later = await make('2026-12-31');
    const early = await make('2026-09-03');
    const tenantId = x.session.tenant.id;
    const requestId = await withTenant(database().db, tenantId, (tx) =>
      insertPartTimeRequest(tx, {
        tenantId,
        employeeId: x.employee.id,
        initiatorUserId: x.session.user.id,
        departmentId: org.id,
        requestType: 'add',
        state: 'draft',
      }),
    );

    const warning = pick(await previewWarnings(x), 'EXIT_PART_TIMES_TO_END');
    expect(pairs(warning)).toEqual([`end:${open.id}`, `end:${later.id}`, `void:${requestId}`].sort());
    expect(pairs(warning)).not.toContain(`end:${early.id}`);

    const leave = await x.directLeave(LAST_WORK_DATE);
    await x.activate(leave.id, TODAY);
    const ended = await x.sqlRows<{
      record_id: string;
    }>(sql`SELECT DISTINCT record_id::text FROM employment_part_time_terms
      WHERE tenant_id=${x.session.tenant.id} AND source='exit' AND source_id=${leave.id}::uuid`);
    const voided = await x.sqlRows<{ request_id: string }>(sql`SELECT request_id::text FROM part_time_request_events
      WHERE tenant_id=${tenantId} AND state='voided' AND reason='exit'`);
    expect(pairs(warning)).toEqual(
      [...ended.map((row) => `end:${row.record_id}`), ...voided.map((row) => `void:${row.request_id}`)].sort(),
    );
  });

  it('没有兼职时不追加该 warning', async () => {
    const x = await downstreamWorld(database().db, 'f429-preview-pt-none', TODAY);
    expect(pick(await previewWarnings(x), 'EXIT_PART_TIMES_TO_END')).toBeUndefined();
  });
});
