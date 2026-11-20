import { ApiError, type Command } from '../foundation/client.js';
import { portalMessages as m } from './portal-messages.js';
export const PORTAL_API = '/api/survey360/portal';
export const portalStorageKey = (tenantId: string) => `survey360.portal.${tenantId}`;
export interface PortalSession {
  session: string;
  expiresAt: string;
}
export interface Answer {
  itemId: string;
  optionId: string;
  remark?: string | null;
}
export interface Sheet {
  status: 'pending' | 'draft' | 'submitted';
  revision: number;
  answers: Answer[];
  suggestion: string | null;
}
export interface Item {
  id: string;
  text?: string;
  name?: string;
  definition?: string | null;
  dimension?: string | null;
  allowRemark?: boolean;
  options: { id: string; label: string; remarkRequired: boolean }[];
}
export interface AnswerPage {
  activity: { name: string; status: string };
  object: { name: string };
  role?: { name: string };
  appraiser?: { name: string };
  questionnaire: { id: string; name: string; type: string; guide: string | null; items: Item[] };
  sheet: Sheet;
}
export interface Task {
  relationId: string;
  object: { name: string };
  role?: { name: string };
  questionnaires: { id: string; name: string; status: string }[];
}
export interface PortalHome {
  kind: 'answer';
  activity: { id: string; name: string; welcome: string | null; status: string };
  appraiser?: { name: string };
  tasks: Task[];
}
export function portalTenant(path: string): string | undefined {
  return /^\/survey360\/portal\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/?$/i.exec(path)?.[1];
}
export function validSession(value: unknown): value is PortalSession {
  const item = value as PortalSession | undefined;
  return (
    !!item &&
    typeof item.session === 'string' &&
    /^[\w-]{43}$/.test(item.session) &&
    typeof item.expiresAt === 'string' &&
    Number.isFinite(Date.parse(item.expiresAt))
  );
}
export function readSession(tenantId: string): PortalSession | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(portalStorageKey(tenantId)) ?? 'null');
    if (validSession(value)) return value;
  } catch {
    /* 存储不可用时仍允许本页登录，不把凭据写入其它介质。 */
  }
  return undefined;
}
export function storeSession(tenantId: string, value?: PortalSession) {
  try {
    if (value) sessionStorage.setItem(portalStorageKey(tenantId), JSON.stringify(value));
    else sessionStorage.removeItem(portalStorageKey(tenantId));
  } catch {
    /* 会话仅保留在当前页面内存。 */
  }
}
export function createPortalClient(tenantId: string, session?: string, expired?: () => void) {
  return {
    async request<T>(path = '', method = 'GET', body?: unknown, command?: Command): Promise<T> {
      if (path && !/^\/(login|logout|tasks\/[^/?#]+\/questionnaires\/[^/?#]+(?:\/submit)?)$/.test(path))
        throw new Error(m.invalidLink);
      const headers = new Headers({ 'content-type': 'application/json', 'x-tenant-id': tenantId });
      if (session) headers.set('x-survey360-session', session);
      if (command) {
        headers.set('idempotency-key', command.id);
        headers.set('if-match', String(command.revision));
      }
      let response: Response;
      try {
        response = await fetch(`${PORTAL_API}${path}`, {
          method,
          headers,
          credentials: 'omit',
          cache: 'no-store',
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        throw new ApiError(0, 'NETWORK_ERROR', 'unknown', m.unknown);
      }
      const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);
      if (!response.ok) {
        if (response.status === 401 && session) expired?.();
        const code = payload?.error?.code ?? 'REQUEST_FAILED';
        const kind = failureKind(response.status);
        const message = failureMessage(response.status, !!session, payload?.error?.message);
        const retry = response.headers.get('retry-after');
        throw new ApiError(
          response.status,
          code,
          kind,
          message,
          payload?.error,
          retry && /^\d+$/.test(retry) ? Number(retry) : undefined,
        );
      }
      if (response.status !== 204 && payload === undefined) throw new Error(m.unknown);
      return payload as T;
    },
  };
}
function failureKind(status: number) {
  if (status === 401) return 'login';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'fields';
  return 'unknown';
}
function failureMessage(status: number, authenticated: boolean, message?: string): string {
  if (status === 401) return authenticated ? m.expired : m.loginFailed;
  if (status === 429) return m.limited;
  if (status === 403) return m.forbidden;
  if (status === 404) return m.missing;
  if (status >= 500) return m.busy;
  return message ?? m.failed;
}
export type PortalClient = ReturnType<typeof createPortalClient>;
/** ownSheet 不返回 id；内核以关系下套卷 ID 作为稳定原单标识，不能虚构后端回执字段。 */
export function sheetReceipt(value: Sheet, revision: number, operation: 'save' | 'submit') {
  if (
    !value ||
    value.revision !== revision + 1 ||
    !Array.isArray(value.answers) ||
    value.status !== (operation === 'submit' ? 'submitted' : 'draft')
  )
    throw new Error(m.unknown);
  return value;
}
export function sheetValues(sheet: Sheet) {
  return {
    answers: sheet.answers.map((answer) => ({ ...answer, remark: answer.remark ?? '' })),
    suggestion: sheet.suggestion,
  };
}
