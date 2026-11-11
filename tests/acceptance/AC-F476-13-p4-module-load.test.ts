/**
 * AC-F476-13（P4 CI 返工）：模块加载顺序。
 * 本 PR 让 approval/handling-content 静态依赖 employment/approval-content（任职 / 离退类办理份 provider），
 * employment/exit-queries、retirement-views、approval-content 因此进入“审批引擎 ↔ 任职上下文”的既有导入环。
 * 环上模块的顶层求值不得读取环上别的模块导出的值：先加载哪一个由入口决定（CI run 42758115092 中
 * AC-DM-F224-order-guard 先加载 exit-queries，retirement-views 顶层的 BILL_SORT 读到未初始化的 EXIT_SORT_DEPENDENCIES）。
 * 每个用例都在全新的模块图里，以一个环上模块为首个入口加载，不依赖测试文件的导入顺序。
 * 不含 main 上已有、与本 PR 无关的入口顺序问题（exit-downstream / exit-confirmation / exit-initiation / entry-contract
 * 作首个入口时在 main 上同样失败），另报总编排。
 */
import { describe, expect, it, vi } from 'vitest';

const MODULES = '../../apps/api/src/modules';

/** 新入环的三个模块、把它们接进环的边（办理份 / 披露 / 任职上下文），以及 CI 崩溃时的入口。 */
const ENTRIES: Record<string, () => Promise<unknown>> = {
  'employment/exit-queries': () => import(`${MODULES}/employment/exit-queries.js`),
  'employment/retirement-views': () => import(`${MODULES}/employment/retirement-views.js`),
  'employment/approval-content': () => import(`${MODULES}/employment/approval-content.js`),
  'employment/context': () => import(`${MODULES}/employment/context.js`),
  'employment/read-model': () => import(`${MODULES}/employment/read-model.js`),
  'employment/activation-store': () => import(`${MODULES}/employment/activation-store.js`),
  'employment/timeline': () => import(`${MODULES}/employment/timeline.js`),
  'employment/exit-gate': () => import(`${MODULES}/employment/exit-gate.js`),
  'employment/exit-handover-items': () => import(`${MODULES}/employment/exit-handover-items.js`),
  'employment/assessment-conflict-disclosure': () => import(`${MODULES}/employment/assessment-conflict-disclosure.js`),
  'approval/disclosure': () => import(`${MODULES}/approval/disclosure.js`),
  'approval/handling-content': () => import(`${MODULES}/approval/handling-content.js`),
  'approval/engine': () => import(`${MODULES}/approval/engine.js`),
};

describe('AC-F476-13 P4：环上模块以任一入口先加载都不抛错', () => {
  it.each(Object.keys(ENTRIES))('首个入口 %s', async (entry) => {
    vi.resetModules();
    await expect(ENTRIES[entry]!()).resolves.toBeDefined();
  });

  it('按 AC-DM-F224-order-guard 的顺序（先离职查询，后办理份）：退休单据列表与任职 provider 都可用', async () => {
    vi.resetModules();
    await import(`${MODULES}/employment/exit-queries.js`);
    const handling = await import(`${MODULES}/approval/handling-content.js`);
    const retirement = await import(`${MODULES}/employment/retirement-views.js`);
    expect(handling.CONTENT_PROVIDERS.employment.kind).toBe('extended');
    expect(typeof retirement.listRetirementBills).toBe('function');
  });
});
