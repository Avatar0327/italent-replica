/**
 * F-474-7b-fe 图谱页夹具：快照与待确认记录用后端同一纯函数 buildJobGraph 现算（graph-routes.ts 返回的就是它的 layout / issues），
 * 响应外形照 graph-routes.ts：GET → { snapshot }，rebuild → 快照本身，错误 → { error: { code, message, details } }。
 */
import { buildJobGraph, type JobGraphInput, type JobGraphRecord } from '@italent/domain';
import { vi } from 'vitest';
import { act, allFields, h, session } from './f474-ui.js';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { App } = requireWeb('antd');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { PermissionsProvider } = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
export const { JobWorkspace } = await import(resolve('apps/web/src/job/JobWorkspace.tsx'));

export const GRAPH = '/api/tenant/job/graph';
/** 与 support/job-graph.ts 的 record 同形；那份带数据库依赖，页面测试不引。 */
const record = (id: string, fields: Partial<JobGraphRecord> = {}): JobGraphRecord => ({
  id,
  name: id,
  enabled: true,
  startDate: '2026-01-01',
  stopDate: '9999-12-31',
  ...fields,
});
export const GRAPH_CODE = 'TenantBase.JobPostAndJobLevelGraph';

/** 合成职务体系：职等 1～3，类别“合成T类”，职级“合成T1”跨职等 1～2，序列“合成研发 / 合成后端”，职务“合成工程师”。 */
export function graphInput(): JobGraphInput {
  return {
    grades: [
      record('g1', { name: '合成职等1', grade: 1 }),
      record('g2', { name: '合成职等2', grade: 2 }),
      record('g3', { name: '合成职等3', grade: 3 }),
    ],
    levelTypes: [record('t', { name: '合成T类' }), record('m', { name: '合成M类' })],
    levels: [
      record('l', { name: '合成T1', levelTypeId: 't', minGradeId: 'g1', maxGradeId: 'g2' }),
      record('lm', { name: '合成M1', levelTypeId: 'm', minGradeId: 'g3', maxGradeId: 'g3' }),
    ],
    sequences: [record('s', { name: '合成研发' }), record('child', { name: '合成后端', parentId: 's' })],
    posts: [
      record('p', { name: '合成工程师', sequenceId: 'child', minLevelId: 'l', code: 'P', displayOrder: 1 }),
      record('p2', { name: '合成架构师', sequenceId: 'child', maxLevelId: 'l', code: 'A', displayOrder: 1 }),
    ],
  };
}
/** 带两条不规范记录：职级“合成空职级”职等范围为空，职务“合成无序列”职务序列为空。 */
export function errorInput(): JobGraphInput {
  const input = graphInput();
  input.levels.push(record('bad', { name: '合成空职级', levelTypeId: 't' }));
  input.posts.push(record('loose', { name: '合成无序列', minLevelId: 'l' }));
  return input;
}
/** 九种原因各至少一例（与 AC-F474-JG-domain 同构，名称换成合成中文）。 */
export function allReasonsInput(): JobGraphInput {
  const input = graphInput();
  input.levelTypes.push(record('d', { name: '合成停用类', enabled: false }));
  input.levels.push(
    record('l2', { name: '合成T2', levelTypeId: 't', minGradeId: 'g2', maxGradeId: 'g3' }),
    record('bad', { name: '合成空职级', levelTypeId: 'd' }),
  );
  input.posts.push(
    record('missing', { name: '合成缺项职务' }),
    record('parent', { name: '合成父序列职务', sequenceId: 's', minLevelId: 'bad' }),
  );
  return input;
}
export function snapshot(revision: number, input = graphInput(), generatedAt = '2026-11-12T02:30:05.000Z') {
  const result = buildJobGraph(input);
  return {
    revision,
    asOfDate: '2026-11-12',
    empty: result.empty,
    containsError: result.issues.length > 0,
    issueCount: result.issues.length,
    generatedAt,
    layout: result.layout,
  };
}
export const issueItems = (input = errorInput()) =>
  buildJobGraph(input).issues.map(({ kind, objectId, objectName, reasons }) => ({
    kind,
    objectId,
    objectName,
    reasons,
  }));
export const failure = (status: number, code: string, message: string, details?: object) =>
  Response.json({ error: { code, message, ...(details ? { details } : {}) } }, { status });

export type Handler = (url: URL, init: RequestInit & { headers: Headers }) => Response | Promise<Response>;
interface Grants {
  /** 图谱对象按钮：rebuild / export 列表级。 */
  graphButtons?: string[];
  /** 无某对象查看权：权限接口按后端 403。 */
  hidden?: string[];
  /** 源对象没有编辑按钮。 */
  readOnly?: string[];
}
const objectPermission = (code: string, grants: Grants) => ({
  objectCode: code,
  dataOperations: { read: true, create: true, update: !grants.readOnly?.includes(code) },
  viewableFields: allFields,
  editableFields: allFields,
  buttons:
    code === GRAPH_CODE
      ? (grants.graphButtons ?? ['rebuild', 'export']).map((buttonCode) => ({ buttonCode, level: 'list' }))
      : [
          { buttonCode: 'create', level: 'list' },
          ...(grants.readOnly?.includes(code) ? [] : [{ buttonCode: 'update', level: 'detail' }]),
        ],
});
export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body?: string;
}
export function graphHarness() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls: Call[] = [];
  const routes = new Map<string, Handler>();
  const render = async (path: string, grants: Grants = {}) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (raw: string, init: RequestInit = {}) => {
        const url = new URL(raw, 'http://localhost');
        const headers = new Headers(init.headers);
        calls.push({ method: init.method ?? 'GET', url, headers, body: init.body as string | undefined });
        if (url.pathname.endsWith('/me/snapshot'))
          return Response.json({ session, apps: [], scope: [], adminMenus: [] });
        if (url.pathname.includes('/permission/me/objects/')) {
          const code = decodeURIComponent(url.pathname.split('/').at(-1)!);
          if (grants.hidden?.includes(code)) return failure(403, 'FORBIDDEN', '无权访问');
          return Response.json(objectPermission(code, grants));
        }
        const handler = routes.get(`${init.method ?? 'GET'} ${url.pathname}`);
        if (handler) return handler(url, { ...init, headers });
        return Response.json({ items: [], today: '2026-11-12', hasDataPermission: true });
      }),
    );
    await act(async () =>
      root.render(
        h(
          MemoryRouter,
          { initialEntries: [path] },
          h(SessionProvider, { session }, h(PermissionsProvider, {}, h(App, {}, h(JobWorkspace)))),
        ),
      ),
    );
    await settle();
  };
  return {
    host,
    calls,
    render,
    route(key: string, handler: Handler) {
      routes.set(key, handler);
    },
    async close() {
      await act(() => root.unmount());
      host.remove();
      document.body.innerHTML = '';
      vi.unstubAllGlobals();
    },
  };
}
export async function settle(ms = 30) {
  await act(async () => {
    await new Promise((done) => setTimeout(done, ms));
  });
}
export async function click(element: Element | null | undefined) {
  if (!element) throw new Error('element not found');
  await act(async () => {
    (element as HTMLElement).click();
  });
  await settle();
}
/** antd 两字中文按钮会插空格（“确 认”），按去空白后的文字找。 */
export const button = (text: string, scope: ParentNode = document.body) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent?.replace(/\s/g, '') === text,
  );
