/**
 * AC-TR-form · R3-T04 PR-B3 盘点内容表单（设计 §2.2 forms / form_fields；DEC-306①；TR-R9 配置 CRUD）：
 * 表单 = 一组盘点字段逐字段三档（edit / view / hidden）+ required；字段整组随表单提交；名称与编码租户唯一；
 * required 只能设在 edit 字段上；新引用已停用字段 400（已持有的保留）；字段被表单引用时拒删；被模板引用拒删的守卫由 B6 登记；
 * 修改写 revision 与字段级审计，删除保留快照。
 */
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerConfigReferenceGuard } from '../../apps/api/src/modules/talent-review/config-kit.js';
import { auditApi } from './AC-AUD-support.js';
import { TR_NOW } from './AC-TR-config-support.js';
import { FORMS, formBody, formFlowWorld, type FormView, reasonOf } from './AC-TR-form-flow-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const referenced = new Set<string>();
registerConfigReferenceGuard('form', async (_tx, _tenantId, id) => (referenced.has(id) ? 'TEST_TEMPLATE' : null));

describe('盘点内容表单 CRUD（DEC-306①）', () => {
  it('新建：字段三档与 required 原样保存，字段顺序按提交顺序；详情与列表一致，ETag = revision', async () => {
    const w = await formFlowWorld(testDb().db, 'trf-create');
    const [a, b, c] = [await w.field(), await w.field(), await w.field()];
    const body = formBody(
      [
        { fieldId: a.id, access: 'edit', required: true },
        { fieldId: b.id, access: 'view' },
        { fieldId: c.id, access: 'hidden' },
      ],
      { kind: 'calibrate_edit', sortNo: 5 },
    );
    const response = await w.post(FORMS, body);
    expect(response.status, await response.clone().text()).toBe(201);
    const created = (await response.json()) as FormView;
    expect(created).toMatchObject({
      code: body.code,
      name: body.name,
      kind: 'calibrate_edit',
      preset: false,
      enabled: true,
      revision: 1,
      sortNo: 5,
      fields: [
        { fieldId: a.id, access: 'edit', required: true },
        { fieldId: b.id, access: 'view', required: false },
        { fieldId: c.id, access: 'hidden', required: false },
      ],
    });
    const read = await w.read<FormView>(FORMS, created.id);
    expect(read.body).toEqual(created);
    expect((await w.list<FormView>(FORMS)).items).toEqual([created]);
  });

  it('结构校验：缺必填 / 未知键 / 非法类型 / 非法三档 400；字段重复 400 FORM_FIELD_DUPLICATE；required 配非 edit 400', async () => {
    const w = await formFlowWorld(testDb().db, 'trf-validate');
    const f = await w.field();
    const ok = formBody([{ fieldId: f.id }]);
    for (const bad of [
      { ...ok, extra: 1 },
      { ...ok, kind: 'other' },
      { ...ok, name: '' },
      { ...ok, fields: [{ fieldId: f.id, access: 'write' }] },
      { ...ok, fields: [{ fieldId: 'not-a-uuid', access: 'edit' }] },
    ]) {
      const response = await w.post(FORMS, bad);
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
    const duplicate = await w.post(FORMS, formBody([{ fieldId: f.id }, { fieldId: f.id, access: 'view' }]));
    expect([duplicate.status, await reasonOf(duplicate)]).toEqual([400, 'FORM_FIELD_DUPLICATE']);
    for (const access of ['view', 'hidden']) {
      const required = await w.post(FORMS, formBody([{ fieldId: f.id, access, required: true }]));
      expect([required.status, await reasonOf(required)]).toEqual([400, 'FORM_REQUIRED_NEEDS_EDIT']);
    }
    expect((await w.list<FormView>(FORMS)).items).toEqual([]);
  });

  it('引用不存在的字段 404；新引用已停用字段 400 FORM_FIELD_DISABLED，已持有的停用字段原样保留可改', async () => {
    const w = await formFlowWorld(testDb().db, 'trf-disabled');
    const missing = await w.post(FORMS, formBody([{ fieldId: '00000000-0000-4000-8000-000000000000' }]));
    expect(missing.status).toBe(404);
    const field = await w.field();
    const form = await w.createForm({}, [field.id]);
    const off = await w.request('PATCH', `/fields/${field.id}`, { ifMatch: 1, body: { enabled: false } });
    expect(off.status, await off.clone().text()).toBe(200);
    const fresh = await w.post(FORMS, formBody([{ fieldId: field.id }]));
    expect([fresh.status, await reasonOf(fresh)]).toEqual([400, 'FORM_FIELD_DISABLED']);
    const kept = await w.request('PATCH', `${FORMS}/${form.id}`, {
      ifMatch: 1,
      body: { fields: [{ fieldId: field.id, access: 'view' }] },
    });
    expect(kept.status, await kept.clone().text()).toBe(200);
  });

  it('修改：fields 整组替换、未提交的键保留；revision 不一致 409；名称 / 编码重复 409 FORM_DUPLICATE', async () => {
    const w = await formFlowWorld(testDb().db, 'trf-patch');
    const [a, b] = [await w.field(), await w.field()];
    const form = await w.createForm({ name: '甲' }, [a.id]);
    const other = await w.createForm({ name: '乙' }, [a.id]);
    const patched = await w.request('PATCH', `${FORMS}/${form.id}`, {
      ifMatch: 1,
      body: { fields: [{ fieldId: b.id, access: 'edit', required: true }] },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect(await patched.json()).toMatchObject({
      name: '甲',
      kind: 'info',
      revision: 2,
      fields: [{ fieldId: b.id, access: 'edit', required: true }],
    });
    const stale = await w.request('PATCH', `${FORMS}/${form.id}`, { ifMatch: 1, body: { name: '丙' } });
    expect([stale.status, await errorCode(stale)]).toEqual([409, 'REVISION_CONFLICT']);
    const rename = await w.request('PATCH', `${FORMS}/${form.id}`, { ifMatch: 2, body: { name: '乙' } });
    expect([rename.status, await reasonOf(rename)]).toEqual([409, 'FORM_DUPLICATE']);
    const code = await w.post(FORMS, formBody([{ fieldId: a.id }], { code: other.code }));
    expect([code.status, await reasonOf(code)]).toEqual([409, 'FORM_DUPLICATE']);
    const unchanged = await w.read<FormView>(FORMS, form.id);
    expect(unchanged.body.revision).toBe(2);
  });

  it('编码建后不可改：修改体带 code 一律 400', async () => {
    const w = await formFlowWorld(testDb().db, 'trf-code');
    const form = await w.createForm();
    const response = await w.request('PATCH', `${FORMS}/${form.id}`, { ifMatch: 1, body: { code: 'other' } });
    expect(response.status).toBe(400);
  });

  it('停用 / 启用；列表按 enabled 筛选', async () => {
    const w = await formFlowWorld(testDb().db, 'trf-enable');
    const form = await w.createForm();
    await w.createForm();
    const off = await w.request('PATCH', `${FORMS}/${form.id}`, { ifMatch: 1, body: { enabled: false } });
    expect(off.status).toBe(200);
    expect((await w.list<FormView>(FORMS, '?enabled=false')).items.map((item) => item.id)).toEqual([form.id]);
    expect((await w.list<FormView>(FORMS, '?enabled=true')).items).toHaveLength(1);
  });

  it('字段被表单引用时拒删 409 FIELD_IN_USE，移出表单后可删', async () => {
    const w = await formFlowWorld(testDb().db, 'trf-field-guard');
    const [a, b] = [await w.field(), await w.field()];
    const form = await w.createForm({}, [a.id]);
    const blocked = await w.request('DELETE', `/fields/${a.id}`, { ifMatch: 1 });
    expect([blocked.status, await reasonOf(blocked)]).toEqual([409, 'FIELD_IN_USE']);
    const moved = await w.request('PATCH', `${FORMS}/${form.id}`, {
      ifMatch: 1,
      body: { fields: [{ fieldId: b.id, access: 'view' }] },
    });
    expect(moved.status).toBe(200);
    expect((await w.request('DELETE', `/fields/${a.id}`, { ifMatch: 1 })).status).toBe(200);
  });

  it('删除：被引用（B6 登记的守卫）409 FORM_IN_USE 不落库；未引用删除成功并保留审计快照', async () => {
    const w = await formFlowWorld(testDb().db, 'trf-delete');
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const used = await w.createForm();
    referenced.add(used.id);
    const blocked = await w.request('DELETE', `${FORMS}/${used.id}`, { ifMatch: 1 });
    expect([blocked.status, await reasonOf(blocked)]).toEqual([409, 'FORM_IN_USE']);
    expect((await w.read<FormView>(FORMS, used.id)).body).toEqual(used);
    const free = await w.createForm();
    const removed = await w.request('DELETE', `${FORMS}/${free.id}`, { ifMatch: 1 });
    expect(removed.status).toBe(200);
    expect((await w.read<FormView>(FORMS, free.id)).status).toBe(404);
    const { items } = await audit.dataChanges(w.as, { objectType: TALENT_REVIEW_OBJECTS.form.code, limit: '50' });
    expect(items.map((entry) => entry.operation).sort()).toEqual(['create', 'create', 'delete']);
    const detail = await audit.dataChange(w.as, items.find((entry) => entry.operation === 'delete')!.id);
    expect(detail.snapshot).toMatchObject({ id: free.id, name: free.name });
  });

  it('同键同内容重放：台账命中、只写一次；同键异内容 409', async () => {
    const w = await formFlowWorld(testDb().db, 'trf-replay');
    const field = await w.field();
    const options = { ifMatch: 0, idempotencyKey: 'trf-replay-create', body: formBody([{ fieldId: field.id }]) };
    const first = await w.request('POST', FORMS, options);
    const again = await w.request('POST', FORMS, options);
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(await again.json()).toEqual(await first.json());
    expect((await w.list<FormView>(FORMS)).items).toHaveLength(1);
    const different = await w.request('POST', FORMS, { ...options, body: formBody([{ fieldId: field.id }]) });
    expect(different.status).toBe(409);
  });
});
