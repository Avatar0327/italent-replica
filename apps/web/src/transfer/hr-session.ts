/**
 * DEC-464：只记处理标记与已知草稿单号；跨抽屉恢复命令搁置到 F-110。
 * DEC-511（F-153）：暂存按人一份——草稿单号按员工记一条，同一人再暂存替换旧单，提交后删除。
 */
/** 读接口不返回异动类型，且多个类型可共用一个表单：暂存时一并记下类型，带出时据此还原（#350 第 1 轮 P2-1）。 */
export interface HrDraftRef {
  readonly id: string;
  readonly transferTypeCode?: string;
}
interface HrSession {
  processing: boolean;
  drafts: Readonly<Record<string, HrDraftRef>>;
}
const key = (scope: string) => `italent.transfer.l2:${scope}`;
export const hrSessionChanged = 'italent-transfer-session-changed';
function draftRef(value: unknown): HrDraftRef {
  // 只记单号的条目没有类型：照常带出，类型交给用户重新确认。
  if (typeof value === 'string') return { id: value };
  const ref = value as Partial<HrDraftRef> | null;
  if (typeof ref?.id !== 'string' || !['string', 'undefined'].includes(typeof ref.transferTypeCode))
    throw new Error('invalid transfer session');
  return { id: ref.id, ...(ref.transferTypeCode ? { transferTypeCode: ref.transferTypeCode } : {}) };
}
function draftIndex(value: unknown): Record<string, HrDraftRef> {
  // F-153 之前按单号累积的数组无法得知员工，不带出也不锁表单。
  if (Array.isArray(value)) return {};
  if (!value || typeof value !== 'object') throw new Error('invalid transfer session');
  return Object.fromEntries(Object.entries(value).map(([employeeId, ref]) => [employeeId, draftRef(ref)]));
}
export function readHrSession(scope: string): HrSession {
  const raw = sessionStorage.getItem(key(scope));
  if (!raw) return { processing: false, drafts: {} };
  const value = JSON.parse(raw) as { processing?: unknown; drafts?: unknown };
  if (typeof value.processing !== 'boolean') throw new Error('invalid transfer session');
  return { processing: value.processing, drafts: draftIndex(value.drafts) };
}
function write(scope: string, value: HrSession) {
  sessionStorage.setItem(key(scope), JSON.stringify(value));
  window.dispatchEvent(new Event(hrSessionChanged));
}
export function beginHrWrite(scope: string) {
  const value = readHrSession(scope);
  if (value.processing) throw new Error('transfer processing');
  write(scope, { ...value, processing: true });
}
/** 有回执时按员工更新索引：回执为草稿记新单号，否则（已提交 / 直接生效）删除；无回执（被拒）不改索引。 */
export function finishHrWrite(scope: string, outcome?: { employeeId: string; draft?: HrDraftRef }) {
  const value = readHrSession(scope);
  const drafts = { ...value.drafts };
  if (outcome?.draft) drafts[outcome.employeeId] = outcome.draft;
  else if (outcome) delete drafts[outcome.employeeId];
  write(scope, { processing: false, drafts });
}
export function hrDraftOf(scope: string, employeeId: string): HrDraftRef | undefined {
  const { drafts } = readHrSession(scope);
  return Object.hasOwn(drafts, employeeId) ? drafts[employeeId] : undefined;
}
/** 点击清除、或暂存已不是草稿时忘掉该人的索引；不删除服务端草稿。 */
export function forgetHrDraft(scope: string, employeeId: string) {
  const value = readHrSession(scope);
  if (!Object.hasOwn(value.drafts, employeeId)) return;
  const drafts = { ...value.drafts };
  delete drafts[employeeId];
  write(scope, { ...value, drafts });
}
