import { modelImageText as text } from './model-image-messages.js';

export const MODEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MODEL_IMAGE_ACCEPT = '.jpeg,.jpg,.gif,.png,.bmp';
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  png: 'image/png',
  bmp: 'image/bmp',
};

export interface ModelImageMetadata {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly status: 'registered' | 'uploaded';
}
export interface ModelImageView {
  readonly revision: number;
  readonly canEdit: boolean;
  readonly modelImage: ModelImageMetadata | null;
}
export interface ModelImageCommand {
  readonly path: string;
  readonly method: 'POST' | 'DELETE';
  readonly key: string;
  readonly revision: number;
  readonly body?: unknown;
  /** 登记结果未知时保留完整上传内容，原登记命令重放成功后再上传。 */
  readonly uploadBase64?: string;
}

export class ModelImageApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const modelImagePath = (criterionId: string) => `criteria/${criterionId}/model-image`;

async function response(tenantId: string, path: string, options: RequestInit = {}) {
  const result = await fetch(`/api/tenant/talent/${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId, ...options.headers },
  });
  if (result.status >= 500) throw new Error(text.uncertain);
  if (!result.ok) {
    const body = (await result.json()) as { error?: { code?: string; message?: string } };
    throw new ModelImageApiError(body.error?.code ?? 'UNKNOWN_ERROR', body.error?.message ?? text.failed);
  }
  return result;
}

export async function modelImageRequest<T>(tenantId: string, path: string, options: RequestInit = {}): Promise<T> {
  return (await response(tenantId, path, options)).json() as Promise<T>;
}

export async function modelImageContent(tenantId: string, path: string, signal: AbortSignal): Promise<Blob> {
  return (await response(tenantId, path, { signal })).blob();
}

export function sendModelImageCommand<T>(tenantId: string, command: ModelImageCommand): Promise<T> {
  return modelImageRequest<T>(tenantId, command.path, {
    method: command.method,
    ...(command.body === undefined ? {} : { body: JSON.stringify(command.body) }),
    headers: { 'if-match': String(command.revision), 'idempotency-key': command.key },
  });
}

export function modelImageFileError(file: File): string | null {
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  const contentType = IMAGE_TYPES[extension];
  if (!contentType || (file.type && file.type !== contentType)) return text.invalidFormat;
  if (file.size > MODEL_IMAGE_MAX_BYTES) return text.tooLarge;
  return null;
}

export async function modelImageRegistration(file: File, path: string, revision: number): Promise<ModelImageCommand> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return {
    path: `${path}/attachments`,
    method: 'POST',
    key: crypto.randomUUID(),
    revision,
    body: {
      filename: file.name,
      contentType: IMAGE_TYPES[file.name.split('.').at(-1)!.toLowerCase()],
      byteSize: file.size,
      sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    },
    uploadBase64: btoa(binary),
  };
}
