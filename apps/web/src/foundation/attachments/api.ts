/**
 * 附件接口客户端与“结果未知”恢复协议（docs/08_设计/F-479_通用附件能力_设计.md §5.1、§5.1.1）。
 * 登记与上传是两条各带客户端命令 ID 的写命令，恢复协议分开：登记未知时附件 ID 还不知道，只能按命令 ID 回查；
 * 上传未知时附件 ID 已知，按 `GET /attachments/:id` 回查当前状态。拿到确定结果前不换键（AGENTS §10 幂等）。
 */
import {
  ATTACHMENT_PURPOSES,
  attachmentExtension,
  type AttachmentPurpose,
  type AttachmentPurposeConfig,
} from '@italent/domain';
import { ApiError, newCommand, type ApiClient, type Command } from '../client.js';
import { attachmentText as text } from './messages.js';

const BASE = '/api/tenant/attachments';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 回执：attachments/audit.ts `receipt`，登记、上传、删除、本人读取同形。 */
export interface AttachmentReceipt {
  readonly kind: 'attachment_file';
  readonly id: string;
  readonly revision: number;
  readonly status: 'registered' | 'uploaded' | 'pending_cleanup';
  readonly purpose: string;
  readonly filename: string;
  readonly contentType: string | null;
  readonly byteSize: number;
  readonly sha256: string;
  readonly expiresAt: string | null;
  readonly uploadedAt: string | null;
}

/** 控件的值：载体展开项 AttachmentSummary（已绑定）或本次上传的临时文件（带 temporary）。 */
export interface AttachmentView {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string | null;
  readonly byteSize: number;
  readonly uploadedAt: string | null;
  readonly missing?: true;
  /** 本次会话上传、尚未随表单保存的临时文件；删除时以此 revision 作 If-Match 调 DELETE。 */
  readonly temporary?: { readonly revision: number };
}

interface RegisterBody {
  purpose: AttachmentPurpose;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
}
interface CommandResult {
  commandId: string;
  status: 'succeeded' | 'failed';
  businessType: string | null;
  businessId: string | null;
  revision: number | null;
  httpStatus: number | null;
}

export const purposeConfig = (purpose: AttachmentPurpose): AttachmentPurposeConfig => ATTACHMENT_PURPOSES[purpose];

/** 扩展名到登记 contentType，与后端 validateImageMetadata 同口径（jpg / jpeg → image/jpeg，其余 image/<扩展名>）。 */
export function declaredType(config: AttachmentPurposeConfig, filename: string): string | undefined {
  const extension = attachmentExtension(filename);
  if (!config.extensions.includes(extension)) return undefined;
  const type = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
  return (config.types as readonly string[]).includes(type) ? type : undefined;
}

/** 本地校验（Q-3：类型只按扩展名判定）；返回拒绝文案，合格返回 undefined。 */
export function localRejection(config: AttachmentPurposeConfig, file: File): string | undefined {
  if (!declaredType(config, file.name)) return text.badFormat;
  if (file.size > config.maxBytes) return text.tooLarge;
  return undefined;
}

export function attachmentApi(client: ApiClient) {
  const path = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
  return {
    register: (command: Command<RegisterBody>, signal?: AbortSignal) =>
      client.request<unknown>(BASE, { method: 'POST', command, signal }).then(receiptOf),
    upload: (id: string, command: Command<{ base64: string }>, signal?: AbortSignal) =>
      client.request<unknown>(`${path(id)}/upload`, { method: 'POST', command, signal }).then(receiptOf),
    read: (id: string, signal?: AbortSignal) => client.request<unknown>(path(id), { signal }).then(receiptOf),
    remove: (id: string, command: Command<undefined>) =>
      client.request<unknown>(path(id), { method: 'DELETE', command }).then(receiptOf),
    commandResult: (commandId: string, signal?: AbortSignal) =>
      client.request<CommandResult>(`/api/tenant/commands/${encodeURIComponent(commandId)}/result`, { signal }),
  };
}
export type AttachmentApi = ReturnType<typeof attachmentApi>;

function receiptOf(value: unknown): AttachmentReceipt {
  const receipt = value as Partial<AttachmentReceipt> | null;
  const valid =
    receipt?.kind === 'attachment_file' &&
    typeof receipt.id === 'string' &&
    UUID.test(receipt.id) &&
    Number.isSafeInteger(receipt.revision) &&
    ['registered', 'uploaded', 'pending_cleanup'].includes(receipt.status ?? '') &&
    typeof receipt.filename === 'string' &&
    typeof receipt.sha256 === 'string';
  if (!valid) throw new ApiError(502, 'INVALID_RESPONSE', 'unknown', text.unknown);
  return receipt as AttachmentReceipt;
}

export function viewOf(receipt: AttachmentReceipt): AttachmentView {
  return {
    id: receipt.id.toLowerCase(),
    filename: receipt.filename,
    contentType: receipt.contentType,
    byteSize: receipt.byteSize,
    uploadedAt: receipt.uploadedAt,
    temporary: { revision: receipt.revision },
  };
}

/** 网络错误、503（结果未知 / 存储不可写）与无法解析的响应都不是确定结果，只能先回查再重提。 */
export function isUncertain(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status === 502 || error.status === 503);
}
export const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/** 确定失败的中文文案；不显示服务端 message 与原因码（设计 §5.1 文案表）。 */
export function failureText(status: number, code?: string): string {
  if (status === 413 || code === 'PAYLOAD_TOO_LARGE') return text.tooLarge;
  if (status === 415) return text.badFormat;
  if (code === 'ATTACHMENT_TEMP_LIMIT') return text.tempLimit;
  if (status === 404) return text.expired;
  if (status === 403 || status === 401) return text.denied;
  if (status === 409) return text.changed;
  if (status === 429) return text.rateLimit;
  if (status === 400) return text.invalid;
  return text.failed;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/** 单张上传的协议状态：命令 ID 与请求体在内存里保留到拿到确定结果为止（§5.1.1 登记恢复第 6 条：刷新即丢弃）。 */
export interface UploadState {
  readonly purpose: AttachmentPurpose;
  readonly file: File;
  prepared?: { sha256: string; base64: string; contentType: string };
  register?: Command<RegisterBody>;
  registerUncertain?: boolean;
  target?: { id: string; revision: number };
  upload?: Command<{ base64: string }>;
  uploadUncertain?: boolean;
}
export type UploadOutcome =
  | { kind: 'done'; receipt: AttachmentReceipt }
  | { kind: 'uncertain' }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string; retryAfter?: number };

/** 跑一次（首次或重试）：按所处阶段走登记恢复或上传恢复。中止（卸载）原样抛出 AbortError，由调用方丢弃。 */
export async function runUpload(api: AttachmentApi, state: UploadState, signal: AbortSignal): Promise<UploadOutcome> {
  if (!state.prepared) {
    const bytes = new Uint8Array(await state.file.arrayBuffer());
    const contentType = declaredType(purposeConfig(state.purpose), state.file.name)!;
    state.prepared = { sha256: await sha256Hex(bytes), base64: base64Of(bytes), contentType };
  }
  if (!state.target) {
    const outcome = await registerStep(api, state, signal);
    if (outcome) return outcome;
  }
  return uploadStep(api, state, signal);
}

async function registerStep(api: AttachmentApi, state: UploadState, signal: AbortSignal) {
  if (state.register && state.registerUncertain) {
    const verdict = await recheckRegister(api, state.register.id, signal);
    if (verdict.kind === 'uncertain') return verdict;
    if (verdict.kind === 'failed') {
      // 确定失败：丢弃原命令，用户再点重试时才生成新键（§5.1.1 登记恢复第 3 条）
      state.register = undefined;
      state.registerUncertain = false;
      return verdict;
    }
    if (verdict.kind === 'succeeded') {
      settleRegister(state, verdict.target);
      return undefined;
    }
    // 404：原键原体重发（第 4 条）；服务端台账同键同内容会重放首次回执
  }
  const prepared = state.prepared!;
  state.register ??= newCommand<RegisterBody>({
    purpose: state.purpose,
    filename: state.file.name,
    contentType: prepared.contentType,
    byteSize: state.file.size,
    sha256: prepared.sha256,
  });
  try {
    const receipt = await api.register(state.register, signal);
    settleRegister(state, { id: receipt.id, revision: receipt.revision });
    return undefined;
  } catch (error) {
    return registerFailure(state, error);
  }
}

function settleRegister(state: UploadState, target: { id: string; revision: number }) {
  state.target = target;
  state.register = undefined;
  state.registerUncertain = false;
}

function registerFailure(state: UploadState, error: unknown): UploadOutcome {
  if (isAbort(error)) throw error;
  if (isUncertain(error)) {
    state.registerUncertain = true;
    return { kind: 'uncertain' };
  }
  const failure = error instanceof ApiError ? error : undefined;
  // 429 请求未被执行：保留原命令，到期后同键重提；其余确定失败丢弃原命令
  if (failure?.status !== 429) state.register = undefined;
  state.registerUncertain = false;
  return { kind: 'failed', message: failureText(failure?.status ?? 0, failure?.code), retryAfter: failure?.retryAfter };
}

type RegisterVerdict =
  | { kind: 'succeeded'; target: { id: string; revision: number } }
  | { kind: 'failed'; message: string }
  | { kind: 'uncertain' }
  | { kind: 'resend' };

async function recheckRegister(api: AttachmentApi, commandId: string, signal: AbortSignal): Promise<RegisterVerdict> {
  try {
    const result = await api.commandResult(commandId, signal);
    if (result.commandId !== commandId) return { kind: 'uncertain' };
    // 结果摘要不带错误码；登记不带 If-Match，业务 409 只有临时文件上限一种（attachments/service.ts）
    if (result.status === 'failed')
      return { kind: 'failed', message: failureText(result.httpStatus ?? 0, registerCode(result.httpStatus)) };
    const id = result.businessId;
    const revision = result.revision;
    if (result.businessType === 'attachment_file' && id && UUID.test(id) && Number.isSafeInteger(revision))
      return { kind: 'succeeded', target: { id, revision: revision! } };
    // 结果摘要不全：原键重发同样安全（台账重放首次回执），不当作确定结果
    return { kind: 'resend' };
  } catch (error) {
    if (isAbort(error)) throw error;
    // 404：不是本人、不存在或结果未知，接口约定不得当作确定失败
    if (error instanceof ApiError && error.status === 404) return { kind: 'resend' };
    return { kind: 'uncertain' };
  }
}

const registerCode = (status: number | null) => (status === 409 ? 'ATTACHMENT_TEMP_LIMIT' : undefined);

async function uploadStep(api: AttachmentApi, state: UploadState, signal: AbortSignal): Promise<UploadOutcome> {
  const target = state.target!;
  if (state.upload && state.uploadUncertain) {
    const verdict = await recheckUpload(api, state, signal);
    if (verdict) return verdict;
  }
  state.upload ??= newCommand({ base64: state.prepared!.base64 }, target.revision);
  try {
    const receipt = await api.upload(target.id, state.upload, signal);
    return { kind: 'done', receipt };
  } catch (error) {
    if (isAbort(error)) throw error;
    if (isUncertain(error)) {
      state.uploadUncertain = true;
      return { kind: 'uncertain' };
    }
    const failure = error instanceof ApiError ? error : undefined;
    if (failure?.status === 404) return { kind: 'expired' };
    if (failure?.status !== 429) state.upload = undefined;
    state.uploadUncertain = false;
    return {
      kind: 'failed',
      message: failureText(failure?.status ?? 0, failure?.code),
      retryAfter: failure?.retryAfter,
    };
  }
}

/** 上传恢复（§5.1.1）：uploaded 且哈希一致即成功；registered 用原上传命令重发；404 失效；403 确定失败。 */
async function recheckUpload(api: AttachmentApi, state: UploadState, signal: AbortSignal) {
  try {
    const receipt = await api.read(state.target!.id, signal);
    if (receipt.status === 'pending_cleanup') return { kind: 'expired' } as const;
    if (receipt.status === 'uploaded')
      return receipt.sha256 === state.prepared!.sha256
        ? ({ kind: 'done', receipt } as const)
        : ({ kind: 'failed', message: text.changed } as const);
    state.uploadUncertain = false;
    return undefined;
  } catch (error) {
    if (isAbort(error)) throw error;
    if (error instanceof ApiError && error.status === 404) return { kind: 'expired' } as const;
    if (error instanceof ApiError && !isUncertain(error))
      return { kind: 'failed', message: failureText(error.status, error.code) } as const;
    return { kind: 'uncertain' } as const;
  }
}
