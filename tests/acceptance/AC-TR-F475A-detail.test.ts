import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ hidden: [] as string[] }));
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h } = requireWeb('react');
const { renderToStaticMarkup: render } = requireWeb('react-dom/server');
vi.mock('../../apps/web/src/foundation/Permissions.js', () => ({
  usePermissions: () => ({ field: (key: string) => ({ visible: !state.hidden.includes(key), editable: false }) }),
}));
vi.mock('../../apps/web/src/foundation/DecisionNote.js', () => ({ DecisionNote: () => null }));
const { RecordDetail } = await import(resolve('apps/web/src/talent-review/RecordDetail.tsx'));
const props = {
  collection: 'projects',
  record: { id: 'synthetic-project', name: '合成项目', criterionId: '合成标准标识' },
  onClose() {},
  actions: h('button', null, '编辑项目'),
};
beforeEach(() => {
  state.hidden = [];
});
describe('AC-TR F-475A 项目整页详情', () => {
  it('整页容器、返回、四卡和八页签，缺接口不显示演示人员', () => {
    const html = render(h(RecordDetail, props));
    expect(html).toContain('class="review-project-detail"');
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('返回');
    expect(html).toContain('合成项目');
    expect(html).toContain('盘点信息采集进展');
    expect(html).toContain('合成标准标识');
    expect([...html.matchAll(/role="tab"[^>]*>[\s\S]*?/g)]).toHaveLength(8);
    for (const label of [
      '盘点对象',
      '多人评价关系',
      '指标明细',
      '九宫格',
      '组织继任地图',
      '职位继任地图',
      '仪表盘',
      '结果审批流程',
    ])
      expect(html).toContain(label);
    expect(html).toContain('未完成（缺后端契约）');
    expect(html).not.toContain('演示数据');
    expect(html).not.toContain('计算失败');
    expect(html).toContain('目标职位');
    expect(html).toContain('更多操作');
  });
  it('被裁剪的项目名和人才标准不从本地记录补全', () => {
    state.hidden = ['name', 'criterionId'];
    const html = render(h(RecordDetail, props));
    expect(html).toContain('class="review-project-detail"');
    expect(html).not.toContain('合成项目');
    expect(html).not.toContain('合成标准标识');
  });
});
