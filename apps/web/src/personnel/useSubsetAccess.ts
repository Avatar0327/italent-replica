import { useEffect, useState } from 'react';
import { SUBSETS } from '@italent/domain';
import { useApiClient, useSession } from '../foundation/Session.js';
import { loadObjectPermission } from '../demo-stubs/navigation.js';
import type { ObjectPermission } from '../foundation/permission-model.js';
import { subsetLabels } from './messages.js';

export type ProfileSubset = keyof typeof subsetLabels;
type Access = Partial<Record<ProfileSubset, ObjectPermission>>;
/** 子集导航与字段使用同一批服务端授权，不把无权限对象先画出来再请求数据。 */
export function useSubsetAccess() {
  const api = useApiClient();
  const session = useSession();
  const [generation, reload] = useState(0);
  const key = `${session.tenantId}/${session.identityKey}/${generation}`;
  const [state, setState] = useState<{ key: string; data?: Access; error?: unknown }>();
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(
      (Object.keys(subsetLabels) as ProfileSubset[]).map(
        async (kind) => [kind, await loadObjectPermission(api, SUBSETS[kind].objectCode, controller.signal)] as const,
      ),
    )
      .then((entries) => {
        if (!controller.signal.aborted)
          setState({ key, data: Object.fromEntries(entries.filter(([, access]) => access)) });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ key, error });
      });
    return () => controller.abort();
  }, [api, key]);
  const current = state?.key === key ? state : undefined;
  return { data: current?.data, error: current?.error, loading: !current, refresh: () => reload((n) => n + 1) };
}
