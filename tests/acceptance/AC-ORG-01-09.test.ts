import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgSession, ORG_TODAY, type Organization } from './AC-ORG-support.js';

const testDb = useTestDb();

describe('AC-ORG-01~09 组织创建与多维视图', () => {
  it('AC-ORG-01 两个并发新建表单预占不同编码，成功创建后编码不会再次分配', async () => {
    const session = await orgSession(testDb().db, 'org01');
    const [first, second] = await Promise.all([session.reserve(), session.reserve()]);
    expect(first.id).not.toBe(second.id);
    expect(first.code).not.toBe(second.code);
    expect(first.revision).toBe(1);
    const created = await session.create('并发预占部门', { reservationId: first.id });
    expect(created.code).toBe(first.code);
    const next = await session.reserve();
    expect([first.code, second.code]).not.toContain(next.code);
  });

  it('AC-ORG-02 取消表单释放预占编码，下次新建可以复用', async () => {
    const session = await orgSession(testDb().db, 'org02');
    const first = await session.reserve();
    const released = await session.request('DELETE', `/code-reservations/${first.id}`, {
      ifMatch: first.revision,
    });
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ status: 'released' });
    const next = await session.reserve();
    expect(next.code).toBe(first.code);
    expect(next.id).not.toBe(first.id);
  });

  it('AC-ORG-03 仅名称与行政上级即可创建，大类默认部门且内部 ID 与编码分离', async () => {
    const session = await orgSession(testDb().db, 'org03');
    const created = await session.create('最少字段部门');
    expect(created).toMatchObject({
      name: '最少字段部门',
      tenantId: session.tenant.id,
      broadType: '部门',
      enabled: true,
      revision: 1,
      startDate: ORG_TODAY,
      parents: { admin: { parentId: session.tenant.id } },
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.code).toBeTruthy();
    expect(created.code).not.toBe(created.id);
    expect(await session.list('最少字段部门')).toHaveLength(1);
  });

  it('AC-ORG-04 二次确认校验返回服务器标志及字段提示，校验本身不写组织', async () => {
    const session = await orgSession(testDb().db, 'org04');
    const validation = await session.request('POST', '/validate', {
      body: { name: '校验后才创建', parents: { admin: { parentId: session.tenant.id } } },
    });
    expect(validation.status).toBe(200);
    expect(await validation.json()).toMatchObject({
      isBeyondEstablishment: false,
      strictControl: false,
      requiresConfirmation: false,
      fields: {},
    });
    expect(await session.list('校验后才创建')).toEqual([]);
    await session.create('校验后才创建');
    expect(await session.list('校验后才创建')).toHaveLength(1);
  });

  it('AC-ORG-04 必填字段校验失败后直接提交也不写入', async () => {
    const session = await orgSession(testDb().db, 'org04invalid');
    const response = await session.request('POST', '/organizations', {
      ifMatch: 0,
      body: { name: '缺行政上级' },
    });
    expect(response.status).toBe(400);
    expect(await session.list('缺行政上级')).toEqual([]);
  });

  it('AC-ORG-06 名称搜索只精确匹配，部分字符搜不到', async () => {
    const session = await orgSession(testDb().db, 'org06');
    const created = await session.create('精确名称研发中心');
    expect(await session.list('研发')).toEqual([]);
    expect((await session.list('精确名称研发中心')).map((item) => item.id)).toEqual([created.id]);
  });

  it('AC-ORG-07 行政、业务、产品（财务别名）及预留维度分别保存上级和顺序号', async () => {
    const session = await orgSession(testDb().db, 'org07');
    const settings = await session.request('PUT', '/settings', {
      ifMatch: 0,
      body: { enabledDimensions: ['business', 'product', 'reserve4', 'reserve5'], fullNameStartLevel: 0 },
    });
    expect(settings.status).toBe(200);
    const admin = await session.create('行政归属');
    const business = await session.create('业务归属');
    const product = await session.create('财务归属');
    const reserve4 = await session.create('预留四归属');
    const reserve5 = await session.create('预留五归属');
    const parents = {
      admin: { parentId: admin.id, sequence: 8 },
      business: { parentId: business.id, sequence: 3 },
      product: { parentId: product.id, sequence: 5 },
      reserve4: { parentId: reserve4.id, sequence: 2 },
      reserve5: { parentId: reserve5.id, sequence: 9 },
    };
    const created = await session.create('多维度部门', { parents });
    expect(created.parents).toEqual(parents);
    expect((await session.list('多维度部门'))[0]?.parents).toEqual(parents);
  });

  // R1-T03 的车道不含前端目录；这里只验收供菜单消费的后端视图元数据。
  it('AC-ORG-08 四个视图固定顺序，成本中心为独立对象而非组织维度', async () => {
    const session = await orgSession(testDb().db, 'org08');
    const response = await session.request('GET', '/views');
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as {
      items: { label: string; resource: string; dimension: string | null }[];
    };
    expect(items.map((item) => item.label)).toEqual(['组织', '业务组织', '利润中心', '成本中心']);
    expect(items.map((item) => item.dimension)).toEqual(['admin', 'business', 'product', null]);
    expect(items[3]).toMatchObject({ label: '成本中心', resource: 'cost-center', dimension: null });
  });

  it('AC-ORG-09 新建默认失效日期为 9999-12-31', async () => {
    const session = await orgSession(testDb().db, 'org09');
    const created: Organization = await session.create('无限失效期部门');
    expect(created.stopDate).toBe('9999-12-31');
    expect((await session.list('无限失效期部门'))[0]?.stopDate).toBe('9999-12-31');
  });
});
