/**
 * F-185（DEC-543 / DEC-615）：职业发展信息的三个目标字段（发展条线 / 拟晋升职级 / 拟晋升职务）与三个“当前”任职快照
 * （当前职级 / 职位 / 职务，系统在新建保存时按员工当天有效任职写入，之后任何编辑都不重取）。
 */
import { randomUUID } from 'node:crypto';
import { IDP_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { idpOperator } from './AC-IDP-permission-support.js';
import { permissionWorldOf, planWorld, PLAN_NOW, type PlanWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';
const TODAY = '2026-03-01';
const span = { startDate: '2026-01-01', endDate: '2026-06-30' };
const SNAPSHOT = ['currentLevelId', 'currentPositionId', 'currentPostId'] as const;

interface CareerView {
  id: string;
  revision: number;
  [field: string]: unknown;
}

async function createJob(w: PlanWorld, path: string, body: Record<string, unknown>, user = w.hrUser) {
  return w.ok<{ id: string; revision: number }>(
    await w.http(user, 'POST', `/api/tenant/job/${path}`, {
      ifMatch: 0,
      body: { code: randomUUID(), startDate: '2020-01-01', ...body },
    }),
    201,
  );
}

/** 职务 + 该职务下本部门的职位 + 职级，凑成一套任职岗位。 */
async function jobSet(w: PlanWorld, label: string, grade: number) {
  const levelType = await createJob(w, 'level-types', { name: `${label}职级体系` });
  const level = await createJob(w, 'levels', { name: `${label}职级`, level: grade, levelTypeId: levelType.id });
  const post = await createJob(w, 'posts', { name: `${label}职务` });
  const position = await createJob(w, 'positions', { name: `${label}职位`, postId: post.id, orgId: w.dept });
  return { level: level.id, post: post.id, position: position.id };
}

type JobSet = Awaited<ReturnType<typeof jobSet>>;

async function transferTo(w: PlanWorld, employeeId: string, effectiveDate: string, job: JobSet) {
  const employee = await w.ok<{ revision: number }>(
    await w.http(w.hrUser, 'GET', `/api/tenant/employment/employees/${employeeId}`),
  );
  await w.ok(
    await w.http(w.hrUser, 'POST', `/api/tenant/employment/employees/${employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate,
        fields: { levelId: job.level, positionId: job.position, postId: job.post },
      },
    }),
    201,
  );
}

async function scene(label: string) {
  const w = await planWorld(testDb().db, label);
  const p1 = await jobSet(w, 'P1', 1);
  const p2 = await jobSet(w, 'P2', 2);
  const line = await createJob(w, 'professional-lines', { name: `${label}条线` });
  const target = await jobSet(w, 'T', 3);
  // 员工丁入职即 P1（2020-01-01 起）
  const person = await w.person('员工丁', w.dept, { levelId: p1.level, positionId: p1.position, postId: p1.post });
  const create = (body: Record<string, unknown>, user = w.hrUser) =>
    w.http(user, 'POST', `${IDP}/careers`, { ifMatch: 0, body: { employeeId: person.employeeId, ...span, ...body } });
  const created = async (body: Record<string, unknown> = {}) => w.ok<CareerView>(await create(body), 201);
  const read = async (id: string) => w.ok<CareerView>(await w.http(w.hrUser, 'GET', `${IDP}/careers/${id}`));
  const patch = (id: string, revision: number, body: Record<string, unknown>) =>
    w.http(w.hrUser, 'PATCH', `${IDP}/careers/${id}`, { ifMatch: revision, body });
  const count = async () =>
    (await w.ok<{ items: unknown[] }>(await w.http(w.hrUser, 'GET', `${IDP}/careers?employeeId=${person.employeeId}`)))
      .items.length;
  return { w, p1, p2, line, target, person, create, created, read, patch, count };
}

const snapshotOf = (view: CareerView) => Object.fromEntries(SNAPSHOT.map((field) => [field, view[field]]));

describe('F-185：三个目标字段（发展条线 / 拟晋升职级 / 拟晋升职务）', () => {
  it('可新建、编辑、回显（列表与详情），可清空，且都不是必填', async () => {
    const s = await scene('f185-target');
    const bare = await s.created({ startDate: '2025-01-01', endDate: '2025-06-30' });
    expect(bare).toMatchObject({ targetProfessionalLineId: null, targetLevelId: null, targetPostId: null });

    const view = await s.created({
      targetProfessionalLineId: s.line.id,
      targetLevelId: s.target.level,
      targetPostId: s.target.post,
    });
    const wanted = {
      targetProfessionalLineId: s.line.id,
      targetLevelId: s.target.level,
      targetPostId: s.target.post,
    };
    expect(view).toMatchObject(wanted);
    expect(await s.read(view.id)).toMatchObject(wanted);
    const list = await s.w.ok<{ items: CareerView[] }>(await s.w.http(s.w.hrUser, 'GET', `${IDP}/careers`));
    expect(list.items.find((i) => i.id === view.id)).toMatchObject(wanted);

    const edited = await s.w.ok<CareerView>(
      await s.patch(view.id, view.revision, { targetLevelId: s.p2.level, targetPostId: null }),
    );
    expect(edited).toMatchObject({
      targetProfessionalLineId: s.line.id,
      targetLevelId: s.p2.level,
      targetPostId: null,
    });
    expect(await s.read(view.id)).toMatchObject({ targetLevelId: s.p2.level, targetPostId: null });
  });

  it('引用须同租户、存在且启用：跨租户 ID / 不存在 / 已停用 → 400，且没有写入', async () => {
    const s = await scene('f185-refs');
    const other = await planWorld(testDb().db, 'f185-refs-other');
    const foreign = {
      targetProfessionalLineId: (await createJob(other, 'professional-lines', { name: '外租户条线' })).id,
      targetLevelId: (await jobSet(other, 'X', 1)).level,
      targetPostId: (await jobSet(other, 'Y', 1)).post,
    };
    const before = await s.count();
    for (const [field, value] of [
      ...Object.entries(foreign),
      ['targetProfessionalLineId', randomUUID()],
      ['targetLevelId', randomUUID()],
      ['targetPostId', randomUUID()],
    ] as const) {
      const response = await s.create({ [field]: value });
      expect(response.status, `${field} ${value}`).toBe(400);
    }
    expect(await s.count()).toBe(before);

    const disabled = await createJob(s.w, 'professional-lines', { name: '停用条线' });
    await s.w.ok(
      await s.w.http(s.w.hrUser, 'PATCH', `/api/tenant/job/professional-lines/${disabled.id}`, {
        ifMatch: disabled.revision,
        body: { enabled: false, effectiveDate: '2021-01-01' },
      }),
    );
    expect((await s.create({ targetProfessionalLineId: disabled.id })).status).toBe(400);
    expect(await s.count()).toBe(before);

    const ok = await s.created({ startDate: '2025-02-01', endDate: '2025-03-01' });
    const rejected = await s.patch(ok.id, ok.revision, { targetPostId: foreign.targetPostId });
    expect(rejected.status).toBe(400);
    expect(await s.read(ok.id)).toMatchObject({ revision: ok.revision, targetPostId: null });
  });
});

describe('F-185：当前职级 / 职位 / 职务快照（DEC-615）', () => {
  it('① 新建时取保存当天有效任职；之后调动生效，旧记录仍是原值', async () => {
    const s = await scene('f185-snap1');
    const first = await s.created({ startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(snapshotOf(first)).toEqual({
      currentLevelId: s.p1.level,
      currentPositionId: s.p1.position,
      currentPostId: s.p1.post,
    });
    await transferTo(s.w, s.person.employeeId, TODAY, s.p2);
    expect(snapshotOf(await s.read(first.id))).toEqual(snapshotOf(first));
  });

  it('② 调动生效后新建开始日早于调动日的记录：取保存当天的任职（不取开始日任职）', async () => {
    const s = await scene('f185-snap2');
    await transferTo(s.w, s.person.employeeId, TODAY, s.p2);
    const view = await s.created({ startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(snapshotOf(view)).toEqual({
      currentLevelId: s.p2.level,
      currentPositionId: s.p2.position,
      currentPostId: s.p2.post,
    });
  });

  it('③ 只改普通字段、改日期、改人员后保存：三个快照都不变', async () => {
    const s = await scene('f185-snap3');
    const other = await s.w.person('员工戊', s.w.dept, {
      levelId: s.p2.level,
      positionId: s.p2.position,
      postId: s.p2.post,
    });
    const view = await s.created();
    const expected = snapshotOf(view);
    expect(expected.currentLevelId).toBe(s.p1.level);
    await transferTo(s.w, s.person.employeeId, TODAY, s.p2);

    let current = await s.w.ok<CareerView>(await s.patch(view.id, view.revision, { strengths: '沟通' }));
    expect(snapshotOf(current)).toEqual(expected);
    current = await s.w.ok<CareerView>(await s.patch(view.id, current.revision, { endDate: '2026-07-31' }));
    expect(snapshotOf(current)).toEqual(expected);
    current = await s.w.ok<CareerView>(await s.patch(view.id, current.revision, { employeeId: other.employeeId }));
    expect(snapshotOf(current)).toEqual(expected);
    expect(snapshotOf(await s.read(view.id))).toEqual(expected);
  });

  it('员工当天没有有效任职：三个快照存空', async () => {
    const s = await scene('f185-snap-empty');
    const bare = await s.w.ok<{ id: string }>(
      await s.w.http(s.w.hrUser, 'POST', '/api/tenant/employment/employees', {
        ifMatch: 0,
        body: { name: '无任职员工', code: `F185_${randomUUID().replaceAll('-', '')}` },
      }),
      201,
    );
    const response = await s.create({ employeeId: bare.id });
    const view = await s.w.ok<CareerView>(response, 201);
    expect(snapshotOf(view)).toEqual({ currentLevelId: null, currentPositionId: null, currentPostId: null });
  });

  it('职务返回名称（currentPostName），不返回职务编码', async () => {
    const s = await scene('f185-post-name');
    const view = await s.created();
    expect(view.currentPostName).toBe('P1职务');
  });

  it('客户端传入“当前”字段 → 400，不得覆盖快照（新建与编辑）', async () => {
    const s = await scene('f185-snap-reject');
    const view = await s.created();
    for (const field of [...SNAPSHOT, 'currentPostName']) {
      const created = await s.create({ [field]: s.p2.level });
      expect(created.status, `create ${field}`).toBe(400);
      const edited = await s.patch(view.id, view.revision, { [field]: s.p2.level });
      expect(edited.status, `patch ${field}`).toBe(400);
    }
    expect(await s.read(view.id)).toMatchObject({ revision: view.revision, ...snapshotOf(view) });
  });
});

describe('F-185：字段权限与审计', () => {
  it('无目标字段编辑权：写入 403 且无写入；无查看权：读取裁剪（含“当前”字段）', async () => {
    const s = await scene('f185-perm');
    const pw = await permissionWorldOf(s.w);
    const guarded = await idpOperator(pw, { orgId: s.w.dept, readonly: { career: ['targetLevelId'] } });
    const before = await s.count();
    const denied = await guarded.request('POST', '/careers', {
      ifMatch: 0,
      body: { employeeId: s.person.employeeId, ...span, targetLevelId: s.target.level },
    });
    expect(denied.status).toBe(403);
    expect(await s.count()).toBe(before);

    const allowed = await guarded.request('POST', '/careers', {
      ifMatch: 0,
      body: { employeeId: s.person.employeeId, ...span, targetPostId: s.target.post },
    });
    const view = await s.w.ok<CareerView>(allowed, 201);
    expect(view).toMatchObject({ targetPostId: s.target.post, currentLevelId: s.p1.level });

    const blind = await idpOperator(pw, {
      orgId: s.w.dept,
      hidden: { career: ['targetProfessionalLineId', 'currentLevelId', 'currentPostId'] },
    });
    const read = await s.w.ok<CareerView>(await blind.request('GET', `/careers/${view.id}`));
    for (const field of ['targetProfessionalLineId', 'currentLevelId', 'currentPostId']) {
      expect(read, field).not.toHaveProperty(field);
    }
    expect(read).toHaveProperty('currentPositionId', s.p1.position);
    expect(read).not.toHaveProperty('currentPostName');
  });

  it('“当前”三字段在权限目录里是系统只读字段', () => {
    const fields = IDP_OBJECTS.career.fields;
    for (const code of SNAPSHOT)
      expect(
        fields.find((f) => f.code === code),
        code,
      ).toMatchObject({ system: true });
    // 职务名称随 currentPostId 的查看权输出，不单独登记字段
    expect(fields.find((f) => f.code === 'currentPostName')).toBeUndefined();
    for (const code of ['targetProfessionalLineId', 'targetLevelId', 'targetPostId']) {
      expect(
        fields.find((f) => f.code === code),
        code,
      ).toMatchObject({ system: false });
    }
  });

  it('审计与新建同事务，变更内容带三个目标字段和快照，字段有中文标签', async () => {
    const s = await scene('f185-audit');
    const view = await s.created({ targetLevelId: s.target.level });
    const audit = auditApi(s.w.db, PLAN_NOW);
    const logs = await audit.dataChanges(s.w.as(s.w.hrUser), { objectType: IDP_OBJECTS.career.code, limit: '50' });
    const log = logs.items.find((i) => i.objectId === view.id && i.operation === 'create')!;
    expect(log).toBeTruthy();
    const detail = await audit.dataChange(s.w.as(s.w.hrUser), log.id);
    expect(detail.after).toMatchObject({ targetLevelId: s.target.level, currentLevelId: s.p1.level });
    const labels = Object.fromEntries(log.changes.map((c) => [c.field, c.label]));
    expect(labels).toMatchObject({ targetLevelId: '拟晋升职级', currentLevelId: '当前职级' });
  });
});
