/**
 * DEC-464：只记处理标记与已知草稿单号；跨抽屉恢复命令搁置到 F-110。
 * DEC-511（F-153）：暂存按人一份——草稿单号按员工记一条，同一人再暂存替换旧单，提交后删除。
 */
interface HrSession {
  processing: boolean;
  drafts: Readonly<Record<string, string>>;
}
const key = (scope: string) => `italent.transfer.l2:${scope}`;
export const hrSessionChanged = 'italent-transfer-session-changed';
function draftIndex(value: unknown): Record<string, string> {
  // F-153 之前按单号累积的数组无法得知员工，不带出也不锁表单。
  if (Array.isArray(value)) return {};
  if (!value || typeof value !== 'object' || Object.values(value).some((id) => typeof id !== 'string'))
    throw new Error('invalid transfer session');
  return { ...(value as Record<string, string>) };
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
export function finishHrWrite(scope: string, outcome?: { employeeId: string; draftId?: string }) {
  const value = readHrSession(scope);
  const drafts = { ...value.drafts };
  if (outcome?.draftId) drafts[outcome.employeeId] = outcome.draftId;
  else if (outcome) delete drafts[outcome.employeeId];
  write(scope, { processing: false, drafts });
}
export function hrDraftOf(scope: string, employeeId: string): string | undefined {
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
