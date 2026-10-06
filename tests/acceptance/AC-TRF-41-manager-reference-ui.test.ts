import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadReferences, queryReferences, managerReferencePath } from '../../apps/web/src/transfer/api.js';
import type { TransferFormModel } from '../../apps/web/src/transfer/types.js';

const model: TransferFormModel = {
  initiator: 'manager',
  employeeId: 'employee',
  effectiveDate: '2026-11-01',
  transferTypeCode: 'in_department',
  reasonCode: '',
  employees: [],
  departments: [],
  catalog: { types: [], reasons: [] },
  fields: { departmentId: 'target', postId: 'post' },
  customFields: {},
  preview: {
    employeeRevision: 2,
    allowDirectTransfer: false,
    fields: {},
    customFields: {},
    before: { fields: { postId: 'old-post' }, customFields: {} },
    form: {
      id: 'form',
      name: '调动',
      isStandard: true,
      customFields: [],
      excludedAutofillFields: [],
      fieldModes: {
        'preset:departmentId': 'editable',
        'preset:postId': 'editable',
        'preset:levelId': 'editable',
        'preset:sequenceId': 'readonly',
      },
    },
  },
};
afterEach(() => vi.unstubAllGlobals());
describe('AC-TRF-41 共享表单的经理参照路由', () => {
  it('初次加载、搜索、分页均走字段受控接口，不回退到全租户字典详情', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ items: [{ id: 'post', name: '职务' }] }))),
    );
    const loaded = await loadReferences('tenant', model.preview!, model, new AbortController().signal);
    expect(loaded.unavailable).toBe(false);
    expect(loaded.references.postId).toEqual([{ id: 'post', name: '职务' }]);
    for (const field of ['departmentId', 'postId', 'levelId', 'sequenceId', 'directManagerId'])
      await queryReferences('tenant', model, field, '合成', 2);
    for (const [url] of vi.mocked(fetch).mock.calls) {
      const path = String(url);
      expect(path).toContain('/transfers/manager/references/');
      expect(path).toContain('employeeId=employee');
      expect(path).toContain('formId=form');
      expect(path).not.toContain('/job/');
    }
    const department = managerReferencePath(model, model.preview!, 'departmentId');
    expect(department).not.toContain('departmentId=');
    expect(department).not.toContain('postId=');
    const post = managerReferencePath(model, model.preview!, 'postId');
    expect(post).toContain('departmentId=target');
    expect(post).not.toContain('postId=');
    expect(managerReferencePath(model, model.preview!, 'levelId')).toContain('postId=post');
  });
});
