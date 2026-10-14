/** R3-T04 PR-B7a：设计 §2.4 / §3.1；TR-R1 / R2 / R7 / R9 / R38；DEC-353 定义侧。 */
import { randomUUID } from 'node:crypto';
import { and, auditEvents, eq, talentReviewProjects as P, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { createOrg, talentWorld } from './AC-TC-support.js';
import { configBody, configOperator } from './AC-TR-config-support.js';
import { LEVEL_OPTIONS, matrixBody, ratioGroupBody, type MatrixView } from './AC-TR-matrix-support.js';
import { seedPermissionWorld } from './AC-PRM-support.js';
import { TR_BASE, TR_NOW } from './AC-TR-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';
import { waitForBlocked } from './support/pg-interleave.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { updateField } from '../../apps/api/src/modules/talent-review/field-service.js';
import { projectCreate } from '../../apps/api/src/modules/talent-review/project-input.js';
import { createProject } from '../../apps/api/src/modules/talent-review/project-service.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const PATH = '/projects';
type Project = {
  id: string;
  revision: number;
  status: string;
  endedCount: number;
  matrices: { matrixId: string; ratioGroupId: string | null }[];
  [key: string]: unknown;
};
const body = (org: string, extra: Record<string, unknown> = {}) => ({
  code: `prj_${uniqueSuffix()}`,
  name: '合成盘点项目',
  ownerOrgId: org,
  year: 2026,
  period: '年度',
  periodStartDate: '2026-01-01',
  periodEndDate: '2026-12-31',
  ...extra,
});
const reason = async (res: Response) =>
  ((await res.json()) as { error: { details?: { reason: string } } }).error.details?.reason;

async function fixture(label: string) {
  const w = await talentWorld(testDb().db, label);
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    w.api.request(method, `${TR_BASE}${path}`, { ...w.as, ...options });
  const create = async <T>(path: string, input: unknown): Promise<T> => {
    const res = await request('POST', path, { ifMatch: 0, body: input });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as T;
  };
  const project = (extra: Record<string, unknown> = {}) => create<Project>(PATH, body(w.orgId, extra));
  const read = async (p: Project) => (await (await request('GET', `${PATH}/${p.id}`)).json()) as Project;
  const write = (p: Project, method: string, input?: unknown, action = '', key?: string) =>
    request(method, `${PATH}/${p.id}${action}`, { ifMatch: p.revision, body: input, idempotencyKey: key });
  const matrix = async (enabled = true) => {
    const field = async (kind: string, group: string) =>
      (
        await create<{ id: string }>(
          '/fields',
          configBody('field', { kind, group, ...(kind === 'option' ? { options: LEVEL_OPTIONS } : {}) }),
        )
      ).id;
    const refs = {
      x: await field('option', 'result'),
      y: await field('option', 'result'),
      before: await field('number', 'position'),
      after: await field('number', 'position'),
    };
    return create<MatrixView>('/matrices', matrixBody(refs, { enabled }));
  };
  return { w, request, create, project, read, write, matrix };
}

describe('AC-TR-project 项目定义', () => {
  it('计划日期 / 年度周期 / 业务日期原样保存；所属人取创建人；calc_state 只读；列表与详情一致', async () => {
    const f = await fixture('project-header');
    const p = await f.project({ businessDate: '2027-01-02', downwardPublic: true, carryLastResult: true });
    expect(p).toMatchObject({
      ownerOrgId: f.w.orgId,
      ownerId: f.w.as.user,
      year: 2026,
      period: '年度',
      status: 'new',
      endedCount: 0,
      periodStartDate: '2026-01-01',
      periodEndDate: '2026-12-31',
      businessDate: '2027-01-02',
      calcState: 'not_calculated',
      lastFullCalcAt: null,
      downwardPublic: true,
      carryLastResult: true,
    });
    expect(p).not.toHaveProperty('startedAt');
    expect(p).not.toHaveProperty('endedAt');
    expect(p).not.toHaveProperty('resultVersion');
    const list = (await (await f.request('GET', PATH)).json()) as { items: Project[] };
    expect(list.items).toContainEqual(p);
    expect(await f.read(p)).toEqual(p);
    for (const patch of [
      { calcState: 'success' },
      { lastFullCalcAt: TR_NOW.toISOString() },
      { ownerId: randomUUID() },
    ]) {
      expect((await f.write(p, 'PATCH', patch)).status).toBe(400);
      expect(await f.read(p)).toEqual(p);
    }
  });

  it('必填 / 非法日期 / 结束早于开始均 400；单改日期也按完整配置检查且不改数据', async () => {
    const f = await fixture('project-date');
    for (const patch of [
      { periodStartDate: undefined },
      { periodEndDate: null },
      { periodStartDate: '2026-02-30' },
      { periodEndDate: '2025-12-31' },
      { year: undefined },
      { year: 2147483648 },
      { periodStartDate: '0000-01-01' },
      { businessDate: '0000-01-01' },
      { period: '' },
      { ownerOrgId: 'bad' },
    ])
      expect((await f.request('POST', PATH, { ifMatch: 0, body: body(f.w.orgId, patch) })).status).toBe(400);
    const p = await f.project();
    const invalid = await f.write(p, 'PATCH', { periodStartDate: '2027-01-01' });
    expect([invalid.status, await reason(invalid)]).toEqual([400, 'PROJECT_DATE_RANGE_INVALID']);
    expect(await f.read(p)).toEqual(p);
    expect((await f.write(p, 'PATCH', { periodStartDate: '2027-01-01', periodEndDate: '2027-01-01' })).status).toBe(
      200,
    );
  });

  it('创建缺省带入全部启用九宫格与默认规则组；显式空集合清空；停用九宫格不带入', async () => {
    const f = await fixture('project-matrices');
    const m = await f.matrix();
    const disabled = await f.matrix(false);
    const groupRes = await f.request('POST', `/matrices/${m.id}/ratio-groups`, {
      ifMatch: m.revision,
      body: ratioGroupBody({ isDefault: true }),
    });
    expect(groupRes.status, await groupRes.clone().text()).toBe(201);
    const configured = (await groupRes.json()) as MatrixView;
    const group = configured.ratioGroups[0]!;
    const p = await f.project();
    expect(p.matrices).toContainEqual({ matrixId: m.id, ratioGroupId: group.id, sortNo: 0 });
    expect(p.matrices.some((x) => x.matrixId === disabled.id)).toBe(false);
    for (const [path, expected] of [
      [`/matrices/${m.id}`, 'MATRIX_IN_USE'],
      [`/matrices/${m.id}/ratio-groups/${group.id}`, 'RATIO_GROUP_IN_USE'],
    ]) {
      const res = await f.request('DELETE', path!, { ifMatch: configured.revision });
      expect([res.status, await reason(res)]).toEqual([409, expected]);
    }
    expect((await f.write(p, 'PATCH', { matrices: [{ matrixId: disabled.id }] })).status).toBe(400);
    expect((await f.write(p, 'PATCH', { matrices: [{ matrixId: m.id, ratioGroupId: randomUUID() }] })).status).toBe(
      400,
    );
    expect(await f.read(p)).toEqual(p);
    const cleared = (await (await f.write(p, 'PATCH', { matrices: [] })).json()) as Project;
    expect(cleared.matrices).toEqual([]);
    expect((await f.project({ matrices: [] })).matrices).toEqual([]);
  });

  it('共享组织 / 排除分类 / 校准原因 / 计算规则随项目保存与清空；引用删除 409', async () => {
    const f = await fixture('project-relations');
    const category = await f.create<{ id: string; revision: number }>('/categories', configBody('category'));
    const field = await f.create<{ id: string; revision: number }>(
      '/fields',
      configBody('field', { group: 'calibration' }),
    );
    const rule = await f.create<{ id: string; revision: number }>('/calc-rules', { name: '项目计算规则', items: [] });
    const extra = {
      categoryId: category.id,
      excludedCategoryIds: [category.id],
      sharedOrgIds: [f.w.orgId.toUpperCase()],
      calcRuleId: rule.id,
      calibrationFields: [{ fieldId: field.id, required: true }],
      matrices: [],
    };
    const p = await f.project(extra);
    expect(p).toMatchObject({ ...extra, sharedOrgIds: [f.w.orgId] });
    for (const [path, ref, expected] of [
      ['categories', category, 'CATEGORY_IN_USE'],
      ['fields', field, 'FIELD_IN_USE'],
      ['calc-rules', rule, 'CALC_RULE_IN_USE'],
    ] as const) {
      const res = await f.request('DELETE', `/${path}/${ref.id}`, { ifMatch: ref.revision });
      expect([res.status, await reason(res)]).toEqual([409, expected]);
      expect(await f.read(p)).toEqual(p);
    }
    const empty = (await (
      await f.write(p, 'PATCH', {
        sharedOrgIds: [],
        excludedCategoryIds: [],
        calibrationFields: [],
        categoryId: null,
        calcRuleId: null,
        businessDate: null,
      })
    ).json()) as Project;
    expect(empty).toMatchObject({
      sharedOrgIds: [],
      excludedCategoryIds: [],
      calibrationFields: [],
      categoryId: null,
      calcRuleId: null,
      businessDate: null,
      revision: p.revision + 1,
    });
  });

  it('无效 / 跨租户引用 404；错误校准分组与重复关系 400，整单不写', async () => {
    const f = await fixture('project-invalid-ref');
    const other = await fixture('project-other-tenant');
    const foreign = await other.create<{ id: string }>('/categories', configBody('category'));
    const field = await f.create<{ id: string }>('/fields', configBody('field'));
    const p = await f.project();
    for (const patch of [
      { categoryId: foreign.id },
      { ownerOrgId: other.w.orgId },
      { calcRuleId: randomUUID() },
      { matrices: [{ matrixId: randomUUID() }] },
      { sharedOrgIds: [other.w.orgId] },
    ]) {
      expect((await f.write(p, 'PATCH', patch)).status).toBe(404);
      expect(await f.read(p)).toEqual(p);
    }
    for (const patch of [{ calibrationFields: [{ fieldId: field.id }] }, { sharedOrgIds: [f.w.orgId, f.w.orgId] }]) {
      expect((await f.write(p, 'PATCH', patch)).status).toBe(400);
      expect(await f.read(p)).toEqual(p);
    }
  });

  it('编码冲突 / revision 冲突 409；创建及状态命令幂等，同键异内容 409', async () => {
    const f = await fixture('project-idempotency');
    const input = body(f.w.orgId);
    const options = { ifMatch: 0, body: input, idempotencyKey: randomUUID() };
    const a = await f.request('POST', PATH, options);
    expect(a.status, await a.clone().text()).toBe(201);
    const p = (await a.json()) as Project;
    expect(await (await f.request('POST', PATH, options)).json()).toEqual(p);
    expect((await f.request('POST', PATH, { ...options, body: { ...input, name: '不同内容' } })).status).toBe(409);
    const dup = await f.request('POST', PATH, { ifMatch: 0, body: input });
    expect([dup.status, await reason(dup)]).toEqual([409, 'PROJECT_DUPLICATE']);
    const key = randomUUID();
    const started = (await (await f.write(p, 'POST', {}, '/start', key)).json()) as Project;
    expect(started.status).toBe('in_progress');
    expect(await (await f.write(p, 'POST', {}, '/start', key)).json()).toEqual(started);
    expect((await f.write(p, 'PATCH', { name: '过期写' })).status).toBe(409);
    expect(await f.read(p)).toEqual(started);
  });
});

describe('AC-TR-project 校准引用属性约束（PR #256 P2-1）', () => {
  const context = (f: Awaited<ReturnType<typeof fixture>>, expectedRevision = 0) => {
    const scope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
    return {
      tenantId: f.w.as.tenant,
      userId: f.w.as.user,
      timezone: 'Asia/Shanghai',
      now: TR_NOW,
      commandId: randomUUID(),
      expectedRevision,
      scope,
      referenceScopes: { category: scope, calcRule: scope, matrix: scope, field: scope },
    };
  };
  const calibration = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.create<{ id: string; revision: number; group: string }>('/fields', configBody('field', { group: 'calibration' }));
  const selection = (id: string, required = true) => ({ calibrationFields: [{ fieldId: id, required }], matrices: [] });

  it.each([true, false])(
    '校准原因 required=%s：改组拒绝且不写；合法属性修改和原样保存允许；解除后可改组',
    async (required) => {
      const f = await fixture('project-field-group');
      const field = await calibration(f);
      const p = await f.project(selection(field.id, required));
      const audits = () =>
        withTenant(testDb().db, f.w.as.tenant, (tx) =>
          tx.select().from(auditEvents).where(eq(auditEvents.objectId, field.id)),
        );
      const beforeAudits = await audits();
      const changed = await f.request('PATCH', `/fields/${field.id}`, {
        ifMatch: field.revision,
        body: { group: 'result', name: '不应保存的字段名称' },
      });
      expect(changed.status, await changed.clone().text()).toBe(409);
      expect(await reason(changed)).toBe('FIELD_GROUP_BREAKS_PROJECT');
      expect(await (await f.request('GET', `/fields/${field.id}`)).json()).toEqual(field);
      expect(await f.read(p)).toEqual(p);
      expect(await audits()).toEqual(beforeAudits);
      const allowed = await f.request('PATCH', `/fields/${field.id}`, {
        ifMatch: field.revision,
        body: { group: 'calibration', name: '校准原因正常改名', enabled: false },
      });
      expect(allowed.status, await allowed.clone().text()).toBe(200);
      const updated = (await allowed.json()) as { revision: number };
      const saved = await f.write(p, 'PATCH', { name: '项目正常保存', ...selection(field.id, required) });
      expect(saved.status, await saved.clone().text()).toBe(200);
      const current = (await saved.json()) as Project;
      expect((await f.write(current, 'PATCH', { calibrationFields: [] })).status).toBe(200);
      expect(
        (await f.request('PATCH', `/fields/${field.id}`, { ifMatch: updated.revision, body: { group: 'result' } }))
          .status,
      ).toBe(200);
    },
  );

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    '真 PG：新建引用先持字段共享锁，改组等待后须读到引用并返回 409',
    async () => {
      const f = await fixture('project-reference-first');
      const field = await calibration(f);
      const { p, pending } = await withTenant(testDb().db, f.w.as.tenant, async (tx) => {
        const p = await createProject(tx, context(f), projectCreate.parse(body(f.w.orgId, selection(field.id))));
        const pending = f.request('PATCH', `/fields/${field.id}`, {
          ifMatch: field.revision,
          body: { group: 'result' },
        });
        await waitForBlocked(testDb().db, 1);
        return { p, pending };
      });
      const changed = await pending;
      expect(changed.status, await changed.clone().text()).toBe(409);
      expect(await reason(changed)).toBe('FIELD_GROUP_BREAKS_PROJECT');
      expect(await (await f.request('GET', `/fields/${field.id}`)).json()).toEqual(field);
      expect((await f.write(p, 'PATCH', { name: '交错后正常保存', ...selection(field.id) })).status).toBe(200);
    },
  );

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    '真 PG：改组先持字段排他锁，新建引用等待后拒绝新分组，项目未落库',
    async () => {
      const f = await fixture('project-group-first');
      const field = await calibration(f);
      const { pending } = await withTenant(testDb().db, f.w.as.tenant, async (tx) => {
        await updateField(tx, context(f, field.revision), field.id, { group: 'result' });
        const pending = f.request('POST', PATH, { ifMatch: 0, body: body(f.w.orgId, selection(field.id)) });
        await waitForBlocked(testDb().db, 1);
        return { pending };
      });
      const created = await pending;
      expect([created.status, await reason(created)]).toEqual([400, 'PROJECT_CALIBRATION_FIELD_INVALID']);
      expect(await (await f.request('GET', `/fields/${field.id}`)).json()).toMatchObject({ group: 'result' });
      expect(await (await f.request('GET', PATH)).json()).toMatchObject({ items: [] });
    },
  );
});

describe('AC-TR-project 状态机 / AC-TR-01 删除定义侧（DEC-353）', () => {
  it('状态 × 操作：新建可结束；仅新建能启动、仅已结束能重启；已结束不能编辑；重启计数递增', async () => {
    const f = await fixture('project-states');
    for (const state of ['new', 'in_progress', 'ended']) {
      let p = await f.project();
      if (state === 'in_progress') p = (await (await f.write(p, 'POST', {}, '/start')).json()) as Project;
      if (state === 'ended') p = (await (await f.write(p, 'POST', {}, '/end')).json()) as Project;
      for (const action of ['start', 'end', 'restart']) {
        const allowed =
          (action === 'start' && state === 'new') ||
          (action === 'end' && state !== 'ended') ||
          (action === 'restart' && state === 'ended');
        const res = await f.write(p, 'POST', {}, `/${action}`);
        expect(res.status, `${state} × ${action}`).toBe(allowed ? 200 : 409);
        if (allowed) {
          // 每个操作使用独立项目，避免前一次成功转换改变下一格的起始状态。
          let fresh = await f.project();
          if (state !== 'new')
            fresh = (await (await f.write(fresh, 'POST', {}, state === 'ended' ? '/end' : '/start')).json()) as Project;
          p = fresh;
        } else expect(await f.read(p)).toEqual(p);
      }
      const edit = await f.write(p, 'PATCH', { name: '配置可编辑性' });
      expect(edit.status).toBe(state === 'ended' ? 409 : 200);
      const current = await f.read(p);
      expect((await f.write(current, 'DELETE')).status).toBe(200);
      expect((await f.request('GET', `${PATH}/${p.id}`)).status).toBe(404);
    }
    let p = await f.project();
    for (let count = 1; count <= 2; count++) {
      p = (await (await f.write(p, 'POST', {}, '/end')).json()) as Project;
      p = (await (await f.write(p, 'POST', {}, '/restart')).json()) as Project;
      expect(p).toMatchObject({ status: 'in_progress', endedCount: count });
    }
  });

  it('start / end / restart 的扩展守卫事务内运行；失败回滚且不写成功审计', async () => {
    const f = await fixture('project-guard');
    const { registerProjectGuard } = await import('../../apps/api/src/modules/talent-review/project-guards.js');
    const { AppError } = await import('@italent/api');
    for (const action of ['start', 'end', 'restart'] as const) {
      let p = await f.project();
      if (action === 'restart') p = (await (await f.write(p, 'POST', {}, '/end')).json()) as Project;
      const undo = registerProjectGuard(action, async (tx) => {
        await tx.update(P).set({ name: '守卫内尚未提交的写入' }).where(eq(P.id, p.id));
        throw new AppError('CONFLICT', '合成守卫', { reason: 'CALC_RUN_IN_PROGRESS' });
      });
      try {
        const res = await f.write(p, 'POST', {}, `/${action}`);
        expect([res.status, await reason(res)]).toEqual([409, 'CALC_RUN_IN_PROGRESS']);
        expect(await f.read(p)).toEqual(p);
      } finally {
        undo();
      }
      const rows = await withTenant(testDb().db, f.w.as.tenant, (tx) =>
        tx
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, f.w.as.tenant), eq(auditEvents.objectId, p.id))),
      );
      expect(rows).toHaveLength(action === 'restart' ? 2 : 1);
      expect((await f.write(p, 'POST', {}, `/${action}`)).status).toBe(200);
    }
  });

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    '真 PG：配置写等待项目锁，结束先提交后旧 revision 写入 409',
    async () => {
      const f = await fixture('project-state-lock');
      const p = await f.project();
      const { pending } = await withTenant(testDb().db, f.w.as.tenant, async (tx) => {
        await tx.select().from(P).where(eq(P.id, p.id)).for('update');
        const pending = f.write(p, 'PATCH', { name: '不能覆盖结束后的配置' });
        await waitForBlocked(testDb().db, 1);
        await tx
          .update(P)
          .set({ status: 'ended', revision: p.revision + 1 })
          .where(eq(P.id, p.id));
        return { pending };
      });
      expect((await pending).status).toBe(409);
      expect(await f.read(p)).toMatchObject({ name: p.name, status: 'ended', revision: p.revision + 1 });
    },
  );

  it('AC-TR-01 对象存在守卫拒删 409；解除后删除、保存完整关系快照', async () => {
    const f = await fixture('project-delete');
    const p = await f.project({ sharedOrgIds: [f.w.orgId] });
    const { registerProjectObjectCheck } = await import('../../apps/api/src/modules/talent-review/project-guards.js');
    const undo = registerProjectObjectCheck(
      async (_tx, tenantId, projectId) => tenantId === f.w.as.tenant && projectId === p.id,
    );
    try {
      const res = await f.write(p, 'DELETE');
      expect([res.status, await reason(res)]).toEqual([409, 'PROJECT_HAS_OBJECTS']);
      expect(await f.read(p)).toEqual(p);
    } finally {
      undo();
    }
    expect((await f.write(p, 'DELETE')).status).toBe(200);
    const rows = await withTenant(testDb().db, f.w.as.tenant, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, f.w.as.tenant), eq(auditEvents.objectId, p.id))),
    );
    expect(rows.find((r) => r.action.endsWith('.delete'))!.before).toMatchObject({ sharedOrgIds: [f.w.orgId] });
  });

  it('权限缺省范围空 404；缺按钮 403；字段裁剪与撤按钮后命令重放复核', async () => {
    const f = await fixture('project-permission-red');
    await f.project(); // 旧实现先在真实 HTTP 新建上红。
    let w = await seedPermissionWorld(testDb().db);
    const setup = tenantApi(w.db, { clock: () => TR_NOW });
    const org = await createOrg(setup, w.asAdmin, '合成项目所属组织');
    const res = await setup.request('POST', `${TR_BASE}${PATH}`, {
      ...w.asAdmin,
      ifMatch: 0,
      body: body(org, { businessDate: '2026-01-02' }),
    });
    expect(res.status).toBe(201);
    const p = (await res.json()) as Project;
    w = { ...w, api: tenantApi(w.db, { authorize: undefined, clock: () => TR_NOW }) };
    const op = await configOperator(w, 'project', { hidden: ['businessDate', 'matrices'] });
    expect(await (await op.request('GET', PATH)).json()).toMatchObject({ items: [], hasDataPermission: false });
    expect((await op.request('POST', PATH, { ifMatch: 0, body: body(f.w.orgId) })).status).toBe(404);
    await op.setSeeAll(true);
    await op.setButtons(false);
    expect((await op.request('POST', PATH, { ifMatch: 0, body: body(f.w.orgId) })).status).toBe(403);
    await op.setButtons(true);
    const detail = await (await op.request('GET', `${PATH}/${p.id}`)).json();
    expect(detail).not.toHaveProperty('businessDate');
    expect(detail).not.toHaveProperty('matrices');
    expect(detail).toMatchObject({ year: 2026, status: 'new' });
    expect(
      (await op.request('PATCH', `${PATH}/${p.id}`, { ifMatch: p.revision, body: { businessDate: null } })).status,
    ).toBe(403);
    const command = { ifMatch: p.revision, body: { name: '可见字段改名' }, idempotencyKey: randomUUID() };
    expect((await op.request('PATCH', `${PATH}/${p.id}`, command)).status).toBe(200);
    await op.setButtons(false);
    expect((await op.request('PATCH', `${PATH}/${p.id}`, command)).status).toBe(403);
    await op.setButtons(true);
    await op.setSeeAll(false);
    expect((await op.request('PATCH', `${PATH}/${p.id}`, command)).status).toBe(404);
  });
});
