/**
 * AC-TR-form-preset · R3-T04 PR-B3 预置四个盘点内容表单（设计 §2.7；DEC-361）：员工自评 / 上级评价 / 管理员查看 /
 * 批量盘点可编辑，经种子补装登记表安装（开通与平台回补共用 installMissingSeeds）：只补缺失编码、不覆盖租户定制、写审计；
 * 预置表单不能删除（可停用）。预置字段先于表单安装，表单按字段编码取 id。
 */
import { talentReviewFields, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { auditApi } from './AC-AUD-support.js';
import { TR_NOW } from './AC-TR-config-support.js';
import { FORMS, formFlowWorld, type FormView, reasonOf } from './AC-TR-form-flow-support.js';

const testDb = useTestDb();

async function installed(label: string) {
  const w = await formFlowWorld(testDb().db, label);
  const write = { tenantId: w.as.tenant, actorUserId: null, now: TR_NOW, commandId: `${label}-seed` };
  const install = () =>
    withTenant(testDb().db, w.as.tenant, (tx) => installMissingSeeds(tx, write, { modules: ['talent-review'] }));
  const report = await install();
  const fields = await withTenant(testDb().db, w.as.tenant, (tx) =>
    tx.select({ id: talentReviewFields.id, code: talentReviewFields.code }).from(talentReviewFields),
  );
  const codeOf = (id: string) => fields.find((row) => row.id === id)!.code;
  const forms = (await w.list<FormView>(FORMS)).items;
  const byCode = (code: string) => forms.find((form) => form.code === code)!;
  const accessOf = (code: string) => {
    const form = byCode(code);
    return new Map(form.fields.map((field) => [codeOf(field.fieldId), field.access]));
  };
  return { w, install, report, forms, byCode, accessOf, fieldCount: fields.length };
}

describe('预置四个盘点内容表单（DEC-361；设计 §2.7）', () => {
  it('补装登记四个预置表单，覆盖全部预置字段（未列出的为 hidden），类型 / 名称 / preset 正确', async () => {
    const { report, forms, byCode, fieldCount } = await installed('trf-preset');
    expect(report.find((item) => item.key === 'preset-forms')).toMatchObject({
      module: 'talent-review',
      installed: ['self_info', 'supervisor_info', 'admin_view', 'batch_calibrate'],
      existing: 0,
    });
    expect(forms.map((form) => [form.code, form.name, form.kind, form.preset])).toEqual([
      ['self_info', '员工自评盘点信息表单', 'info', true],
      ['supervisor_info', '上级评价盘点信息表单', 'info', true],
      ['admin_view', '管理员查看盘点信息表单', 'info', true],
      ['batch_calibrate', '批量盘点可编辑信息', 'calibrate_edit', true],
    ]);
    for (const form of forms) expect(form.fields).toHaveLength(fieldCount);
    expect(byCode('self_info').fields.every((field) => !field.required)).toBe(true);
  });

  it('字段三档：自评 = 评价分组可编辑；上级评价 = 校准前字段 + 标签 + 评价；管理员 = 全部只读；批量 = 校准后 + 标签 + 校准', async () => {
    const { accessOf } = await installed('trf-preset-access');
    const editable = (code: string) => [...accessOf(code)].filter(([, access]) => access === 'edit').map(([c]) => c);
    expect(editable('self_info')).toContain('strengths');
    expect(editable('self_info')).not.toContain('tags');
    expect(editable('supervisor_info')).toEqual(expect.arrayContaining(['achievement_before', 'tags', 'strengths']));
    expect(editable('supervisor_info')).not.toContain('achievement_after');
    expect([...accessOf('admin_view').values()].every((access) => access === 'view')).toBe(true);
    expect(editable('batch_calibrate')).toEqual(
      expect.arrayContaining(['achievement_after', 'tags', 'calibration_reason', 'remark']),
    );
    expect(accessOf('batch_calibrate').get('strengths')).toBe('hidden');
    expect(accessOf('self_info').get('achievement_capability_cell_after')).toBe('hidden');
  });

  it('重复补装无副作用；租户改名 / 停用后回补不覆盖；补装写数据变更日志（系统写入）', async () => {
    const { w, install, byCode } = await installed('trf-preset-again');
    const renamed = await w.request('PATCH', `${FORMS}/${byCode('self_info').id}`, {
      ifMatch: 1,
      body: { name: '改过的名称', enabled: false },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const before = (await w.list<FormView>(FORMS)).items;
    const report = await install();
    expect(report.find((item) => item.key === 'preset-forms')).toMatchObject({ installed: [], existing: 4 });
    expect((await w.list<FormView>(FORMS)).items).toEqual(before);
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const { items } = await audit.dataChanges(w.as, { objectType: 'TalentReview.Form', limit: '50' });
    expect(items.filter((entry) => entry.operation === 'create')).toHaveLength(4);
  });

  it('预置表单不能删除（409 FORM_PRESET），可以停用', async () => {
    const { w, byCode } = await installed('trf-preset-delete');
    const first = byCode('admin_view');
    const response = await w.request('DELETE', `${FORMS}/${first.id}`, { ifMatch: 1 });
    expect([response.status, await reasonOf(response)]).toEqual([409, 'FORM_PRESET']);
    expect((await w.read<FormView>(FORMS, first.id)).body).toEqual(first);
    const off = await w.request('PATCH', `${FORMS}/${first.id}`, { ifMatch: 1, body: { enabled: false } });
    expect(off.status).toBe(200);
  });

  it('预置字段被预置表单引用：字段拒删 409 FIELD_IN_USE', async () => {
    const { w } = await installed('trf-preset-field');
    const fields = (await w.list<{ id: string; preset: boolean }>('/fields?pageSize=100')).items;
    const response = await w.request('DELETE', `/fields/${fields[0]!.id}`, { ifMatch: 1 });
    expect(response.status).toBe(409);
  });
});
