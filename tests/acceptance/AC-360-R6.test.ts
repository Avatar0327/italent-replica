/**
 * PR #107 第 6 轮修改清单（DEC-319，评论 6062375420；依据第 5 轮审查 6059585343）：
 * - R5-P2-1 精细化权限生效时（受限管理员），任何结果都不能随其看不到的 360 人员变化：看不到的人员占用了组织员工的
 *   邮箱（或手机、工号命中）时，自动添加、同步（新建 / 冲突 / 刷新邮箱）、导入 sync:true、冲突清单与冲突处理、
 *   关联日志，以及成功后收窄范围再用原键重放，调用人看到的都与“没有隐藏人员”时的某个合法结果相同。
 * - DEC-319① 可见下属的上级在范围外：原样 PUT 回去，上级没有改动，不重新校验可见性（200、上级不变）；
 *   真的改成另一个范围外的人仍 400 SUPERIOR_NOT_FOUND。
 * - F-057 / DEC-325③ 修订 DEC-319②：详情、列表、重放回执显示范围外上级姓名，仍不带邮箱、部门等其他字段；
 *   拿上级 ID 调 GET /people/:id，与“不存在”同样 404。头像来源待总编排确认，当前测试只固定已确认的姓名边界。
 */
import { randomUUID } from 'node:crypto';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { fullAccess, type PersonView, world360, type World360 } from './AC-360-support.js';

const testDb = useTestDb();
const APP = survey360.SURVEY360_APP;

// TODO(需取证 #126)：明确 F-057 的头像来源与授权契约后补齐头像断言，不能把证件照当作头像。

interface SyncPage {
  created: { personId: string; employeeId: string }[];
  updated: { personId: string; employeeId: string }[];
  conflicts: string[];
  skipped: { employeeId: string; reason: string }[];
  nextCursor: string | null;
}

interface AutoAddResult {
  added: { appraiserPersonId: string }[];
  skipped: { employeeId: string; reason: string }[];
}

const mail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.com`;

async function hire(w: World360, name: string, orgId: string, managerId?: string) {
  const employee = await w.session.employee(name);
  await w.session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2025-01-01',
      fields: { departmentId: orgId, ...(managerId ? { directManagerId: managerId } : {}) },
    },
    employee.revision,
  );
  return employee;
}

/** 组织员工侧改工作邮箱（同步先取工作邮箱）；返回员工信息的新 revision（夹具的员工侧替身不回 revision）。 */
async function setWorkEmail(w: World360, employeeId: string, workEmail: string, revision: number): Promise<number> {
  const res = await w.api.request('PATCH', `/api/tenant/personnel/employees/${employeeId}`, {
    user: w.admin,
    tenant: w.tenantId,
    ifMatch: revision,
    body: { workEmail },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return revision + 1;
}

async function setFine(w: World360, on: boolean) {
  const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
  await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: on } }));
}

/** 系统管理员看到的全部人员。 */
async function everyone(w: World360) {
  return (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
}

const byEmployee = <T extends { employeeId: string }>(list: readonly T[]): T[] =>
  [...list].sort((x, y) => (x.employeeId < y.employeeId ? -1 : 1));

const reasonOf = async (res: Response) =>
  ((await res.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;

/**
 * 甲部门：经理、评价对象（经理的下属，已同步）；乙部门：范围外经理（已同步），其下属在甲部门（已同步，上级是范围外
 * 经理）。系统管理员同步之后，甲部门再入职两名经理的下属——“待同步同事”与“普通同事”，都还没有 360 人员。
 * 一名外部 360 人员（系统管理员建，没有挂接员工）占用“待同步同事”的邮箱：精细化下受限管理员看不到他。
 * 受限管理员：360 高级管理员，（用户 × Survey360）范围只有甲部门。精细化权限按 fine 参数开启。
 */
async function scene(label: string, fine = true) {
  const w = await world360(testDb().db, label, { access: fullAccess() });
  const orgA = await w.session.org('甲部门', { establishedOn: '2025-01-01' });
  const orgB = await w.session.org('乙部门', { establishedOn: '2025-01-01' });
  const manager = await hire(w, '甲部门经理', orgA.id);
  const target = await hire(w, '评价对象', orgA.id, manager.id);
  const outsideBoss = await hire(w, '范围外经理', orgB.id);
  const subordinate = await hire(w, '甲部门下属', orgA.id, outsideBoss.id);
  const bossEmail = mail('outside-boss');
  await setWorkEmail(w, outsideBoss.id, bossEmail, 0);
  await w.ok(w.request('POST', '/people/sync', { body: {} }));
  const colleague = await hire(w, '待同步同事', orgA.id, manager.id);
  const plain = await hire(w, '普通同事', orgA.id, manager.id);
  const colleagueEmail = mail('colleague');
  await setWorkEmail(w, colleague.id, colleagueEmail, 0);
  const hidden = await w.person('隐藏外部人员', { email: colleagueEmail });

  const people = await everyone(w);
  const personOf = (employeeId: string) => people.find((p) => p.employeeId === employeeId)!;
  const mou = await w.ok<{ id: string }>(
    w.enterprise('POST', '/mous', {
      ifMatch: 0,
      body: { code: `mou-${label}`, name: '甲部门', orgRanges: [{ orgId: orgA.id, includeDescendants: true }] },
    }),
    201,
  );
  const admin = await w.member('受限高级管理员');
  await w.appoint(admin, 'advanced');
  await w.ok(w.enterprise('PUT', `/scopes/${admin}/${APP}`, { ifMatch: 0, body: { kind: 'mou', mouId: mou.id } }));
  if (fine) await setFine(w, true);
  const as = w.as(admin);
  const q = await w.enableQuestionnaire(await w.keyBehavior());
  const activity = await w.activity({ name: `${label} 活动` }, admin);
  const object = await w.ok<{ id: string }>(
    as('POST', `/activities/${activity.id}/objects`, {
      ifMatch: 0,
      body: { personId: personOf(target.id).id, questionnaireIds: [q.id] },
    }),
    201,
  );
  const autoAdd = (key = randomUUID()) =>
    as('POST', `/activities/${activity.id}/objects/${object.id}/appraisers/auto`, {
      ifMatch: 0,
      idempotencyKey: key,
      body: { roles: ['peer'] },
    });
  const sync = (key = randomUUID()) => as('POST', '/people/sync', { idempotencyKey: key, body: {} });
  return {
    w,
    orgA,
    orgB,
    manager,
    target,
    outsideBoss,
    bossEmail,
    subordinate,
    colleague,
    plain,
    hidden,
    admin,
    as,
    q,
    activity,
    object,
    autoAdd,
    sync,
    personOf,
  };
}

/** 受限管理员看不到的人员不应出现在任何结果里；可调的系统管理员动作：把隐藏人员的邮箱改走。 */
async function moveHiddenEmail(w: World360, hidden: PersonView) {
  const current = await w.ok<PersonView>(w.request('GET', `/people/${hidden.id}`));
  await w.ok(w.request('PUT', `/people/${hidden.id}`, { ifMatch: current.revision, body: { email: mail('moved') } }));
}

describe('R5-P2-1 自动添加同事：隐藏人员占用邮箱时，结果与没有隐藏冲突时无法区分', () => {
  it('审查场景：受限管理员自动添加同事，隐藏人员占用邮箱前后、与普通同事的结果都相同，且不建人员', async () => {
    const s = await scene('r6a');
    const first = await s.w.ok<AutoAddResult>(s.autoAdd());
    // 待同步同事（邮箱被隐藏人员占用）与普通同事（没有任何冲突）是同一个结果：不可添加，原因相同
    expect(first.added).toEqual([]);
    expect(byEmployee(first.skipped)).toEqual(
      byEmployee([
        { employeeId: s.colleague.id, reason: 'PERSON_NOT_AVAILABLE' },
        { employeeId: s.plain.id, reason: 'PERSON_NOT_AVAILABLE' },
      ]),
    );
    expect(JSON.stringify(first)).not.toContain(s.hidden.id);

    // 系统管理员只把隐藏人员的邮箱改走：同一候选的结果不变（审查原文中这一步之后会添加成功）
    await moveHiddenEmail(s.w, s.hidden);
    const second = await s.w.ok<AutoAddResult>(s.autoAdd());
    expect(second).toEqual(first);

    // 受限管理员的自动添加不建 360 人员、不登记冲突
    const people = await everyone(s.w);
    expect(people.filter((p) => [s.colleague.id, s.plain.id].includes(p.employeeId ?? ''))).toEqual([]);
    expect((await s.w.ok<{ items: unknown[] }>(s.w.request('GET', '/people/sync-conflicts'))).items).toEqual([]);
  });

  it('成功后收窄（开启精细化）再用原键重放：回执里的跳过原因与新命令一致，不带出冲突', async () => {
    const s = await scene('r6b', false);
    // 精细化关闭时（不受限）：隐藏人员此时对管理员可见，查重命中 → 跳过；普通同事按同步规则建人员并添加
    const key = randomUUID();
    const before = await s.w.ok<AutoAddResult>(s.autoAdd(key));
    expect(before.skipped).toEqual([{ employeeId: s.colleague.id, reason: 'SYNC_CONFLICT' }]);
    expect(before.added).toHaveLength(1);
    await setFine(s.w, true);
    const replay = await s.w.ok<AutoAddResult>(s.autoAdd(key));
    expect(replay.skipped).toEqual([{ employeeId: s.colleague.id, reason: 'PERSON_NOT_AVAILABLE' }]);
    expect(replay.added).toEqual(before.added);
  });
});

describe('R5-P2-1 同类入口：同步、刷新邮箱、导入 sync:true、冲突清单与处理、关联日志', () => {
  it('同步：未挂接的员工一律跳过且原因相同，不登记冲突、不建人员；隐藏人员的邮箱改走前后结果相同', async () => {
    const s = await scene('r6c');
    const first = await s.w.ok<SyncPage>(s.sync());
    expect(first).toEqual({
      created: [],
      updated: [],
      conflicts: [],
      skipped: byEmployee([
        { employeeId: s.colleague.id, reason: 'PERSON_NOT_AVAILABLE' },
        { employeeId: s.plain.id, reason: 'PERSON_NOT_AVAILABLE' },
      ]),
      nextCursor: null,
    });
    await moveHiddenEmail(s.w, s.hidden);
    const second = await s.w.ok<SyncPage>(s.sync());
    expect({ ...second, skipped: byEmployee(second.skipped) }).toEqual(first);
    expect((await s.w.ok<{ items: unknown[] }>(s.w.request('GET', '/people/sync-conflicts'))).items).toEqual([]);
    const people = await everyone(s.w);
    expect(people.filter((p) => [s.colleague.id, s.plain.id].includes(p.employeeId ?? ''))).toEqual([]);
  });

  it('刷新已挂接人员：组织邮箱改成隐藏人员占用的邮箱，同步与导入 sync:true 都不报 EMAIL_TAKEN，也不改邮箱', async () => {
    const s = await scene('r6d');
    const targetPerson = s.personOf(s.target.id);
    const managerPerson = s.personOf(s.manager.id);
    const occupied = mail('occupied');
    const blocker = await s.w.person('占用新邮箱的外部人员', { email: occupied });
    await setWorkEmail(s.w, s.target.id, occupied, 0);
    const emailOf = async (id: string) => (await s.w.ok<PersonView>(s.w.request('GET', `/people/${id}`))).email;

    const first = await s.w.ok<SyncPage>(s.sync());
    expect(first.skipped.find((e) => e.employeeId === s.target.id)).toBeUndefined();
    expect(await emailOf(targetPerson.id)).toBe(targetPerson.email);

    // 导入 sync:true：已挂接的评价者按组织刷新，同样不改邮箱、不因隐藏人员 409
    await s.w.ok(
      s.as('POST', `/activities/${s.activity.id}/objects`, {
        ifMatch: 0,
        body: { personId: managerPerson.id, questionnaireIds: [s.q.id] },
      }),
      201,
    );
    const imported = await s.as('POST', `/activities/${s.activity.id}/appraisers/import`, {
      ifMatch: 0,
      body: {
        sync: true,
        rows: [
          { objectEmail: managerPerson.email, roleId: s.w.role('peer'), name: '评价对象', email: targetPerson.email },
        ],
      },
    });
    expect(imported.status, await imported.clone().text()).toBe(200);
    expect(await emailOf(targetPerson.id)).toBe(targetPerson.email);

    // 隐藏人员把邮箱让出后，受限管理员的同步结果相同、仍不改邮箱；不受限的系统管理员同步才改
    await moveHiddenEmail(s.w, blocker);
    const second = await s.w.ok<SyncPage>(s.sync());
    expect({ ...second, skipped: byEmployee(second.skipped) }).toEqual({
      ...first,
      skipped: byEmployee(first.skipped),
    });
    expect(await emailOf(targetPerson.id)).toBe(targetPerson.email);
    await s.w.ok(s.w.request('POST', '/people/sync', { body: {} }));
    expect(await emailOf(targetPerson.id)).toBe(occupied);
  });

  it('冲突清单、冲突处理、关联日志：受限管理员一律 403，看不到的人员仍 404，响应不带冲突员工与候选', async () => {
    const s = await scene('r6e');
    // 系统管理员同步：待同步同事的邮箱被隐藏人员占用 → 登记冲突（候选只有隐藏人员）
    const sync = await s.w.ok<SyncPage>(s.w.request('POST', '/people/sync', { body: {} }));
    expect(sync.conflicts).toHaveLength(1);
    const [conflict] = (
      await s.w.ok<{ items: { id: string; revision: number }[] }>(s.w.request('GET', '/people/sync-conflicts'))
    ).items;

    const list = await s.as('GET', '/people/sync-conflicts');
    expect(list.status).toBe(403);
    expect(await reasonOf(list.clone())).toBe('FINE_PERMISSION_RESTRICTED');
    const listText = await list.text();
    expect(listText).not.toContain(s.colleague.id);
    expect(listText).not.toContain(s.hidden.id);

    for (const action of ['ignore', 'create', 'link'] as const) {
      const resolved = await s.as('POST', `/people/sync-conflicts/${conflict!.id}/resolve`, {
        ifMatch: conflict!.revision,
        body: action === 'link' ? { action, personId: s.hidden.id } : { action },
      });
      expect(resolved.status, action).toBe(403);
      expect(await reasonOf(resolved), action).toBe('FINE_PERMISSION_RESTRICTED');
    }
    // 冲突仍待系统管理员处理
    expect(
      (await s.w.ok<{ items: { id: string }[] }>(s.w.request('GET', '/people/sync-conflicts'))).items.map((c) => c.id),
    ).toEqual([conflict!.id]);

    const visibleLogs = await s.as('GET', `/people/${s.personOf(s.target.id).id}/link-logs`);
    expect(visibleLogs.status).toBe(403);
    expect(await reasonOf(visibleLogs)).toBe('FINE_PERMISSION_RESTRICTED');
    expect((await s.as('GET', `/people/${s.hidden.id}/link-logs`)).status).toBe(404);
  });

  it('同步成功后收窄（开启精细化）再用原键重放：回执不带冲突，跳过原因与新命令一致', async () => {
    const s = await scene('r6f', false);
    const key = randomUUID();
    const before = await s.w.ok<SyncPage>(s.sync(key));
    expect(before.conflicts).toHaveLength(1);
    expect(before.created.map((c) => c.employeeId)).toEqual([s.plain.id]);
    await setFine(s.w, true);
    const replay = await s.w.ok<SyncPage>(s.sync(key));
    expect(replay.conflicts).toEqual([]);
    expect(replay.created).toEqual(before.created);
    expect(JSON.stringify(replay)).not.toContain(s.colleague.id);
  });
});

describe('DEC-319① 可见下属的上级在范围外：上级没有改动时不重新校验', () => {
  it('原样 PUT 返回 200、上级不变；改成另一个范围外的人仍 400 SUPERIOR_NOT_FOUND', async () => {
    const s = await scene('r6g');
    const sub = s.personOf(s.subordinate.id);
    const boss = s.personOf(s.outsideBoss.id);
    expect(sub.superiorPersonId).toBe(boss.id);
    const seen = await s.w.ok<PersonView>(s.as('GET', `/people/${sub.id}`));
    const asIs = {
      name: seen.name,
      email: seen.email,
      mobile: seen.mobile,
      staffCode: seen.staffCode,
      department: seen.department,
      position: seen.position,
      superiorPersonId: seen.superiorPersonId,
    };
    const saved = await s.w.ok<PersonView>(
      s.as('PUT', `/people/${sub.id}`, { ifMatch: seen.revision, body: { ...asIs, position: '改了职位' } }),
    );
    expect(saved).toMatchObject({ position: '改了职位', superiorPersonId: boss.id });

    const another = await s.w.person('另一名范围外人员');
    const changed = await s.as('PUT', `/people/${sub.id}`, {
      ifMatch: saved.revision,
      body: { superiorPersonId: another.id },
    });
    expect(changed.status).toBe(400);
    expect(await reasonOf(changed)).toBe('SUPERIOR_NOT_FOUND');
    expect((await s.w.ok<PersonView>(s.w.request('GET', `/people/${sub.id}`))).superiorPersonId).toBe(boss.id);
  });
});

describe('F-057 / DEC-325③ 范围外上级显示姓名，仍不披露其他字段', () => {
  it('详情、列表、重放回执显示上级姓名；审计不越权；上级独立点查仍与不存在同样 404', async () => {
    const s = await scene('r6h');
    const sub = s.personOf(s.subordinate.id);
    const boss = s.personOf(s.outsideBoss.id);
    const markers = [s.bossEmail, '乙部门'];
    const noBossPrivateFields = (text: string) => {
      for (const marker of markers) expect(text).not.toContain(marker);
    };
    const bossSummary = { id: boss.id, name: boss.name };

    // ① 详情
    const detail = await s.as('GET', `/people/${sub.id}`);
    const detailText = await detail.clone().text();
    expect(await detail.json()).toMatchObject({ superiorPersonId: boss.id, superior: bossSummary });
    noBossPrivateFields(detailText);
    // ② 列表
    const list = await s.w.ok<{ items: PersonView[] }>(s.as('GET', '/people?pageSize=200'));
    expect(list.items.find((p) => p.id === sub.id)).toMatchObject({
      superiorPersonId: boss.id,
      superior: bossSummary,
    });
    expect(list.items.map((p) => p.id)).not.toContain(boss.id);
    noBossPrivateFields(JSON.stringify(list));
    // ③ 审计：360 的数据变更日志列表与详情（经理作为组织员工的信息本就对该管理员可见，只核 360 日志）
    const audit = auditApi(testDb().db, '2026-10-01T02:00:00Z', { authorize: s.w.authorize });
    const viewer = { user: s.admin, tenant: s.w.tenantId };
    const logs = (await audit.dataChanges(viewer, { limit: '100' })).items.filter((i) =>
      i.objectType.startsWith('survey360'),
    );
    expect(logs.length).toBeGreaterThan(0);
    // 精细化受限管理员仍不可查看人员日志，F-057 不扩张审计对象范围。
    expect(logs.some((log) => log.objectType === 'survey360-person')).toBe(false);
    expect(JSON.stringify(logs)).not.toContain(boss.name);
    noBossPrivateFields(JSON.stringify(logs));
    for (const log of logs) {
      const entry = JSON.stringify(await audit.dataChange(viewer, log.id));
      expect(entry).not.toContain(boss.name);
      noBossPrivateFields(entry);
    }
    // ④ 重放回执：原样 PUT 后用原键重放
    const seen = (await s.w.ok<PersonView>(s.as('GET', `/people/${sub.id}`))) as PersonView & Record<string, unknown>;
    const key = randomUUID();
    const put = () =>
      s.as('PUT', `/people/${sub.id}`, {
        ifMatch: seen.revision,
        idempotencyKey: key,
        body: { name: seen.name, superiorPersonId: seen.superiorPersonId, position: '重放职位' },
      });
    const first = await s.w.ok<PersonView>(put());
    const replay = await put();
    const replayText = await replay.clone().text();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(first);
    expect(first).toMatchObject({ superiorPersonId: boss.id, superior: bossSummary });
    noBossPrivateFields(replayText);
    // ⑤ GET 范围外经理：与不存在的人员同样 404
    const hiddenBoss = await s.as('GET', `/people/${boss.id}`);
    const missing = await s.as('GET', `/people/${randomUUID()}`);
    expect([hiddenBoss.status, missing.status]).toEqual([404, 404]);
    expect(await hiddenBoss.json()).toEqual(await missing.json());
  });
});
