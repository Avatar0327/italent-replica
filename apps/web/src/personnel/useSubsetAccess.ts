import { useEffect, useState } from 'react';
import { SUBSETS } from '@italent/domain';
import { useSession } from '../foundation/Session.js';
import { usePermissions } from '../foundation/Permissions.js';
import type { ObjectPermission } from '../foundation/permission-model.js';
import { subsetLabels } from './messages.js';

export type ProfileSubset = keyof typeof subsetLabels;
type Access = Partial<Record<ProfileSubset, ObjectPermission>>;
/** 子集导航与字段使用同一批服务端授权，不把无权限对象先画出来再请求数据。 */
export function useSubsetAccess() {
  const permissions = usePermissions();
  const session = useSession();
  const [generation, reload] = useState(0);
  const key = `${session.tenantId}/${session.identityKey}/${generation}`;
  const [state, setState] = useState<{ key: string; data?: Access; error?: unknown }>();
  useEffect(() => {
    if (permissions.loading || permissions.error) return;
    const controller = new AbortController();
    void Promise.all(
      (Object.keys(subsetLabels) as ProfileSubset[]).map(
        async (kind) => [kind, await permissions.ensure(SUBSETS[kind].objectCode, controller.signal)] as const,
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
  }, [permissions.ensure, permissions.loading, permissions.error, key]);
  const current = state?.key === key ? state : undefined;
  return {
    data: current?.data,
    error: permissions.error ?? current?.error,
    loading: !current,
    refresh: () => {
      reload((n) => n + 1);
      permissions.refresh();
    },
  };
}
