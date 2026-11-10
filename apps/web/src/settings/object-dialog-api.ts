import type { Command } from '../foundation/client.js';
import type { Values } from '../foundation/forms/store.js';
import type { useApiClient } from '../foundation/Session.js';
import {
  dialogBody,
  dialogError,
  profilePath,
  snapshotOf,
  type DialogMode,
  type DialogRead,
  type DialogSnapshot,
  type ProfileDetail,
} from './object-dialog-model.js';
import { om } from './object-messages.js';
type Api = ReturnType<typeof useApiClient>;
export async function readDialog(api: Api, path: string, id: string, objectCode: string, mode: DialogMode) {
  let offset = 0;
  let latest: DialogSnapshot | undefined;
  let total = 0;
  do {
    const raw = await api.request<DialogRead>(mode === 'fields' ? `${path}?limit=500&offset=${offset}` : path);
    const next = snapshotOf(raw, id, objectCode, mode);
    if (
      latest &&
      (latest.revision !== next.revision ||
        latest.values.catalogDigest !== next.values.catalogDigest ||
        total !== raw.total)
    )
      throw new Error(om.invalid);
    latest = latest
      ? { ...latest, values: { ...latest.values, ...next.values }, rows: { ...latest.rows, ...next.rows } }
      : next;
    if (mode === 'data-operations') break;
    total = raw.total!;
    if (!raw.items!.length && offset < total) throw new Error(om.invalid);
    offset += raw.items!.length;
  } while (offset < total);
  return latest!;
}
export async function saveDialog(
  api: Api,
  path: string,
  id: string,
  objectCode: string,
  mode: DialogMode,
  request: Command<Values>,
  baseline: Values,
) {
  let receipt: DialogRead;
  try {
    receipt = await api.request<DialogRead>(path, {
      method: 'PUT',
      command: { ...request, body: dialogBody(mode, request.body, baseline) },
    });
  } catch (cause) {
    throw dialogError(cause);
  }
  if (receipt.profileId !== id || receipt.objectCode !== objectCode || receipt.revision !== request.revision! + 1)
    throw new Error(om.invalid);
  // 写入成功后的读失败仍归入结果未知，不能把后续 4xx 当作原命令被拒。
  const latest = await api.request<ProfileDetail>(profilePath(id)).catch((cause: unknown) => {
    throw new Error(om.invalid, { cause });
  });
  if (latest.id !== id || !Number.isSafeInteger(latest.revision) || latest.revision < receipt.revision)
    throw new Error(om.invalid);
  return { id };
}
