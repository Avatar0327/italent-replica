import { describe, expect, it, vi } from 'vitest';
import { settingsAccess, userInput, scopeInput, listPath } from '../../apps/web/src/settings/model.js';
import { settingsApi } from '../../apps/web/src/settings/api.js';
import { ApiError } from '../../apps/web/src/foundation/client.js';

describe('AC-FE-R1d2 DEC-456 企业设置', () => {
  it('本地校验失败能显示输入错误，不误报结果未知', () => {
    for (const validate of [() => userInput({}), () => scopeInput({ kind: 'mou', mouId: 'invalid' })]) {
      expect(validate).toThrow(ApiError);
      try {
        validate();
      } catch (error) {
        expect(error).toMatchObject({ kind: 'fields', code: 'VALIDATION_ERROR' });
      }
    }
  });
  it('AC-PRM-01 菜单缺失默认拒绝，只读菜单不能写', () => {
    expect(settingsAccess([], 'users.all')).toEqual({ visible: false, editable: false });
    expect(settingsAccess([{ code: 'users.all', editable: false }], 'users.all')).toEqual({
      visible: true,
      editable: false,
    });
  });
  it('外部用户必填、邮箱与长度校验，内部员工不能手工创建', () => {
    expect(() => userInput({ displayName: ' ', email: 'x', businessIdentity: '' })).toThrow();
    expect(() =>
      userInput({ displayName: '甲', email: 'a@example.com', businessIdentity: '顾问', userType: 'internal' }),
    ).toThrow();
    expect(userInput({ displayName: ' 甲 ', email: 'a@example.com', businessIdentity: '顾问' })).toEqual({
      displayName: '甲',
      email: 'a@example.com',
      businessIdentity: '顾问',
      userType: 'external',
    });
  });
  it('AC-PRM-03 空范围不扩权，切换类型不会提交旧的管理单元', () => {
    expect(scopeInput({ kind: 'default', mouId: 'old' })).toEqual({ kind: 'default' });
    expect(scopeInput({ kind: 'org_range', orgRanges: [] })).toEqual({ kind: 'org_range', orgRanges: [] });
    expect(() => scopeInput({ kind: 'mou' })).toThrow();
  });
  it('组织范围使用现有契约维度 product，不能提交臆造的 finance', () => {
    const row = { orgId: '10000000-0000-4000-8000-000000000001', dimension: 'product', includeDescendants: false };
    expect(scopeInput({ kind: 'org_range', orgRanges: [row] })).toEqual({ kind: 'org_range', orgRanges: [row] });
    expect(() => scopeInput({ kind: 'org_range', orgRanges: [{ ...row, dimension: 'finance' }] })).toThrow();
  });
  it('用户列表使用后端 offset，不把一页当作总数', () => {
    expect(listPath('users.internal', { page: 2, pageSize: 15 })).toBe(
      '/api/tenant/permission/users?type=internal&limit=15&offset=15',
    );
  });
  it('AC-PRM-15 撤销只调用授权命令，不写数据范围；携带 revision 与命令 ID', async () => {
    const request = vi.fn().mockResolvedValue({});
    await settingsApi({ request }).revoke({ id: 'grant-1', revision: 7 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      '/api/tenant/permission/grants/grant-1/revoke',
      expect.objectContaining({
        method: 'POST',
        command: expect.objectContaining({ revision: 7, id: expect.any(String) }),
      }),
    );
  });
});
