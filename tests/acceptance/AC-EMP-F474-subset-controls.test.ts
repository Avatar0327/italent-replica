/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { uiHarness } from './support/f474-ui.js';
import { openSubset, subsetFormFields } from './support/f474-subset-forms.js';
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
const cases = Object.entries(subsetFormFields).flatMap(([kind, fields]) =>
  [false, true].map((edit) => ({ kind, fields, edit })),
);
it.each(cases)('AC-EMP F474 $kind 编辑=$edit 实际控件齐全且顺序一致', async ({ kind, fields, edit }) => {
  await openSubset(ui, kind, [...fields, 'attachmentId', 'educationCertificate', 'isThisCompany'], edit);
  const labels = Array.from(document.querySelectorAll<HTMLLabelElement>('[role="dialog"] .ant-form-item-label label'));
  expect(labels.map((label) => label.htmlFor)).toEqual(fields);
  for (const label of labels) {
    expect(
      label.closest('.ant-form-item')?.querySelector('.ant-form-item-control input, .ant-form-item-control button'),
      label.htmlFor,
    ).not.toBeNull();
    expect(label.textContent).toMatch(/[\u4e00-\u9fff]/);
  }
});
it.each([
  ['education', 'graduationType', '毕业类型'],
  ['jobhistory', 'referenceName', '证明人'],
  ['education', 'isHighestDegree', '是否最高学位'],
  ['education', 'trainingMode', '培养方式'],
  ['education', 'learningForm', '学习形式'],
  ['education', 'majorCategory', '专业类别'],
  ['education', 'schoolType', '毕业学校类型'],
  ['education', 'majorDescription', '专业描述'],
  ['project-experience', 'headcount', '项目人数'],
  ['project-experience', 'developmentTools', '开发工具'],
  ['training', 'passed', '及格状态'],
  ['language-ability', 'isNative', '是否母语'],
  ['professional-technical-post', 'assessmentDate', '评定日期'],
  ['professional-technical-post', 'qualificationRoute', '获取资格途径'],
  ['professional-technical-post', 'assessmentInstitution', '资格评审单位'],
])('AC-EMP F474 %s 的 %s 使用呈现标签 %s', async (kind, field, label) => {
  await openSubset(ui, kind);
  expect(document.querySelector(`label[for="${field}"]`)?.textContent).toBe(label);
});
