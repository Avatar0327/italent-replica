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
    employeeRevision: 1,
    allowDirectTransfer: false,
    allowedActions: { application: true, directList: false, directRow: false },
    fields: {},
    customFields: {},
    basicFieldModes: { effectiveDate: 'hidden', reasonCode: 'hidden' },
    form: { id: 'form', name: '调动', isStandard: true, customFields: [], excludedAutofillFields: [], fieldModes: {} },
  },
};
describe('AC-TRF-39 共享表单保留本人界面权限与只提交行为', () => {
  it('本人 submitOnly 不展示暂存和直接调动', async () => {
    const { TransferForm } = (await import(path)) as { TransferForm: unknown };
    const html = renderToStaticMarkup(createElement(TransferForm, { model, submitOnly: true }));
    expect(html).toContain('提交');
    expect(html).not.toContain('暂存');
    expect(html).not.toContain('直接调动');
  });
  it('预览基本字段隐藏不能被共享组件重新展示', async () => {
    const { TransferForm } = (await import(path)) as { TransferForm: unknown };
    const html = renderToStaticMarkup(createElement(TransferForm, { model, submitOnly: true }));
    expect(html).not.toContain('name="effectiveDate"');
    expect(html).not.toContain('name="reasonCode"');
  });
});
