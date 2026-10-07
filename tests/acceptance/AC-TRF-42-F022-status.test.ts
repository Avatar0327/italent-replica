/**
 * F-022 工作台接入（Q-M0-76 / Q-M0-99）：
 * - 试用中 = 当前生效主职版本人员状态 = 试用（雇佣关系 ∈ 内部员工 / 实习生、任职中、未删除）；
 * - 待入职 = 人员状态 = 待入职、入职状态 ∈ {空, 正常, 延期}、变动类型 ∈ {新增入职, 重聘入职}，不限当前记录；
 * 计数、列表、标记同一谓词；范围外与跨租户不可见。
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { changePendingEntryStatus } from '../../apps/api/src/modules/employment/employee-status.js';
import { transitionEmployment } from '../../apps/api/src/modules/employment/transitions.js';
import { MODULE_OBJECTS } from '@italent/domain';
import { addMember, createProfile, setObjectPermission } from './AC-PRM-support.js';
import { transferWorld } from './AC-TRF-manager-support.js';

const database = useTestDb();
const BASE = '/api/tenant/employment/transfers';
type World = Awaited<ReturnType<typeof transferWorld>>;
interface TeamDto {
  readonly items: { id: string; probation?: boolean; employeeStatus?: number; entryStatus?: number | null }[];
  readonly counts: Record<string, number | null>;
}

async function managed(world: World) {
  const user = await addMember(world, `f022-manager-${randomUUID().slice(0, 6)}`);
  const manager = { user: user.id, tenant: world.tenant.id };
  const self = await world.person(world.outside.id, manager);
  const updated = await world.setup.request('PATCH', `/api/tenant/org/organizations/${world.inside.id}`, {
    ...world.asAdmin,
    ifMatch: world.inside.revision,
    body: { effectiveDate: '2026-01-02', personInChargeId: self.id },
  });
  expect(updated.status, await updated.clone().text()).toBe(200);
  return manager;
}

async function team(world: World, manager: { user: string; tenant: string }, category: string) {
  const response = await world.api.request('GET', `${BASE}/manager/team?category=${category}&pageSize=200`, manager);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as TeamDto;
}

function context(world: World, expectedRevision: number) {
  return {
    tenantId: world.tenant.id,
    userId: world.asAdmin.user,
    timezone: world.tenant.timezone,
    now: new Date('2026-10-01T01:00:00Z'),
    commandId: randomUUID(),
    expectedRevision,
  };
}

async function hireRecord(world: World, employeeId: string) {
  const response = await world.setup.request(
    'GET',
    `/api/tenant/employment/employees/${employeeId}/records?asOf=2026-10-01`,
    world.asAdmin,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: { id: string; revision: number }[] }).items[0]!;
}

describe('AC-TRF-42（F-022）试用中 / 待入职按人员状态精确统计', () => {
  let world: World;
  let other: World;
  let manager: { user: string; tenant: string };
  beforeAll(async () => {
    world = await transferWorld(database().db);
    other = await transferWorld(database().db);
    manager = await managed(world);
  });

  it('试用中只看人员状态：试用计入，正式不计；在岗包含试用；列表、计数、标记一致', async () => {
    const probation = await world.person(world.inside.id, undefined, undefined, { entry: { probation: true } });
    const intern = await world.person(world.inside.id, undefined, undefined, {
      employType: 'intern',
      entry: { probation: true },
    });
    const regular = await world.person(world.inside.id);
    const external = await world.person(world.inside.id, undefined, undefined, {
      employType: 'external',
      entry: { probation: true },
    });
    const outside = await world.person(world.outside.id, undefined, undefined, { entry: { probation: true } });
    const dto = await team(world, manager, 'probation');
    const ids = dto.items.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([probation.id, intern.id]));
    for (const id of [regular.id, external.id, outside.id]) expect(ids).not.toContain(id);
    expect(dto.counts.probation).toBe(ids.length);
    expect(dto.items.every((row) => row.probation === true)).toBe(true);
    // DEC-225：系统默认经理身份可查看下属的人员状态、入职状态（只读），列表显示这两列
    expect(dto.items.every((row) => row.employeeStatus === 2 && row.entryStatus === null)).toBe(true);
    const active = await team(world, manager, 'active');
    expect(active.items.map((row) => row.id)).toEqual(expect.arrayContaining([probation.id, regular.id]));
    expect(active.items.find((row) => row.id === regular.id)).toMatchObject({ probation: false, employeeStatus: 3 });
    expect(active.items.find((row) => row.id === probation.id)?.probation).toBe(true);
  });

  it('待入职：待入职 + 入职状态正常 / 延期计入，取消不计；R1 未来日期办理入职不计；删除后不计', async () => {
    const normal = await world.person(world.inside.id, undefined, undefined, {
      effectiveDate: '2026-11-01',
      entry: { pendingEntry: true },
    });
    const postponed = await world.person(world.inside.id, undefined, undefined, {
      effectiveDate: '2026-11-01',
      entry: { pendingEntry: true },
    });
    const cancelled = await world.person(world.inside.id, undefined, undefined, {
      effectiveDate: '2026-11-01',
      entry: { pendingEntry: true },
    });
    const removed = await world.person(world.inside.id, undefined, undefined, {
      effectiveDate: '2026-11-01',
      entry: { pendingEntry: true },
    });
    const future = await world.person(world.inside.id, undefined, undefined, { effectiveDate: '2026-11-01' });
    for (const [person, target] of [
      [postponed, 'postponed'],
      [cancelled, 'cancelled'],
    ] as const) {
      const record = await hireRecord(world, person.id);
      await withTenant(database().db, world.tenant.id, (tx) =>
        changePendingEntryStatus(tx, context(world, record.revision), record.id, target),
      );
    }
    const record = await hireRecord(world, removed.id);
    await withTenant(database().db, world.tenant.id, (tx) =>
      transitionEmployment(tx, context(world, record.revision), { id: record.id, action: 'delete' }),
    );
    const dto = await team(world, manager, 'pending');
    const ids = dto.items.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([normal.id, postponed.id]));
    for (const id of [cancelled.id, removed.id, future.id]) expect(ids).not.toContain(id);
    expect(dto.counts.pending).toBe(ids.length);
    const hr = await world.setup.request(
      'GET',
      `/api/tenant/employment/employees/${postponed.id}/records?asOf=2026-10-01`,
      world.asAdmin,
    );
    expect(((await hr.json()) as { items: unknown[] }).items[0]).toMatchObject({ employeeStatus: 1, entryStatus: 2 });
  });

  it('字段权限照常裁剪：未授人员状态 / 入职状态查看的 HR 读任职记录时不返回这两个字段', async () => {
    const person = await world.person(world.inside.id, undefined, undefined, { entry: { probation: true } });
    const visible = await world.actor('f022-visible');
    const hidden = await world.actor('f022-hidden', { hidden: ['employeeStatus', 'entryStatus'] });
    const read = async (as: { user: string; tenant: string }) => {
      const response = await world.api.request(
        'GET',
        `/api/tenant/employment/employees/${person.id}/records?asOf=2026-10-01`,
        as,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { items: Record<string, unknown>[] }).items[0]!;
    };
    expect(await read(visible)).toMatchObject({ employeeStatus: 2, entryStatus: null });
    const trimmed = await read(hidden);
    expect(trimmed).not.toHaveProperty('employeeStatus');
    expect(trimmed).not.toHaveProperty('entryStatus');
  });

  it('DEC-225：默认经理可见待入职的入职状态；租户收回查看权后两列不再返回，标记与计数不变', async () => {
    const pending = await other.person(other.inside.id, undefined, undefined, {
      effectiveDate: '2026-11-01',
      entry: { pendingEntry: true },
    });
    const otherManager = await managed(other);
    const visible = await team(other, otherManager, 'pending');
    expect(visible.items.find((row) => row.id === pending.id)).toMatchObject({ employeeStatus: 1, entryStatus: 0 });
    // 租户创建同编码经理身份后完全使用其字段配置（manager-identity.ts）：收回两字段的查看权
    const profile = await createProfile(other, 'department_manager_self_service');
    const hidden = new Set(['employeeStatus', 'entryStatus']);
    for (const definition of [MODULE_OBJECTS.employmentRecord, MODULE_OBJECTS.employee]) {
      const response = await setObjectPermission(
        other,
        profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: definition.fields.map((f) => ({ fieldCode: f.code, view: !hidden.has(f.code), edit: false })),
          buttons: [],
        },
        definition.code,
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const revoked = await team(other, otherManager, 'pending');
    expect(revoked.counts.pending).toBe(visible.counts.pending);
    const row = revoked.items.find((item) => item.id === pending.id);
    expect(row).toBeTruthy();
    expect(row).not.toHaveProperty('employeeStatus');
    expect(row).not.toHaveProperty('entryStatus');
  });

  it('跨租户：另一租户的试用、待入职人员不进入本租户统计；本租户经理请求另一租户被拒', async () => {
    const before = await team(world, manager, 'probation');
    await other.person(other.inside.id, undefined, undefined, { entry: { probation: true } });
    await other.person(other.inside.id, undefined, undefined, {
      effectiveDate: '2026-11-01',
      entry: { pendingEntry: true },
    });
    const after = await team(world, manager, 'probation');
    expect(after.counts).toEqual(before.counts);
    const denied = await world.api.request('GET', `${BASE}/manager/team?category=probation`, {
      user: manager.user,
      tenant: other.tenant.id,
    });
    expect([401, 403, 404]).toContain(denied.status);
  });
});
