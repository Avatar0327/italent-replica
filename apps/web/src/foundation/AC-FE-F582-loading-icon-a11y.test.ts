// @vitest-environment happy-dom
/**
 * F-582：antd 5 Button 的 loading 图标（DefaultLoadingIcon，rc-motion removeOnLeave）在 loading 结束后
 * 要等离场动画 transitionend 才移出 DOM；happy-dom 没有过渡事件，图标会一直留着，正好确定性复现
 * “图标不可见但可访问名仍为 loading 保 存”。回到正常态后可访问名应只剩按钮文字；加载中仍带
 * img「loading」（冒烟 AC-FE-R1c / R2b2 按它断言加载态），忙碌期间不可重复提交，结束后立即可点。
 * 夹具：门户登录失败照 apps/api survey360/portal.ts（401 UNAUTHENTICATED + LOGIN_FAILED_MESSAGE），
 * 表单保存冲突照 errors.ts 错误信封（409 REVISION_CONFLICT）。
 */
import { Button } from 'antd';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { ApiError } from './client.js';
import { FormOverlay } from './FormOverlay.js';

const PORTAL = '/survey360/portal/10000000-0000-4000-8000-000000000001';
const LOGIN_FAILED = '您输入的密码和序列号不匹配，请重新输入';
const roots: { host: HTMLElement; root: Root }[] = [];
let replies: ((response: Response) => void)[];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState({}, '', PORTAL);
  sessionStorage.clear();
  replies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => replies.push(resolve))),
  );
});
afterEach(async () => {
  for (const { host, root } of roots.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function mount(node: Parameters<Root['render']>[0]) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ host, root });
  await act(async () => root.render(node));
  return { host, root };
}
async function settle() {
  for (let i = 0; i < 4; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
}
/**
 * accname 的简化实现，只覆盖本单用到的规则：aria-hidden 子树不计，带 aria-label 的元素取标签，
 * 其余取文本；真实浏览器的计算由冒烟 AC-FE-F582 用 Playwright toHaveAccessibleName 复核。
 */
function accessibleName(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element) || node.getAttribute('aria-hidden') === 'true') return '';
  const label = node.getAttribute('aria-label');
  if (label) return label;
  return [...node.childNodes].map(accessibleName).join(' ');
}
const nameOf = (button: Element) => accessibleName(button).replace(/\s+/g, ' ').trim();
const loadingIcon = (button: Element) => button.querySelector('.ant-btn-loading-icon');

async function submitLogin(host: HTMLElement) {
  for (const name of ['serial', 'password']) {
    const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, crypto.randomUUID());
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  await act(async () =>
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  await settle();
}

it('AC-FE-F582 门户登录失败回到正常态后，可访问名只剩按钮文字，按钮立即可点', async () => {
  const { host } = await mount(h(App));
  await submitLogin(host);
  const login = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  // 加载中：沿用现状，带 loading 图标与 ant-btn-loading；重复提交不发第二个请求。
  expect(login.classList.contains('ant-btn-loading')).toBe(true);
  expect(nameOf(login)).toBe('loading 登 录');
  await act(async () => login.click());
  await settle();
  expect(fetch).toHaveBeenCalledOnce();

  replies[0]!(Response.json({ error: { code: 'UNAUTHENTICATED', message: LOGIN_FAILED } }, { status: 401 }));
  await settle();
  expect(host.textContent).toContain(LOGIN_FAILED);
  expect(login.classList.contains('ant-btn-loading')).toBe(false);
  // 离场动画未结束：图标仍在 DOM 中，但不再进入可访问名。
  expect(loadingIcon(login)).not.toBeNull();
  expect(nameOf(login)).toBe('登 录');
  expect(login.disabled).toBe(false);
  await submitLogin(host);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(nameOf(login)).toBe('loading 登 录');
});

it('AC-FE-F582 表单内核保存按钮（FormOverlay，另一 React 根的弹窗）遇 409 后可访问名为「保 存」', async () => {
  await mount(h(App));
  let reject!: (cause: unknown) => void;
  const onSubmit = vi.fn(() => new Promise<void>((_, fail) => (reject = fail)));
  await mount(
    h(FormOverlay, {
      recordKey: 'f582',
      open: true,
      mode: 'modal',
      title: '合成表单',
      groups: [],
      onSubmit,
      onClose: () => undefined,
    }),
  );
  const save = () =>
    [...document.querySelectorAll<HTMLButtonElement>('.ant-modal-footer button')].find((button) =>
      button.textContent?.includes('保'),
    )!;
  await act(async () => save().click());
  await settle();
  expect(onSubmit).toHaveBeenCalledOnce();
  expect(save().disabled).toBe(true);
  expect(nameOf(save())).toBe('loading 保 存');

  reject(new ApiError(409, 'REVISION_CONFLICT', 'refresh', '数据已被他人修改'));
  await settle();
  expect(save().classList.contains('ant-btn-loading')).toBe(false);
  expect(loadingIcon(save())).not.toBeNull();
  expect(nameOf(save())).toBe('保 存');
  expect(save().disabled).toBe(false);
  await act(async () => save().click());
  await settle();
  expect(onSubmit).toHaveBeenCalledTimes(2);
  expect(nameOf(save())).toBe('loading 保 存');
});

it('AC-FE-F582 离场中重新进入加载态时图标恢复可读；自带图标的按钮不受影响', async () => {
  await mount(h(App));
  const { root, host: plainHost } = await mount(h(Button, { loading: true }, '提交'));
  const plain = plainHost.querySelector('button');
  const render = (loading: boolean) => act(async () => root.render(h(Button, { loading }, '提交')));
  await render(false);
  await settle();
  expect(nameOf(plain!)).toBe('提 交');
  await render(true);
  await settle();
  expect(loadingIcon(plain!)?.getAttribute('aria-hidden')).toBeNull();
  expect(nameOf(plain!)).toBe('loading 提 交');

  const iconOf = (loading: boolean) => h(Button, { loading, icon: h('span', { 'aria-label': '下载' }) }, '导出');
  const { root: withIcon, host } = await mount(iconOf(true));
  const exporting = host.querySelector('button')!;
  expect(nameOf(exporting)).toBe('loading 导出');
  await act(async () => withIcon.render(iconOf(false)));
  await settle();
  expect(loadingIcon(exporting)).toBeNull();
  expect(nameOf(exporting)).toBe('下载 导出');
});

it('AC-FE-F582 离线容器内已结束加载的按钮随容器插入页面后，可访问名只剩按钮文字', async () => {
  await mount(h(App));
  // 容器先不挂到页面上：加载结束时 body 上的观察器看不到它，图标随整个容器一次插入。
  const host = document.createElement('div');
  const root = createRoot(host);
  roots.push({ host, root });
  await act(async () => root.render(h(Button, { loading: true }, '提交')));
  await act(async () => root.render(h(Button, { loading: false }, '提交')));
  // 离场动画的 class 切换在离线时走完，插入后不再有属性变化可供观察器捕获。
  await settle();
  const button = host.querySelector('button')!;
  expect(loadingIcon(button)).not.toBeNull();
  expect(nameOf(button)).toBe('loading 提 交');

  await act(async () => document.body.append(host));
  await settle();
  expect(loadingIcon(button)).not.toBeNull();
  expect(nameOf(button)).toBe('提 交');
});
