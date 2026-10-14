import { accountText as text } from './messages.js';

export const AVATAR_PATH = '/api/tenant/account/avatar';
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_ACCEPT = '.jpg,.jpeg,.gif,.png,.bmp';
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  png: 'image/png',
  bmp: 'image/bmp',
};

export interface AvatarReference {
  readonly id: string;
  readonly url: string;
}
export interface AvatarView {
  readonly revision: number;
  readonly name: string;
  readonly avatar: AvatarReference | null;
}
export interface AvatarCommand {
  readonly path: string;
  readonly method: 'POST' | 'DELETE';
  readonly key: string;
  readonly revision: number;
  readonly body?: unknown;
}

export class AvatarApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function avatarRequest<T>(tenantId: string, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId, ...options.headers },
  });
  if (response.status >= 500) throw new Error(text.uncertain);
  if (!response.ok) {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    throw new AvatarApiError(body.error?.code ?? 'UNKNOWN_ERROR', body.error?.message ?? text.failed, response.status);
  }
  return response.json() as Promise<T>;
}

export function sendAvatarCommand<T>(tenantId: string, command: AvatarCommand): Promise<T> {
  return avatarRequest<T>(tenantId, command.path, {
    method: command.method,
    ...(command.body === undefined ? {} : { body: JSON.stringify(command.body) }),
    headers: { 'if-match': String(command.revision), 'idempotency-key': command.key },
  });
}

export function avatarFileError(file: File): string | null {
  const contentType = IMAGE_TYPES[file.name.split('.').at(-1)?.toLowerCase() ?? ''];
  if (!contentType || (file.type && file.type !== contentType)) return text.invalidFormat;
  if (file.size > AVATAR_MAX_BYTES) return text.tooLarge;
  return null;
}

export async function avatarRegistration(file: File, revision: number) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  const command: AvatarCommand = {
    path: `${AVATAR_PATH}/attachments`,
    method: 'POST',
    key: crypto.randomUUID(),
    revision,
    body: {
      filename: file.name,
      contentType: IMAGE_TYPES[file.name.split('.').at(-1)!.toLowerCase()],
      byteSize: file.size,
      sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    },
  };
  return { command, base64: btoa(binary) };
}
