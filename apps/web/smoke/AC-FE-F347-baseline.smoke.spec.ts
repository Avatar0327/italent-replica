import type { Page } from '@playwright/test';
import { test, expect, employee } from './fixtures.js';
import { businessId, openDetail, setup, type Server } from './probation-fixtures.js';
import { actionButton } from './action-button.js';

// F-347 冲突基线自查矩阵（rf347_2，DEC-385③ 问 2）：入口 × 场景 → 实际发出的请求与服务端最终值。
// 冲突核对后用户明确做出的选择必须原样送达服务端；没改的字段跟随服务端最新值。
const draftPath = `/api/tenant/employment/employees/${employee}/regularization-draft`;
const businessPath = `/api/tenant/employment/businesses/${businessId}`;
const submitPath = `${businessPath}/submit`;
const names = { pass: '合成通过', extend: '合成延期', third: '合成第三' } as const;
type Code = keyof typeof names;
/** none 无冲突；theirs 冲突后保留对方值；back 冲突后改回原值；third 冲突后改成第三个值；again 成功暂存后再冲突。 */
type Scene = 'none' | 'theirs' | 'back' | 'third' | 'again';
type Entry = 'draft-patch' | 'draft-submit' | 'stage' | 'stage-recovered';
type Write = [method: string, path: string, ifMatch: string, body?: Record<string, unknown>];
interface Cell {
  entry: Entry;
  scene: Scene;
  writes: Write[];
  final: Record<string, unknown>;
}

const dialog = (page: Page) => page.getByRole('dialog', { name: '转正申请', exact: true });
type Form = ReturnType<typeof dialog>;
const selected = (form: Form) =>
  form.locator('.ant-form-item').filter({ hasText: '试用结果' }).locator('.ant-select-selection-item');
const stageButton = (form: Form) => form.getByRole('button', { name: /暂\s*存$/ });
const dateInput = (form: Form) => form.getByLabel('转正日期', { exact: true });
async function pick(page: Page, form: Form, code: Code) {
  await form
    .getByRole('combobox', { name: '试用结果', exact: true })
    .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .click();
  await page.locator('.ant-select-dropdown:visible').getByText(names[code], { exact: true }).click();
}
const choices: Partial<Record<Scene, Code>> = { back: 'pass', third: 'third' };
const choice = (scene: Scene) => choices[scene];

async function open(page: Page, prepare: (server: Server) => void) {
  const { server } = await setup(page);
  server.results.push(
    { code: 'extend', name: names.extend, enabled: true },
    { code: 'third', name: names.third, enabled: true },
  );
  prepare(server);
  await page.reload();
  await openDetail(page);
  await actionButton(page, '转正申请').click();
  return { server, form: dialog(page) };
}
/** 409 后核对差异：表单先显示对方的值，再按场景做出用户自己的选择。 */
async function review(page: Page, form: Form, scene: Scene, reread: boolean) {
  await expect(form).toContainText('版本冲突');
  if (reread) await actionButton(form, '重读最新版本').click();
  await actionButton(form, '已核对差异，继续编辑').click();
  await expect(selected(form)).toHaveText(names.extend);
  const code = choice(scene);
  if (code) await pick(page, form, code);
}

/**
 * 撤回回草稿的申请单 rev3 {11-01, pass}；冲突 = 另一会话把结果改成 extend（rev4）。
 * PATCH 入口先改日期，submit 入口不改。
 */
async function draftCell(page: Page, cell: Cell) {
  const { server, form } = await open(page, (server) => {
    server.business = {
      revision: 3,
      status: 'draft',
      mode: 'application',
      effectiveDate: '2026-11-01',
      probationResult: 'pass',
    };
  });
  await expect(form).toContainText('已带出原申请');
  if (cell.scene !== 'none')
    server.business = {
      ...server.business!,
      revision: 4,
      probationResult: 'extend',
      probationResultName: names.extend,
    };
  if (cell.entry === 'draft-patch') await dateInput(form).fill('2026-11-10');
  await actionButton(form, '提交').click();
  if (cell.scene !== 'none') {
    await review(page, form, cell.scene, false);
    await actionButton(form, '提交').click();
  }
  await expect(form).toHaveCount(0);
  return { server, final: server.business };
}

/** 暂存：stage 无暂存（rev0）；stage-recovered 恢复 rev1 {11-15, pass}。冲突 = 另一会话暂存了 {11-15, extend}。 */
async function stageCell(page: Page, cell: Cell) {
  const { server, form } = await open(page, (server) => {
    if (cell.entry !== 'stage-recovered') return;
    server.temporary = { effectiveDate: '2026-11-15', probationResult: 'pass' };
    server.temporaryRevision = 1;
  });
  if (cell.entry === 'stage-recovered') await expect(selected(form)).toHaveText(names.pass);
  if (cell.scene === 'again') {
    await pick(page, form, 'pass');
    await stageButton(form).click();
    await expect.poll(() => server.temporaryRevision).toBe(1);
    await expect(stageButton(form)).toBeEnabled();
  }
  if (cell.scene !== 'none') {
    server.temporary = { effectiveDate: '2026-11-15', probationResult: 'extend' };
    server.temporaryRevision += 1;
  }
  await dateInput(form).fill(cell.scene === 'again' ? '2026-11-25' : '2026-11-20');
  await stageButton(form).click();
  if (cell.scene !== 'none') {
    await review(page, form, cell.scene, true);
    await stageButton(form).click();
  }
  await expect.poll(() => server.writes.length).toBe(cell.writes.length);
  await expect(page.getByText('已暂存', { exact: true })).toBeVisible();
  return { server, final: server.temporary };
}

const D = '2026-11-10';
const patch = (ifMatch: string, body: Record<string, unknown>): Write => ['PATCH', businessPath, ifMatch, body];
const submit = (ifMatch: string): Write => ['POST', submitPath, ifMatch];
const put = (ifMatch: string, body: Record<string, unknown>): Write => ['PUT', draftPath, ifMatch, body];
const stage = (effectiveDate: string, probationResult: string | null) => ({ effectiveDate, probationResult });
const cells: Cell[] = [
  {
    entry: 'draft-patch',
    scene: 'none',
    writes: [patch('3', { effectiveDate: D }), submit('4')],
    final: stage(D, 'pass'),
  },
  ...(['theirs', 'back', 'third'] as const).map((scene): Cell => {
    const result = choice(scene) ?? 'extend';
    const body = scene === 'theirs' ? { effectiveDate: D } : { effectiveDate: D, probationResult: result };
    return {
      entry: 'draft-patch',
      scene,
      writes: [patch('3', { effectiveDate: D }), patch('4', body), submit('5')],
      final: stage(D, result),
    };
  }),
  { entry: 'draft-submit', scene: 'none', writes: [submit('3')], final: stage('2026-11-01', 'pass') },
  { entry: 'draft-submit', scene: 'theirs', writes: [submit('3'), submit('4')], final: stage('2026-11-01', 'extend') },
  ...(['back', 'third'] as const).map((scene): Cell => ({
    entry: 'draft-submit',
    scene,
    writes: [submit('3'), patch('4', { probationResult: choice(scene) }), submit('5')],
    final: stage('2026-11-01', choice(scene)!),
  })),
  { entry: 'stage', scene: 'none', writes: [put('0', stage('2026-11-20', null))], final: stage('2026-11-20', null) },
  // 无暂存时“原值”是空结果：下拉没有清空项，改回原值不可操作，矩阵不列
  ...(['theirs', 'third'] as const).map((scene): Cell => ({
    entry: 'stage',
    scene,
    writes: [put('0', stage('2026-11-20', null)), put('1', stage('2026-11-20', choice(scene) ?? 'extend'))],
    final: stage('2026-11-20', choice(scene) ?? 'extend'),
  })),
  {
    entry: 'stage',
    scene: 'again',
    writes: [
      put('0', stage('2026-11-01', 'pass')),
      put('1', stage('2026-11-25', 'pass')),
      put('2', stage('2026-11-25', 'extend')),
    ],
    final: stage('2026-11-25', 'extend'),
  },
  {
    entry: 'stage-recovered',
    scene: 'none',
    writes: [put('1', stage('2026-11-20', 'pass'))],
    final: stage('2026-11-20', 'pass'),
  },
  ...(['theirs', 'back', 'third'] as const).map((scene): Cell => ({
    entry: 'stage-recovered',
    scene,
    writes: [put('1', stage('2026-11-20', 'pass')), put('2', stage('2026-11-20', choice(scene) ?? 'extend'))],
    final: stage('2026-11-20', choice(scene) ?? 'extend'),
  })),
];

for (const cell of cells) {
  test(`AC-FE-F347-基线矩阵 ${cell.entry} × ${cell.scene}`, async ({ page }) => {
    const run = cell.entry.startsWith('draft') ? draftCell : stageCell;
    const { server, final } = await run(page, cell);
    const sent = server.writes.map(({ method, path, ifMatch, body }, index) =>
      cell.writes[index]?.[3] === undefined ? [method, path, ifMatch] : [method, path, ifMatch, body],
    );
    expect(sent).toEqual(cell.writes);
    expect(final).toMatchObject(cell.final);
    if (cell.entry.startsWith('draft')) expect(final).toMatchObject({ status: 'in_review' });
  });
}
