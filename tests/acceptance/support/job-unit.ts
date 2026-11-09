/**
 * 职级新建需要创建人在职务体系应用（TenantBase）里有授权管理单元（DEC-339①，零单元 403 NO_MANAGEMENT_UNIT）。
 * 其他模块的验收夹具只想要一个职级，用这里给创建人补一个管理单元（组织 + 管理单元 + 用户 × 应用授权）。
 */
import { expect } from 'vitest';
import { uniqueSuffix } from './unique.js';

/** 以授权人身份发请求（各夹具世界的请求封装不同，由调用方包一层）。 */
export type GrantCall = (method: string, path: string, init: { ifMatch: number; body: unknown }) => Promise<Response>;
const PERMISSION = '/api/tenant/permission';

/** 给 `userId` 补一个职务体系授权管理单元并返回它（即职级的资源集合）；`call` 以有授权权限的人发请求。 */
export async function grantJobUnit(call: GrantCall, userId: string, tenantId: string): Promise<string> {
  const post = async (path: string, body: unknown) => {
    const response = await call('POST', path, { ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  const orgId = await post('/api/tenant/org/organizations', {
    name: `夹具资源集合${uniqueSuffix()}`,
    establishedOn: '2000-01-01',
    parents: { admin: { parentId: tenantId } },
  });
  const mouId = await post(`${PERMISSION}/mous`, {
    code: `fx-${uniqueSuffix()}`,
    name: '夹具管理单元',
    orgRanges: [{ orgId, includeDescendants: true }],
  });
  const scope = await call('PUT', `${PERMISSION}/scopes/${userId}/TenantBase`, {
    ifMatch: 0,
    body: { kind: 'mou', mouId },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
  return orgId;
}
