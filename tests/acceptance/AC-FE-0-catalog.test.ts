/// <reference lib="dom" />
import {
  MODULE_OBJECTS as M,
  PERSONNEL_OBJECTS,
  PERSONNEL_REQUEST_OBJECT,
  APPROVAL_OBJECTS,
  TALENT_OBJECTS,
  QUALIFICATION_OBJECTS,
  QUALIFICATION_PAGES,
  EVALUATION_OBJECTS,
  EVALUATION_FLOW_OBJECTS,
  TALENT_REVIEW_OBJECTS,
  SUCCESSION_OBJECTS,
  IDP_OBJECTS,
  survey360,
} from '@italent/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB_OBJECT_CODES } from '../../apps/api/src/modules/permission/module-route-access.js';
import { createApiClient } from '../../apps/web/src/foundation/client.js';
import { APP_ROUTES } from '../../apps/web/src/foundation/routes.js';
import { menuObjects } from '../../apps/web/src/foundation/permission-snapshot.js';
import { loadSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';

// 对照 API 的 catalog/access 登记及 JOB_OBJECT_CODES；自助、经理、企业设置继续用专用入口判定。
const expected = {
  org: [M.organization.code, M.establishment.code],
  job: Object.values(JOB_OBJECT_CODES),
  staff: [M.employee, M.contract, M.contractType, M.contractCompany, ...PERSONNEL_OBJECTS]
    .map((object) => object.code)
    .filter((code) => code !== PERSONNEL_REQUEST_OBJECT),
  transfer: [M.employmentRecord.code],
  approval: APPROVAL_OBJECTS.map((object) => object.code),
  self: [PERSONNEL_REQUEST_OBJECT],
  manager: [],
  settings: [M.employmentSettings, M.employmentCustomField, M.contractSettings, M.contractRules].map(
    (object) => object.code,
  ),
  talent: Object.values(TALENT_OBJECTS).map((object) => object.code),
  qualification: [...Object.values(QUALIFICATION_OBJECTS), QUALIFICATION_PAGES].map((object) => object.code),
  evaluation: [...Object.values(EVALUATION_OBJECTS), ...Object.values(EVALUATION_FLOW_OBJECTS)].map(
    (object) => object.code,
  ),
  survey360: Object.values(survey360.SURVEY360_OBJECTS).map((object) => object.code),
  'talent-review': Object.values(TALENT_REVIEW_OBJECTS).map((object) => object.code),
  succession: Object.values(SUCCESSION_OBJECTS).map((object) => object.code),
  idp: Object.values(IDP_OBJECTS).map((object) => object.code),
};
afterEach(() => vi.unstubAllGlobals());

describe('AC-FE-0-07 公共对象目录与后端逐应用核对', () => {
  it.each(APP_ROUTES)('$id 完整登记实际对象，不依赖编码前缀', (route) => {
    expect([...menuObjects(route)].sort()).toEqual([...expected[route.id]].sort());
  });
  const singleGrants = APP_ROUTES.filter((route) => route.objectCode).flatMap((route) =>
    expected[route.id].map((code) => ({ app: route.id, code })),
  );
  it.each(singleGrants)('只授予 $code 时仍可进入 $app', async ({ app, code }) => {
    vi.stubGlobal('fetch', async (path: string) => {
      if (path.endsWith('/me/snapshot'))
        return Response.json({
          session: { tenantId: 'tenant', userId: 'user' },
          apps: [{ app, visible: true, entryObjects: [code] }],
          scope: [],
          adminMenus: [],
        });
      if (path.endsWith(`/objects/${code}`))
        return Response.json({
          objectCode: code,
          dataOperations: { create: false, update: false, delete: false },
          viewableFields: ['name'],
          editableFields: [],
          buttons: [],
        });
      if (path.endsWith('/admin-menus')) return Response.json({ items: [] });
      return Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
    });
    const api = createApiClient(() => ({ tenantId: 'tenant', identityKey: 'user' }));
    const { snapshot: result } = await loadSnapshot(api, new AbortController().signal);
    expect(result.menus.map((menu) => menu.key)).toEqual([
      app,
      ...(code === M.contract.code ? ['contracts'] : []),
      ...(app === 'transfer' && code === M.employmentRecord.code ? ['entries', 'exit-settings', 'offers'] : []),
      // F-154：带教信息独立入口。
      ...(app === 'idp' && code === 'IDP.TutorShip' ? ['tutorship-information'] : []),
    ]);
    expect(result.objects[code]?.objectCode).toBe(code);
    expect(result.scope.items).toEqual([]);
  });
});
