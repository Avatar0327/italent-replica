import { useEffect, useState } from 'react';
import { useApiClient } from '../foundation/Session.js';
import { usePermissions } from '../foundation/Permissions.js';
import { newCommand } from '../foundation/client.js';
import { base } from './api.js';
import { projectActions } from './model.js';
import { objects, type Collection, type ProjectAction, type ReviewRecord } from './types.js';
import { useCollection } from './useCollection.js';
export function useReviewController(collection: Collection) {
  const api = useApiClient();
  const permission = usePermissions(objects[collection]);
  const result = useCollection(collection, !!permission.snapshot.objects[objects[collection]]);
  const [selected, select] = useState<{ id: string; editing?: boolean }>();
  const [detail, setDetail] = useState<ReviewRecord>();
  const [error, setError] = useState<unknown>();
  const [editing, setEditing] = useState<ReviewRecord | 'new'>();
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    select(undefined);
    setDetail(undefined);
    setEditing(undefined);
    setError(undefined);
    result.refresh();
  };
  useEffect(() => {
    const controller = new AbortController();
    setDetail(undefined);
    if (selected) setError(undefined);
    if (selected)
      void api
        .request<ReviewRecord>(`${base}/${collection}/${selected.id}`, { signal: controller.signal })
        .then((row) => {
          if (!controller.signal.aborted) {
            setDetail(row);
            if (
              selected.editing &&
              row.accessLevel === 'manage' &&
              Number.isInteger(row.revision) &&
              (collection !== 'projects' || ['new', 'in_progress'].includes(row.status ?? ''))
            )
              setEditing(row);
          }
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(cause);
        });
    return () => controller.abort();
  }, [selected, api, collection]);
  const actionsFor = (row: ReviewRecord) => allowedActions(collection, row, permission.can);
  const transition = async (row: ReviewRecord, action: ProjectAction) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.request(`${base}/projects/${row.id}/${action}`, {
        method: 'POST',
        command: newCommand({}, row.revision),
      });
      refresh();
    } catch (cause) {
      setError(cause);
      select(undefined);
      setDetail(undefined);
      result.refresh();
    } finally {
      setBusy(false);
    }
  };
  return {
    permission,
    result,
    selected,
    select,
    detail,
    error,
    editing,
    setEditing,
    busy,
    refresh,
    actionsFor,
    transition,
  };
}

function allowedActions(collection: Collection, row: ReviewRecord, can: (action: string) => boolean): ProjectAction[] {
  if (collection === 'projects') return projectActions(row, can);
  return collection === 'templates' && row.accessLevel === 'manage' && Number.isInteger(row.revision) && can('update')
    ? ['update']
    : [];
}
