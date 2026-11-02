/**
 * F-323a（DEC-706）列车 I2 m2：任职存人员类别字典 ID 后，调动审批详情的“人员类别”按当前字典名称显示。
 * 字段裁剪之后给当前值与原值附 employmentTypeName（改名取当前名、停用仍取名）；提交与编辑仍用 ID。只用合成人员。
 */
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld } from './AC-APV-support.js';

const database = useTestDb();
const TYPES = '/api/tenant/employment/employment-types';

async function employmentType(w: ApprovalWorld, name: string) {
  return w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', TYPES, {
      ifMatch: 0,
      body: { name, displayOrder: 1, effectiveDate: '2018-01-01' },
    }),
    201,
  );
}

it('AC-EMP-F323-approval-name：审批人看调动详情，人员类别当前值与原值都显示字典名称，不显示 UUID', async () => {
  const w = await approvalWorld(database().db, 'f323-apv-name');
  const s = await transferScene(w);
  const before = await employmentType(w, '合成类别原');
  const after = await employmentType(w, '合成类别新');
  const subject = await w.person('类别调动员工', s.from, {
    directManagerId: s.manager.employeeId,
    employmentType: before.id,
  });
  await w.publishedProcess({
    nodes: [
      {
        key: 'out_head',
        approver: { type: 'department', value: 'latest_record_department_head' },
        formFields: ['departmentId', 'employmentType', 'effectiveDate'],
      },
    ],
  });
  const draft = await w.application(subject.employeeId, { departmentId: s.to, employmentType: after.id });
  const submitted = await w.submit(draft);
  const shown = await w.detail(submitted.id, s.outHead.userId);
  // 编辑 / 提交仍用 ID；名称是并列的展示字段
  expect(shown.form.values).toMatchObject({ employmentType: after.id, employmentTypeName: '合成类别新' });
  expect(shown.form.originals).toMatchObject({ employmentType: before.id, employmentTypeName: '合成类别原' });

  // 改名取当前名称；停用的字典项照常取名
  const renamed = await w.request(w.hr.id, 'PUT', `${TYPES}/${after.id}`, {
    ifMatch: after.revision,
    body: { name: '合成类别新（改）' },
  });
  expect(renamed.status, await renamed.clone().text()).toBe(200);
  const disabled = await w.request(w.hr.id, 'POST', `${TYPES}/${before.id}/disable`, { ifMatch: before.revision });
  expect(disabled.status, await disabled.clone().text()).toBe(200);
  const again = await w.detail(submitted.id, s.outHead.userId);
  expect(again.form.values).toMatchObject({ employmentType: after.id, employmentTypeName: '合成类别新（改）' });
  expect(again.form.originals).toMatchObject({ employmentType: before.id, employmentTypeName: '合成类别原' });

  // 关闭“显示原信息”后原值整体不下发，名称也不随之泄露
  const off = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/approval.show_original_values', {
    ifMatch: 0,
    body: { value: false },
  });
  expect(off.status, await off.clone().text()).toBe(200);
  const hidden = await w.detail(submitted.id, s.outHead.userId);
  expect(hidden.form.values).toMatchObject({ employmentTypeName: '合成类别新（改）' });
  expect(hidden.form.originals).toBeUndefined();
});

it('AC-EMP-F323-approval-name：节点表单未含人员类别时，详情不下发类别 ID，也不下发名称', async () => {
  const w = await approvalWorld(database().db, 'f323-apv-hidden');
  const s = await transferScene(w);
  const before = await employmentType(w, '合成类别隐甲');
  const after = await employmentType(w, '合成类别隐乙');
  const subject = await w.person('类别隐藏员工', s.from, {
    directManagerId: s.manager.employeeId,
    employmentType: before.id,
  });
  await w.publishedProcess({
    nodes: [
      {
        key: 'out_head',
        approver: { type: 'department', value: 'latest_record_department_head' },
        formFields: ['departmentId', 'effectiveDate'],
      },
    ],
  });
  const draft = await w.application(subject.employeeId, { departmentId: s.to, employmentType: after.id });
  const shown = await w.detail((await w.submit(draft)).id, s.outHead.userId);
  expect(shown.form.values).toMatchObject({ departmentId: s.to });
  expect(shown.form.values).not.toHaveProperty('employmentType');
  expect(shown.form.values).not.toHaveProperty('employmentTypeName');
  expect(JSON.stringify(shown.form)).not.toContain('合成类别隐');
});
