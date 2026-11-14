// @vitest-environment happy-dom
// F-474-6b 第 2 轮返工（P2-1）：组织页读自定义字段定义走业务侧只读目录，不再读需要配置管理能力的配置接口。
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../foundation/Session.js';
import { useOrgCustomFields } from './custom-fields.js';
import { pageAccess } from './page-model.js';

const fieldId = '30000000-0000-4000-8000-0000000000d1';
const hiddenId = '30000000-0000-4000-8000-0000000000d2';
let host: HTMLDivElement;
let root: Root;
let paths: string[];
let seen: ReturnType<typeof useOrgCustomFields> | undefined;

const access = pageAccess({
  objectCode: 'TenantBase.Organization',
  dataOperations: { create: true, update: true },
  viewableFields: ['name', `custom:${fieldId}`],
  editableFields: [`custom:${fieldId}`],
  buttons: [],
});
function Probe() {
  seen = useOrgCustomFields(access);
  return null;
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  paths = [];
  seen = undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = String(input);
    paths.push(path);
    if (path === '/api/tenant/org/custom-field-definitions')
      return Response.json({
        items: [
          { id: fieldId, name: '合成成本中心', valueType: 'text', options: [], editable: true },
          { id: hiddenId, name: '合成不该出现', valueType: 'text', options: [], editable: false },
        ],
      });
    return Response.json({ error: { code: 'FORBIDDEN', message: '无权限' } }, { status: 403 });
  });
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('AC-F474-6b-R2-07 组织页定义目录请求路径', () => {
  it('读业务侧 /api/tenant/org/custom-field-definitions，不请求配置接口；只留有 custom:<id> 查看权的定义', async () => {
    await act(async () =>
      root.render(
        h(SessionProvider, {
          session: {
            tenantId: 'synthetic-tenant',
            identityKey: 'synthetic-identity',
            tenantName: '合成租户',
            timezone: 'Asia/Shanghai',
            displayName: '合成组织管理员',
            source: 'server',
          },
          children: h(Probe),
        }),
      ),
    );
    await settle();
    expect(paths).toEqual(['/api/tenant/org/custom-field-definitions']);
    expect(seen?.keys).toEqual([`custom:${fieldId}`]);
    expect(seen?.labels).toEqual({ [`custom:${fieldId}`]: '合成成本中心' });
  });
});
