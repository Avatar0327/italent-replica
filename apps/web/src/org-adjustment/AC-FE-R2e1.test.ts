import { MODULE_OBJECTS } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { menuNodes, type ServerSnapshot } from '../foundation/permission-snapshot.js';
import { appRoute, MENU_ROUTES, routePath } from '../foundation/routes.js';
import { acceptReceipt } from './commands.js';
import {
  collection,
  downloadName,
  listPath,
  previewRows,
  rangeLabel,
  statusOptions,
  type PreviewNode,
} from './model.js';

describe('AC-FE-R2e1 组织管理入口', () => {
  it('在组织管理下提供一体化组织调整审批入口', () => {
    const snapshot = {
      apps: [{ app: 'org', visible: true, entryObjects: [MODULE_OBJECTS.organization.code] }],
    } satisfies Pick<ServerSnapshot, 'apps'>;
    const menu = menuNodes(MENU_ROUTES, snapshot as ServerSnapshot).find(({ key }) => key === 'org');
    expect(menu?.children?.find(({ path }) => path === '/org/adjustments')?.label ?? '入口缺失').toBe(
      '一体化组织调整审批',
    );
  });
  it('列表和审批直达各沿用其应用的菜单门禁', () => {
    expect(appRoute('/org/adjustments')?.id).toBe('org');
    expect(appRoute('/approval/org-adjustment')?.id).toBe('approval');
    expect(routePath('/org/adjustments')?.ungated).toBe(false);
    expect(routePath('/approval/org-adjustment')?.ungated).toBe(false);
  });
});

describe('AC-FE-R2e1 前端契约', () => {
  it('把三项可见筛选映射到查询，字段权限撤销后不发送原值', () => {
    const filter = {
      approvalSubjectOrgId: 'ZZ_FER2E1_SUBJECT',
      effectiveFrom: '2026-11-01',
      effectiveTo: '2026-12-01',
      approvalStatus: 'draft',
    };
    const page = { page: 2, pageSize: 15 };
    expect(listPath(page, filter, () => true)).toBe(
      `${collection}?page=2&pageSize=15&approvalSubjectOrgId=ZZ_FER2E1_SUBJECT` +
        '&effectiveFrom=2026-11-01&effectiveTo=2026-12-01&approvalStatus=draft',
    );
    expect(listPath(page, filter, (field) => field === 'approvalStatus')).toBe(
      `${collection}?page=2&pageSize=15&approvalStatus=draft`,
    );
    expect(statusOptions.map(({ label }) => label)).toEqual([
      '草稿',
      '已暂存',
      '审批中',
      '审批通过',
      '审批未通过',
      '生效',
      '作废',
      '已驳回',
    ]);
  });

  it('保留无权限字段的 --，忽略 masked.name 的现名并剪掉调整后停用分支', () => {
    const node: PreviewNode = {
      key: 'ZZ_FER2E1_ROOT',
      name: 'ZZ_FER2E1_MASKED',
      masked: ['name'],
      mark: 'changed',
      personInChargeName: null,
      establishment: 0,
      children: [],
    };
    const roots = [{ ...node, children: [{ ...node, key: 'ZZ_FER2E1_STOP', mark: 'deactivated' as const }] }];
    expect(previewRows(roots, false)[0]).toMatchObject({
      name: null,
      establishment: 0,
      children: [{ mark: 'deactivated' }],
    });
    expect(previewRows(roots, true)[0]).toMatchObject({ name: null, establishment: 0, mark: null, children: [] });
    expect(rangeLabel([{ orgId: node.key, label: null, name: null }])).toBe('--');
  });

  it('从服务端文件基名保留中文和日期，替换路径保留字符后再补格式', () => {
    const name = '架构图（ZZ_FER2E1/:*?"<>|\\）_20261002';
    expect(downloadName(name, 'png')).toBe('架构图（ZZ_FER2E1＿＿＿＿＿＿＿＿＿）_20261002.png');
    expect(downloadName(name, 'svg')).toBe('架构图（ZZ_FER2E1＿＿＿＿＿＿＿＿＿）_20261002.svg');
  });

  it('只接受原单和实际发送版本之后的回执，新建由服务端分配 ID', () => {
    expect(acceptReceipt({ id: 'ZZ_FER2E1_01', revision: 1 }, undefined, 0)).toEqual({ id: 'ZZ_FER2E1_01' });
    expect(acceptReceipt({ id: 'ZZ_FER2E1_01', revision: 4 }, 'ZZ_FER2E1_01', 3)).toEqual({ id: 'ZZ_FER2E1_01' });
    expect(() => acceptReceipt({ id: 'ZZ_FER2E1_02', revision: 4 }, 'ZZ_FER2E1_01', 3)).toThrow();
    expect(() => acceptReceipt({ id: 'ZZ_FER2E1_01', revision: 3 }, 'ZZ_FER2E1_01', 3)).toThrow();
  });
});
