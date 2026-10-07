/// <reference lib="dom" />
// @vitest-environment happy-dom
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import type { TransferFormModel } from '../../apps/web/src/transfer/types.js';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const hookPath = resolve('apps/web/src/self-service/shared/useTransferForm.ts');
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
const model: TransferFormModel = {
  initiator: 'employee',
  employees: [],
  departments: [],
  employeeId: 'employee',
  effectiveDate: '2026-10-05',
  transferTypeCode: 'cross_department',
  reasonCode: '',
  fields: { departmentId: 'target' },
  customFields: {},
  catalog: { types: [], reasons: [] },
  preview: {
    form: { id: 'form', name: '调动', isStandard: true, customFields: [], excludedAutofillFields: [], fieldModes: {} },
    employeeRevision: 2,
    before: null,
    fields: {},
    customFields: {},
    allowDirectTransfer: false,
  },
};
it.each([
  ['CONFIRMATION_REQUIRED', true, 2],
  ['CONFIRMATION_REQUIRED', false, 1],
  ['ESTABLISHMENT_EXCEEDED', true, 1],
  ['REVISION_CONFLICT', true, 1],
] as const)('AC-EST-26 %s，确认=%s：仅明确确认才重提', async (reason, accepted, calls) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const prompt = vi.fn(() => accepted);
  vi.stubGlobal('confirm', prompt);
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body)) as { confirmed?: boolean };
    return body.confirmed
      ? Response.json({ id: 'saved', revision: 1, status: 'in_review' })
      : Response.json(
          {
            error: {
              code: reason === 'REVISION_CONFLICT' ? reason : 'CONFLICT',
              message: '合成提示',
              details: { reason },
            },
          },
          { status: 409 },
        );
  });
  vi.stubGlobal('fetch', fetcher);
  const { useTransferForm } = await import(hookPath);
  const { saveTransfer } = await import('../../apps/web/src/transfer/api.js');
  const adapter = {
    initialModel: model,
    save: saveTransfer,
    loadPreview: async () => ({ preview: model.preview }),
    queryReferences: async () => ({ items: [] }),
  };
  function Form() {
    const value = useTransferForm('tenant', 'employee', adapter);
    return createElement(
      'button',
      { onClick: () => value.submit('submit'), disabled: value.busy },
      value.saved ? '已提交' : '提交',
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(Form));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  await act(async () => {
    container.querySelector('button')!.click();
  });
  expect(fetcher).toHaveBeenCalledTimes(calls);
  expect(prompt).toHaveBeenCalledTimes(reason === 'CONFIRMATION_REQUIRED' ? 1 : 0);
  if (calls === 2) {
    const first = fetcher.mock.calls[0]![1]!;
    const second = fetcher.mock.calls[1]![1]!;
    expect(JSON.parse(String(second.body))).toEqual({ ...JSON.parse(String(first.body)), confirmed: true });
    expect(new Headers(second.headers).get('if-match')).toBe(new Headers(first.headers).get('if-match'));
    expect(new Headers(second.headers).get('idempotency-key')).not.toBe(
      new Headers(first.headers).get('idempotency-key'),
    );
    expect(container.textContent).toBe('已提交');
  } else expect(container.textContent).toBe('提交');
});
