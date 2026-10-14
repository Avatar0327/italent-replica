/**
 * F-024 R1 端到端验收 · 带编调动（第三轮补跑：#79 F-018 合并后，DEC-181）。
 * 真实 HR（任职 + 编制写权限，数据范围 = 调出 / 调入组织含下级）发起带编调动申请：保存即调编 → 三节点逐个审批
 * → 定时生效不重复增减 → 审批中撤销按原分配回退 → 已生效调动删除后回退；范围外 HR 带编调动被拒且编制不变。
 * 编制容量与审计按“前后各读一次”对比（派发规则 §1 负向用例）。涉及 AC：AC-TRF-47/48/49、AC-EST-08/14。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { readCapacity } from '../../apps/api/src/modules/establishment/capacity-read.js';
import { rowsOf } from '../../apps/api/src/modules/establishment/store.js';
import type { Person } from './AC-APV-support.js';
import { chain, e2eWorld, type E2EWorld } from './AC-R1-E2E-support.js';

const database = useTestDb();
const BUSINESSES = '/api/tenant/employment/businesses';

let w: E2EWorld;
let source: string;
let target: string;
let sourcePosition: string;
let targetPosition: string;
let capacityIds: [string, string];
let first: Person;
let firstTransfer: string;

/** 编制快照：组织编制、预留与各职位细分（组织编制 = 细分之和 + 预留）。 */
interface CapacityShape {
  readonly localCapacity: number | null;
  readonly reservedLocal: number | null;
  readonly subdivisions: { positionId: string; localCapacity: number | null }[];
}

async function capacities(): Promise<CapacityShape[]> {
  const asOf = tenantLocalDate(w.clock(), 'Asia/Shanghai');
  const records = await withTenant(w.db, w.tenant.id, (tx) =>
    Promise.all(capacityIds.map((id) => readCapacity(tx, w.tenant.id, id, asOf))),
  );
  return records.map((record) => ({
    localCapacity: record.localCapacity,
    reservedLocal: record.reservedLocal,
    subdivisions: record.subdivisions.map((item) => ({
      positionId: item.positionId,
      localCapacity: item.localCapacity,
    })),
  }));
}

const shape = (sourceSub: number, reserve: number, targetSub: number): CapacityShape[] => [
  {
    localCapacity: sourceSub + reserve,
    reservedLocal: reserve,
    subdivisions: [{ positionId: sourcePosition, localCapacity: sourceSub }],
  },
  {
    localCapacity: targetSub,
    reservedLocal: 0,
    subdivisions: [{ positionId: targetPosition, localCapacity: targetSub }],
  },
];

/** 编制增减审计（establishment.transfer.*）；传业务 ID 时只取关联该调动的事件。 */
async function carriedAudit(businessId?: string) {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<{ action: string }>(
      await tx.execute(sql`SELECT action FROM audit_events WHERE tenant_id=${w.tenant.id}
        AND action LIKE 'establishment.transfer.%'
        AND (${businessId ?? null}::text IS NULL OR after::text LIKE ${`%${businessId ?? ''}%`})
        ORDER BY occurred_at, id`),
    ),
  );
}

function carried(effectiveDate: string) {
  return { effectiveDate, withEstablishment: true, fields: { departmentId: target, positionId: targetPosition } };
}

beforeAll(async () => {
  w = await e2eWorld(database().db, 'r1-e2e-carried');
  source = await w.org('带编调出组', w.from);
  target = await w.org('带编调入组', w.to);
  await w.setOrgRoles(source, { head: w.outHead.employeeId });
  await w.setOrgRoles(target, { head: w.inHead.employeeId, hrbp: w.inHrbp.employeeId });
  const create = async (path: string, body: object) => {
    const response = await w.trusted('POST', `/api/tenant/${path}`, { ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  const post = await create('job/posts', { name: '带编合成职务', code: randomUUID(), startDate: '2020-01-01' });
  const position = (orgId: string, name: string) =>
    create('job/positions', { name, code: randomUUID(), postId: post, orgId, startDate: '2020-01-01' });
  sourcePosition = await position(source, '带编调出职位');
  targetPosition = await position(target, '带编调入职位');
  const scheme = await create('establishment/schemes', {
    name: '带编端到端方案',
    periodType: 'annual',
    maintenanceMode: 'local',
    subdivision: 'position',
    startDate: '2026-01-01',
  });
  const capacity = (orgId: string, positionId: string, count: number, reserve: number) =>
    create('establishment/capacities', {
      orgId,
      schemeId: scheme,
      periodStart: '2026-01-01',
      strictControl: true,
      reservedLocal: reserve,
      subdivisions: [{ positionId, localCapacity: count, inclusiveCapacity: null }],
    });
  capacityIds = [await capacity(source, sourcePosition, 2, 1), await capacity(target, targetPosition, 0, 0)];
});

describe('E2E-03 带编调动（F-018，DEC-181，AC-TRF-47/48/49、AC-EST-08/14）', () => {
  it('步骤 1：HR 带编调动申请保存即调编；逐节点审批与定时生效不重复增减（AC-TRF-47 / 49、AC-EST-08）', async () => {
    w.setNow('2026-10-01T01:00:00Z');
    first = await w.person('带编调动员工甲', source, { positionId: sourcePosition });
    expect(await capacities()).toEqual(shape(2, 1, 0));

    const saved = await w.json<{ id: string; status: string }>(
      await w.hrTransfer(w.hr, first.employeeId, carried('2026-10-20')),
      201,
    );
    firstTransfer = saved.id;
    expect(saved.status).toBe('in_review');
    // 原职位有匹配细分：调出细分 −1；调入组织与新职位细分 +1；预留不动；每次增减一条审计。
    expect(await capacities()).toEqual(shape(1, 1, 1));
    expect(await carriedAudit(saved.id)).toHaveLength(2);
    // 审批通过 ≠ 生效：任职版本链此时不变。
    expect(await w.records(w.hr, first.employeeId)).toHaveLength(1);

    const { steps, view } = await w.approveAll(await w.instanceOf(w.hr, saved.id));
    expect(steps).toEqual([
      { nodeKey: 'out_head', by: w.outHead.userId },
      { nodeKey: 'in_hrbp', by: w.inHrbp.userId },
      { nodeKey: 'in_head', by: w.inHead.userId },
    ]);
    expect(view.status).toBe('approved');
    expect(await w.business(w.hr, saved.id)).toMatchObject({ status: 'approved', record: null });
    expect(await capacities()).toEqual(shape(1, 1, 1));

    const run = await w.runScheduler('2026-10-19T17:15:00Z');
    expect(run.activated).toContain(saved.id);
    expect(run.failed).toEqual([]);
    w.setNow('2026-10-20T02:00:00Z');
    expect(await w.business(w.hr, saved.id)).toMatchObject({
      status: 'effective',
      record: { effectiveDate: '2026-10-20', fields: { departmentId: target, positionId: targetPosition } },
    });
    // 生效时不再重复增减（编制在保存时已转移）。
    expect(await capacities()).toEqual(shape(1, 1, 1));
    expect(await carriedAudit(saved.id)).toHaveLength(2);
  });

  it('步骤 2：审批中的带编申请被撤销 → 按原分配回退；重复撤销 409 且编制、审计、业务不变（AC-TRF-48）', async () => {
    w.setNow('2026-10-21T01:00:00Z');
    const second = await w.person('带编调动员工乙', source, { positionId: sourcePosition });
    const saved = await w.json<{ id: string }>(await w.hrTransfer(w.hr, second.employeeId, carried('2026-10-28')), 201);
    expect(await capacities()).toEqual(shape(0, 1, 2));
    expect(await carriedAudit(saved.id)).toHaveLength(2);

    const revoked = await w.json<{ status: string; revision: number }>(
      await w.request(w.hr, 'POST', `${BUSINESSES}/${saved.id}/revoke`, {
        ifMatch: (await w.business(w.hr, saved.id)).revision,
        body: {},
      }),
    );
    expect(revoked.status).toBe('voided');
    expect(await capacities()).toEqual(shape(1, 1, 1));
    expect(await carriedAudit(saved.id)).toHaveLength(4);

    const before = {
      capacities: await capacities(),
      audit: await carriedAudit(),
      business: await w.business(w.hr, saved.id),
    };
    const again = await w.request(w.hr, 'POST', `${BUSINESSES}/${saved.id}/revoke`, {
      ifMatch: revoked.revision,
      body: {},
    });
    expect(again.status, await again.clone().text()).toBe(409);
    expect({
      capacities: await capacities(),
      audit: await carriedAudit(),
      business: await w.business(w.hr, saved.id),
    }).toEqual(before);
  });

  it('步骤 3：范围外 HR 用有效 revision 发起带编调动 → 被拒，编制、审计、版本链都不变（AC-EST-14）', async () => {
    // 员工丙在调出部门（不受编制控制的上级组织），不占调出职位细分，避免影响步骤 4 的回退。
    const third = await w.person('带编调动员工丙', w.from);
    const revision = await w.employeeRevision(w.hr, third.employeeId);
    const before = {
      capacities: await capacities(),
      audit: await carriedAudit(),
      chain: chain(await w.records(w.hr, third.employeeId)),
    };
    const denied = await w.hrTransfer(w.outsider, third.employeeId, carried('2026-10-28'), revision);
    expect(denied.status, await denied.clone().text()).toBe(404);
    expect(await denied.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect({
      capacities: await capacities(),
      audit: await carriedAudit(),
      chain: chain(await w.records(w.hr, third.employeeId)),
    }).toEqual(before);
    expect(await w.employeeRevision(w.hr, third.employeeId)).toBe(revision);
  });

  it('步骤 4：删除已生效的带编调动 → 编制按原分配回退到初始，员工回到调出组（AC-TRF-48 / AC-TRF-08）', async () => {
    w.setNow('2026-10-22T01:00:00Z');
    const deleted = await w.json<{ status: string }>(
      await w.request(w.hr, 'DELETE', `${BUSINESSES}/${firstTransfer}`, {
        ifMatch: (await w.business(w.hr, firstTransfer)).revision,
      }),
    );
    expect(deleted.status).toBe('deleted');
    expect(await capacities()).toEqual(shape(2, 1, 0));
    expect(await carriedAudit(firstTransfer)).toHaveLength(4);
    expect(chain(await w.records(w.hr, first.employeeId))).toEqual([
      expect.objectContaining({ departmentId: source, stopDate: '9999-12-31', isCurrent: true }),
    ]);
  });
});
