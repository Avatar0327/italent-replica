import type { Locator, Page } from '@playwright/test';
import {
  CONTRACT_BOARD_COMPONENTS,
  CONTRACT_BOARD_OBJECT,
  HR_PROCESS_COMPONENTS,
  HR_PROCESS_DASHBOARD_OBJECT,
} from '@italent/domain';
import { expect, seedDemoUser, snapshotFixture, test } from './fixtures.js';

/*
 * F-559 卡片被撑宽回归（F-556 审查列为范围外的两处）：
 * ① S5 合同看板卡头“共 N 人查看详情”按钮（antd Button 默认 nowrap），9 位数总数时不得越出卡片内容区；
 * ② S4b 人事流程看板指标块的大号总数，9 位数时不得越出指标块与卡片内容区。
 * 375px 下两处可见边界都在卡片内容区内、卡片内容区不横向滚动；1280px 下保持修前的单行、字号与按钮可访问名称。
 * 只量卡片本身：375px 下 PC 外壳顶栏与侧栏把整页撑宽按 DEC-007 不算。
 * 夹具形状照后端：contract-board.ts（value / groups）、hr-process-dashboard.ts（total / hits / rate / average / groups）。
 */
const today = snapshotFixture.session.today;
const LONG = 123_456_789;
const LONG_TEXT = String(LONG);

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

function contractBoard(value: number) {
  return {
    asOf: today,
    hasDataPermission: true,
    components: CONTRACT_BOARD_COMPONENTS.map((component) => ({
      ...component,
      value,
      groups:
        component.kind === 'groups'
          ? [
              {
                key: 'ZZ_F559_甲',
                label: 'ZZ_F559_甲',
                count: value,
                ...(component.code === 'signByCompany' && { ratio: 1 }),
              },
            ]
          : null,
    })),
  };
}

function processBoard(total: number) {
  return {
    asOf: today,
    from: today,
    to: today,
    hasDataPermission: true,
    components: HR_PROCESS_COMPONENTS.map((item) => ({
      ...item,
      total,
      hits: total,
      rate: 1,
      average: 2.5,
      groups: [],
    })),
  };
}

async function contract(page: Page, value: number) {
  await seedDemoUser(page);
  await entry(page, CONTRACT_BOARD_OBJECT);
  await page.route(/\/analytics\/contract-board(?:\?|$)/, (route) => route.fulfill({ json: contractBoard(value) }));
  await page.route('**/contracts/master-data/companies?*', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/contracts/master-data/types?*', (route) => route.fulfill({ json: { items: [] } }));
  await page.goto('/hr-contract-board');
  await expect(page.locator('.hr-contract-count').first()).toBeVisible({ timeout: 8000 });
}

async function process(page: Page, total: number) {
  await seedDemoUser(page);
  await entry(page, HR_PROCESS_DASHBOARD_OBJECT);
  await page.route(/\/analytics\/hr-process-dashboard(?:\?|$)/, (route) =>
    route.fulfill({ json: processBoard(total) }),
  );
  await page.route('**/analytics/organization-candidates?*', (route) => route.fulfill({ json: { items: [] } }));
  await page.goto('/hr-dashboard/process');
  await expect(page.locator('.hr-process-metrics strong').first()).toBeVisible({ timeout: 8000 });
}

// 卡片内越出内容区（扣边框与内边距）的元素：元素框与文字本身的范围都量；另报该框自身的横向滚动
const overflow = (card: Locator, selector: string) =>
  card.evaluate((element, selector) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const left = rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const right = rect.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    const out = (box: DOMRect) => box.left < left - 0.5 || box.right > right + 0.5;
    const problems = Array.from(element.querySelectorAll(selector)).flatMap((item) => {
      const range = document.createRange();
      range.selectNodeContents(item);
      const own = Array.from(item.classList).filter((name) => !/^(css-|ant-)/.test(name));
      const name = `${[item.tagName.toLowerCase(), ...own].join('.')}「${item.textContent}」`;
      return [item.getBoundingClientRect(), range.getBoundingClientRect()]
        .filter(out)
        .map(
          (box) =>
            `${name} ${Math.round(box.left)}–${Math.round(box.right)} 超出 ${Math.round(left)}–${Math.round(right)}`,
        );
    });
    const scroll = element.scrollWidth - element.clientWidth;
    return scroll > 0 ? [...problems, `横向滚动 ${scroll}px`] : problems;
  }, selector);

// 文字被裁（省略号 / overflow 隐藏）：文字宽于可见框；悬停 title 不算可读
const clipped = (scope: Locator, selector: string) =>
  scope
    .locator(selector)
    .evaluateAll((items) =>
      items.flatMap((item) =>
        item.scrollWidth > item.clientWidth + 0.5
          ? [`「${item.textContent}」可见 ${item.clientWidth} / 文字 ${item.scrollWidth}`]
          : [],
      ),
    );

// 文字占的行数与计算字号：字形框按纵向是否重叠归行（同一行里大小字号混排、顶边不同也算一行）
const layout = (item: Locator) =>
  item.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = Array.from(range.getClientRects())
      .filter(({ width }) => width > 0)
      .sort((a, b) => a.top - b.top);
    let lines = 0;
    let bottom = -Infinity;
    for (const rect of rects) {
      if (rect.top >= bottom - 1) lines += 1;
      bottom = Math.max(bottom, rect.bottom);
    }
    return { lines, fontSize: getComputedStyle(element).fontSize };
  });

test.describe('F-559 375px 窗口 9 位数总数不撑宽卡片', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('S5 合同看板卡头“共 N 人查看详情”按钮在卡片内容区内、卡片不横向滚动', async ({ page }) => {
    await contract(page, LONG);
    for (const { code } of CONTRACT_BOARD_COMPONENTS) {
      const card = article(page, CONTRACT_BOARD_COMPONENTS, code);
      const button = card.locator('.hr-contract-count');
      await expect(button, `${code} 按钮可访问名称保持完整总数`).toHaveAccessibleName(
        new RegExp(`^查看详情：(共 )?${LONG_TEXT}( 人)?$`),
      );
      expect.soft(await overflow(card, '.hr-contract-count, .hr-contract-count > *'), `375px S5 ${code}`).toEqual([]);
      expect.soft(await clipped(button, 'strong, span'), `375px S5 ${code} 总数与“查看详情”完整可见`).toEqual([]);
    }
  });

  test('S4b 人事流程看板指标块大号总数在指标块与卡片内容区内、卡片不横向滚动', async ({ page }) => {
    await process(page, LONG);
    const cards = page.locator('article.hr-structure-stat');
    expect(await cards.count(), '至少一张指标卡').toBeGreaterThan(0);
    for (const card of await cards.all()) {
      const name = await card.getAttribute('aria-label');
      expect
        .soft(
          await overflow(card, '.hr-process-metrics, .board-chart-item, .board-chart-item > *'),
          `375px S4b ${name}`,
        )
        .toEqual([]);
      for (const item of await card.locator('.hr-process-metrics .board-chart-item').all())
        expect.soft(await overflow(item, 'strong'), `375px S4b ${name} 指标块`).toEqual([]);
      expect.soft(await clipped(card, '.hr-process-metrics strong'), `375px S4b ${name} 总数完整可见`).toEqual([]);
    }
    await expect(page.getByRole('button', { name: new RegExp(`^查看详情：.+，${LONG_TEXT}$`) }).first()).toBeVisible();
  });
});

test.describe('F-559 1280px 显示与修前一致', () => {
  test('S5 卡头按钮单行、总数字号不变；短数值同样成立', async ({ page }) => {
    for (const value of [LONG, 24]) {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await contract(page, value);
      for (const { code } of CONTRACT_BOARD_COMPONENTS) {
        const card = article(page, CONTRACT_BOARD_COMPONENTS, code);
        const button = card.locator('.hr-contract-count');
        expect.soft(await layout(button), `1280px S5 ${code} ${value} 按钮`).toEqual({
          lines: 1,
          fontSize: '14px',
        });
        expect.soft(await layout(button.locator('strong')), `1280px S5 ${code} ${value} 总数`).toEqual({
          lines: 1,
          fontSize: '26px',
        });
        expect
          .soft(await overflow(card, '.hr-contract-count, .hr-contract-count > *'), `1280px S5 ${code}`)
          .toEqual([]);
      }
    }
  });

  test('S4b 指标块大号总数单行、字号 26px 不变；短数值同样成立', async ({ page }) => {
    for (const total of [LONG, 7]) {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await process(page, total);
      const numbers = page.locator('article.hr-structure-stat .hr-process-metrics strong');
      expect(await numbers.count()).toBeGreaterThan(0);
      for (const number of await numbers.all())
        expect.soft(await layout(number), `1280px S4b ${total}「${await number.textContent()}」`).toEqual({
          lines: 1,
          fontSize: '26px',
        });
      // 与 375px 同口径：总数 / 指标块在卡片内容区与指标块内容区内、两者都不横向滚动
      for (const card of await page.locator('article.hr-structure-stat').all()) {
        const name = await card.getAttribute('aria-label');
        expect
          .soft(
            await overflow(card, '.hr-process-metrics, .board-chart-item, .board-chart-item > *'),
            `1280px S4b ${total} ${name}`,
          )
          .toEqual([]);
        for (const item of await card.locator('.hr-process-metrics .board-chart-item').all())
          expect.soft(await overflow(item, 'strong'), `1280px S4b ${total} ${name} 指标块`).toEqual([]);
      }
    }
  });
});
