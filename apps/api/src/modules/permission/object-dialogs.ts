/**
 * 身份详情里「数据操作权限」「字段权限」两个弹窗的读写（F-474-5 #26，R1bd §2.13 / §3.8）。
 * 不引入新的权限模型：读 = 该身份在某对象上的当前值；写 = 把弹窗的改动合并进该对象现有的权限后，
 * 交给既有的 setObjectPermission（revision / 目录指纹 / 应用边界 / 审计 / 补装台账全部沿用）。
 * 对象还没配置进这个身份时一律 404：配置新对象只能走整对象替换的既有入口，弹窗不顺手新建。
 */
import { type Tx } from '@italent/db';
import {
  type DataOperations,
  type ObjectPermission,
  objectCatalogDigest,
  type ObjectDefinition,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { type WriteContext } from './audit.js';
import { objectCatalog } from './catalog.js';
import { setObjectPermission, loadProfile } from './profiles.js';
import { loadObjectPermissions } from './subject.js';
import { tenantObjectCatalog } from './tenant-catalog.js';

/** 目录里没有字段显示名（只有编码与是否系统字段），“字段名”列不伪造。 */
export const FIELD_DIALOG_UNRECORDED = ['fieldName'] as const;

export interface DialogBase {
  readonly profileId: string;
  readonly objectCode: string;
  readonly revision: number;
}

export interface FieldDialogItem {
  readonly fieldCode: string;
  readonly system: boolean;
  readonly view: boolean;
  readonly edit: boolean;
}

export interface FieldDialogQuery {
  readonly code?: string;
  readonly limit: number;
  readonly offset: number;
}

interface Loaded {
  readonly revision: number;
  readonly definition: ObjectDefinition;
  readonly permission: ObjectPermission;
}

async function load(tx: Tx, profileId: string, objectCode: string, lock: boolean): Promise<Loaded> {
  const profile = await loadProfile(tx, profileId, lock);
  const definition = (await tenantObjectCatalog(tx, objectCatalog, objectCode)).get(objectCode);
  if (!definition) throw new AppError('NOT_FOUND', '对象不存在');
  const [permission] = await loadObjectPermissions(tx, [profileId], objectCode);
  if (!permission) throw new AppError('NOT_FOUND', '该身份尚未配置此对象');
  return { revision: profile.revision, definition, permission };
}

export async function readDataOperations(
  tx: Tx,
  profileId: string,
  objectCode: string,
): Promise<DialogBase & { dataOperations: DataOperations }> {
  const { revision, permission } = await load(tx, profileId, objectCode, false);
  return { profileId, objectCode, revision, dataOperations: permission.dataOperations };
}

export async function readFields(tx: Tx, profileId: string, objectCode: string, query: FieldDialogQuery) {
  const { revision, definition, permission } = await load(tx, profileId, objectCode, false);
  const granted = new Map(permission.fields.map((f) => [f.fieldCode, f]));
  const needle = query.code?.toLowerCase();
  const matched = definition.fields
    .filter((f) => needle === undefined || f.code.toLowerCase().includes(needle))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const items: FieldDialogItem[] = matched.slice(query.offset, query.offset + query.limit).map((f) => ({
    fieldCode: f.code,
    system: f.system,
    view: granted.get(f.code)?.view ?? false,
    edit: granted.get(f.code)?.edit ?? false,
  }));
  return {
    profileId,
    objectCode,
    revision,
    catalogDigest: objectCatalogDigest(definition),
    items,
    total: matched.length,
    unrecorded: FIELD_DIALOG_UNRECORDED,
  };
}

export interface DialogWrite {
  readonly profileId: string;
  readonly objectCode: string;
  readonly expectedRevision: number;
}

export async function saveDataOperations(
  tx: Tx,
  write: WriteContext,
  change: DialogWrite & { dataOperations: DataOperations },
): Promise<DialogBase> {
  const { permission } = await load(tx, change.profileId, change.objectCode, true);
  return save(tx, write, change, { ...permission, dataOperations: change.dataOperations });
}

export async function saveFields(
  tx: Tx,
  write: WriteContext,
  change: DialogWrite & {
    fields: readonly { fieldCode: string; view: boolean; edit: boolean }[];
    catalogDigest?: string;
  },
): Promise<DialogBase> {
  const codes = change.fields.map((f) => f.fieldCode);
  const dup = codes.find((c, i) => codes.indexOf(c) !== i);
  if (dup !== undefined) {
    throw new AppError('VALIDATION_FAILED', '字段权限配置不合法', [{ reason: 'DUPLICATE_FIELD', fieldCode: dup }]);
  }
  const { permission } = await load(tx, change.profileId, change.objectCode, true);
  // 只替换提交的字段，其余字段、数据操作、按钮原样保留
  const merged = new Map(permission.fields.map((f) => [f.fieldCode, f]));
  for (const field of change.fields) merged.set(field.fieldCode, field);
  return save(tx, write, change, { ...permission, fields: [...merged.values()] }, change.catalogDigest);
}

async function save(
  tx: Tx,
  write: WriteContext,
  change: DialogWrite,
  permission: ObjectPermission,
  catalogDigest?: string,
): Promise<DialogBase> {
  const detail = await setObjectPermission(tx, write, objectCatalog, {
    profileId: change.profileId,
    expectedRevision: change.expectedRevision,
    permission,
    ...(catalogDigest === undefined ? {} : { catalogDigest }),
  });
  return { profileId: change.profileId, objectCode: change.objectCode, revision: detail.revision };
}
