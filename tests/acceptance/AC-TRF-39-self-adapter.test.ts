import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransferFormModel } from '../../apps/web/src/transfer/types.js';
import type { OwnPreview, Profile } from '../../apps/web/src/employee-self-service/types.js';
const path = new URL('../../apps/web/src/employee-self-service/transfer-adapter.ts', import.meta.url).pathname;
const profile: Profile = {
  employee: { id: 'self', name: '本人', code: '001', revision: 1 },
  today: '2026-10-19',
  timezone: 'Asia/Shanghai',
  record: null,
};
const preview: OwnPreview = {
  employeeRevision: 3,
  allowDirectTransfer: false,
  fields: { departmentId: 'new-department', directManagerId: 'auto-manager', postId: 'post' },
  customFields: {},
  before: { fields: { postId: 'old-post' }, customFields: {} },
  reasons: [],
  beforeLabels: { postId: '原职务' },
  valueLabels: { postId: '现职务', directManagerId: '自动负责人' },
  form: {
    id: 'form',
    name: '调动',
    isStandard: true,
    customFields: [],
    excludedAutofillFields: [],
    fieldModes: {
      'preset:departmentId': 'editable',
      'preset:directManagerId': 'editable',
      'preset:postId': 'readonly',
    },
  },
};
async function adapter() {
  const module = (await import(path)) as {
    employeeTransferAdapter: (p: Profile) => {
      initialModel: TransferFormModel;
      loadPreview: (
        tenant: string,
        model: TransferFormModel,
        signal: AbortSignal,
      ) => Promise<Partial<TransferFormModel>>;
      queryReferences: (
        tenant: string,
        model: TransferFormModel,
        code: string,
        name: string,
        page: number,
      ) => Promise<{ items: { id: string; name: string }[] }>;
      save: (tenant: string, model: TransferFormModel, action: string, command: string) => Promise<unknown>;
    };
  };
  return module.employeeTransferAdapter(profile);
}
afterEach(() => vi.unstubAllGlobals());
describe('AC-TRF-39 本人共享 Hook 数据适配', () => {
  it('预览只取可编辑候选，姓名保留可信原值与自动带出，不查询职务字典', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: unknown) =>
          new Response(JSON.stringify(String(url).endsWith('/preview') ? preview : { items: [] })),
      ),
    );
    const port = await adapter();
    const result = await port.loadPreview('tenant', port.initialModel, new AbortController().signal);
    expect(result.beforeReferences?.postId).toEqual([{ id: 'old-post', name: '原职务' }]);
    expect(result.references?.postId).toEqual([{ id: 'post', name: '现职务' }]);
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.includes('/references/'))).toHaveLength(2);
    expect(urls.every((url) => url.startsWith('/api/tenant/self-service/transfer/'))).toBe(true);
    expect(urls.some((url) => url.includes('departmentId=new-department'))).toBe(true);
  });
  it('经理搜索只走本人接口并携带新部门，显示姓名与组织路径', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ items: [{ id: 'manager', name: '合成经理', orgPath: '总部/部门' }] })),
      ),
    );
    const port = await adapter();
    const result = await port.queryReferences(
      'tenant',
      { ...port.initialModel, preview },
      'directManagerId',
      '合成',
      2,
    );
    expect(result.items).toEqual([{ id: 'manager', name: '合成经理 · 总部/部门' }]);
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain('/self-service/transfer/references/directManagerId?');
    expect(String(url)).toContain('departmentId=new-department');
    expect(String(url)).toContain('page=2');
  });
  it('提交只发送客户端显式字段与 revision / 命令 ID，不回填只读原值', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'saved', status: 'in_review', revision: 2 }))),
    );
    const port = await adapter();
    await port.save(
      'tenant',
      { ...port.initialModel, preview, fields: { departmentId: 'new-department' } },
      'submit',
      'command',
    );
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/tenant/self-service/transfer');
    expect(JSON.parse(String(init?.body))).toEqual({
      effectiveDate: profile.today,
      fields: { departmentId: 'new-department' },
      customFields: {},
    });
    expect(new Headers(init?.headers).get('if-match')).toBe('3');
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('command');
  });
});
