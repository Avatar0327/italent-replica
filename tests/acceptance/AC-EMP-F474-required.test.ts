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
const requiredFields: Record<string, string[]> = {
  education: ['school', 'graduationType', 'startDate', 'endDate'],
  jobhistory: ['company', 'referenceName'],
  'project-experience': ['name'],
  training: ['name'],
  family: ['name'],
  certificate: ['name'],
  'language-ability': ['language'],
  skill: ['name'],
  awards: ['name'],
  'professional-technical-post': ['qualificationName', 'level', 'assessmentDate', 'qualificationRoute'],
};
const verifiedEdit = ['education', 'jobhistory', 'training', 'language-ability'];
const cases = Object.entries(requiredFields).flatMap(([kind, required]) =>
  (verifiedEdit.includes(kind) ? [false, true] : [false]).map((edit) => ({ kind, required, edit })),
);
const labels = () =>
  Array.from(document.querySelectorAll<HTMLLabelElement>('[role="dialog"] .ant-form-item-label label'));
it.each(cases)('AC-EMP F474 $kind 编辑=$edit 逐字段标记并覆盖可选字段', async ({ kind, required, edit }) => {
  await openSubset(ui, kind, undefined, edit);
  for (const label of labels()) {
    expect
      .soft(label.classList.contains('ant-form-item-required'), label.htmlFor)
      .toBe(required.includes(label.htmlFor));
  }
  expect(
    labels()
      .filter((label) => label.classList.contains('ant-form-item-required'))
      .map((label) => label.htmlFor),
  ).toEqual(required);
});
it.each(cases.flatMap((item) => item.required.map((hidden) => ({ ...item, hidden }))))(
  'AC-EMP F474 $kind 编辑=$edit 隐藏 $hidden 后不显示标签和红星',
  async ({ kind, required, edit, hidden }) => {
    await openSubset(
      ui,
      kind,
      subsetFormFields[kind].filter((field) => field !== hidden),
      edit,
    );
    expect(labels().map((label) => label.htmlFor)).not.toContain(hidden);
    expect(
      labels()
        .filter((label) => label.classList.contains('ant-form-item-required'))
        .map((label) => label.htmlFor),
    ).toEqual(required.filter((field) => field !== hidden));
  },
);
it('AC-EMP F474 同步工作履历的公司只读仍有标记，权限隐藏后整项消失', async () => {
  await openSubset(ui, 'jobhistory', undefined, true, ['referenceName'], { isThisCompany: true, company: '合成单位' });
  const company = labels().find((label) => label.textContent === '公司');
  expect(company?.classList.contains('ant-form-item-required')).toBe(true);
  expect(company?.closest('.ant-form-item')?.querySelector('input')).toBeNull();
  expect(
    labels()
      .filter((label) => label.classList.contains('ant-form-item-required'))
      .map((label) => label.textContent),
  ).toEqual(['公司', '证明人']);
});
it.each(Object.keys(requiredFields).filter((kind) => !verifiedEdit.includes(kind)))(
  'AC-EMP F474 %s 编辑红星未取证，保持既有呈现',
  async (kind) => {
    await openSubset(ui, kind, undefined, true);
    expect(document.querySelectorAll('[role="dialog"] .ant-form-item-required')).toHaveLength(0);
  },
);
