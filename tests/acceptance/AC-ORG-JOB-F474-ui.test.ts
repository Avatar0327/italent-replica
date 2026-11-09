/// <reference lib="dom" />
// @vitest-environment happy-dom
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allFields, h, permission, uiHarness } from './support/f474-ui.js';
const { OrgPage } = await import(resolve('apps/web/src/org/OrgPage.tsx'));
const { JobWorkspace } = await import(resolve('apps/web/src/job/JobWorkspace.tsx'));
const { JobEditor } = await import(resolve('apps/web/src/job/JobEditor.tsx'));
const { pageAccess } = await import(resolve('apps/web/src/org/page-model.ts'));
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());

describe('AC-ORG / AC-JOB F-474 已有接口字段的页面对齐', () => {
  it('组织列表名称宽列、日期窄列、操作固定宽度', async () => {
    await ui.render(h(OrgPage), '/org');
    expect(ui.headers()).toEqual([
      '机构ID',
      '机构名称',
      '机构全称',
      '所在城市',
      '机构类型',
      '建立日期',
      '启用日期',
      '禁用日期',
      '操作',
    ]);
    expect(ui.widths()).toEqual(['128px', '240px', '128px', '128px', '128px', '93px', '93px', '93px', '204px']);
  });
  it('职级列表包含已支持的生效日期，各列按证据宽度', async () => {
    await ui.render(h(JobWorkspace), '/job?kind=levels');
    expect(ui.headers()).toEqual([
      '资源集合',
      '职级类别',
      '名称',
      '级别',
      '开始职等',
      '结束职等',
      '薪资上限值',
      '薪资中位值',
      '薪资下限制',
      '生效日期',
    ]);
    expect(ui.widths()).toEqual([
      '140px',
      '140px',
      '140px',
      '172px',
      '140px',
      '140px',
      '172px',
      '172px',
      '172px',
      '105px',
    ]);
  });
  it('职级没有生效日期查看权时不补出该列', async () => {
    await ui.render(h(JobWorkspace), '/job?kind=levels', ['name', 'level']);
    expect(ui.headers()).toEqual(['名称', '级别']);
  });
  describe('职级新建的资源集合（DEC-339①）', () => {
    const CANDIDATES = '/api/tenant/job/candidates/resource-sets';
    const open = (items: { id: string }[]) =>
      ui.render(
        h(JobEditor, {
          kind: 'levels',
          date: '2026-11-03',
          today: '2026-11-03',
          access: pageAccess(permission(allFields)),
          onClose() {},
          onSaved() {},
        }),
        '/',
        allFields,
        { [CANDIDATES]: { items } },
      );
    const labels = () =>
      Array.from(document.querySelectorAll('[role="dialog"] .ant-form-item-label label')).map(
        (label) => label.textContent,
      );
    it('有多个授权管理单元：首个字段是必选的资源集合，薪资三值在职等之后', async () => {
      await open([{ id: 'a0000000-0000-4000-8000-000000000001' }, { id: 'a0000000-0000-4000-8000-000000000002' }]);
      expect(labels().slice(0, 9)).toEqual([
        '资源集合',
        '名称',
        '职级类别',
        '级别',
        '开始职等',
        '结束职等',
        '薪资上限值',
        '薪资中位值',
        '薪资下限制',
      ]);
    });
    it('只有一个或没有授权管理单元：不出下拉，由服务端自动填写 / 留空', async () => {
      await open([{ id: 'a0000000-0000-4000-8000-000000000001' }]);
      expect(labels()).not.toContain('资源集合');
      expect(labels()[0]).toBe('名称');
    });
    it('编辑已有职级不出资源集合（列表只读）', async () => {
      await ui.render(
        h(JobEditor, {
          kind: 'levels',
          original: { id: 'b0000000-0000-4000-8000-000000000001', revision: 1, name: '合成职级', ownerOrgId: 'x' },
          date: '2026-11-03',
          today: '2026-11-03',
          access: pageAccess(permission(allFields)),
          onClose() {},
          onSaved() {},
        }),
      );
      expect(labels()).not.toContain('资源集合');
    });
  });
  describe('列表的引用列显示名称（F-474-2a 第 1 轮返工 P2-3 / P2-4）', () => {
    const POSTS = '/api/tenant/job/posts';
    const LEVELS = '/api/tenant/job/levels';
    const CRITERION = 'c0000000-0000-4000-8000-000000000001';
    const ORG = 'a0000000-0000-4000-8000-000000000001';
    const page = (items: object[]) => ({ items, total: items.length, page: 1, pageSize: 15, today: '2026-11-03' });
    const post = {
      id: 'b0000000-0000-4000-8000-000000000001',
      revision: 1,
      name: '合成职务',
      competencyModelId: CRITERION,
    };
    const level = { id: 'b0000000-0000-4000-8000-000000000002', revision: 1, name: '合成职级', ownerOrgId: ORG };
    const cells = () => Array.from(ui.host.querySelectorAll('tbody td')).map((cell) => cell.textContent?.trim());
    const withModel = [...allFields, 'competencyModelId'];

    it('职务列表末列是「胜任力模型」（宽 153），单元格显示按当前权限读到的人才标准名称', async () => {
      await ui.render(h(JobWorkspace), '/job?kind=posts', withModel, {
        [POSTS]: page([post]),
        [`/api/tenant/talent/criteria/${CRITERION}`]: { id: CRITERION, name: '合成胜任力模型', enabled: true },
      });
      expect(ui.headers().at(-1)).toBe('胜任力模型');
      expect(ui.widths().at(-1)).toBe('153px');
      expect(cells()).toContain('合成胜任力模型');
      expect(cells()).not.toContain(CRITERION);
    });
    it('职务的胜任力模型被事后停用：列表保留引用并标注已停用', async () => {
      await ui.render(h(JobWorkspace), '/job?kind=posts', withModel, {
        [POSTS]: page([post]),
        [`/api/tenant/talent/criteria/${CRITERION}`]: { id: CRITERION, name: '合成胜任力模型', enabled: false },
      });
      expect(cells().some((text) => text?.startsWith('合成胜任力模型') && text.length > '合成胜任力模型'.length)).toBe(
        true,
      );
    });
    it('读不到被引用人才标准的名称：显示不在可见范围，不露 ID', async () => {
      await ui.render(h(JobWorkspace), '/job?kind=posts', withModel, {
        [POSTS]: page([post]),
        [`/api/tenant/talent/criteria/${CRITERION}`]: {},
      });
      expect(cells()).toContain('（不在可见范围）');
      expect(cells()).not.toContain(CRITERION);
    });
    it('没有胜任力模型字段查看权：整列隐藏，也不去读人才标准', async () => {
      await ui.render(h(JobWorkspace), '/job?kind=posts', allFields, {
        [POSTS]: page([post]),
        [`/api/tenant/talent/criteria/${CRITERION}`]: { id: CRITERION, name: '合成胜任力模型' },
      });
      expect(ui.headers()).not.toContain('胜任力模型');
      expect(cells()).not.toContain('合成胜任力模型');
    });
    it('职级列表的「资源集合」显示组织名称，不显示 UUID', async () => {
      await ui.render(h(JobWorkspace), '/job?kind=levels', allFields, {
        [LEVELS]: page([level]),
        [`/api/tenant/org/organizations/${ORG}`]: { id: ORG, name: '合成资源集合组织' },
      });
      expect(cells()).toContain('合成资源集合组织');
      expect(cells()).not.toContain(ORG);
    });
    it('读不到组织名称（无组织名称查看权 / 范围外）：显示不在可见范围，不露 UUID', async () => {
      await ui.render(h(JobWorkspace), '/job?kind=levels', allFields, {
        [LEVELS]: page([level]),
        [`/api/tenant/org/organizations/${ORG}`]: {},
      });
      expect(cells()).toContain('（不在可见范围）');
      expect(cells()).not.toContain(ORG);
    });
    it('没有资源集合字段查看权：该列隐藏', async () => {
      await ui.render(
        h(JobWorkspace),
        '/job?kind=levels',
        allFields.filter((field) => field !== 'ownerOrgId'),
        { [LEVELS]: page([level]) },
      );
      expect(ui.headers()).not.toContain('资源集合');
    });
  });
  it('职等新建按名称、等级、职层、上限、下限顺序，生效日期在状态之前', async () => {
    await ui.render(
      h(JobEditor, {
        kind: 'grades',
        date: '2026-11-03',
        today: '2026-11-03',
        access: pageAccess(permission(allFields)),
        onClose() {},
        onSaved() {},
      }),
    );
    const labels = Array.from(document.querySelectorAll('[role="dialog"] .ant-form-item-label label')).map(
      (label) => label.textContent,
    );
    expect(labels.slice(0, 7)).toEqual(['名称', '等级', '职层', '评估分上限', '评估分下限', '生效日期', '状态']);
  });
});
