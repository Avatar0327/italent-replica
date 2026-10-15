import { useRemote } from '../org/page-support.js';
import type { JobRow } from './page-model.js';
import { pageText as m } from './messages.js';

/** 列表与详情接口只返回引用 ID；详情里按当前权限读取被引用对象的名称，读不到或名称被裁剪时明确提示，不补写。 */
export function ReferenceName({ kind, id, date }: { kind: string; id: string; date: string }) {
  const base = kind === 'org' ? '/api/tenant/org/organizations' : `/api/tenant/job/${kind}`;
  const remote = useRemote<JobRow>(`${base}/${id}?asOf=${date}`);
  if (remote.error) return <>{m.hiddenReference}</>;
  if (!remote.data) return <>{m.missing}</>;
  return <>{remote.data.name ?? m.hiddenReference}</>;
}
