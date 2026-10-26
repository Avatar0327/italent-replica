import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { tenantApi } from './support/tenant-api.js';
import { relationWorld, orgVersion, dimensions, source, save, job, stopJob, resolved } from './AC-APV-F318c-support.js';

const database = useTestDb();
const path = '/api/tenant/approval/designer/source-candidates';
describe('AC-APV-F318c 保存及候选契约', () => {
  it('D4 空缺 / 停用引用允许保存；存在性、类型与跨租户保存 422 且运行不泄露', async () => {
    const w = await relationWorld(database().db, 'c-save');
    const foreign = await relationWorld(database().db, 'c-foreign');
    const post = await job(w, 'posts');
    const position = await job(w, 'positions', { orgId: w.staff, postId: post.id });
    await stopJob(w, 'position', position.id);
    for (const value of [
      source('department', w.root, ':descendants'),
      source('position', position.id),
      source('job', post.id),
      source('job', post.id, ':relative'),
    ]) {
      const response = await save(w, [value]);
      expect(response.status, await response.clone().text()).toBe(201);
      expect((await response.json()).latestVersion.nodes[0].approvers).toEqual([value]);
    }
    for (const value of [
      source('department', foreign.root),
      source('position', post.id),
      source('job', position.id),
      source('department', randomUUID()),
    ]) {
      expect((await save(w, [value])).status).toBe(422);
      expect(await resolved(w, value)).toEqual([]);
    }
  });
  it('D7 无业务日的类型拒存新值；D8 关闭维度拒存，已有来源运行为空；身份 c2 / F326 不开放', async () => {
    const w = await relationWorld(database().db, 'c-rejections');
    const unsupported = await save(w, [source('department', w.root)], 'idp_plan');
    expect(unsupported.status).toBe(422);
    expect((await unsupported.json()).error.message).toContain('业务日');
    for (const type of ['reserve4', 'reserve5', 'business_org', 'profit_center'] as const) {
      expect((await save(w, [source(type, w.root)])).status).toBe(422);
      await dimensions(w);
      expect((await save(w, [source(type, w.root)])).status).toBe(201);
      await dimensions(w, false);
      expect(await resolved(w, source(type, w.root))).toEqual([]);
    }
    for (const type of ['public_variable', 'application_variable', 'matrix', 'identity'] as const)
      expect((await save(w, [source(type, randomUUID())])).status).toBe(422);
    expect((await save(w, [source('identity', 'handover_hr_admin')])).status).toBe(422);
  });
  it('候选仅流程编辑者可读，最少字段、分页搜索、停用显式选择、跨租户不回显', async () => {
    const w = await relationWorld(database().db, 'c-candidates');
    const other = await relationWorld(database().db, 'c-candidates-other');
    await orgVersion(w, w.child, { enabled: false });
    const api = (allow: boolean) =>
      tenantApi(w.db, {
        authorize: (q) => allow && q.action === 'admin.process_matrix',
        clock: w.clock,
      });
    const get = (query: string, allow = true) => api(allow).request('GET', `${path}?${query}`, w.as(w.hr.id));
    const base = 'type=department&asOf=2026-10-01';
    expect((await get(base, false)).status).toBe(403);
    const response = await get(`${base}&ids=${w.root},${w.child},${other.root}`);
    expect(response.status).toBe(200);
    expect((await response.json()).items.map((item: { id: string }) => item.id)).toEqual([w.root]);
    const both = await (await get(`${base}&includeInactive=true&ids=${w.root},${w.child}`)).json();
    expect(both.items).toHaveLength(2);
    expect(both.items.find((item: { id: string }) => item.id === w.child).enabled).toBe(false);
    for (const item of both.items) expect(Object.keys(item).sort()).toEqual(['enabled', 'id', 'name', 'parentId']);
    const first = await (await get(`${base}&pageSize=1`)).json();
    const second = await (await get(`${base}&page=2&pageSize=1`)).json();
    expect(first.hasMore).toBe(true);
    expect(first.items[0].id).not.toBe(second.items[0].id);
    expect((await (await get(`${base}&keyword=${encodeURIComponent('合成中心')}`)).json()).items).toMatchObject([
      { id: w.root },
    ]);
    for (const q of [
      'type=department',
      `${base}&page=0`,
      `${base}&ids=invalid`,
      'type=department&asOf=2026-02-30',
      `${base}&includeInactive=garbage`,
    ])
      expect((await get(q)).status).toBe(400);
    expect((await get('type=reserve4&asOf=2026-10-01')).status).toBe(422);
    const post = await job(w, 'posts');
    const position = await job(w, 'positions', { orgId: w.staff, postId: post.id });
    await stopJob(w, 'position', position.id);
    const pos = 'type=position&asOf=2026-10-01';
    expect((await (await get(pos)).json()).items).toEqual([]);
    expect((await (await get(`${pos}&includeInactive=true`)).json()).items).toEqual([
      { id: position.id, name: '合成岗位', enabled: false, parentId: w.staff },
    ]);
    expect((await (await get('type=job&asOf=2026-10-01')).json()).items).toEqual([
      { id: post.id, name: '合成岗位', enabled: true, parentId: null },
    ]);
  });
});
