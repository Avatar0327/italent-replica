/// <reference lib="dom" />
// @vitest-environment happy-dom
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, h, uiHarness } from './support/f474-ui.js';
const { TransferList } = await import(resolve('apps/web/src/transfer/TransferList.tsx'));
const { GapSectionPage } = await import(resolve('apps/web/src/approval/GapSectionPage.tsx'));
const { Applications } = await import(resolve('apps/web/src/approval/Applications.tsx'));
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
describe('AC-TRF / AC-APV F-474 列宽与详情入口', () => {
  it('调动中日期窄列、当前审批人窄列、操作固定宽度', async () => {
    await ui.render(h(TransferList, { view: 'progress' }));
    expect(ui.widths()).toEqual(
      [140, 140, 105, 140, 140, 140, 140, 140, 140, 140, 140, 140, 110, 164].map((n) => `${n}px`),
    );
  });
  it('调动日期可打开任职记录详情', async () => {
    await ui.render(h(TransferList, { view: 'progress' }));
    const row = ui.host.querySelector('tbody tr[data-row-key]')!;
    const date = row.querySelectorAll('td')[2]!.querySelector('button');
    expect(date).not.toBeNull();
    await act(async () => date!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
  it('流程管理各列按已确认宽度，保留无接口禁用边界', async () => {
    await ui.render(h(GapSectionPage, { page: 'processes' }));
    expect(ui.widths()).toEqual([30, 128, 128, 118, 128, 98, 128, 146, 128, 128, 160].map((n) => `${n}px`));
    expect(ui.host.querySelector<HTMLButtonElement>('.approval-gap-head button:last-child')?.disabled).toBe(true);
  });
  it('管理员进行中委托保留复选列，完成视图没有复选列', async () => {
    await ui.render(h(GapSectionPage, { page: 'admin-delegations' }));
    expect(ui.host.querySelector('thead input[type="checkbox"]')).not.toBeNull();
    const buttons = [...ui.host.querySelectorAll<HTMLButtonElement>('button')];
    await act(async () => buttons.find((button) => button.textContent === '已完成的委托(管理员)')!.click());
    expect(ui.host.querySelector('thead input[type="checkbox"]')).toBeNull();
    expect(ui.widths()).toEqual([160, 118, 146, 146, 146, 128, 128, 128, 128, 118, 146, 95, 100].map((n) => `${n}px`));
  });
  it('我的申请仅已有四列，时间列宽192，其余174', async () => {
    await ui.render(h(Applications));
    expect(ui.headers()).toEqual(['标题', '类别', '审批状态', '申请时间']);
    expect(ui.widths()).toEqual(['174px', '174px', '174px', '192px']);
  });
});
