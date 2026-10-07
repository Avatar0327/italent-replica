import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { TransferFormModel } from '../../apps/web/src/transfer/types.js';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react') as { createElement: (component: unknown, props: unknown) => unknown };
const { renderToStaticMarkup } = webRequire('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string;
};
const path = new URL('../../apps/web/src/self-service/shared/TransferForm.tsx', import.meta.url).pathname;
const model: TransferFormModel = {
  initiator: 'employee',
  employees: [],
  departments: [],
  employeeId: 'self',
  effectiveDate: '2026-10-19',
  transferTypeCode: 'in_department',
  reasonCode: '',
  fields: {},
  customFields: {},
  catalog: { types: [], reasons: [] },
  preview: {
    before: null,
    employeeRevision: 1,
    allowDirectTransfer: false,
    allowedActions: { application: true, directList: false, directRow: false },
    fields: {},
    customFields: {},
    basicFieldModes: { effectiveDate: 'hidden', reasonCode: 'hidden' },
    form: { id: 'form', name: '调动', isStandard: true, customFields: [], excludedAutofillFields: [], fieldModes: {} },
  },
};
describe('AC-TRF-55 本人跨部门调动提示', () => {
  it.each(['employee', 'manager', 'hr'])('跨部门仅本人提示 HR 补充：%s', async (initiator) => {
    const { TransferForm } = (await import(path)) as { TransferForm: unknown };
    const next = {
      ...model,
      initiator,
      preview: {
        ...model.preview!,
        positionCleared: true,
        fields: { departmentId: 'target' },
        before: { fields: { departmentId: 'source' }, customFields: {} },
      },
    };
    const html = renderToStaticMarkup(createElement(TransferForm, { model: next, submitOnly: true }));
    if (initiator === 'employee') expect(html).toContain('职位由 HR 补充');
    else expect(html).not.toContain('职位由 HR 补充');
  });
  it('同部门或部门无查看权不显示提示，不新增职位选择器', async () => {
    const { TransferForm } = (await import(path)) as { TransferForm: unknown };
    for (const fields of [{ departmentId: 'source' }, {}]) {
      const next = {
        ...model,
        preview: {
          ...model.preview!,
          positionCleared: !('departmentId' in fields),
          fields,
          before: { fields: { departmentId: 'source' }, customFields: {} },
        },
      };
      const html = renderToStaticMarkup(createElement(TransferForm, { model: next, submitOnly: true }));
      expect(html).not.toContain('职位由 HR 补充');
      expect(html).not.toContain('name="positionId"');
    }
  });
  it.each([false, undefined])('跨部门但职位没有被清空时不提示：%s', async (positionCleared) => {
    const { TransferForm } = (await import(path)) as { TransferForm: unknown };
    const next = {
      ...model,
      preview: {
        ...model.preview!,
        positionCleared,
        fields: { departmentId: 'target' },
        before: { fields: { departmentId: 'source' }, customFields: {} },
      },
    };
    const html = renderToStaticMarkup(createElement(TransferForm, { model: next, submitOnly: true }));
    expect(html).not.toContain('职位由 HR 补充');
  });
});
