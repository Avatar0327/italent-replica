import { DATA_OPERATIONS, type ObjectPermission } from '@italent/domain';
import { ApiError } from '../foundation/client.js';
import type { Values } from '../foundation/forms/store.js';
import type { Profile } from './model.js';
import { base } from './model.js';
import { om } from './object-messages.js';
export type DialogMode = 'data-operations' | 'fields';
export type ProfileDetail = Omit<Profile, 'objects'> & { objects: ObjectPermission[] };
export interface FieldRow {
  fieldCode: string;
  system: boolean;
  view: boolean;
  edit: boolean;
}
export interface DialogRead {
  profileId: string;
  objectCode: string;
  revision: number;
  dataOperations?: Record<string, boolean>;
  catalogDigest?: string;
  items?: FieldRow[];
  total?: number;
}
export interface DialogSnapshot {
  revision: number;
  values: Values;
  rows: Record<string, FieldRow>;
}
export const profilePath = (id: string) => `${base}/profiles/${encodeURIComponent(id)}`;
export const dialogPath = (id: string, objectCode: string, mode: DialogMode) =>
  `${profilePath(id)}/objects/${encodeURIComponent(objectCode)}/${mode}`;
export const fieldKey = (code: string, kind: 'view' | 'edit') => `${kind}:${code}`;
export function snapshotOf(raw: DialogRead, id: string, objectCode: string, mode: DialogMode): DialogSnapshot {
  if (raw.profileId !== id || raw.objectCode !== objectCode || !Number.isSafeInteger(raw.revision) || raw.revision < 0)
    throw new Error(om.invalid);
  if (mode === 'data-operations') {
    if (!DATA_OPERATIONS.every((key) => typeof raw.dataOperations?.[key] === 'boolean')) throw new Error(om.invalid);
    return { revision: raw.revision, values: { ...raw.dataOperations }, rows: {} };
  }
  if (
    !Array.isArray(raw.items) ||
    !Number.isSafeInteger(raw.total) ||
    raw.total! < raw.items.length ||
    !/^[0-9a-f]{16}$/.test(raw.catalogDigest ?? '') ||
    raw.items.some(
      (row) =>
        !row.fieldCode || !['system', 'view', 'edit'].every((key) => typeof row[key as keyof FieldRow] === 'boolean'),
    ) ||
    new Set(raw.items.map((row) => row.fieldCode)).size !== raw.items.length
  )
    throw new Error(om.invalid);
  return {
    revision: raw.revision,
    values: {
      catalogDigest: raw.catalogDigest,
      ...Object.fromEntries(
        raw.items.flatMap((row) =>
          [
            ['view', row.view],
            ['edit', row.edit],
          ].map(([kind, value]) => [fieldKey(row.fieldCode, kind as 'view' | 'edit'), value]),
        ),
      ),
    },
    rows: Object.fromEntries(raw.items.map((row) => [row.fieldCode, row])),
  };
}
export function writableKeys(snapshot: DialogSnapshot | undefined, mode: DialogMode) {
  if (!snapshot) return [];
  if (mode === 'data-operations') return [...DATA_OPERATIONS];
  return Object.values(snapshot.rows).flatMap((row) => [
    fieldKey(row.fieldCode, 'view'),
    ...(!row.system ? [fieldKey(row.fieldCode, 'edit')] : []),
  ]);
}
export function dialogError(error: unknown) {
  if (error instanceof ApiError && error.status === 404) return new ApiError(404, error.code, 'not-found', om.missing);
  // 目录冲突也按内核的重读、核对、显式重提流程恢复。
  if (error instanceof ApiError && error.code === 'CATALOG_CHANGED')
    return new ApiError(409, 'REVISION_CONFLICT', 'refresh', om.catalogChanged);
  return error;
}
export function dialogBody(mode: DialogMode, patch: Values, baseline: Values) {
  if (mode === 'data-operations') return { dataOperations: patch };
  const codes = [...new Set(Object.keys(patch).map((key) => key.slice(5)))].sort();
  return {
    catalogDigest: baseline.catalogDigest,
    fields: codes.map((fieldCode) => ({
      fieldCode,
      view: patch[fieldKey(fieldCode, 'view')] ?? baseline[fieldKey(fieldCode, 'view')],
      edit: patch[fieldKey(fieldCode, 'edit')] ?? baseline[fieldKey(fieldCode, 'edit')],
    })),
  };
}
