/** DEC-464：只记处理标记；跨抽屉恢复命令搁置到 F-110。暂存由服务端按人保存（F-181b）。 */
interface HrSession {
  processing: boolean;
}
const key = (scope: string) => `italent.transfer.l2:${scope}`;
export const hrSessionChanged = 'italent-transfer-session-changed';
export function readHrSession(scope: string): HrSession {
  const raw = sessionStorage.getItem(key(scope));
  if (!raw) return { processing: false };
  const value = JSON.parse(raw) as { processing?: unknown };
  if (typeof value.processing !== 'boolean') throw new Error('invalid transfer session');
  return { processing: value.processing };
}
function write(scope: string, value: HrSession) {
  sessionStorage.setItem(key(scope), JSON.stringify(value));
  window.dispatchEvent(new Event(hrSessionChanged));
}
export function beginHrWrite(scope: string) {
  const value = readHrSession(scope);
  if (value.processing) throw new Error('transfer processing');
  write(scope, { processing: true });
}
export function finishHrWrite(scope: string) {
  readHrSession(scope);
  write(scope, { processing: false });
}
