import { resolve } from 'node:path';
import { expect } from 'vitest';
import { act, h, permission, uiHarness } from './f474-ui.js';
const { SubsetCreate, SubsetRowCommands } = await import(resolve('apps/web/src/personnel/EditCommands.tsx'));
// 独立列举本批已排序、已有接口支持的普通字段；附件和系统字段继续排除。
export const subsetFormFields: Record<string, string[]> = {
  education: [
    'school',
    'graduationType',
    'startDate',
    'endDate',
    'educationLevel',
    'isHighestEducation',
    'degree',
    'isHighestDegree',
    'trainingMode',
    'learningForm',
    'majorCategory',
    'major',
    'schoolType',
    'majorDescription',
  ],
  jobhistory: ['company', 'post', 'startDate', 'endDate', 'referenceName'],
  'project-experience': [
    'name',
    'post',
    'startDate',
    'endDate',
    'responsibilities',
    'headcount',
    'results',
    'developmentTools',
    'description',
  ],
  training: ['name', 'institution', 'category', 'score', 'startDate', 'endDate', 'hours', 'passed'],
  family: ['name', 'birthday', 'gender', 'relationship', 'mobilePhone', 'company', 'phone'],
  certificate: ['type', 'name', 'number', 'issuer', 'obtainedDate', 'startDate', 'endDate'],
  'language-ability': ['language', 'isNative', 'proficiency', 'writing', 'reading', 'speaking'],
  skill: ['name', 'proficiency', 'category', 'months'],
  awards: ['name', 'awardDate', 'description'],
  'professional-technical-post': [
    'qualificationName',
    'level',
    'assessmentDate',
    'qualificationRoute',
    'assessmentInstitution',
    'appointedPost',
    'startDate',
    'endDate',
    'company',
    'appointedLevel',
    'isHighestLevel',
  ],
};
export async function openSubset(
  ui: ReturnType<typeof uiHarness>,
  kind: string,
  fields = subsetFormFields[kind],
  edit = false,
  editableFields = fields,
  rowValues: Record<string, unknown> = {},
) {
  await ui.render(
    h(edit ? SubsetRowCommands : SubsetCreate, {
      employeeId: '30000000-0000-4000-8000-000000000474',
      kind,
      permission: { ...permission(fields), editableFields },
      saved() {},
      ...(edit
        ? { row: { id: '40000000-0000-4000-8000-000000000474', revision: 1, isThisCompany: false, ...rowValues } }
        : {}),
    }),
    '/',
    fields,
  );
  const button = ui.host.querySelector('button');
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}
