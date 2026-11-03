import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
export const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { App } = requireWeb('antd');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { PermissionsProvider } = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
const { FormCommands } = await import(resolve('apps/web/src/foundation/forms/useCommandForm.tsx'));
export const session = {
  tenantId: '10000000-0000-4000-8000-000000000474',
  userId: '20000000-0000-4000-8000-000000000474',
  identityKey: 'synthetic',
  tenantName: '合成租户',
  displayName: '合成用户',
  timezone: 'Asia/Shanghai',
  source: 'server',
};
export const allFields = [
  'name',
  'code',
  'fullName',
  'location',
  'broadType',
  'establishedOn',
  'startDate',
  'stopDate',
  'enabled',
  'displayOrder',
  'remarks',
  'grade',
  'scoreHigh',
  'scoreLow',
  'layerId',
  'parentId',
  'levelTypeId',
  'level',
  'minGradeId',
  'maxGradeId',
  'sequenceId',
  'orgId',
  'postId',
  'parents',
  'minLevelId',
  'maxLevelId',
  'workDate',
  'gender',
  'entryDate',
  'employeeStatus',
  'firstEntryDate',
  'email',
  'mobilePhone',
  'lastWorkDate',
];
export const permission = (fields = allFields) => ({
  dataOperations: { read: true, create: true, update: true },
  viewableFields: fields,
  editableFields: fields,
  buttons: [
    { buttonCode: 'create', level: 'list' },
    { buttonCode: 'update', level: 'detail' },
  ],
});
export function uiHarness() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (node: unknown, path = '/', fields = allFields, responses: Record<string, unknown> = {}) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (raw: string) => {
        const url = new URL(raw, 'http://localhost');
        if (url.pathname.endsWith('/me/snapshot'))
          return Response.json({ session, apps: [], scope: [], adminMenus: [] });
        if (url.pathname.includes('/permission/me/objects/'))
          return Response.json({
            ...permission(fields),
            objectCode: decodeURIComponent(url.pathname.split('/').at(-1)!),
          });
        if (Object.hasOwn(responses, url.pathname)) return Response.json(responses[url.pathname]);
        return Response.json({ items: [], today: '2026-11-03', hasDataPermission: true });
      }),
    );
    await act(async () =>
      root.render(
        h(
          MemoryRouter,
          { initialEntries: [path] },
          h(SessionProvider, { session }, h(PermissionsProvider, {}, h(App, {}, h(FormCommands, {}, node)))),
        ),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  };
  return {
    host,
    render,
    async close() {
      await act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    },
    headers: () => Array.from(host.querySelectorAll('thead th')).map((cell) => cell.textContent?.trim()),
    widths: () => Array.from(host.querySelectorAll<HTMLTableColElement>('colgroup col')).map((col) => col.style.width),
  };
}
