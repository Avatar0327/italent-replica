import { describe, expect, it, vi } from 'vitest';
import { projectActions, projectInput, filterProjects } from '../../apps/web/src/talent-review/model.js';
import { loadCollection, saveRecord } from '../../apps/web/src/talent-review/api.js';
import type { ApiClient } from '../../apps/web/src/foundation/client.js';

const base = { id: 'p', revision: 3, accessLevel: 'manage' as const };
describe('AC-FE-R3c 项目配置与权限边界', () => {
  it.each([
    ['new', ['update', 'start', 'end']],
    ['in_progress', ['update', 'end']],
    ['ended', ['restart']],
  ] as const)('状态 %s 的操作只取后端按钮与允许状态的交集', (status, expected) => {
    expect(projectActions({ ...base, status }, () => true)).toEqual(expected);
    expect(projectActions({ ...base, status }, () => false)).toEqual([]);
    expect(projectActions({ ...base, status, accessLevel: 'readonly' }, () => true)).toEqual([]);
  });
  it('状态不可见或 revision 缺失时不显示写操作', () => {
    expect(projectActions(base, () => true)).toEqual([]);
    expect(projectActions({ ...base, status: 'new', revision: undefined }, () => true)).toEqual([]);
  });
  it('表单只提交可编辑字段，日期保持租户业务日期，清空引用显式为 null', () => {
    const input = {
      name: '  年度盘点  ',
      ownerOrgId: 'A0000000-0000-4000-8000-000000000001',
      periodStartDate: '2026-10-01',
      periodEndDate: '2026-10-31',
      categoryId: undefined,
      status: 'ended',
    };
    expect(projectInput(input, Object.keys(input))).toEqual({
      name: '年度盘点',
      ownerOrgId: 'a0000000-0000-4000-8000-000000000001',
      periodStartDate: '2026-10-01',
      periodEndDate: '2026-10-31',
      categoryId: null,
    });
    expect(projectInput(input, ['name'])).toEqual({ name: '年度盘点' });
  });
  it('结束日期早于开始日期不能发送；单字段修改也与已加载日期校验', () => {
    expect(() =>
      projectInput({ periodEndDate: '2026-09-30' }, ['periodEndDate'], { periodStartDate: '2026-10-01' }),
    ).toThrow();
  });
  it('进行中视图包含新建和进行中，隐藏状态不被错误归类；结束视图独立', () => {
    const items = ['new', 'in_progress', 'ended', undefined].map((status, i) => ({ ...base, id: String(i), status }));
    expect(filterProjects(items, 'active', '').map((x) => x.id)).toEqual(['0', '1']);
    expect(filterProjects(items, 'ended', '').map((x) => x.id)).toEqual(['2']);
    expect(filterProjects(items, 'all', '').length).toBe(4);
  });
});
describe('AC-FE-R3c 已有接口契约', () => {
  it('跨后端分页读完后才能应用视图，不把第一页当全量', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ items: Array.from({ length: 200 }, (_, i) => ({ id: String(i) })) })
      .mockResolvedValueOnce({ items: [{ id: 'last' }], hasDataPermission: true });
    const result = await loadCollection({ request } as ApiClient, 'projects', new AbortController().signal);
    expect(result.items).toHaveLength(201);
    expect(request.mock.calls[1]?.[0]).toContain('page=2');
  });
  it('读取失败不回退为演示项目；超出加载上限不返回不完整统计', async () => {
    const denied = { request: vi.fn().mockRejectedValue(new Error('FORBIDDEN')) };
    await expect(loadCollection(denied as ApiClient, 'projects', new AbortController().signal)).rejects.toThrow(
      'FORBIDDEN',
    );
    const full = { request: vi.fn().mockResolvedValue({ items: Array.from({ length: 200 }, () => ({ id: 'x' })) }) };
    await expect(loadCollection(full as ApiClient, 'projects', new AbortController().signal)).rejects.toThrow();
  });
  it('编辑传原 revision 和新命令 ID，仅发送一次；冲突不自动重试', async () => {
    const request = vi.fn().mockRejectedValue(new Error('REVISION_CONFLICT'));
    await expect(saveRecord({ request } as ApiClient, 'projects', { name: '修改' }, base)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual([
      '/api/tenant/talent-review/projects/p',
      {
        method: 'PATCH',
        command: { id: expect.any(String), revision: 3, body: { name: '修改' } },
      },
    ]);
  });
});

it('AC-FE-R3c-04 筛选按完整授权列表匹配年度、所属组织与业务日期，隐藏字段不参与筛选', async () => {
  const { matchesFilters } = await import('../../apps/web/src/talent-review/model.js');
  const row = { id: 'p', name: '年度项目', year: 2026, ownerOrgId: 'org-a', periodStartDate: '2026-10-01' };
  const filters = { name: '年度', year: 2026, ownerOrgId: 'org-a', startFrom: '2026-10-01', startTo: '2026-10-31' };
  expect(matchesFilters(row, filters, () => true)).toBe(true);
  expect(matchesFilters(row, { ...filters, year: 2027 }, () => true)).toBe(false);
  expect(matchesFilters(row, { ...filters, startFrom: '2026-10-02' }, () => true)).toBe(false);
  expect(matchesFilters({ id: 'hidden' }, filters, () => false)).toBe(true);
  expect(matchesFilters({ id: 'hidden' }, filters, () => true)).toBe(false);
});

it('AC-FE-R3c-05 权限回调的第二参数必须保持 detail，不能被数组下标覆盖', () => {
  const can = (_button: string, level: unknown = 'detail') => level === 'detail';
  expect(projectActions({ ...base, status: 'new' }, can)).toEqual(['update', 'start', 'end']);
});
