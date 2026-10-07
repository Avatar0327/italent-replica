import { randomUUID } from 'node:crypto';
import { runEmploymentActivations } from '@italent/api';
import { type Db, sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { activateWithJudgement } from '../../apps/api/src/modules/employment/activation-checks.js';
import { pendingActivations } from '../../apps/api/src/modules/employment/activation-store.js';
import { lockTransferParticipants } from '../../apps/api/src/modules/employment/transfer-locks.js';
import { callAt, versions, worker } from './AC-JOB-sequence-support.js';
import { orgPeopleWorld, resultRows } from './AC-ORG-people-support.js';
import { cmd } from './support/tenant-api.js';

export const ACTUAL_DATE = '2026-10-10';
export const MANUAL_PLACE = '人工更正地点';
export type SaveOperation = 'transfer2' | 'F-006' | 'F-007' | 'F-021' | 'manual';
export const MODEL_FIELDS = ['departmentId', 'positionId', 'postId', 'sequenceId', 'directManagerId', 'place'] as const;
export type ModelFields = Record<(typeof MODEL_FIELDS)[number], string | null>;

export async function timelineWorld(db: Db, label: string, baselinePostB = false) {
  const w = await orgPeopleWorld(db, label);
  const org = await w.org('时间轴部门');
  const sequenceA = await w.job('sequences', 'S_A');
  const sequenceB = await w.job('sequences', 'S_B');
  const sequenceC = await w.job('sequences', '同步 S_C');
  const sequenceX = await w.job('sequences', '人工 S_X');
  const postA = await w.job('posts', '职务 A', { sequenceId: sequenceA.id });
  const postB = await w.job('posts', '职务 B', { sequenceId: sequenceB.id });
  const parentA = await w.job('positions', '上级 A', { orgId: org.id, postId: postA.id });
  const parentB = await w.job('positions', '上级 B', { orgId: org.id, postId: postB.id });
  const positionA = await w.job('positions', '职位 A', {
    orgId: org.id,
    postId: postA.id,
    parents: { admin: { parentId: parentA.id } },
  });
  const positionB = await w.job('positions', '职位 B', { orgId: org.id, postId: postB.id });
  const managerA = await w.hire('经理 A', { departmentId: org.id, positionId: parentA.id });
  const managerB = await w.hire('经理 B', { departmentId: org.id, positionId: parentB.id });
  const person = await w.hire('员工', {
    departmentId: org.id,
    positionId: baselinePostB ? null : positionA.id,
    postId: baselinePostB ? postB.id : postA.id,
    sequenceId: baselinePostB ? sequenceB.id : sequenceA.id,
    directManagerId: managerA.id,
    place: '原地点',
  });
  return {
    db,
    w,
    org,
    person,
    positionA,
    positionB,
    parentB,
    postA,
    postB,
    sequenceA,
    sequenceB,
    sequenceC,
    sequenceX,
    managerA,
    managerB,
  };
}
export type TimelineWorld = Awaited<ReturnType<typeof timelineWorld>>;

export async function saveTransfer(s: TimelineWorld, second = false, synced = false, explicitManager = false) {
  return s.w.business(
    s.person.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: second ? '2026-10-06' : '2026-10-05',
      fields: {
        positionId: s.positionB.id,
        postId: s.postB.id,
        sequenceId: synced ? s.sequenceC.id : s.sequenceB.id,
        place: second ? '第二调动地点' : '第一调动地点',
        ...(explicitManager ? { directManagerId: s.managerB.id } : {}),
      },
    },
    (await s.w.getEmployee(s.person.id)).revision,
  );
}

export async function saveManagerChange(s: TimelineWorld, date: string, explicit = false) {
  const before = new Set((await s.w.records(s.person.id, ACTUAL_DATE)).map((r) => r.id));
  const response = await s.w.call('PATCH', `job/positions/${s.positionB.id}`, {
    ifMatch: s.positionB.revision,
    body: {
      parents: { admin: { parentId: s.parentB.id } },
      effectiveDate: date,
      adjustEmployeeDirectManager: !explicit,
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  if (explicit)
    return (
      await s.w.business(
        s.person.id,
        { kind: 'org_adjustment', mode: 'direct', effectiveDate: date, fields: { directManagerId: s.managerB.id } },
        (await s.w.getEmployee(s.person.id)).revision,
      )
    ).id;
  const added = (await s.w.records(s.person.id, ACTUAL_DATE)).filter((r) => !before.has(r.id));
  expect(added).toHaveLength(1);
  return added[0]!.id;
}

export async function saveRename(s: TimelineWorld, date = '2026-10-09') {
  const before = new Set((await s.w.records(s.person.id, ACTUAL_DATE)).map((r) => r.id));
  const response = await s.w.patchOrg(s.org, { name: '时间轴改名', effectiveDate: date, addEmployment: true });
  expect(response.status, await response.clone().text()).toBe(200);
  const added = (await s.w.records(s.person.id, ACTUAL_DATE)).filter((r) => !before.has(r.id));
  expect(added).toHaveLength(1);
  return added[0]!.id;
}

export async function syncSequence(s: TimelineWorld) {
  const response = await callAt(s.db, s.w)(
    'PATCH',
    `posts/${s.postB.id}`,
    { sequenceId: s.sequenceC.id, effectiveDate: '2026-10-05', syncSequenceToAssignments: true },
    s.postB.revision,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await worker(s.db, s.w.tenant.id)).toMatchObject({ completed: 1, failed: 0 });
}

export async function manualCorrection(s: TimelineWorld, id: string) {
  const response = await s.w.request('GET', `/businesses/${id}`);
  expect(response.status, await response.clone().text()).toBe(200);
  const { revision } = (await response.json()) as { revision: number };
  const corrected = await s.w.request('PATCH', `/records/${id}`, {
    ifMatch: revision,
    body: { fields: { sequenceId: s.sequenceX.id, place: MANUAL_PLACE } },
  });
  expect(corrected.status, await corrected.clone().text()).toBe(200);
}

export async function executeTransfers(s: TimelineWorld, ids: readonly string[], actualDate = ACTUAL_DATE) {
  for (const id of ids)
    await withTenant(s.db, s.w.tenant.id, async (tx) => {
      const ctx = {
        tenantId: s.w.tenant.id,
        userId: s.w.user.id,
        timezone: s.w.tenant.timezone,
        now: new Date(`${actualDate}T01:00:00Z`),
        commandId: randomUUID(),
        expectedRevision: 0,
      };
      await lockTransferParticipants(tx, ctx, s.person.id);
      const target = (await pendingActivations(tx, ctx, s.person.id)).find((item) => item.id === id);
      expect(target, `待生效调动 ${id} 必须存在`).toBeDefined();
      expect(await activateWithJudgement(tx, ctx, target!)).toBeNull();
    });
}

export async function assertIdempotent(s: TimelineWorld) {
  const before = await versions(s.db, s.w.tenant.id, s.person.id);
  const result = await runEmploymentActivations(
    s.db,
    cmd(),
    { tenantId: s.w.tenant.id },
    { clock: () => new Date(`${ACTUAL_DATE}T02:00:00Z`) },
  );
  expect(result.runs[0]).toMatchObject({ failed: [], errors: [] });
  expect(await versions(s.db, s.w.tenant.id, s.person.id)).toEqual(before);
}

export async function originalPayloads(s: TimelineWorld) {
  return withTenant(s.db, s.w.tenant.id, async (tx) =>
    resultRows(
      await tx.execute(sql`SELECT p.* FROM employment_payload_versions p
      WHERE p.tenant_id=${s.w.tenant.id} AND p.employee_id=${s.person.id}::uuid AND p.version_no=1 ORDER BY p.id`),
    ),
  );
}

export function modeledFields(fields: Readonly<Record<string, unknown>>): ModelFields {
  return Object.fromEntries(MODEL_FIELDS.map((field) => [field, fields[field]])) as ModelFields;
}

export interface ModelEvent {
  readonly id: string;
  readonly kind: 'F-006' | 'F-007' | 'transfer1' | 'transfer2';
  readonly date: string;
  readonly operation: number;
  readonly manual?: boolean;
  readonly explicitManager?: boolean;
}

/**
 * 独立参考模型只读取合成业务输入，不读取载荷来源/版本差值，也不调用生产派生或重建函数。
 * 先按最终日期与 DEC-108 操作先后排序，再从 hire 从头计算；两笔迟到调动按原计划日排序（DEC-195）。
 * F-021 只对仍引用职务 B 的结果应用 C；人工更正属于输入，即使旧引用的自动同步在其后写入也保留。
 */
export function referenceTimeline(s: TimelineWorld, events: readonly ModelEvent[]) {
  let fields: ModelFields = {
    departmentId: s.org.id,
    positionId: s.positionA.id,
    postId: s.postA.id,
    sequenceId: s.sequenceA.id,
    directManagerId: s.managerA.id,
    place: '原地点',
  };
  return [...events]
    .sort((a, b) => a.date.localeCompare(b.date) || a.operation - b.operation)
    .map((event) => {
      fields = { ...fields };
      if (event.kind.startsWith('transfer')) {
        fields.positionId = s.positionB.id;
        fields.postId = s.postB.id;
        fields.sequenceId = s.sequenceC.id;
        fields.directManagerId = s.managerB.id;
        fields.place = event.kind === 'transfer1' ? '第一调动地点' : '第二调动地点';
      } else if (event.kind === 'F-006') {
        fields.directManagerId =
          event.explicitManager || fields.positionId === s.positionB.id ? s.managerB.id : s.managerA.id;
      }
      if (event.manual) {
        fields.sequenceId = s.sequenceX.id;
        fields.place = MANUAL_PLACE;
      }
      return { id: event.id, date: event.date, fields: { ...fields } };
    });
}

function permutations<T>(items: readonly T[]): T[][] {
  if (!items.length) return [[]];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, candidate) => candidate !== index)).map((tail) => [item, ...tail]),
  );
}

/** 固定种子洗牌合法排列；既覆盖全逆序，也保证更正对象先存在，没有 catch/skip 筛选。 */
export function propertySaveOrders() {
  const all = permutations<SaveOperation>(['transfer2', 'F-006', 'F-007', 'F-021', 'manual']).filter(
    (order) => order.indexOf('F-007') < order.indexOf('manual'),
  );
  let seed = 0x83_06_007;
  for (let index = all.length - 1; index > 0; index--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const other = seed % (index + 1);
    [all[index], all[other]] = [all[other]!, all[index]!];
  }
  return all.slice(0, 12);
}
