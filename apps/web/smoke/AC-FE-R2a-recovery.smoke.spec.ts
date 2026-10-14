// F-127b 第 3 轮：配置对象行内命令的冲突恢复（确认后的基线、按 ID 重读本行、业务字段差异、下一次 If-Match）。
import { test, expect } from './fixtures.js';
import type { Locator, Page } from '@playwright/test';
import { capture, named, ruleRow, setupContracts, typeRow, type Write } from './contracts-fixtures.js';

const tab = (page: Page, label: string) => page.getByRole('link', { name: label, exact: true }).click();
const conflict = { status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } };
const forbidden = { status: 403, json: { error: { code: 'FORBIDDEN' } } };
type Reply = { status?: number; json: unknown };

/** 列表 GET 按 page / pageSize 切片返回 rows()；写请求依次按 replies 应答。 */
async function stub(page: Page, list: string, write: string, rows: () => object[], replies: ((w: Write) => Reply)[]) {
  const writes: Write[] = [];
  const reads: URL[] = [];
  await page.route(list, (route) => {
    const url = new URL(route.request().url());
    reads.push(url);
    const at = Number(url.searchParams.get('page') ?? 1);
    const size = Number(url.searchParams.get('pageSize') ?? 15);
    const all = rows();
    return route.fulfill({ json: { items: all.slice((at - 1) * size, at * size), total: all.length, page: at } });
  });
  await page.route(write, (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    capture(writes, route.request());
    const reply = replies[writes.length - 1]!(writes.at(-1)!);
    return route.fulfill({ status: reply.status ?? 200, json: reply.json });
  });
  return { writes, reads };
}
const confirmPop = (page: Page) => page.getByRole('tooltip').getByRole('button', named('确定')).click();
const rereadAndConfirm = async (scope: Locator) => {
  await scope.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await scope.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
};

test('AC-FE-R2a-27 类型启停冲突核对后被 403 拒绝，重提沿用确认值与新版本，不覆盖他人修改', async ({ page }) => {
  await setupContracts(page);
  let current = { ...typeRow };
  const { writes } = await stub(
    page,
    '**/api/tenant/contracts/master-data/types?*',
    '**/api/tenant/contracts/master-data/types/type',
    () => [current],
    [
      () => {
        current = { ...current, name: '他人改名类型', revision: typeRow.revision + 1 };
        return conflict;
      },
      () => forbidden,
      (write) => ({ json: { ...current, ...(write.body as object), revision: current.revision + 1 } }),
    ],
  );
  await tab(page, '合同类型');
  const table = page.locator('.ant-table');
  await table.getByRole('button', named('停用')).click();
  await confirmPop(page);
  await rereadAndConfirm(table);
  await table.getByRole('button', named('停用')).click();
  await confirmPop(page);
  await expect(table.locator('.ant-alert-error')).toBeVisible();
  await table.getByRole('button', named('停用')).click();
  await confirmPop(page);
  await expect.poll(() => writes.length).toBe(3);
  const confirmed = { code: typeRow.code, name: '他人改名类型', enabled: false };
  expect(writes.map(({ revision, body }) => [revision, body])).toEqual([
    [String(typeRow.revision), { code: typeRow.code, name: typeRow.name, enabled: false }],
    [String(typeRow.revision + 1), confirmed],
    [String(typeRow.revision + 1), confirmed],
  ]);
});

test('AC-FE-R2a-28 规则删除冲突：按业务字段展示差异，核对前不删除，核对后带新版本删除', async ({ page }) => {
  await setupContracts(page);
  let current = { ...ruleRow };
  const { writes } = await stub(
    page,
    '**/api/tenant/contracts/rules?*',
    '**/api/tenant/contracts/rules/rule',
    () => [current],
    [
      () => {
        const details = [{ ...ruleRow.details[0]!, months: 24 }];
        current = { ...current, name: '他人改名规则', details, revision: ruleRow.revision + 1 };
        return conflict;
      },
      () => ({ json: { id: 'rule', deleted: true } }),
    ],
  );
  await tab(page, '自动续签规则');
  const table = page.locator('.ant-table').first();
  await table.getByRole('button', named('删除')).click();
  await confirmPop(page);
  await table.getByRole('button', { name: '重读最新版本', exact: true }).click();
  const differences = table.locator('.ant-table').filter({ hasText: '最新值' });
  await expect(differences.getByRole('row').filter({ hasText: '规则名称' })).toContainText('他人改名规则');
  await expect(differences.getByRole('row').filter({ hasText: '续签规则明细' })).toContainText('"months":24');
  await expect(table.getByText('字段值无变化', { exact: false })).toHaveCount(0);
  await expect(table.getByRole('button', named('删除'))).toBeDisabled();
  expect(writes).toHaveLength(1);
  await table.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await table.getByRole('button', named('删除')).click();
  await confirmPop(page);
  await expect.poll(() => writes.length).toBe(2);
  expect(writes.map(({ method, revision, body }) => [method, revision, body ?? null])).toEqual([
    ['DELETE', String(ruleRow.revision), {}],
    ['DELETE', String(ruleRow.revision + 1), {}],
  ]);
});

const many = Array.from({ length: 210 }, (_, index) => {
  const n = String(index + 1).padStart(3, '0');
  return { id: `type-${n}`, code: `T${n}`, name: `合成类型${n}`, enabled: true, revision: 2 };
});
async function toTypePage(page: Page, target: number) {
  await tab(page, '合同类型');
  for (let at = 2; at <= target; at++) {
    await page.locator('.ant-pagination-next').click();
    await expect(page.locator('.ant-table-row').first()).toContainText(many[(at - 1) * 15]!.code);
  }
}

test('AC-FE-R2a-29 第 201 条合同类型启停冲突：重读按 ID 翻页定位本行并恢复', async ({ page }) => {
  await setupContracts(page);
  const target = many[200]!;
  let rows = many;
  const { writes, reads } = await stub(
    page,
    '**/api/tenant/contracts/master-data/types?*',
    `**/api/tenant/contracts/master-data/types/${target.id}`,
    () => rows,
    [
      () => {
        rows = rows.map((row) => (row.id === target.id ? { ...row, name: '他人改名类型', revision: 3 } : row));
        return conflict;
      },
      (write) => ({ json: { id: target.id, ...(write.body as object), revision: 4 } }),
    ],
  );
  await toTypePage(page, 14);
  const line = page.locator('.ant-table-row').filter({ hasText: target.code });
  await line.getByRole('button', named('停用')).click();
  await confirmPop(page);
  await rereadAndConfirm(line);
  await line.getByRole('button', named('停用')).click();
  await confirmPop(page);
  await expect.poll(() => writes.length).toBe(2);
  expect(reads.some((url) => url.searchParams.get('page') === '2' && url.searchParams.get('pageSize') === '200')).toBe(
    true,
  );
  expect(writes.map(({ revision, body }) => [revision, body])).toEqual([
    ['2', { code: target.code, name: target.name, enabled: false }],
    ['3', { code: target.code, name: '他人改名类型', enabled: false }],
  ]);
});

test('AC-FE-R2a-29b 重读时本行已被删除：提示已删除，保持锁定，不再提交', async ({ page }) => {
  await setupContracts(page);
  let rows = [typeRow];
  const { writes } = await stub(
    page,
    '**/api/tenant/contracts/master-data/types?*',
    '**/api/tenant/contracts/master-data/types/type',
    () => rows,
    [
      () => {
        rows = [];
        return conflict;
      },
    ],
  );
  await tab(page, '合同类型');
  const table = page.locator('.ant-table');
  await table.getByRole('button', named('停用')).click();
  await confirmPop(page);
  await table.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await expect(table.getByText('该记录已被删除', { exact: false })).toBeVisible();
  await expect(table.getByRole('button', named('停用'))).toBeDisabled();
  expect(writes).toHaveLength(1);
});
