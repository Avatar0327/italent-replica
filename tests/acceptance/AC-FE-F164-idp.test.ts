// F-164 / F-155b（DEC-518 / DEC-523）：回顾填写的开放判定与字数口径。
// 计划详情按参与人视图构造（apps/api/src/modules/idp/plan-view.ts：模块带当前节点按钮，reviews 按模块 × 阶段）；
// 字数口径对齐后端 execution-service reviewWithinLimit（去首尾空白后按码点计，各 ≤1000）。
import { describe, expect, it } from 'vitest';
import { annotations } from '../../apps/web/src/annotations/index.js';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import { codepoints, reviewStage, reviewTooLong, stageReview } from '../../apps/web/src/idp/model.js';
import type { PlanDetail, PlanModule } from '../../apps/web/src/idp/types.js';

const stages = [
  { id: 's-1', seq: 1, name: '制定计划', status: 'ended' },
  { id: 's-2', seq: 2, name: '中期回顾', status: 'running' },
  { id: 's-3', seq: 3, name: '期末回顾', status: 'pending' },
] as PlanDetail['stages'];
const review: PlanModule = { id: 'm-r', moduleType: 'review', name: '回顾', buttons: ['EditModuleContent'] };
const plan = (patch: Partial<PlanDetail> = {}): PlanDetail =>
  ({
    id: 'p-1',
    revision: 5,
    name: '合成发展计划',
    status: 'running',
    employeeId: 'e-1',
    currentStageName: '中期回顾',
    currentNodeName: '员工中期回顾',
    stages,
    modules: [review],
    reviews: [
      { moduleId: 'm-r', stageId: 's-1', summary: '合成上阶段总结', improvement: '合成上阶段改进' },
      { moduleId: 'm-r', stageId: 's-2', summary: '合成草稿', improvement: null },
    ],
    ...patch,
  }) as PlanDetail;

describe('AC-FE-F164 回顾填写开放判定（失败即拒绝）', () => {
  it('进行中、带 revision、有运行中阶段、当前节点给了“编辑内容”按钮时，在运行中阶段填写', () => {
    expect(reviewStage(plan(), review)?.id).toBe('s-2');
  });
  it('缺按钮、计划不在进行中、缺 revision、没有运行中阶段、不是回顾模块，一律不开放', () => {
    expect(reviewStage(plan(), { ...review, buttons: [] })).toBeUndefined();
    // HR 视图不返回按钮
    expect(reviewStage(plan(), { ...review, buttons: undefined })).toBeUndefined();
    expect(reviewStage(plan({ status: 'ended' }), review)).toBeUndefined();
    expect(reviewStage(plan({ revision: undefined }), review)).toBeUndefined();
    const idle = stages!.map((stage) => ({ ...stage, status: stage.status === 'running' ? 'ended' : stage.status }));
    expect(reviewStage(plan({ stages: idle as PlanDetail['stages'] }), review)).toBeUndefined();
    expect(reviewStage(plan(), { ...review, moduleType: 'summary' })).toBeUndefined();
  });
  it('表单基线取本模块本阶段那一份；未填写时两项为空', () => {
    expect(stageReview(plan(), 'm-r', 's-2')).toEqual({ summary: '合成草稿', improvement: null });
    expect(stageReview(plan(), 'm-r', 's-3')).toEqual({ summary: null, improvement: null });
    expect(stageReview(plan(), 'm-other', 's-1')).toEqual({ summary: null, improvement: null });
  });
});

describe('AC-FE-F164 回顾字数与后端同口径', () => {
  it('按码点计：一个表情算 1 个字，1000 个表情不超长、1001 个超长', () => {
    expect(codepoints('😀'.repeat(1000))).toBe(1000);
    expect('😀'.repeat(1000).length).toBe(2000);
    expect(reviewTooLong({ summary: '😀'.repeat(1000) })).toEqual([]);
    expect(reviewTooLong({ summary: '😀'.repeat(1001) })).toEqual(['summary']);
  });
  it('首尾空白不计；两项分别判定，逐个列出', () => {
    expect(reviewTooLong({ summary: `  ${'字'.repeat(1000)}\n` })).toEqual([]);
    expect(reviewTooLong({ summary: '字'.repeat(1001), improvement: '法'.repeat(1001) })).toEqual([
      'summary',
      'improvement',
    ]);
    expect(reviewTooLong({ summary: null, improvement: undefined })).toEqual([]);
  });
});

describe('AC-FE-F164 我辅导的发展计划入口', () => {
  it('路由登记 /self/idp/tutoring，页面说明给出两页的原站与复刻取舍', () => {
    const paths = PAGES.routes.filter((item) => item.module === 'idp').map((item) => item.path);
    expect(paths).toEqual(expect.arrayContaining(['/self/idp', '/self/idp/tutoring']));
    expect(annotations['idp-tutor-plans']?.decision).toContain('进行中');
    expect(annotations['idp-my-plans']?.decision).toContain('已终止的不列');
    expect(annotations['idp-plan-detail']?.decision).toContain('无权限查看当前发展计划');
  });
});
