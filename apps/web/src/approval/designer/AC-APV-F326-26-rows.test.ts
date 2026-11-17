/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-326 F3 第 2 轮 P2-1（AC-APV-F326-26）：来源行要有稳定身份。会签节点删除前面的行后，
 * 后面行尚未完成的矩阵一级选择须随原行保留，不能串用被删行的状态。候选按后端真实形状，合成 ID。
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Form, type FormInstance } from 'antd';
import type { ApprovalNode, ApproverSource } from '@italent/domain';
import { act, h, uiHarness } from '../../../../../tests/acceptance/support/f474-ui.js';
import { flowFixture } from '../../../../../tests/acceptance/support/f315-fixture.js';
import { ApproverSources } from './ApproverSources.js';
import { candidateEndpoint } from './source-candidates.js';
import { nodeField } from './model.js';

const A = 'b3260000-0000-4000-8000-000000000011';
const A_COLUMN = 'b3260000-0000-4000-8000-000000000012';
const B = 'b3260000-0000-4000-8000-000000000021';
const B_COLUMN = 'b3260000-0000-4000-8000-000000000022';
// 与 designer-sources.ts listDesignerSources 同形：矩阵头无 multiple，角色列 id 为“矩阵:列”
const CANDIDATES = [
  { id: A, name: '甲矩阵', enabled: true, parentId: null },
  { id: `${A}:${A_COLUMN}`, name: '甲角色', enabled: true, parentId: A, multiple: false },
  { id: B, name: '乙矩阵', enabled: true, parentId: null },
  { id: `${B}:${B_COLUMN}`, name: '乙角色', enabled: true, parentId: B, multiple: false },
];
const candidates = (url: URL) => {
  const ids = url.searchParams.get('ids')?.split(',');
  const items = ids ? CANDIDATES.filter((item) => ids.includes(item.id)) : CANDIDATES;
  return { items, page: 1, pageSize: 200, hasMore: false };
};
const node = { ...flowFixture().latestVersion.nodes[0]!, kind: 'countersign' } as unknown as ApprovalNode;
const field = nodeField(node.key, 'approvers');

let ui: ReturnType<typeof uiHarness>;
let form: FormInstance | undefined;
beforeEach(() => {
  ui = uiHarness();
  form = undefined;
});
afterEach(async () => ui.close());

function Harness({ initial }: { initial: ApproverSource[] }) {
  const [instance] = Form.useForm();
  form = instance;
  return h(
    Form,
    { form: instance, initialValues: { [field]: initial } },
    h(ApproverSources, { node, approvalType: 'transfer' }),
  );
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
const rows = () => [...ui.host.querySelectorAll<HTMLElement>('.flow-source-row')];
const selectIn = (row: HTMLElement, label: string) =>
  [...row.querySelectorAll<HTMLElement>('.ant-select')].find((node) => node.querySelector(`[aria-label="${label}"]`))!;
const shown = (select: HTMLElement) => select.querySelector('.ant-select-selection-item')?.textContent ?? '';
// 只取该下拉自己的浮层：happy-dom 下先前打开的浮层不会隐藏，测试环境里各下拉的 aria-controls 又同号，
// 故按“打开时新出现的浮层”记下归属
const dropdowns = new Map<HTMLElement, Element>();
const allDropdowns = () => [...document.querySelectorAll('.ant-select-dropdown')];
const optionsOf = (select: HTMLElement) => [
  ...dropdowns.get(select)!.querySelectorAll<HTMLElement>('.ant-select-item-option'),
];
async function open(select: HTMLElement) {
  const before = new Set(allDropdowns());
  await act(async () => {
    select.querySelector('.ant-select-selector')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await settle();
  const added = allDropdowns().find((dropdown) => !before.has(dropdown));
  if (added) dropdowns.set(select, added);
  return optionsOf(select).map((option) => option.textContent);
}
async function pick(select: HTMLElement, name: string) {
  await open(select);
  const option = optionsOf(select).find((item) => item.textContent === name);
  expect(option, `选项 ${name}`).toBeDefined();
  await act(async () => option!.click());
  await settle();
}

it('AC-APV-F326-26-10 会签删除前一行后，后一行未完成的矩阵选择仍是乙，只给乙的角色列，载荷属于乙', async () => {
  const initial: ApproverSource[] = [
    { type: 'matrix', value: `${A}:${A_COLUMN}` },
    { type: 'matrix', value: '' },
  ];
  await ui.render(h(Harness, { initial }), '/', undefined, { [candidateEndpoint]: candidates });
  await settle();
  expect(shown(selectIn(rows()[0]!, '矩阵'))).toBe('甲矩阵');
  expect(shown(selectIn(rows()[0]!, '角色列'))).toBe('甲角色');
  // 第二行只选一级矩阵乙，暂不选角色列
  await pick(selectIn(rows()[1]!, '矩阵'), '乙矩阵');
  expect(shown(selectIn(rows()[1]!, '矩阵'))).toBe('乙矩阵');

  const remove = rows()[0]!.querySelector<HTMLButtonElement>('button[aria-label="移除来源"]')!;
  await act(async () => remove.click());
  await settle();

  expect(rows()).toHaveLength(1);
  const [left] = rows();
  expect(shown(selectIn(left!, '矩阵'))).toBe('乙矩阵');
  expect(await open(selectIn(left!, '角色列'))).toEqual(['乙角色']);
  await pick(selectIn(left!, '角色列'), '乙角色');
  expect(form!.getFieldValue(field)).toEqual([{ type: 'matrix', value: `${B}:${B_COLUMN}` }]);
});
