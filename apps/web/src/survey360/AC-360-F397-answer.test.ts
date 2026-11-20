// @vitest-environment happy-dom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../foundation/client.js';
import { ConflictCommands } from '../foundation/forms/ConflictCommands.js';
import { PortalAnswer } from './PortalAnswer.js';
import type { AnswerPage, PortalClient } from './portal-client.js';
let host: HTMLDivElement;
let root: Root;
let page: AnswerPage;
let api: PortalClient;
let requests: { path: string; method: string; body: unknown; command?: { id: string; revision?: number } }[];
let failure: 'reject' | 'unknown' | 'lost' | 'conflict' | 'stale' | undefined;
// 写请求在途：放行前响应不到达（用于构造“保存在途时继续作答”的时序）。
let gate: Promise<void> | undefined;
// 命令台账：落库的命令按 ID 记下当时的响应；同一 ID 重放返回原响应、不再落库（apps/api/src/commands.ts findReplay）。
let ledger: Map<string, AnswerPage['sheet']>;
const path = '/tasks/relation/questionnaires/questionnaire';
const text = () => host.textContent ?? '';
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
};
const render = async (open = true) => {
  await act(async () =>
    root.render(
      h(ConflictCommands, {
        children: open
          ? h(PortalAnswer, {
              api,
              path,
              initial: page,
              back: () => {
                root.render(h(ConflictCommands, { children: null }));
              },
            })
          : null,
      }),
    ),
  );
  await settle();
};
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.replace(/\s/g, '') === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
  await settle();
}
async function answer() {
  await act(async () => host.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  await settle();
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  requests = [];
  failure = undefined;
  gate = undefined;
  ledger = new Map();
  page = {
    activity: { name: '合成活动', status: 'enabled' },
    object: { name: '合成对象' },
    questionnaire: {
      id: 'questionnaire',
      name: '合成套卷',
      type: 'key_behavior',
      guide: null,
      items: [{ id: 'item', text: '合成题目', options: [{ id: 'option', label: '合成选项', remarkRequired: false }] }],
    },
    sheet: { status: 'pending', revision: 0, answers: [], suggestion: null },
  };
  api = {
    request: vi.fn(async (url = '', method = 'GET', body, command) => {
      if (method === 'GET') return structuredClone(page);
      requests.push({ path: url, method, body, ...(command ? { command } : {}) });
      if (gate) await gate;
      const stored = command && ledger.get(command.id);
      if (stored) return structuredClone(stored);
      if (failure === 'reject') throw new ApiError(400, 'VALIDATION_FAILED', 'fields', '请补充说明');
      if (failure === 'conflict') {
        page.sheet = { ...page.sheet, revision: 5, suggestion: '合成远端建议' };
        throw new ApiError(409, 'REVISION_CONFLICT', 'refresh', '版本冲突');
      }
      if (failure === 'stale') return { ...page.sheet };
      if (requests.length === 1 || failure !== 'unknown') {
        page.sheet = {
          ...page.sheet,
          ...(body as object),
          status: method === 'POST' ? 'submitted' : 'draft',
          revision: (command?.revision ?? 0) + 1,
        };
        if (command) ledger.set(command.id, structuredClone(page.sheet));
      }
      if (failure === 'unknown') throw new ApiError(503, 'RESULT_UNKNOWN', 'unknown', '结果待确认');
      // lost：服务端已落库、响应在途丢失（网络中断），回执不可得。
      if (failure === 'lost') throw new ApiError(0, 'NETWORK_ERROR', 'unknown', '结果待确认');
      return structuredClone(page.sheet);
    }) as PortalClient['request'],
  };
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('AC-360-F397 保存后按新 revision 提交；匿名姓名与角色不补造', async () => {
  await render();
  await answer();
  await click('立即保存');
  expect(text()).toContain('保存成功');
  await click('提交作答');
  expect(text()).toContain('提交成功');
  expect(requests.map((r) => [r.method, r.command?.revision])).toEqual([
    ['PUT', 0],
    ['POST', 1],
  ]);
  expect(requests[1]?.body).toEqual({});
  expect(text()).not.toContain('评价者姓名');
});
it('AC-360-F397 明确业务拒绝保留选择并允许改正重提', async () => {
  failure = 'reject';
  await render();
  await answer();
  await click('立即保存');
  expect(text()).toContain('请补充说明');
  expect(host.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true);
  failure = undefined;
  await click('立即保存');
  expect(text()).toContain('保存成功');
  expect(requests[0]?.command?.id).not.toBe(requests[1]?.command?.id);
});
it('AC-360-F397 409 重读回填未编辑字段，核对后用最新版本重提', async () => {
  failure = 'conflict';
  await render();
  await answer();
  await click('立即保存');
  await click('重读最新版本');
  await click('已核对差异，继续编辑');
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('合成远端建议');
  failure = undefined;
  await click('立即保存');
  expect(requests[1]?.command?.revision).toBe(5);
  expect(requests[1]?.body).toMatchObject({
    suggestion: '合成远端建议',
    answers: [{ itemId: 'item', optionId: 'option' }],
  });
});
for (const kind of ['unknown', 'stale'] as const)
  it(`AC-360-F397 ${kind} 回执锁定跨关闭重开，不生成新命令`, async () => {
    failure = kind;
    await render();
    await answer();
    await click('立即保存');
    expect(text()).toContain('结果待确认');
    await click('返回评价列表');
    await render();
    expect(text()).toContain('结果待确认');
    expect(host.querySelector<HTMLInputElement>('input[type="radio"]')?.disabled).toBe(true);
    await click('立即保存');
    expect(requests).toHaveLength(1);
    await click('回查原单');
    expect(text()).toContain('按原命令确认结果');
    failure = undefined;
    await click('按原命令确认结果');
    expect(requests[1]?.command).toEqual(requests[0]?.command);
    expect(requests[1]?.body).toEqual(requests[0]?.body);
  });
it('AC-360-F397 活动暂停与已提交答卷均只读', async () => {
  page.activity.status = 'disabled';
  await render();
  expect(text()).toContain('活动暂停中');
  expect(host.querySelector<HTMLInputElement>('input[type="radio"]')?.disabled).toBe(true);
  await click('立即保存');
  expect(requests).toHaveLength(0);
});

it('AC-360-F397 从要求说明的选项切换后不提交不可见的旧备注', async () => {
  page.questionnaire.items[0]!.options[0]!.remarkRequired = true;
  page.questionnaire.items[0]!.options.push({ id: 'second', label: '无需说明', remarkRequired: false });
  await render();
  await answer();
  const remark = host.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(remark, '合成说明');
    remark.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click());
  await click('立即保存');
  expect(requests[0]?.body).toMatchObject({ answers: [{ itemId: 'item', optionId: 'second', remark: '' }] });
});

const tick = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await settle();
};
const twoItems = () =>
  page.questionnaire.items.push({
    id: 'second-item',
    text: '合成题目二',
    options: [{ id: 'second-option', label: '合成选项二', remarkRequired: false }],
  });
const choose = async (index: number) => {
  await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[index]!.click());
  await settle();
};
const checked = () => [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((r) => r.checked);

// 审查 F-397 第 1 轮 P2-1：规格 E3-R22 作答页每 10 秒自动保存、支持断点续答。
it('AC-360-F397 E3-R22 每 10 秒自动保存草稿，返回列表再打开恢复作答', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  await render();
  await answer();
  await tick(9_000);
  expect(requests).toHaveLength(0);
  await tick(1_000);
  expect(requests.map((r) => [r.method, r.path, r.command?.revision])).toEqual([['PUT', path, 0]]);
  expect(requests[0]?.body).toMatchObject({ answers: [{ itemId: 'item', optionId: 'option' }] });
  await tick(30_000);
  expect(requests).toHaveLength(1);
  await click('返回评价列表');
  await render();
  expect(checked()).toEqual([true]);
});

it('AC-360-F397 E3-R22 未到自动保存就返回列表时先保存草稿，不丢答案', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  await render();
  await answer();
  const leave = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(leave);
  expect(leave.defaultPrevented).toBe(true);
  await click('返回评价列表');
  expect(requests.map((r) => [r.method, r.path])).toEqual([['PUT', path]]);
  await render();
  expect(checked()).toEqual([true]);
});

it('AC-360-F397 E3-R22 自动保存结果未知期间锁定，不另起保存命令', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  failure = 'unknown';
  await render();
  await answer();
  await tick(10_000);
  expect(text()).toContain('结果待确认');
  await tick(60_000);
  await click('返回评价列表');
  await render();
  await tick(60_000);
  expect(text()).toContain('结果待确认');
  expect(requests).toHaveLength(1);
});

// 审查 F-397 第 1 轮 P2-2：提交被拒 / 冲突后改走保存，结果未知的重放必须固定为原保存命令。
for (const refused of ['reject', 'conflict'] as const)
  it(`AC-360-F397 提交${refused === 'reject' ? '被拒' : '冲突'}后补答保存遇响应丢失，回查后按原保存命令重放`, async () => {
    twoItems();
    await render();
    await choose(0);
    await click('立即保存');
    expect(text()).toContain('保存成功');
    failure = refused;
    await click('提交作答');
    if (refused === 'conflict') {
      await click('重读最新版本');
      await click('已核对差异，继续编辑');
    } else expect(text()).toContain('请补充说明');
    failure = 'lost';
    await choose(1);
    await click('立即保存');
    expect(text()).toContain('结果待确认');
    failure = undefined;
    await click('回查原单');
    await click('按原命令确认结果');
    const [saved, submitted, lost, replayed] = requests;
    expect([saved, submitted, lost].map((r) => [r?.method, r?.path])).toEqual([
      ['PUT', path],
      ['POST', `${path}/submit`],
      ['PUT', path],
    ]);
    expect(requests).toHaveLength(4);
    expect([replayed?.method, replayed?.path]).toEqual([lost?.method, lost?.path]);
    expect(replayed?.command).toEqual(lost?.command);
    expect(replayed?.command?.revision).toBe(refused === 'conflict' ? 5 : 1);
    expect(replayed?.body).toEqual(lost?.body);
    expect(lost?.body).toMatchObject({
      answers: [
        { itemId: 'item', optionId: 'option' },
        { itemId: 'second-item', optionId: 'second-option' },
      ],
    });
    expect(text()).toContain('保存成功');
  });

const hold = () => {
  let open!: () => void;
  gate = new Promise<void>((resolve) => (open = resolve));
  return async () => {
    gate = undefined;
    await act(async () => open());
    await settle();
  };
};
const guarded = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
const suggestionBox = () =>
  [...host.querySelectorAll<HTMLTextAreaElement>('textarea')].find(
    (node) => node.getAttribute('aria-label') === '综合建议',
  );
const typeSuggestion = async (value: string) => {
  const box = suggestionBox()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};
const both = [
  { itemId: 'item', optionId: 'option' },
  { itemId: 'second-item', optionId: 'second-option' },
];

// 审查 F-397 第 2 轮 P2-A：返回列表的保存在途时新填的答案，回执后须先保存再离开。
it('AC-360-F397 返回列表的保存在途时新填的答案先保存再离开，重开两题都在', async () => {
  twoItems();
  await render();
  await choose(0);
  const release = hold();
  await click('返回评价列表');
  await choose(1);
  await release();
  await render();
  expect(checked()).toEqual([true, true]);
  expect(requests.map((r) => [r.method, r.path, r.command?.revision])).toEqual([
    ['PUT', path, 0],
    ['PUT', path, 1],
  ]);
  expect(requests[1]?.body).toMatchObject({ answers: both });
});

// 审查 F-397 第 2 轮 P2-B：自动保存在途时新填的答案与原命令快照分开保护；重放仍与原请求逐字节一致。
it('AC-360-F397 自动保存在途时新填的答案，响应丢失后回查原单仍保留，离开仍提示，按原命令重放', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  twoItems();
  await render();
  await choose(0);
  const release = hold();
  failure = 'lost';
  await tick(10_000);
  await choose(1);
  await release();
  expect(text()).toContain('结果待确认');
  expect(checked()).toEqual([true, true]);
  expect(guarded()).toBe(true);
  // 返回列表会丢掉在途后新填的内容：留在本页提示，不离开。
  await click('返回评价列表');
  expect(checked()).toEqual([true, true]);
  expect(text()).toContain('有尚未保存的作答内容');
  failure = undefined;
  await click('回查原单');
  expect(checked()).toEqual([true, true]);
  expect(guarded()).toBe(true);
  await click('按原命令确认结果');
  const [lost, replayed] = requests;
  expect([replayed?.method, replayed?.path]).toEqual([lost?.method, lost?.path]);
  expect(replayed?.command).toEqual(lost?.command);
  expect(replayed?.body).toEqual(lost?.body);
  expect(lost?.body).toMatchObject({ answers: [{ itemId: 'item', optionId: 'option' }] });
  expect(checked()).toEqual([true, true]);
  await tick(10_000);
  expect(requests.map((r) => [r.method, r.command?.revision])).toEqual([
    ['PUT', 0],
    ['PUT', 0],
    ['PUT', 1],
  ]);
  expect(requests[2]?.body).toMatchObject({ answers: both });
});

it('AC-360-F397 自动保存在途时新填的答案，版本冲突重读后仍保留，离开仍提示', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  twoItems();
  await render();
  await choose(0);
  const release = hold();
  failure = 'conflict';
  await tick(10_000);
  await choose(1);
  await release();
  failure = undefined;
  await click('重读最新版本');
  expect(checked()).toEqual([true, true]);
  expect(guarded()).toBe(true);
  await click('已核对差异，继续编辑');
  expect(checked()).toEqual([true, true]);
  await click('立即保存');
  expect(requests[1]?.command?.revision).toBe(5);
  expect(requests[1]?.body).toMatchObject({ answers: both, suggestion: '合成远端建议' });
});

// 审查 F-397 第 2 轮 P2-C：F-123 §136 核对只解锁；下次写入须由用户显式发起（新输入或点保存）。
it('AC-360-F397 冲突核对后不自动保存，用户改动后才按周期保存', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  await render();
  await answer();
  failure = 'conflict';
  await click('立即保存');
  failure = undefined;
  await click('重读最新版本');
  await click('已核对差异，继续编辑');
  await tick(30_000);
  expect(requests).toHaveLength(1);
  await typeSuggestion('合成核对后建议');
  await tick(10_000);
  expect(requests.map((r) => [r.method, r.command?.revision])).toEqual([
    ['PUT', 0],
    ['PUT', 5],
  ]);
  expect(requests[1]?.body).toMatchObject({ suggestion: '合成核对后建议' });
});

// 审查 F-397 第 3 轮 P2-1：活动暂停后不得补写，但页面上未保存的内容仍须拦截刷新与返回，不能静默丢稿。
it('AC-360-F397 保存在途时新填的答案，响应丢失后活动暂停：按原命令确认后不补写，刷新与返回仍拦截', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  twoItems();
  await render();
  await choose(0);
  const release = hold();
  failure = 'lost';
  await tick(10_000);
  await choose(1);
  await release();
  expect(text()).toContain('结果待确认');
  failure = undefined;
  page.activity.status = 'disabled';
  await click('回查原单');
  await click('按原命令确认结果');
  expect(text()).toContain('保存成功');
  expect(checked()).toEqual([true, true]);
  expect(guarded()).toBe(true);
  await click('返回评价列表');
  expect(checked()).toEqual([true, true]);
  expect(text()).toContain('活动已暂停，未保存内容无法提交');
  await tick(30_000);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.body).toEqual(requests[0]?.body);
});

// 审查 F-397 第 3 轮 P2-3：冲突核对后整卷与最新记录一致即无未保存内容，可直接返回，不发保存。
it('AC-360-F397 保存在途时把建议改成另一页签已保存的同一值，冲突核对后可直接返回，不发保存', async () => {
  await render();
  await typeSuggestion('合成本页建议');
  const release = hold();
  failure = 'conflict';
  await click('立即保存');
  await typeSuggestion('合成远端建议');
  await release();
  failure = undefined;
  await click('重读最新版本');
  await click('已核对差异，继续编辑');
  expect(guarded()).toBe(false);
  await click('返回评价列表');
  expect(host.querySelector('textarea')).toBeNull();
  expect(requests).toHaveLength(1);
});

// 核对表一行的“我的输入”列（按表头定位，不依赖列序）。
const mineCell = (label: string) => {
  const column = [...host.querySelectorAll('th')].findIndex((th) => th.textContent === '我的输入');
  const row = [...host.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent === label);
  return row?.querySelectorAll('td')[column]?.textContent;
};
// 审查 F-397 第 3 轮 P2-4：核对表展示的“我的输入”须是核对后将要保存的实时草稿，不是在途命令的快照。
it('AC-360-F397 保存在途改了建议又遇冲突：核对表“我的输入”与随后显式保存的请求体一致', async () => {
  await render();
  await typeSuggestion('合成发出值');
  const release = hold();
  failure = 'conflict';
  await click('立即保存');
  await typeSuggestion('合成新值');
  await release();
  failure = undefined;
  await click('重读最新版本');
  const mine = mineCell('综合建议');
  await click('已核对差异，继续编辑');
  await click('立即保存');
  expect(requests[0]?.body).toMatchObject({ suggestion: '合成发出值' });
  expect(requests[1]?.command?.revision).toBe(5);
  expect(mine).toBe(JSON.stringify((requests[1]?.body as { suggestion?: string }).suggestion));
});
// 第 4 轮结构改动（重开恢复不再经内核回填推送，改为挂载时按槽恢复）的不回退守卫：
// 结果未知时页面真正卸载再打开，仍显示已发出的命令快照、仍锁定，返回与刷新照常拦截，不生成新命令。
it('AC-360-F397 结果未知时卸载重开：恢复已发出的答卷并保持锁定，回查重放原命令后才可返回', async () => {
  failure = 'stale';
  await render();
  await answer();
  await click('立即保存');
  expect(text()).toContain('结果待确认');
  await render(false);
  expect(host.querySelector('input[type="radio"]')).toBeNull();
  await render();
  expect(checked()).toEqual([true]);
  expect(host.querySelector<HTMLInputElement>('input[type="radio"]')?.disabled).toBe(true);
  expect(guarded()).toBe(true);
  await click('返回评价列表');
  expect(text()).toContain('有尚未保存的作答内容');
  expect(requests).toHaveLength(1);
  failure = undefined;
  await click('回查原单');
  await click('按原命令确认结果');
  expect(requests[1]?.command).toEqual(requests[0]?.command);
  expect(guarded()).toBe(false);
  await click('返回评价列表');
  expect(host.querySelector('input[type="radio"]')).toBeNull();
  expect(requests).toHaveLength(2);
});
// 离开循环的保护：回执与本页答卷按比较口径仍不一致、期间又没有新输入时，停下提示，不反复发送。
it('AC-360-F397 回执与本页答卷口径不一致时，返回只保存一次并提示，不反复发送', async () => {
  const base = api.request;
  api.request = (async (...args: Parameters<PortalClient['request']>) => {
    const value = await base(...args);
    return args[1] === 'PUT' ? { ...(value as object), suggestion: '合成改写建议' } : value;
  }) as PortalClient['request'];
  await render();
  await answer();
  await typeSuggestion('合成本页建议');
  await click('返回评价列表');
  expect(requests).toHaveLength(1);
  expect(text()).toContain('有尚未保存的作答内容');
  expect(host.querySelector('textarea')?.value).toBe('合成本页建议');
});

const radio = () => host.querySelector<HTMLInputElement>('input[type="radio"]');
// —— 第 5 轮：状态采用决策表（结果文件）逐格用例。P2-A～D 为第 4 轮审查复现场景，其余为表内补格。——

// 审查 F-397 第 4 轮 P2-A：发出后改回旧确认值（清空建议）也是编辑，回执不得覆盖；补存空值后才离开。
it('AC-360-F397 返回列表的保存在途时清空建议：回执后补存空值再离开，重开为空', async () => {
  await render();
  await typeSuggestion('合成撤回建议');
  const release = hold();
  await click('返回评价列表');
  expect(guarded()).toBe(true);
  await typeSuggestion('');
  await release();
  expect(requests.map((r) => [r.method, r.command?.revision])).toEqual([
    ['PUT', 0],
    ['PUT', 1],
  ]);
  expect(requests[1]?.body).toMatchObject({ suggestion: '' });
  expect(radio()).toBeNull();
  await render();
  expect(suggestionBox()?.value).toBe('');
});

// 决策表“回查命中 × dirty”：结果未知期间改回旧值，回查读到原命令已落库也不得用服务端值覆盖。
it('AC-360-F397 保存在途清空建议后响应丢失：回查与按原命令确认后仍为空，显式保存补存空值', async () => {
  await render();
  await typeSuggestion('合成发出建议');
  const release = hold();
  failure = 'lost';
  await click('立即保存');
  await typeSuggestion('');
  await release();
  expect(text()).toContain('结果待确认');
  failure = undefined;
  await click('回查原单');
  expect(suggestionBox()?.value).toBe('');
  await click('按原命令确认结果');
  expect(suggestionBox()?.value).toBe('');
  expect(guarded()).toBe(true);
  await click('立即保存');
  expect(requests.map((r) => [r.method, r.command?.revision])).toEqual([
    ['PUT', 0],
    ['PUT', 0],
    ['PUT', 1],
  ]);
  expect(requests[2]?.body).toMatchObject({ suggestion: '' });
});

// 审查 F-397 第 4 轮 P2-B：原命令未确认时两端内容一致也拦刷新与返回；按原命令确认后才放行。
it('AC-360-F397 响应丢失后回查两端一致：刷新与返回仍拦截，按原命令确认后才可离开', async () => {
  failure = 'lost';
  await render();
  await answer();
  await click('立即保存');
  expect(text()).toContain('结果待确认');
  failure = undefined;
  await click('回查原单');
  expect(text()).toContain('按原命令确认结果');
  expect(guarded()).toBe(true);
  await click('返回评价列表');
  expect(radio()).not.toBeNull();
  expect(text()).toContain('有尚未保存的作答内容');
  expect(requests).toHaveLength(1);
  await click('按原命令确认结果');
  expect(requests[1]?.command).toEqual(requests[0]?.command);
  expect(guarded()).toBe(false);
  await click('返回评价列表');
  expect(radio()).toBeNull();
  expect(requests).toHaveLength(2);
});

// 审查 F-397 第 4 轮 P2-C：核对后干净离开，重开以新 GET 为准，不恢复已确认失败的旧命令快照。
it('AC-360-F397 冲突核对后两端一致正常返回，重开以服务端答卷为准且不拦截', async () => {
  await render();
  await typeSuggestion('合成本页建议');
  const release = hold();
  failure = 'conflict';
  await click('立即保存');
  await typeSuggestion('合成远端建议');
  await release();
  failure = undefined;
  await click('重读最新版本');
  await click('已核对差异，继续编辑');
  await click('返回评价列表');
  expect(suggestionBox()).toBeUndefined();
  await render();
  expect(suggestionBox()?.value).toBe('合成远端建议');
  expect(guarded()).toBe(false);
  expect(requests).toHaveLength(1);
});

// 决策表“GET 重开 × 无未确认命令”：被拒的命令已确定失败，卸载重开以 GET 为准，不再显示旧草稿与拒绝原因。
it('AC-360-F397 保存被拒后卸载重开：以服务端答卷为准，不恢复被拒草稿', async () => {
  failure = 'reject';
  await render();
  await typeSuggestion('合成被拒建议');
  await click('立即保存');
  expect(text()).toContain('请补充说明');
  await render(false);
  await render();
  expect(suggestionBox()?.value).toBe('');
  expect(text()).not.toContain('请补充说明');
  expect(guarded()).toBe(false);
});

// 决策表“GET 重开 × 有未确认命令”：只恢复命令改过的字段，其余字段取重开时的新 GET。
it('AC-360-F397 结果未知时卸载重开：命令改过的题目按命令快照恢复，未改的建议取新 GET', async () => {
  failure = 'stale';
  await render();
  await answer();
  await click('立即保存');
  await render(false);
  page.sheet = { ...page.sheet, suggestion: '合成他页建议', revision: 1, status: 'draft' };
  await render();
  expect(checked()).toEqual([true]);
  expect(radio()?.disabled).toBe(true);
  expect(suggestionBox()?.value).toBe('合成他页建议');
  expect(guarded()).toBe(true);
  expect(requests).toHaveLength(1);
});

// 审查 F-397 第 4 轮 P2-D：重放回执是台账里的旧响应，只确认旧命令成功，不得把已读到的 submitted 与更高 revision 降回。
it('AC-360-F397 保存响应丢失后另一页签已提交：按原命令确认后答卷仍为已提交只读', async () => {
  await render();
  await answer();
  failure = 'lost';
  await click('立即保存');
  failure = undefined;
  page.sheet = { ...page.sheet, status: 'submitted', revision: 2 };
  await click('回查原单');
  await click('按原命令确认结果');
  expect(requests[1]?.command).toEqual(requests[0]?.command);
  expect(requests[1]?.body).toEqual(requests[0]?.body);
  expect(page.sheet).toMatchObject({ status: 'submitted', revision: 2 });
  expect(radio()?.disabled).toBe(true);
  expect(suggestionBox()?.disabled).toBe(true);
  expect(text()).toContain('答卷已提交');
  expect(guarded()).toBe(false);
  await click('返回评价列表');
  expect(radio()).toBeNull();
  expect(requests).toHaveLength(2);
});

// 决策表“重放回执（历史）”：另一页签已存更高 revision 的草稿时，旧回执不降基线；页面仍有未保存内容，
// 但不自动覆盖（同核对后，F-123 §136），离开提示，用户显式保存时按已读到的 revision 发出。
it('AC-360-F397 保存响应丢失后另一页签已存新草稿：旧回执不降 revision、不自动覆盖，显式保存按新 revision', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  await render();
  await answer();
  const release = hold();
  failure = 'lost';
  await click('立即保存');
  await typeSuggestion('合成本页建议');
  await release();
  failure = undefined;
  page.sheet = { ...page.sheet, suggestion: '合成他页建议', revision: 2 };
  await click('回查原单');
  await click('按原命令确认结果');
  expect(suggestionBox()?.value).toBe('合成本页建议');
  await tick(30_000);
  expect(requests).toHaveLength(2);
  expect(guarded()).toBe(true);
  await click('返回评价列表');
  expect(text()).toContain('有尚未保存的作答内容');
  await click('立即保存');
  expect(requests.map((r) => [r.method, r.command?.revision])).toEqual([
    ['PUT', 0],
    ['PUT', 0],
    ['PUT', 2],
  ]);
  expect(requests[2]?.body).toMatchObject({ suggestion: '合成本页建议' });
});

// 决策表“409 重读 × dirty”：发出后改回旧值，重读不得用远端值覆盖（本页为准，DEC-936），核对后显式保存发出空值。
it('AC-360-F397 保存在途清空建议后版本冲突：重读保留空值，核对后显式保存发出空值', async () => {
  await render();
  await typeSuggestion('合成本页建议');
  const release = hold();
  failure = 'conflict';
  await click('立即保存');
  await typeSuggestion('');
  await release();
  failure = undefined;
  await click('重读最新版本');
  expect(suggestionBox()?.value).toBe('');
  await click('已核对差异，继续编辑');
  expect(guarded()).toBe(true);
  await click('立即保存');
  expect(requests[1]?.command?.revision).toBe(5);
  expect(requests[1]?.body).toMatchObject({ suggestion: '' });
});

// 决策表“输入 × dirty”：按编辑事件判定，改了又改回也算有过编辑；拦刷新，返回时补存一次再离开。
it('AC-360-F397 改了又改回仍算有过编辑：拦刷新，返回先保存再离开', async () => {
  await render();
  await typeSuggestion('合成临时建议');
  await typeSuggestion('');
  expect(guarded()).toBe(true);
  await click('返回评价列表');
  expect(requests.map((r) => [r.method, r.command?.revision])).toEqual([['PUT', 0]]);
  expect(requests[0]?.body).toMatchObject({ suggestion: '' });
  expect(radio()).toBeNull();
});

// 决策表“被拒 × 离开守卫”：被拒的同一份草稿不自动重发，刷新与返回都拦截。
it('AC-360-F397 保存被拒后刷新与返回均拦截，不自动重发', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  failure = 'reject';
  await render();
  await answer();
  await click('立即保存');
  await tick(30_000);
  expect(guarded()).toBe(true);
  await click('返回评价列表');
  expect(radio()).not.toBeNull();
  expect(text()).toContain('有尚未保存的作答内容');
  expect(requests).toHaveLength(1);
});

// 决策表“保存回执（提交）× 可编辑性 / 离开守卫”：提交回执后只读、无未保存内容，可直接返回。
it('AC-360-F397 提交回执后只读，无未保存内容时直接返回', async () => {
  await render();
  await answer();
  await click('立即保存');
  await click('提交作答');
  expect(radio()?.disabled).toBe(true);
  expect(suggestionBox()?.disabled).toBe(true);
  expect(guarded()).toBe(false);
  await click('返回评价列表');
  expect(radio()).toBeNull();
  expect(requests.map((r) => r.method)).toEqual(['PUT', 'POST']);
});
