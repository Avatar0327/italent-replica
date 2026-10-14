import { useEffect, useMemo, useState } from 'react';
import { useApiClient, useSession } from '../foundation/Session.js';
import { t } from './messages.js';

const SOURCES = {
  employee: '/api/tenant/employment/employees',
  org: '/api/tenant/org/organizations',
} as const;
const MAX_LOOKUPS = 50;

/**
 * IDP 接口只返回员工 / 组织 ID，名称按可见行逐个回查（后端缺口：列表未带名称）。
 * 回查受对方模块权限约束；查不到时回显 ID，不用合成名称冒充真实关联（同 talent-review 约定）。
 */
export function useNames(kind: keyof typeof SOURCES, ids: readonly (string | null | undefined)[]) {
  const api = useApiClient();
  const session = useSession();
  const [names, setNames] = useState<Record<string, string>>({});
  const wanted = useMemo(
    () => [...new Set(ids.filter((id): id is string => !!id))].sort().slice(0, MAX_LOOKUPS),
    [ids],
  );
  const missing = wanted.filter((id) => !(id in names)).join(',');
  useEffect(() => setNames({}), [session.tenantId, session.identityKey]);
  useEffect(() => {
    if (!missing) return;
    const controller = new AbortController();
    void Promise.all(
      missing.split(',').map((id) =>
        api
          .request<{ name?: string }>(`${SOURCES[kind]}/${id}`, { signal: controller.signal })
          .then((row) => [id, row.name ?? id] as const)
          .catch(() => [id, id] as const),
      ),
    ).then((pairs) => {
      if (!controller.signal.aborted) setNames((old) => ({ ...old, ...Object.fromEntries(pairs) }));
    });
    return () => controller.abort();
  }, [api, kind, missing]);
  return (id: string | null | undefined) => (id ? (names[id] ?? id) : t.noValue);
}
