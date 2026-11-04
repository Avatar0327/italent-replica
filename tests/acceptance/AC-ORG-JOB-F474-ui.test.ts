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
    expect(ui.headers()).toEqual(['职级类别', '名称', '级别', '开始职等', '结束职等', '生效日期']);
    expect(ui.widths()).toEqual(['140px', '140px', '172px', '140px', '140px', '105px']);
  });
  it('职级没有生效日期查看权时不补出该列', async () => {
    await ui.render(h(JobWorkspace), '/job?kind=levels', ['name', 'level']);
    expect(ui.headers()).toEqual(['名称', '级别']);
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
