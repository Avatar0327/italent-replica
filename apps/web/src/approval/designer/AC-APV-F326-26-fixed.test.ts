/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-326 F3 第 3 轮 P2-2（AC-APV-F326-26）：来源值下拉的固定取值与候选对象合并后 value 唯一。
 * 已选的动态引用（变量 / 身份 UUID）不得再作为“来源信息未读取”禁用项混进固定取值；身份候选里的命名来源
 * （system_admin）与固定取值同值时只出现一次。反复切换来源值后候选稳定、无残留、无重复 key 告警。
 * 候选按后端 designer-sources.ts 真实形状（变量 name 为“名称（编码）”，身份含命名来源行），合成 ID。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Form } from 'antd';
import type { ApprovalNode, ApproverSource, ApproverSourceType } from '@italent/domain';
import { act, h, uiHarness } from '../../../../../tests/acceptance/support/f474-ui.js';
import { flowFixture } from '../../../../../tests/acceptance/support/f315-fixture.js';
import { ApproverSources } from './ApproverSources.js';
import { candidateEndpoint } from './source-candidates.js';
import { s } from './source-messages.js';
import { nodeField } from './model.js';

const A = 'b3260000-0000-4000-8000-000000000031';
const B = 'b3260000-0000-4000-8000-000000000032';
const node = flowFixture().latestVersion.nodes[0]! as unknown as ApprovalNode;
const field = nodeField(node.key, 'approver');
const variables = (code: string) => [
  { id: A, name: `合成甲（${code}.A）`, enabled: true, parentId: null, multiple: false },
  { id: B, name: `合成乙（${code}.B）`, enabled: true, parentId: null, multiple: false },
];
// 身份候选：身份方案行 + 命名来源 system_admin（designer-sources.ts namedRows，id 即来源值）
const identities = [
  { id: A, name: '合成甲身份', enabled: true, parentId: null },
  { id: B, name: '合成乙身份', enabled: true, parentId: null },
  { id: 'system_admin', name: '系统管理员', enabled: true, parentId: null },
];
const CANDIDATES: Partial<Record<ApproverSourceType, object[]>> = {
  public_variable: variables('Global.B'),
  application_variable: variables('Transfer.B'),
  identity: identities,
};
const candidates = (url: URL) => {
  const all = (CANDIDATES[url.searchParams.get('type') as ApproverSourceType] ?? []) as { id: string }[];
  const ids = url.searchParams.get('ids')?.split(',');
  return { items: ids ? all.filter((item) => ids.includes(item.id)) : all, page: 1, pageSize: 50, hasMore: false };
};

let ui: ReturnType<typeof uiHarness>;
let errors: string[];
beforeEach(() => {
  ui = uiHarness();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
});
afterEach(async () => {
  await ui.close();
  vi.restoreAllMocks();
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
const valueSelect = () =>
  [...ui.host.querySelectorAll<HTMLElement>('.flow-source-row')[0]!.querySelectorAll<HTMLElement>('.ant-select')].find(
    (node) => node.querySelector(`[aria-label="${s.value}"]`),
  )!;
// happy-dom 下已关闭的浮层不隐藏；来源值下拉只有一个，取其首次打开时新出现的浮层
let dropdown: Element | undefined;
async function open() {
  const before = new Set(document.querySelectorAll('.ant-select-dropdown'));
  await act(async () => {
    valueSelect()
      .querySelector('.ant-select-selector')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await settle();
  dropdown ??= [...document.querySelectorAll('.ant-select-dropdown')].find((item) => !before.has(item));
  return [...dropdown!.querySelectorAll<HTMLElement>('.ant-select-item-option')];
}
async function pick(name: string) {
  const option = (await open()).find((item) => item.textContent === name);
  expect(option, `选项 ${name}`).toBeDefined();
  await act(async () => option!.click());
  await settle();
}
async function cycle(type: ApproverSourceType, expected: string[], a: string, b: string) {
  dropdown = undefined;
  const initial: ApproverSource = { type, value: A };
  await ui.render(
    h(Form, { initialValues: { [field]: initial } }, h(ApproverSources, { node, approvalType: 'transfer' })),
    '/',
    undefined,
    { [candidateEndpoint]: candidates },
  );
  await settle();
  const first = (await open()).map((item) => item.textContent);
  for (const name of [b, a, b]) await pick(name);
  const last = (await open()).map((item) => item.textContent);
  expect(last).toEqual(expected);
  expect(first).toEqual(expected);
  expect(last).not.toContain(s.unknown);
  expect(errors.filter((line) => line.includes('same key'))).toEqual([]);
}

it('AC-APV-F326-26-11 公共变量：甲→乙→甲→乙反复切换后候选稳定为甲、乙，无“来源信息未读取”残留，无重复 key', async () => {
  const [a, b] = ['合成甲（Global.B.A）', '合成乙（Global.B.B）'];
  await cycle('public_variable', [a, b], a, b);
});

it('AC-APV-F326-26-12 应用变量：反复切换来源值后候选稳定，无残留禁用项，无重复 key', async () => {
  const [a, b] = ['合成甲（Transfer.B.A）', '合成乙（Transfer.B.B）'];
  await cycle('application_variable', [a, b], a, b);
});

it('AC-APV-F326-26-13 身份：反复切换后固定取值 + 甲、乙各一次，命名来源 system_admin 不与固定取值重复', async () => {
  // 固定取值（调动下离职交接人事管理员受限）+ 候选；system_admin 只以固定取值出现一次，名称与后端一致
  const fixed = ['离职交接 → 人事管理员 · 该审批类型不可选', '系统管理员'];
  await cycle('identity', [...fixed, '合成甲身份', '合成乙身份'], '合成甲身份', '合成乙身份');
});
