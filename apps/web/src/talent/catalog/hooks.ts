import { fieldAccess, type ObjectPermission } from '../../foundation/permission-model.js';
import type { Resource } from './types.js';
import { candidates } from './api.js';
import { useEffect, useState } from 'react';
import { ApiError, type ApiClient } from '../../foundation/client.js';
import { useApiClient, useSession } from '../../foundation/Session.js';

/** 请求按会话和完整参数隔离，过时回包不覆盖当前页面。 */
export function useRemote<T>(key: string, load: (api: ApiClient, signal: AbortSignal) => Promise<T>) {
  const api = useApiClient();
  const session = useSession();
  const requestKey = `${session.tenantId}:${session.identityKey}:${key}`;
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown }>();
  useEffect(() => {
    const controller = new AbortController();
    if (key) {
      void load(api, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setState({ key: requestKey, data });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setState({ key: requestKey, error });
        });
    }
    return () => controller.abort();
    // key 是请求契约，调用者须把全部请求参数放进 key；函数闭包不作为刷新来源。
  }, [api, requestKey]);
  const current = state?.key === requestKey ? state : undefined;
  return { data: current?.data, error: current?.error, loading: !!key && !current };
}
export function useReferenceNames(resource: Resource, generation = 0, permission?: ObjectPermission) {
  return useRemote(
    `names:${resource.object}:${generation}:${permission?.viewableFields.join(',') ?? ''}`,
    async (api, signal) => {
      const sources = [
        ...new Set(
          resource.fields
            .filter((field) => !permission || fieldAccess(permission, field.key).visible)
            .map((field) => field.source)
            .filter((path): path is string => !!path),
        ),
      ];
      if (
        resource.module === 'qualification' &&
        resource.key === 'standards' &&
        (!permission || fieldAccess(permission, 'categoryId').visible)
      )
        sources.push('/api/tenant/qualification/category-classes');
      const rows = await Promise.all(
        sources.map(async (path) => {
          try {
            return await candidates(api, path, signal);
          } catch (error) {
            if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return [];
            throw error;
          }
        }),
      );
      const names = new Map(
        rows
          .flat()
          .filter((row) => row.name !== undefined)
          .map((row) => [row.id, row.name!]),
      );
      for (const row of rows.flat()) {
        if (typeof row.classId === 'string' && names.has(row.classId))
          names.set(`class:${row.id}`, names.get(row.classId)!);
      }
      return names;
    },
  );
}
