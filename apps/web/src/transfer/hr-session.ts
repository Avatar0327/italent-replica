/** DEC-464：只记处理标记与已知草稿单号；跨抽屉恢复命令搁置到 F-110。 */
interface HrSession {
  processing: boolean;
  drafts: string[];
}
const key = (scope: string) => `italent.transfer.l2:${scope}`;
export const hrSessionChanged = 'italent-transfer-session-changed';
export function readHrSession(scope: string): HrSession {
  const raw = sessionStorage.getItem(key(scope));
  if (!raw) return { processing: false, drafts: [] };
  const value = JSON.parse(raw) as HrSession;
  if (
    typeof value.processing !== 'boolean' ||
    !Array.isArray(value.drafts) ||
    value.drafts.some((id) => typeof id !== 'string')
  )
    throw new Error('invalid transfer session');
  return { processing: value.processing, drafts: value.drafts };
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
export function finishHrWrite(scope: string, draftId?: string) {
  const value = readHrSession(scope);
  write(scope, { processing: false, drafts: draftId ? [...new Set([...value.drafts, draftId])] : value.drafts });
}
