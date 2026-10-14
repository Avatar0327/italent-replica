/// <reference lib="dom" />
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, newCommand, pageQuery, type PageResult } from '../../apps/web/src/foundation/client.js';
import { canButton, fieldAccess } from '../../apps/web/src/foundation/permission-model.js';
import { loadSnapshot, fetchObjectPermission } from '../../apps/web/src/foundation/permission-snapshot.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { jobSession, type JobRecord } from './AC-JOB-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');
afterEach(() => vi.unstubAllGlobals());

function client(server: ReturnType<typeof tenantApi>, user: string, tenantId: string) {
  // 仅补测试身份签名；租户、原始 If-Match、幂等键和 JSON 均直接来自公共客户端。
  vi.stubGlobal('fetch', (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      requestHeaders[name] = value;
    });
    return server.request(init.method ?? 'GET', path, {
      user,
      headers: requestHeaders,
      idempotencyKey: headers.get('idempotency-key'),
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
  });
  return createApiClient(() => ({ tenantId, identityKey: user }));
}

describe('AC-FE-0-11 真实后端回执接入公共层', () => {
  it('只有职位权限：后端列表有数据，导航保留职务体系，并使用真实按钮与字段编码', async () => {
    const world = await seedPermissionWorld(testDb().db);
    const setup = tenantApi(world.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    async function create(path: string, body: object) {
      const response = await setup.request('POST', `/api/tenant/${path}`, { ...world.asAdmin, ifMatch: 0, body });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as { id: string };
    }
    const org = await create('org/organizations', {
      name: '职位权限测试组织',
      parents: { admin: { parentId: world.tenant.id } },
    });
    const post = await create('job/posts', { code: 'FE0_POST', name: '合成职务', startDate: '2026-10-01' });
    const position = await create('job/positions', {
      code: 'FE0_POSITION',
      name: '仅职位可见',
      orgId: org.id,
      postId: post.id,
      startDate: '2026-10-01',
    });
    const profile = await createProfile(world, 'position-only');
    const permission = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: MODULE_OBJECTS.jobPosition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: false })),
        buttons: [{ buttonCode: 'validate', level: 'detail' }],
      },
      MODULE_OBJECTS.jobPosition.code,
    );
    expect(permission.status, await permission.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    const member = await addMember(world, 'position-only');
    expect((await grant(world, member.id, profile.id)).status).toBe(201);
    const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${member.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: org.id, includeDescendants: false }] },
    });
    expect(scope.status).toBe(200);
    const api = client(world.api, member.id, world.tenant.id);
    const data = await api.request<PageResult<JobRecord>>('/api/tenant/job/positions?asOf=2026-10-01');
    expect(data.items).toMatchObject([{ id: position.id, name: '仅职位可见' }]);
    await expect(api.request('/api/tenant/permission/me/objects/TenantBase.JobPost')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    const { snapshot } = await loadSnapshot(api, new AbortController().signal);
    expect(snapshot.menus.map((menu) => menu.key)).toContain('job');
    expect(snapshot.objects[MODULE_OBJECTS.jobPosition.code]?.summary).toBe(true);
    const actual = await fetchObjectPermission(api, MODULE_OBJECTS.jobPosition.code, new AbortController().signal);
    expect(canButton(actual, 'validate', 'detail')).toBe(true);
    expect(canButton(actual, 'validate', 'list')).toBe(false);
    expect(fieldAccess(actual, 'name')).toEqual({ visible: true, editable: false });
  });

  it('真实职务分页没有 total/hasMore：满页可继续，空页可返回，不伪造总数', async () => {
    const session = await jobSession(testDb().db, 'fe0-pagination');
    const first = await session.create('sequences', '分页甲');
    const second = await session.create('sequences', '分页乙');
    const api = client(tenantApi(testDb().db), session.user.id, session.tenant.id);
    const { ListPage } = await import(resolve('apps/web/src/foundation/templates.tsx'));
    const window = new Window();
    try {
      const ids: string[] = [];
      for (const page of [1, 2, 3]) {
        const request = { page, pageSize: 1 };
        const data = await api.request<PageResult<JobRecord>>(`/api/tenant/job/sequences?${pageQuery(request)}`);
        expect(data).toMatchObject({ page, pageSize: 1, hasDataPermission: true });
        expect(data).not.toHaveProperty('total');
        expect(data).not.toHaveProperty('hasMore');
        ids.push(...data.items.map((item) => item.id));
        window.document.body.innerHTML = renderToStaticMarkup(
          h(ListPage, {
            title: '职务序列',
            data,
            rowKey: 'id',
            columns: [{ title: '名称', dataIndex: 'name' }],
            page: request,
            onPageChange() {},
          }),
        );
        const buttons = Array.from(window.document.querySelectorAll('button'));
        expect(buttons.find((button) => button.textContent === '下一页')?.disabled).toBe(page === 3);
        expect(buttons.find((button) => button.textContent === '上一页')?.disabled).toBe(page === 1);
        expect(window.document.querySelector('.page-total')).toBeNull();
      }
      expect(ids.sort()).toEqual([first.id, second.id].sort());
    } finally {
      await window.happyDOM.close();
    }
  });

  it('真实命令接收原始头：同键重放、异内容冲突、revision 冲突与字段错误', async () => {
    const session = await jobSession(testDb().db, 'fe0-command');
    const api = client(tenantApi(testDb().db), session.user.id, session.tenant.id);
    const command = newCommand({ code: 'FE0_SEQUENCE', name: '命令测试序列', startDate: '2026-10-01' }, 0);
    const path = '/api/tenant/job/sequences';
    const first = await api.request<JobRecord>(path, { method: 'POST', command });
    expect(await api.request(path, { method: 'POST', command })).toEqual(first);
    await expect(
      api.request(path, {
        method: 'POST',
        command: { ...command, body: { ...command.body, name: '不同内容' } },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT', kind: 'conflict' });
    await expect(
      api.request(`${path}/${first.id}`, {
        method: 'PATCH',
        command: newCommand({ name: '冲突修改', effectiveDate: '2026-10-01' }, 0),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT', kind: 'refresh' });
    await expect(
      api.request(path, {
        method: 'POST',
        command: newCommand({ name: '', code: 'FE0_INVALID' }, 0),
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      kind: 'fields',
      fieldErrors: expect.arrayContaining([expect.objectContaining({ name: ['name'] })]),
    });
    expect(await api.request(`${path}/${first.id}`)).toMatchObject({
      name: command.body.name,
      revision: first.revision,
    });
  });
});
