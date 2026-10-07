/**
 * 第 7 轮（DEC-288 止损：后端兜底）端到端测试支撑：审批中心组件直接驱动真实 Hono 应用（PGlite + 生产授权器）。
 * 在 node 环境里手工注册 happy-dom 窗口（web 转换模式下 `import.meta.url` 不是 file:，数据库包无法加载），
 * `fetch` 直接转给 `app.request`，并记录每次往返（状态码、响应体）供断言“响应体不带业务数据”。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createApp, createDevIdentityResolver, devIdentityHeaders } from '@italent/api';
import { sql, withTenant, type Db } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { Window } from 'happy-dom';
import { expect, vi } from 'vitest';
import {
  approvalWorld,
  grantFieldAccess,
  permissionAdmin,
  transferScene,
  type ApprovalWorld,
} from './AC-APV-support.js';
import { setObjectPermission } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

export const BASE = '/api/tenant/approval';
export const PLACE_VALUE = '合成撤权前可见的工作地点';
export const TIGHTENED = 'DISCLOSURE_TIGHTENED';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const PAGE = resolve('apps/web/src/approval/ApprovalPage.tsx');

/* ---------- DOM 注册（只注册 DOM 相关全局，不替换 URL / fetch / Request / Response） ---------- */
const DOM_KEYS = [
  'window',
  'self',
  'document',
  'navigator',
  'Node',
  'Element',
  'Text',
  'Comment',
  'DocumentFragment',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'HTMLButtonElement',
  'HTMLFormElement',
  'HTMLDivElement',
  'HTMLIFrameElement',
  'SVGElement',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'InputEvent',
  'FocusEvent',
  'CustomEvent',
  'MutationObserver',
  'CSSStyleDeclaration',
  'DOMParser',
  'Range',
  'Selection',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'sessionStorage',
  'localStorage',
] as const;
let saved: Map<string, PropertyDescriptor | undefined> | null = null;
let currentWindow: Window | null = null;

/** 每个用例一个新窗口：sessionStorage 等状态互不串扰。 */
export function registerDom(): Window {
  releaseDom();
  const win = new Window({ url: 'http://localhost/approvals' });
  saved = new Map();
  const source = win as unknown as Record<string, unknown>;
  for (const key of DOM_KEYS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = source[key];
    const bound = typeof value === 'function' && !/^[A-Z]/.test(key) ? (value as () => void).bind(win) : value;
    Object.defineProperty(globalThis, key, { value: bound, configurable: true, writable: true });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  currentWindow = win;
  return win;
}
export function releaseDom() {
  if (saved) {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    saved = null;
  }
  currentWindow?.close();
  currentWindow = null;
}

/* ---------- 真实请求记录 ---------- */
export interface Exchange {
  readonly url: string;
  readonly options: RequestInit;
  readonly status: number;
  readonly body: unknown;
}
export interface RealFetch {
  readonly exchanges: Exchange[];
  /** 把某次响应的交付挂起（服务端已算完，组件尚未收到），用于制造“在途”。 */
  hold(match: (url: string, options: RequestInit) => boolean): { release: () => void; held: Promise<void> };
  /** 某次响应交付前的钩子（如记录 Profiler 帧标记）。 */
  onDeliver: (exchange: Exchange) => void;
}
export function header(options: RequestInit, name: string) {
  return new Headers(options.headers).get(name);
}
export function realFetch(app: ReturnType<typeof createApp>, secret: string, userId: string): RealFetch {
  const exchanges: Exchange[] = [];
  let gate: {
    match: (url: string, options: RequestInit) => boolean;
    promise: Promise<void>;
    arrived: () => void;
  } | null = null;
  const self: RealFetch = {
    exchanges,
    hold(match) {
      let release!: () => void;
      let arrived!: () => void;
      const promise = new Promise<void>((done) => (release = done));
      const held = new Promise<void>((done) => (arrived = done));
      gate = { match, promise, arrived };
      return { release, held };
    },
    onDeliver: () => undefined,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const headers = { ...(init.headers as Record<string, string>), ...devIdentityHeaders(secret, userId) };
      const response = await app.request(url, { ...init, headers });
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      const exchange: Exchange = { url, options: init, status: response.status, body };
      exchanges.push(exchange);
      if (gate?.match(url, init)) {
        const current = gate;
        gate = null;
        current.arrived();
        await current.promise;
      }
      self.onDeliver(exchange);
      return response;
    }),
  );
  return self;
}

/* ---------- 组件挂载 ---------- */
/** 整棵 DOM 的快照：文本内容 + 所有输入控件的当前值（可编辑字段的值只在 value 里）。 */
export function snapshot(host: Element): string {
  const values = Array.from(host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).map(
    (element) => element.value,
  );
  return `${host.textContent ?? ''}\u0000${values.join('\u0000')}`;
}
export interface Mounted {
  readonly host: HTMLDivElement;
  readonly frames: string[];
  readonly act: (callback: () => Promise<void> | void) => Promise<void>;
  panel(): Element;
  buttons(): HTMLButtonElement[];
  click(label: string): Promise<void>;
  input(label: string, value: string): Promise<void>;
  /** 轮询直到条件成立（真实请求异步返回）。 */
  until(predicate: () => boolean, what: string): Promise<void>;
  unmount(): Promise<void>;
}
export async function mountWorkspace(props: {
  readonly tenantId: string;
  readonly instanceId?: string;
  readonly reload: () => void;
}): Promise<Mounted> {
  const { createElement, act, Profiler } = requireWeb('react');
  const { createRoot } = requireWeb('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const frames: string[] = [];
  const { ApprovalWorkspace } = (await import(PAGE)) as { ApprovalWorkspace: unknown };
  await act(async () =>
    root.render(
      createElement(
        Profiler,
        { id: 'approval', onRender: () => frames.push(snapshot(host)) },
        createElement(ApprovalWorkspace, props),
      ),
    ),
  );
  const buttons = () => Array.from(host.querySelectorAll('button'));
  const until = async (predicate: () => boolean, what: string) => {
    for (let round = 0; round < 400 && !predicate(); round++)
      await act(async () => new Promise<void>((done) => setTimeout(done, 10)));
    expect(predicate(), `等待超时：${what}`).toBe(true);
  };
  return {
    host,
    frames,
    act,
    panel: () => host.querySelector('.approval-detail')!,
    buttons,
    async click(label) {
      // 列表区与历史区都有“上一页 / 下一页”：优先点可用的那一个。
      const matches = buttons().filter((item) => item.textContent?.trim() === label);
      const button = matches.find((item) => !item.disabled) ?? matches[0];
      expect(button, label).toBeTruthy();
      await act(async () => button!.click());
    },
    async input(label, value) {
      const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        `[aria-label="${label}"]`,
      );
      expect(element, label).toBeTruthy();
      await act(async () => {
        const prototype =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : element instanceof HTMLSelectElement
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
        element!.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      });
    },
    until,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/* ---------- 场景夹具 ---------- */
export interface PlaceSceneOptions {
  /** 首节点勾选“审批记录查看权限”（DEC-115）：U 作为首节点审批人从一开始就看不到记录（logs 为空）。 */
  readonly hiddenFirstNode?: boolean;
  /** 第二节点勾选“审批记录查看权限”（DEC-115），转交进入即隐藏。 */
  readonly hiddenSecondNode?: boolean;
}
/** 调出负责人 U 为首节点审批人，节点表单含 place / remarks 且可独立编辑、可转交；U 有 place / remarks 查看与编辑权。 */
export async function placeScene(db: Db, label: string, options: PlaceSceneOptions = {}) {
  const w = await approvalWorld(db, label);
  const s = await transferScene(w);
  const world = await permissionAdmin(w);
  const viewer = s.outHead.userId;
  const profile = await grantFieldAccess(world, viewer, {
    view: ['id', 'departmentId', 'effectiveDate', 'place', 'remarks'],
    edit: ['place', 'remarks'],
  });
  const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
  await w.publishedProcess({
    nodes: [
      {
        key: 'out_head',
        approver: 'latest_record_department_head',
        formFields: ['departmentId', 'effectiveDate', 'place', 'remarks'],
        editableFields: ['place', 'remarks'],
        editMode: 'separate',
        actions: { transfer: true },
        ...(options.hiddenFirstNode ? { hideRecords: true } : {}),
      },
      {
        key: 'in_hrbp',
        approver: 'record_department_hrbp',
        actions: { transfer: true },
        ...(options.hiddenSecondNode ? { hideRecords: true } : {}),
      },
    ],
  });
  const view = await w.submit(
    await w.application(s.subject.employeeId, { departmentId: s.to, place: PLACE_VALUE, remarks: '合成备注' }),
  );
  const [task] = w.pending(view);
  const definition = MODULE_OBJECTS.employmentRecord;
  async function setFields(view: readonly string[], edit: readonly string[]) {
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: edit.length > 0, delete: false },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: view.includes(field.code) || edit.includes(field.code),
          edit: edit.includes(field.code),
        })),
        buttons: [],
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  return {
    w,
    s,
    world,
    api,
    viewer,
    view,
    task: task!,
    /** 以 U 的身份请求生产授权器应用。 */
    request: (method: string, path: string, options: Parameters<typeof api.request>[2] = {}) =>
      api.request(method, path, { ...options, ...w.as(viewer) }),
    /** 撤销 place 的查看权与编辑权（其余不变）。 */
    revokePlace: () => setFields(['id', 'departmentId', 'effectiveDate', 'remarks'], ['remarks']),
    /** 恢复 place 查看权与编辑权。 */
    grantPlace: () => setFields(['id', 'departmentId', 'effectiveDate', 'place', 'remarks'], ['place', 'remarks']),
    /** 可信夹具：追加 count 条合成催办日志，把更早的日志挤出详情最近 200 条窗口（X-19）。 */
    async padLogs(count: number) {
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`INSERT INTO approval_instance_logs
            (id,tenant_id,instance_id,seq,round,node_key,task_id,event,actor_user_id,admin_self_transfer,
             detail,created_at)
          SELECT gen_random_uuid(),${w.tenant.id}::uuid,${view.id}::uuid,m.max_seq+s,1,NULL,NULL,'urge',NULL,false,
            '{}'::jsonb,now()
          FROM generate_series(1,${count}) s,
            (SELECT COALESCE(max(seq),0) AS max_seq FROM approval_instance_logs
              WHERE tenant_id=${w.tenant.id}::uuid AND instance_id=${view.id}::uuid) m`),
      );
    },
    /** 生产授权器应用 + 开发身份：组件 fetch 直接转给它。 */
    app() {
      const secret = `r7${Math.random().toString(16).slice(2)}${'0'.repeat(48)}`.slice(0, 64);
      const app = createApp({
        db: w.db,
        identity: createDevIdentityResolver({ secret, nodeEnv: 'test' }),
        clock: w.clock,
      });
      return { app, secret };
    },
  };
}
export type PlaceScene = Awaited<ReturnType<typeof placeScene>>;

/** 409 + 机器原因码，且响应体除 error 外不带任何业务字段。 */
export function expectTightenedBody(status: number, body: unknown) {
  expect(status).toBe(409);
  const error = body as { error?: { code?: string; details?: { reason?: string } } };
  expect(error.error?.code).toBe('CONFLICT');
  expect(error.error?.details?.reason).toBe(TIGHTENED);
  expect(Object.keys(error as object)).toEqual(['error']);
  expect(JSON.stringify(body)).not.toContain(PLACE_VALUE);
}
export { approvalWorld, type ApprovalWorld };
