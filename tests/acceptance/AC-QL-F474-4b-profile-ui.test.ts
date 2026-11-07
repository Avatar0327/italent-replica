/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-474-4b #20 前端（DEC-778①，规格 §3.5）：我的档案 → 任职资格页签 = 通道图 + 各级标准卡，只读。
 * 接口夹具取 support/f474-qualification-card.ts（后端验收断言真实响应结构与它一致）。
 */
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, h, uiHarness } from './support/f474-ui.js';
import { CARD_SAMPLE } from './support/f474-qualification-card.js';

const SELF = '/api/tenant/self-service';
const employee = { id: '30000000-0000-4000-8000-000000000474', name: '合成用户', code: 'SYNTH-474' };
const PROFILE = { employee, record: null, timezone: 'Asia/Shanghai', today: '2026-11-03', selfServiceButtons: [] };
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
const page = async () => (await import(resolve('apps/web/src/self-service/pages/SelfPage.tsx'))).SelfPage;
const tab = (name: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('.ant-tabs-tab')).find((t) => t.textContent === name);
const open = async (name: string) => {
  await act(async () => tab(name)!.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
};

describe('AC-QL F-474-4b #20 我的档案任职资格页签', () => {
  it('页签在人员信息、任职记录之后；点开读本人卡片，显示通道图与各级标准卡', async () => {
    await ui.render(h(await page()), '/self', undefined, {
      [`${SELF}/profile`]: PROFILE,
      [`${SELF}/development-channel`]: CARD_SAMPLE,
    });
    const labels = Array.from(document.querySelectorAll('.ant-tabs-tab')).map((t) => t.textContent);
    expect(labels).toEqual(['人员信息', '任职记录', '任职资格']);
    await open('任职资格');
    const text = ui.host.textContent!;
    // 通道图：当前资格、纵向各级、横向去向
    for (const expected of ['合成研发类', '获得日期', '2026-01-01', '纵向发展', 'P10', 'P20', '横向发展', '合成产品类'])
      expect(text, expected).toContain(expected);
    // 标准卡：当前级别带“当前级别”标记；级别描述、指标目标值 / 权重、能力标准
    for (const expected of ['合成研发类标准', '合成二级描述', '合成指标', '90', '40%', '合成二级能力'])
      expect(text, expected).toContain(expected);
    expect(ui.host.querySelectorAll('.self-standard-card')).toHaveLength(2);
    expect(ui.host.querySelector('.self-standard-card.current')?.textContent).toContain('P20');
    // 只读：页签内没有任何编辑 / 保存入口
    expect(Array.from(ui.host.querySelectorAll('.self-qualification button')).map((b) => b.textContent)).toEqual([]);
  });

  it('没有当前资格显示“暂无发展通道信息”；有资格但当前类别没有标准只显示通道图', async () => {
    const empty = { asOf: '2026-11-03', current: null, vertical: [], horizontal: [], standard: null };
    await ui.render(h(await page()), '/self', undefined, {
      [`${SELF}/profile`]: PROFILE,
      [`${SELF}/development-channel`]: empty,
    });
    await open('任职资格');
    expect(ui.host.textContent).toContain('暂无发展通道信息');
    expect(ui.host.querySelectorAll('.self-standard-card')).toHaveLength(0);
    await ui.close();
    ui = uiHarness();
    await ui.render(h(await page()), '/self', undefined, {
      [`${SELF}/profile`]: PROFILE,
      [`${SELF}/development-channel`]: { ...CARD_SAMPLE, standard: null },
    });
    await open('任职资格');
    expect(ui.host.textContent).toContain('纵向发展');
    expect(ui.host.textContent).toContain('暂无任职资格标准');
    expect(ui.host.querySelectorAll('.self-standard-card')).toHaveLength(0);
  });

  it('无员工发展通道页面权限（403）按原站文案提示，不显示卡片', async () => {
    await ui.render(h(await page()), '/self', undefined, { [`${SELF}/profile`]: PROFILE });
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (raw: string) =>
      new URL(raw, 'http://localhost').pathname === `${SELF}/development-channel`
        ? Response.json({ error: { code: 'FORBIDDEN', message: '无权查看员工发展通道' } }, { status: 403 })
        : real(raw),
    );
    await open('任职资格');
    expect(ui.host.textContent).toContain('请联系管理员配置以下权限：配置【任职资格】应用中的【员工发展通道】页面权限');
    expect(ui.host.querySelectorAll('.self-standard-card')).toHaveLength(0);
  });
});
