import { useRemote } from '../org/page-support.js';
import { isExternalReference, referencePath, type JobRow } from './page-model.js';
import { pageText as m } from './messages.js';

/** 列表与详情接口只返回引用 ID；详情里按当前权限读取被引用对象的名称，读不到或名称被裁剪时明确提示，不补写。 */
export function ReferenceName({ kind, id, date }: { kind: string; id: string; date: string }) {
  // 人才标准、任职类别不按职务体系的业务日期取值。
  const external = isExternalReference(kind);
  const remote = useRemote<JobRow>(`${referencePath(kind)}/${id}${external ? '' : `?asOf=${date}`}`);
  if (remote.error) return <>{m.hiddenReference}</>;
  if (!remote.data) return <>{m.missing}</>;
  const name = remote.data.name ?? m.hiddenReference;
  // 被引用的人才标准事后停用时保留引用，展示标注已停用（Q-M0-17）。
  return <>{external && remote.data.enabled === false ? `${name}${m.disabledReference}` : name}</>;
}
