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
