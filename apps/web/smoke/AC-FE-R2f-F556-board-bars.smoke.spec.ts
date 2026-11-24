import type { Locator, Page } from '@playwright/test';
import {
  CONTRACT_BOARD_COMPONENTS,
  CONTRACT_BOARD_OBJECT,
  HR_PROCESS_COMPONENTS,
  HR_PROCESS_DASHBOARD_OBJECT,
  HR_STRUCTURE_COMPONENTS,
  HR_STRUCTURE_OBJECT,
} from '@italent/domain';
import { expect, seedDemoUser, snapshotFixture, test } from './fixtures.js';

/*
 * F-556 跨看板横条几何回归：凡走共用 BoardChart 横条（board-charts.css 的两行规则）的看板各取横条图，
 * 同一图内各行轨道左右边界一致、与数值文字长短无关；≤375px 窗口横条图不横向滚动，
 * 正常排版下图框、轨道与数值都落在卡片内容区，长数值只在剩余空间换行、分组标签保持完整可见。
 * 标签样本覆盖长中文名、无自然断点的长拉丁名（同前缀、只差末位，裁掉末位就分不清），且都与长数值同行。
 * 横条使用方以代码为准：S2 结构（6.05 / 6.11）、S4b 流程（7.2.x 条形与差值图）、S5 合同（签署分组）；
 * S1 管理看板只有指标卡、S3 异动看板只有纵向柱 / 饼 / 趋势，没有横条。
 * 夹具形状照后端：hr-structure-board.ts groups()（按人数降序）、hr-process-dashboard.ts、contract-board.ts。
 */
const prefix = 'ZZ_F556_';
const today = snapshotFixture.session.today;
// 数值文字很长的样本：与只有一位数的行同图
const LONG = 123_456_789;
// 分组名称样本：长中文名可在字间断行；长拉丁名没有自然断点，两条只差末位（合同类型名称上限 200 字，
// apps/api/src/modules/contracts/configuration.ts saveMaster）；发起人为用户 UUID，只在连字符处断行
const CJK = `${prefix}集团总部人力资源共享服务中心`;
const LATIN = 'WWWWWWWWWWWWW';
const UUID = '0f4a6b1e-2c3d-4e5f-8a9b-0c1d2e3f4a5';

const article = (page: Page, components: readonly { code: string; name: string }[], code: string) =>
  page.getByRole('article', { name: components.find((item) => item.code === code)!.name, exact: true });

function entry(page: Page, object: string) {
  return page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'staff' ? { ...app, visible: true, entryObjects: [object] } : app,
        ),
      },
    }),
  );
}

function structureBoard() {
  return {
    asOf: today,
    hasDataPermission: true,
    components: HR_STRUCTURE_COMPONENTS.map((component) => {
      if (component.kind === 'unavailable') return { ...component, value: null, groups: null };
      if (component.kind === 'average') return { ...component, value: 36.5, count: LONG + 1, groups: null };
      if (component.code === '6.11')
        return {
          ...component,
          value: LONG,
          groups: [
            { key: `${prefix}本科`, label: `${prefix}本科`, count: LONG, total: LONG * 2, ratio: 0.5 },
            { key: `${prefix}硕士`, label: `${prefix}硕士`, count: 1, total: 1, ratio: 1 },
          ],
        };
      const groups =
        component.kind === 'groups'
          ? [
              { key: `${prefix}甲`, label: `${CJK}职级甲`, count: LONG },
              { key: `${prefix}乙`, label: `${CJK}职级乙`, count: 1 },
            ]
          : null;
      return { ...component, value: LONG + 1, groups };
    }),
  };
}

const processGroup = (key: string, count: number, average: number | null = null) => ({
  key,
  label: null,
  series: null,
  count,
  hits: null,
  rate: null,
  average,
});
function processBoard() {
  const groups: Record<string, ReturnType<typeof processGroup>[]> = {
    lateSubmitByInitiator: [processGroup(`${UUID}1`, LONG), processGroup(`${UUID}2`, 1)],
    // 7.2.17 差值图（零轴居中）同走两行规则；正负、位数悬殊混排
    submitLagByCategory: [
      processGroup('transfer', 2, 123_456.5),
      processGroup('offer', 1, -1),
      processGroup('contract', 1, 0.5),
    ],
  };
  return {
    asOf: today,
    from: today,
    to: today,
    hasDataPermission: true,
    components: HR_PROCESS_COMPONENTS.map((item) => {
      const mine = groups[item.code] ?? [];
      const total = mine.reduce((sum, row) => sum + row.count, 0);
      return { ...item, total, hits: null, rate: null, average: null, groups: mine };
    }),
  };
}

function contractBoard() {
  const total = LONG + 1;
  const options: Record<string, { key: string; label: string; count: number; ratio?: number | null }[]> = {
    signByCompany: [
      { key: `${prefix}公司甲`, label: `${CJK}有限公司甲`, count: LONG, ratio: 1 },
      { key: `${prefix}公司乙`, label: `${CJK}有限公司乙`, count: 1, ratio: 0 },
    ],
    signByType: [
      { key: `${prefix}类型甲`, label: `${LATIN}A`, count: LONG },
      { key: `${prefix}类型乙`, label: `${LATIN}B`, count: 1 },
    ],
  };
  return {
    asOf: today,
    hasDataPermission: true,
    components: CONTRACT_BOARD_COMPONENTS.map((component) => ({
      ...component,
      value: total,
      groups: component.kind === 'groups' ? (options[component.code] ?? []) : null,
    })),
  };
}

interface Board {
  name: string;
  path: string;
  object: string;
  components: readonly { code: string; name: string }[];
  bars: readonly string[];
  routes(page: Page): Promise<unknown>;
}
const boards: Board[] = [
  {
    name: 'S2 结构',
    path: '/hr-dashboard/structure',
    object: HR_STRUCTURE_OBJECT,
    components: HR_STRUCTURE_COMPONENTS,
    bars: ['6.05', '6.11'],
    routes: async (page) => {
      await page.route(/\/analytics\/hr-structure(?:\?|$)/, (route) => route.fulfill({ json: structureBoard() }));
      await page.route('**/analytics/organization-candidates?*', (route) => route.fulfill({ json: { items: [] } }));
      await page.route('**/job/sequences?*', (route) =>
        route.fulfill({ json: { page: 1, pageSize: 200, hasDataPermission: true, items: [] } }),
      );
      await page.route('**/employment/employment-forms', (route) => route.fulfill({ json: { items: [] } }));
      await page.route('**/employment/employment-types/options', (route) => route.fulfill({ json: { items: [] } }));
    },
  },
  {
    name: 'S4b 流程',
    path: '/hr-dashboard/process',
    object: HR_PROCESS_DASHBOARD_OBJECT,
    components: HR_PROCESS_COMPONENTS,
    bars: ['lateSubmitByInitiator', 'submitLagByCategory'],
    routes: async (page) => {
      await page.route(/\/analytics\/hr-process-dashboard(?:\?|$)/, (route) => route.fulfill({ json: processBoard() }));
      await page.route('**/analytics/organization-candidates?*', (route) => route.fulfill({ json: { items: [] } }));
    },
  },
  {
    name: 'S5 合同',
    path: '/hr-contract-board',
    object: CONTRACT_BOARD_OBJECT,
    components: CONTRACT_BOARD_COMPONENTS,
    bars: ['signByCompany', 'signByType'],
    routes: async (page) => {
      await page.route(/\/analytics\/contract-board(?:\?|$)/, (route) => route.fulfill({ json: contractBoard() }));
      await page.route('**/contracts/master-data/companies?*', (route) => route.fulfill({ json: { items: [] } }));
      await page.route('**/contracts/master-data/types?*', (route) => route.fulfill({ json: { items: [] } }));
    },
  },
];

// 同图各行轨道的左右边界（取 0.1px），比较时容许 1px 亚像素误差
const tracks = (chart: Locator) =>
  chart.locator('.board-chart-mark').evaluateAll((marks) =>
    marks.map((mark) => {
      const rect = mark.getBoundingClientRect();
      return { left: Math.round(rect.left * 10) / 10, right: Math.round(rect.right * 10) / 10 };
    }),
  );
const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

// 越出给定框的图框、轨道、标签或数值文字（标签与数值按文字本身的范围量）；content 为真时量框的内容区（扣边框与内边距）
const outside = (scope: Locator, content = false) =>
  scope.evaluate((element, content) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const inset = (side: 'Left' | 'Right') =>
      content ? parseFloat(style[`border${side}Width`]) + parseFloat(style[`padding${side}`]) : 0;
    const box = { left: rect.left + inset('Left'), right: rect.right - inset('Right') };
    const items = element.querySelectorAll(
      '.board-chart-bar, .board-chart-bar .board-chart-mark, .board-chart-bar .board-chart-label, .board-chart-number',
    );
    return Array.from(items).flatMap((item) => {
      const range = document.createRange();
      range.selectNodeContents(item);
      const text = item.classList.contains('board-chart-number') || item.classList.contains('board-chart-label');
      const own = text ? range : item;
      const { left, right } = own.getBoundingClientRect();
      const out = left < box.left - 0.5 || right > box.right + 0.5;
      const name = `${item.className}「${item.textContent}」`;
      return out
        ? [`${name}${Math.round(left)}–${Math.round(right)} 超出 ${Math.round(box.left)}–${Math.round(box.right)}`]
        : [];
    });
  }, content);

// 被挤没或被裁的分组标签：宽度为 0，或文字宽 / 高于可见区域（overflow: hidden + 省略号）；悬停 title 不算可见
const clipped = (chart: Locator) =>
  chart.locator('.board-chart-label').evaluateAll((labels) =>
    labels.flatMap((label) => {
      const { width, height } = label.getBoundingClientRect();
      const wide = label.scrollWidth > label.clientWidth;
      const cut = width < 1 || wide || label.scrollHeight > label.clientHeight;
      const size = `可见 ${Math.round(width)}×${Math.round(height)} / 文字 ${label.scrollWidth}×${label.scrollHeight}`;
      return cut ? [`「${label.textContent}」${size}`] : [];
    }),
  );

async function show(page: Page, board: Board) {
  await seedDemoUser(page);
  await entry(page, board.object);
  await board.routes(page);
  await page.goto(board.path);
  for (const code of board.bars)
    await expect(article(page, board.components, code).locator('.board-chart-bar')).toBeVisible({ timeout: 8000 });
}

async function aligned(page: Page, board: Board, viewport: string) {
  for (const code of board.bars) {
    const card = article(page, board.components, code);
    const numbers = await card.locator('.board-chart-bar .board-chart-number').allTextContents();
    expect(numbers.length, `${board.name} ${code} 至少两行`).toBeGreaterThan(1);
    expect(
      spread(numbers.map((text) => text.length)),
      `${board.name} ${code} 样本数值文字 ${numbers.join(' / ')} 长短应悬殊`,
    ).toBeGreaterThan(4);
    const rows = await tracks(card.locator('.board-chart-bar'));
    const drift = Math.max(spread(rows.map(({ left }) => left)), spread(rows.map(({ right }) => right)));
    expect
      .soft(drift, `${viewport} ${board.name} ${code} 各行轨道 ${JSON.stringify(rows)} 左右边界应一致`)
      .toBeLessThanOrEqual(1);
    const chart = card.locator('.board-chart-bar');
    expect.soft(await outside(chart), `${viewport} ${board.name} ${code} 标签、轨道与数值应在图内`).toEqual([]);
    // 正常排版下（不改任何宽度）直接量：图框、轨道、标签与数值都落在卡片内容区
    expect.soft(await outside(card, true), `${viewport} ${board.name} ${code} 横条应落在卡片内容区`).toEqual([]);
    // 同一长值、长名样本：数值再长也只在剩余空间换行，标签保留可读宽度、长名折行而不被裁
    expect.soft(await clipped(chart), `${viewport} ${board.name} ${code} 分组标签应完整可见`).toEqual([]);
  }
}

for (const board of boards) {
  test(`F-556 ${board.name}看板横条同图各行轨道左右边界一致，与数值文字长短无关`, async ({ page }) => {
    await show(page, board);
    await aligned(page, board, '1280px');
  });

  test(`F-556 ${board.name}看板 375px 窗口横条落在卡片内容区，各行仍对齐、标签完整可见`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await show(page, board);
    await aligned(page, board, '375px');
    // 只量横条而不是整页：375px 下 PC 外壳顶栏与侧栏（DEC-007 首期只做 PC）本来就把页面撑宽，与横条无关；
    // 卡头按钮、大号指标自身的宽度也不在本回归范围内，但不得再把横条连带撑出卡片内容区（上面 aligned 已量）
    for (const code of board.bars) {
      const chart = article(page, board.components, code).locator('.board-chart-bar');
      const scroll = await chart.evaluate((element) => element.scrollWidth - element.clientWidth);
      expect.soft(scroll, `375px ${board.name} ${code} 横条图不应横向滚动`).toBeLessThanOrEqual(0);
    }
  });
}
