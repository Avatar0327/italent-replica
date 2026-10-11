/**
 * R3-T04 B6a-2：步骤表单与结果公式的版本入口验收（设计 §2.3、§4.3、§7）。
 * DEC-423④ 已确认：沿用模板结构保存入口，保留 B6a 既有行为。
 */
import { auditApi } from './AC-AUD-support.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { formBody } from './AC-TR-form-flow-support.js';
import { BASE, seedPermissionWorld } from './AC-PRM-support.js';
import { createOrg } from './AC-IDP-support.js';
import { tenantApi } from './support/tenant-api.js';
import { configBody } from './AC-TR-config-support.js';
import { TR_BASE, TR_NOW } from './AC-TR-template-support.js';
import { templateOperator } from './AC-TR-template-support.js';
import {
  and,
  eq,
  withTenant,
  talentReviewTemplateResultRules as R,
  talentReviewTemplateResultRefs as RF,
} from '@italent/db';
import { indicatorModule, templateBody, templateWorld, type TemplateView } from './AC-TR-template-support.js';

const testDb = useTestDb();

describe('AC-TR-04 / AC-TR-15：模板步骤表单与结果公式', () => {
  it('AC-TR-15：步骤选用表单生成新版本；源表单变更不改写版本快照，旧版本仍无选用', async () => {
    const w = await templateWorld(testDb().db, 'b6a2-form');
    const { flow } = await w.threeStepFlow();
    const field = await w.field();
    const form = await w.created<{ id: string; revision: number }>(
      '/forms',
      formBody([{ fieldId: field.id, access: 'edit', required: true }]),
    );
    const initial = await w.template(templateBody(w.orgId, { flowId: flow.id }));
    const response = await w.patch(initial, {
      stepForms: [{ nodeKey: 'self', purpose: 'info', formId: form.id }],
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = (await response.json()) as TemplateView;
    expect(saved.currentVersionNo).toBe(2);
    expect(saved.stepForms).toMatchObject([
      {
        nodeKey: 'self',
        purpose: 'info',
        formId: form.id,
        formSnapshot: [{ fieldId: field.id, access: 'edit', required: true }],
      },
    ]);
    const sourceChanged = await w.trRequest('PATCH', `/forms/${form.id}`, {
      ifMatch: form.revision,
      body: { fields: [{ fieldId: field.id, access: 'view', required: false }] },
    });
    expect(sourceChanged.status, await sourceChanged.clone().text()).toBe(200);
    expect((await w.read(initial.id)).body.stepForms).toEqual(saved.stepForms);
    expect((await w.read(initial.id, '?version=1')).body.stepForms).toEqual([]);
  });

  it('结果公式目标按 ID 保存；模块文本与数字比较编辑期放行（DEC-391 / DEC-416⑥）', async () => {
    const w = await templateWorld(testDb().db, 'b6a2-result');
    const { flow } = await w.threeStepFlow();
    const rule = await w.gradeRule();
    const target = await w.field({ kind: 'number' });
    const initial = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [indicatorModule(rule.id, { name: '业绩' })],
      }),
    );
    const resultRules = [{ targetFieldId: target.id, formula: 'IF(模块.业绩.等级 > 1, 1, 0)', priority: 0 }];
    const response = await w.patch(initial, { resultRules });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = (await response.json()) as TemplateView;
    expect(saved.currentVersionNo).toBe(2);
    expect(saved.resultRules).toMatchObject(resultRules);
    expect((await w.read(initial.id, '?version=1')).body.resultRules).toEqual([]);
    const removed = await w.trRequest('DELETE', `/fields/${target.id}`, { ifMatch: 1 });
    expect(removed.status, await removed.clone().text()).toBe(409);
    expect((await w.read(initial.id)).body.resultRules).toEqual(saved.resultRules);
  });

  it('AC-TR-04：四种用途与会签角色可配置；错误席位 / 用途 / 类型 / 跨租户引用整体拒绝，清空生成版本', async () => {
    const w = await templateWorld(testDb().db, 'b6a2-seats');
    const { flow, roles } = await w.threeStepFlow();
    const forms = await Promise.all(
      ['info', 'calibrate_edit', 'succession_edit'].map((kind) =>
        w.created<{ id: string }>('/forms', formBody([], { kind })),
      ),
    );
    const stepForms = [
      { nodeKey: 'peers', roleId: roles.peerA.id, purpose: 'info', formId: forms[0]!.id },
      { nodeKey: 'calibrate', purpose: 'calibrate_edit', formId: forms[1]!.id },
      { nodeKey: 'self', purpose: 'successor_edit', formId: forms[2]!.id },
      { nodeKey: 'self', purpose: 'target_edit', formId: forms[2]!.id },
    ];
    const t = await w.template(templateBody(w.orgId, { flowId: flow.id, stepForms }));
    expect(t.stepForms).toMatchObject(stepForms);
    const other = await templateWorld(testDb().db, 'b6a2-foreign');
    const foreign = await other.created<{ id: string }>('/forms', formBody([]));
    for (const [status, rows] of [
      [400, [{ ...stepForms[0], roleId: null }]],
      [400, [{ ...stepForms[1], nodeKey: 'self' }]],
      [400, [{ ...stepForms[2], formId: forms[0]!.id }]],
      [400, [stepForms[0], stepForms[0]]],
      [404, [{ ...stepForms[0], formId: foreign.id }]],
    ] as const) {
      const before = (await w.read(t.id)).body;
      expect((await w.patch(t, { stepForms: rows })).status).toBe(status);
      expect((await w.read(t.id)).body).toEqual(before);
    }
    const cleared = await w.patch(t, { stepForms: [] });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ currentVersionNo: 2, stepForms: [] });
    expect((await w.read(t.id, '?version=1')).body.stepForms).toMatchObject(stepForms);
  });

  it('DEC-387：盘点字段按 ID 存储与引用；改名后历史 / 重放按当前名渲染，引用阻止删除', async () => {
    const w = await templateWorld(testDb().db, 'b6a2-bind');
    const source = await w.field({ name: '源分', kind: 'number' });
    const target = await w.field({ kind: 'number' });
    const initial = await w.template(templateBody(w.orgId));
    const body = {
      resultRules: [
        { targetFieldId: target.id, formula: '盘点对象.源分 + 1', formulaBindings: [source.id], priority: 1000000 },
      ],
    };
    const first = await w.patch(initial, body, 'b6a2-bound');
    expect(first.status, await first.clone().text()).toBe(200);
    const stored = await withTenant(testDb().db, w.as.tenant, async (tx) => {
      const rules = await tx.select().from(R).where(eq(R.tenantId, w.as.tenant));
      const refs = await tx
        .select()
        .from(RF)
        .where(and(eq(RF.tenantId, w.as.tenant), eq(RF.fieldId, source.id)));
      return { rules, refs };
    });
    expect(stored.rules[0]!.formula).toBe(`@{tr-field:${source.id}} + 1`);
    expect(stored.refs).toHaveLength(1);
    expect(
      (await w.trRequest('PATCH', `/fields/${source.id}`, { ifMatch: 1, body: { name: '改名源分' } })).status,
    ).toBe(200);
    const replay = await w.patch(initial, body, 'b6a2-bound');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      resultRules: [{ formula: '盘点对象.改名源分 + 1', formulaBindings: [source.id] }],
    });
    expect((await w.trRequest('DELETE', `/fields/${source.id}`, { ifMatch: 2 })).status).toBe(409);
    const current = (await w.read(initial.id)).body;
    expect((await w.patch(current, body)).status).toBe(409);
    expect((await w.read(initial.id)).body).toEqual(current);
    const brokenName = await w.trRequest('PATCH', `/fields/${source.id}`, {
      ifMatch: 2,
      body: { name: '坏.名称' },
    });
    expect(brokenName.status).toBe(409);
    expect((await w.read(initial.id)).body).toEqual(current);
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const events = await audit.dataChanges(w.as, { objectType: 'TalentReview.Template', limit: '50' });
    const update = await audit.dataChange(w.as, events.items.find((e) => e.operation === 'update')!.id);
    expect(update.after).toMatchObject({ resultRules: [{ formula: '盘点对象.源分 + 1' }] });
    expect(JSON.stringify(update)).not.toContain('@{tr-field:');
    expect((await w.trRequest('DELETE', `/templates/${initial.id}`, { ifMatch: current.revision })).status).toBe(200);
    const deleted = await audit.dataChanges(w.as, { objectType: 'TalentReview.Template', limit: '50' });
    const snapshot = await audit.dataChange(w.as, deleted.items.find((e) => e.operation === 'delete')!.id);
    expect(snapshot.snapshot).toMatchObject({ resultRules: [{ formula: '盘点对象.改名源分 + 1' }] });
    expect((await w.trRequest('DELETE', `/fields/${source.id}`, { ifMatch: 2 })).status).toBe(200);
  });

  it('DEC-387：循环可保存；resultRules 不可见时只返回匿名提示，隐藏引用不返回字段 ID / 名称', async () => {
    const base = await seedPermissionWorld(testDb().db);
    const clock = () => TR_NOW;
    const setup = tenantApi(base.db, { clock });
    const world = { ...base, api: tenantApi(base.db, { authorize: undefined, clock }) };
    const orgId = await createOrg(setup, base.asAdmin, '模板组织');
    const post = async <T>(path: string, body: unknown): Promise<T> => {
      const response = await setup.request('POST', `${TR_BASE}${path}`, { ...base.asAdmin, ifMatch: 0, body });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as T;
    };
    const w = {
      orgId,
      field: (extra: Record<string, unknown>) => post<{ id: string }>('/fields', configBody('field', extra)),
      template: (body: unknown) => post<TemplateView>('/templates', body),
    };
    const a = await w.field({ name: '甲分', kind: 'number' });
    const b = await w.field({ name: '乙分', kind: 'number' });
    const t = await w.template(
      templateBody(w.orgId, {
        resultRules: [
          { targetFieldId: a.id, formula: '盘点对象.乙分', formulaBindings: [b.id], priority: 1 },
          { targetFieldId: b.id, formula: '盘点对象.甲分', formulaBindings: [a.id], priority: 2 },
        ],
      }),
    );
    expect(t.hints).toMatchObject({ cycles: [expect.arrayContaining([a.id, b.id])] });
    const reader = await templateOperator(world, { orgId: w.orgId, references: 'none' });
    const hidden = await reader.request('GET', `/templates/${t.id}`);
    expect(hidden.status).toBe(200);
    const text = await hidden.text();
    expect(text).toContain('不可见字段');
    for (const secret of [a.id, b.id, '甲分', '乙分', '@{tr-field:']) expect(text).not.toContain(secret);
    expect(
      (
        await world.api.request('POST', `${BASE}/admins`, {
          ...base.asAdmin,
          body: { userId: reader.user.id, role: 'audit_admin', grantableAdminRoles: [], grantableProfileIds: [] },
        })
      ).status,
    ).toBe(201);
    const audit = auditApi(testDb().db, TR_NOW.toISOString(), { authorize: undefined });
    const entries = await audit.dataChanges(reader.as, { objectType: 'TalentReview.Template', limit: '50' });
    const entry = entries.items.find((e) => e.objectId === t.id)!;
    expect(entry).toBeDefined();
    const auditText = JSON.stringify(await audit.dataChange(reader.as, entry.id));
    for (const secret of [a.id, b.id, '甲分', '乙分', '@{tr-field:']) expect(auditText).not.toContain(secret);

    const noItems = await templateOperator(world, { orgId: w.orgId, references: 'seeAll', hidden: ['resultRules'] });
    const projected = (await (await noItems.request('GET', `/templates/${t.id}`)).json()) as Record<string, unknown>;
    expect(projected).not.toHaveProperty('resultRules');
    expect(projected.hints).toMatchObject({ order: [], cycles: [], blocked: [], others: expect.any(Object) });
    const before = await w.template(templateBody(w.orgId));
    expect(
      (
        await noItems.request('PATCH', `/templates/${before.id}`, {
          ifMatch: before.revision,
          body: { resultRules: [] },
        })
      ).status,
    ).toBe(403);
    const writer = await templateOperator(world, { orgId: w.orgId, references: 'seeAll' });
    const body = {
      resultRules: [{ targetFieldId: a.id, formula: '盘点对象.乙分', formulaBindings: [b.id], priority: 0 }],
    };
    const replay = () =>
      writer.request('PATCH', `/templates/${before.id}`, {
        ifMatch: before.revision,
        body,
        idempotencyKey: 'b6a2-revoke-replay',
      });
    const saved = await replay();
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toMatchObject({ revision: 2, resultRules: body.resultRules });
    const adminBefore = await setup.request('GET', `${TR_BASE}/templates/${before.id}`, base.asAdmin);
    const savedView = await adminBefore.json();
    await writer.setSeeAll('field', false);
    expect((await replay()).status).toBe(404);
    const after = await setup.request('GET', `${TR_BASE}/templates/${before.id}`, base.asAdmin);
    expect(await after.json()).toEqual(savedView);
  });

  it('DEC-387：裸词 / 多选 / 越界优先级 / 重复目标均拒绝，新输入须目录版本，旧模块被移除须同时改公式', async () => {
    const w = await templateWorld(testDb().db, 'b6a2-invalid');
    const field = await w.field({ kind: 'number', name: '分数' });
    const rule = await w.scoreRule();
    const t = await w.template(templateBody(w.orgId, { modules: [indicatorModule(rule.id, { name: '业绩' })] }));
    const item = { targetFieldId: field.id, formula: '模块.业绩.得分', priority: 0 };
    for (const [status, body] of [
      [400, { resultRules: [{ ...item, formula: '分数 + 1' }] }],
      [400, { resultRules: [{ ...item, priority: -1 }] }],
      [400, { resultRules: [{ ...item, priority: 1000001 }] }],
      [400, { resultRules: [item, item] }],
      [409, { resultRules: [{ ...item, formula: '盘点对象.分数' }] }],
    ] as const) {
      expect((await w.patch(t, body)).status).toBe(status);
      expect((await w.read(t.id)).body).toEqual(t);
    }
    const saved = await w.patch(t, { resultRules: [item] });
    expect(saved.status).toBe(200);
    const next = (await saved.json()) as TemplateView;
    expect((await w.patch(next, { modules: [indicatorModule(rule.id, { name: '改名' })] })).status).toBe(400);
    expect((await w.read(t.id)).body).toEqual(next);
  });
  it('AC-TR-15：未提交结构沿用快照；停用已有表单 / 公式引用可保留，新模板不可引用', async () => {
    const w = await templateWorld(testDb().db, 'b6a2-disabled');
    const { flow } = await w.threeStepFlow();
    const source = await w.field({ name: '原来源', kind: 'number' });
    const target = await w.field({ kind: 'number' });
    const form = await w.created<{ id: string }>(
      '/forms',
      formBody([{ fieldId: source.id, access: 'edit', required: true }]),
    );
    const structures = {
      stepForms: [{ nodeKey: 'self', purpose: 'info', formId: form.id }],
      resultRules: [
        { targetFieldId: target.id, formula: '盘点对象.原来源', formulaBindings: [source.id], priority: 0 },
      ],
    };
    const t = await w.template(templateBody(w.orgId, { flowId: flow.id, ...structures }));
    expect(
      (
        await w.trRequest('PATCH', `/forms/${form.id}`, {
          ifMatch: 1,
          body: { fields: [], enabled: false },
        })
      ).status,
    ).toBe(200);
    for (const id of [source.id, target.id]) {
      expect((await w.trRequest('PATCH', `/fields/${id}`, { ifMatch: 1, body: { enabled: false } })).status).toBe(200);
    }
    const inherited = await w.patch(t, { permissions: [] });
    expect(inherited.status, await inherited.clone().text()).toBe(200);
    const next = (await inherited.json()) as TemplateView;
    expect(next.stepForms).toEqual(t.stepForms);
    expect(next.resultRules).toEqual(t.resultRules);
    const retained = await w.patch(next, { resultRules: structures.resultRules });
    expect(retained.status, await retained.clone().text()).toBe(200);
    const current = (await retained.json()) as TemplateView;
    const fresh = await w.template(templateBody(w.orgId, { flowId: flow.id }));
    for (const body of [{ stepForms: structures.stepForms }, { resultRules: structures.resultRules }]) {
      expect((await w.patch(fresh, body)).status).toBe(400);
      expect((await w.read(fresh.id)).body).toEqual(fresh);
    }
    const cleared = await w.patch(current, { resultRules: [], stepForms: [] });
    expect(cleared.status).toBe(200);
    expect((await w.trRequest('DELETE', `/fields/${source.id}`, { ifMatch: 2 })).status).toBe(409);
    expect((await w.read(t.id, '?version=1')).body.stepForms).toEqual(t.stepForms);
  });

  it('AC-TR-04：多选来源 / 不允许目标、错误绑定与旧目录版本均拒绝，版本与台账结果不变', async () => {
    const w = await templateWorld(testDb().db, 'b6a2-negative');
    const source = await w.field({ name: '多选来源', kind: 'multi_option', options: [{ label: '甲', value: 'a' }] });
    const target = await w.field({ kind: 'number' });
    const t = await w.template(templateBody(w.orgId));
    for (const [status, body] of [
      [
        400,
        {
          resultRules: [
            { targetFieldId: target.id, formula: '盘点对象.多选来源', formulaBindings: [source.id], priority: 0 },
          ],
        },
      ],
      [400, { resultRules: [{ targetFieldId: source.id, formula: '1', priority: 0 }] }],
      [400, { resultRules: [{ targetFieldId: target.id, formula: '1', formulaBindings: [source.id], priority: 0 }] }],
      [
        409,
        {
          fieldCatalogVersion: 0,
          resultRules: [{ targetFieldId: target.id, formula: '盘点对象.多选来源', priority: 0 }],
        },
      ],
    ] as const) {
      const response = await w.patch(t, body);
      expect(response.status, await response.clone().text()).toBe(status);
      expect((await w.read(t.id)).body).toEqual(t);
    }
  });
});
