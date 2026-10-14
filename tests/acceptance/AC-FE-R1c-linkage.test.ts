import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { emptyLinkage } from '../../apps/web/src/transfer/linkage-api.js';
import type { TransferFormModel } from '../../apps/web/src/transfer/types.js';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');

async function render(viewableFields: string[], editableFields: string[]) {
  const { LinkageFields } = await import(resolve('apps/web/src/transfer/LinkageFields.tsx'));
  const model: TransferFormModel = {
    initiator: 'hr',
    employees: [],
    departments: [],
    employeeId: 'synthetic-employee',
    effectiveDate: '2026-11-01',
    transferTypeCode: 'transfer',
    reasonCode: '',
    fields: {},
    customFields: {},
    catalog: { types: [], reasons: [], viewableFields, editableFields },
    linkage: emptyLinkage,
    preview: {
      employeeRevision: 1,
      allowDirectTransfer: false,
      fields: {},
      customFields: {},
      before: null,
      form: {
        id: 'form',
        name: '合成表单',
        isStandard: true,
        excludedAutofillFields: [],
        fieldModes: {},
        customFields: [],
      },
    },
  };
  return renderToStaticMarkup(createElement(LinkageFields, { model })) as string;
}

it('AC-FE-R1c-09 服务端未授予联动字段查看权时不渲染输入', async () => {
  const html = await render([], []);
  for (const name of ['changeContract', 'adjustSalary', 'onTrialMonths', 'handoverPersonId', 'dutyReceiverId'])
    expect(html).not.toContain(`name="${name}"`);
});

it('AC-FE-R1c-09 仅有查看权的联动字段不可编辑，可编辑字段独立开放', async () => {
  const html = await render(['adjustSalary', 'onTrialMonths'], ['onTrialMonths']);
  expect(html).toMatch(/<fieldset[^>]*disabled=""[^>]*>[\s\S]*?name="adjustSalary"/);
  expect(html).toContain('name="onTrialMonths"');
  expect(html).not.toContain('name="changeContract"');
});
