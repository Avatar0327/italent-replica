/**
 * F-479 S4：附件接口替身。形状照 main 上的后端实现，不按前端类型手写：
 * - 回执：apps/api/src/modules/attachments/audit.ts `receipt`（顶层 kind / id / revision，无 base64）；
 * - 登记 / 上传 / 删除 / 本人读取：apps/api/src/modules/attachments/routes.ts、service.ts；
 * - 命令台账：apps/api/src/commands.ts（同键同内容重放，同键异内容 409 IDEMPOTENCY_CONFLICT，失败不入台账）；
 * - 结果回查：apps/api/src/modules/command-result/service.ts（台账优先，其次本人确定的业务失败，否则 404）；
 * - 错误信封 { error: { code, message, details? } }：apps/api/src/errors.ts。
 * 只供前端单测与冒烟使用，数据全部合成。
 */
export const ATTACHMENT_PURPOSE = 'exit.handwritten_application';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const BASE = '/api/tenant/attachments';
const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

export interface FixtureFile {
  id: string;
  revision: number;
  status: 'registered' | 'uploaded' | 'pending_cleanup';
  purpose: string;
  filename: string;
  contentType: string | null;
  byteSize: number;
  sha256: string;
  expiresAt: string | null;
  uploadedAt: string | null;
  createdAt: string;
  bytes?: Uint8Array;
}
export interface FixtureCall {
  method: string;
  path: string;
  headers: Headers;
  body?: Record<string, unknown>;
  signal?: AbortSignal | null;
}
/** network：请求未到达服务端；lost：服务端已执行并提交，响应丢失；函数：直接返回该响应、不执行。 */
export type Fault = 'network' | 'lost' | (() => Response | Promise<Response>);
interface Rule {
  method: string;
  pattern: RegExp;
  fault: Fault;
  times: number;
}
interface Outcome {
  status: number;
  body: unknown;
}

export const errorBody = (code: string, message: string, details?: unknown) => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});
const fail = (status: number, code: string, message: string): Outcome => ({
  status,
  body: errorBody(code, message),
});

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 与 model-image-format.ts `sniffImageType` 同一组文件头。 */
export function sniff(bytes: Uint8Array): string | null {
  const starts = (...head: number[]) => head.every((value, index) => bytes[index] === value);
  if (bytes.length >= 3 && starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (bytes.length >= 8 && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (bytes.length >= 6 && (starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)))
    return 'image/gif';
  if (bytes.length >= 14 && starts(0x42, 0x4d)) return 'image/bmp';
  return null;
}

/** 合成的最小 PNG 文件头（8 字节签名 + 若干填充），足以通过文件头识别。 */
export function pngBytes(fill = 1, length = 32): Uint8Array {
  const bytes = new Uint8Array(length).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

export function receiptOf(file: FixtureFile) {
  const { bytes: _bytes, ...rest } = file;
  return {
    kind: 'attachment_file' as const,
    id: rest.id,
    revision: rest.revision,
    status: rest.status,
    purpose: rest.purpose,
    filename: rest.filename,
    contentType: rest.contentType,
    byteSize: rest.byteSize,
    sha256: rest.sha256,
    expiresAt: rest.expiresAt,
    uploadedAt: rest.uploadedAt,
    createdAt: rest.createdAt,
  };
}

const json = (outcome: Outcome) =>
  new Response(JSON.stringify(outcome.body), {
    status: outcome.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });

export class AttachmentBackend {
  readonly files = new Map<string, FixtureFile>();
  /** 载体内容（已绑定文件），按完整路径登记。 */
  readonly carrier = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly calls: FixtureCall[] = [];
  private readonly ledger = new Map<string, { fingerprint: string; outcome: Outcome }>();
  private readonly failures = new Map<string, { status: number; commandType: string }>();
  private readonly rules: Rule[] = [];
  private sequence = 0;
  readonly now = '2026-11-08T02:00:00.000Z';

  constructor(readonly tenantId: string) {}

  /** 给匹配的下一次（或前 times 次）请求注入故障。 */
  inject(method: string, pattern: RegExp, fault: Fault, times = 1) {
    this.rules.push({ method, pattern, fault, times });
  }

  /** 预置本人临时文件（用于临时文件上限等场景）。 */
  seedTemporary(count: number) {
    for (let i = 0; i < count; i++) this.add({ status: 'uploaded', filename: `已上传${i}.png` });
  }

  add(partial: Partial<FixtureFile>): FixtureFile {
    this.sequence += 1;
    const file: FixtureFile = {
      id: `00000000-0000-4000-8000-${String(this.sequence).padStart(12, '0')}`,
      revision: 1,
      status: 'registered',
      purpose: ATTACHMENT_PURPOSE,
      filename: '合成.png',
      contentType: null,
      byteSize: 32,
      sha256: '0'.repeat(64),
      expiresAt: null,
      uploadedAt: null,
      createdAt: this.now,
      ...partial,
    };
    this.files.set(file.id, file);
    return file;
  }

  calledWith(method: string, pattern: RegExp) {
    return this.calls.filter((call) => call.method === method && pattern.test(call.path));
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = String(input);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    this.calls.push({ method, path, headers, body, signal: init.signal });
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const rule = this.rules.find((item) => item.times > 0 && item.method === method && item.pattern.test(path));
    if (rule) rule.times -= 1;
    if (rule?.fault === 'network') throw new TypeError('Failed to fetch');
    if (typeof rule?.fault === 'function') return rule.fault();
    const response = await this.respond(method, path, headers, body);
    if (rule?.fault === 'lost') throw new TypeError('Failed to fetch');
    return response;
  };

  private async respond(method: string, path: string, headers: Headers, body?: Record<string, unknown>) {
    if (headers.get('x-tenant-id') !== this.tenantId)
      return json(fail(400, 'TENANT_CONTEXT_REQUIRED', '缺少租户上下文'));
    const content = this.carrier.get(path);
    if (method === 'GET' && content) return this.binary(content.bytes, content.contentType);
    const result = /^\/api\/tenant\/commands\/([^/]+)\/result$/.exec(path);
    if (result && method === 'GET') return json(this.commandResult(decodeURIComponent(result[1]!)));
    const file = new RegExp(`^${BASE}/(${UUID.source})(/upload|/content)?$`).exec(path);
    if (method === 'GET' && file?.[2] === '/content') return this.content(file[1]!);
    if (method === 'GET' && file && !file[2]) return json(this.meta(file[1]!));
    if (method === 'POST' && path === BASE)
      return json(await this.command(method, path, headers, body, () => this.register(body!)));
    if (method === 'POST' && file?.[2] === '/upload')
      return json(await this.command(method, path, headers, body, () => this.upload(file[1]!, headers, body!)));
    if (method === 'DELETE' && file && !file[2])
      return json(await this.command(method, path, headers, body, () => this.remove(file[1]!, headers)));
    return json(fail(404, 'NOT_FOUND', '资源不存在'));
  }

  private async command(
    method: string,
    path: string,
    headers: Headers,
    body: unknown,
    execute: () => Outcome | Promise<Outcome>,
  ): Promise<Outcome> {
    const key = headers.get('idempotency-key');
    if (!key) return fail(400, 'IDEMPOTENCY_KEY_REQUIRED', '写请求必须携带 Idempotency-Key');
    const fingerprint = JSON.stringify({ method, path, ifMatch: headers.get('if-match'), body });
    const replay = this.ledger.get(key);
    if (replay && replay.fingerprint !== fingerprint)
      return fail(409, 'IDEMPOTENCY_CONFLICT', '同一命令 ID 已用于不同内容的请求');
    if (replay) return replay.outcome;
    const outcome = await execute();
    if (outcome.status < 400) this.ledger.set(key, { fingerprint, outcome });
    else this.failures.set(key, { status: outcome.status, commandType: `${method} ${path.replace(UUID, ':id')}` });
    return outcome;
  }

  private commandResult(commandId: string): Outcome {
    const entry = this.ledger.get(commandId);
    if (entry) {
      const record = entry.outcome.body as { kind?: string; id?: string; revision?: number };
      return {
        status: 200,
        body: {
          commandId,
          status: entry.outcome.status < 400 ? 'succeeded' : 'failed',
          commandType: null,
          businessType: record.kind ?? null,
          businessId: record.id ?? null,
          revision: record.revision ?? null,
          httpStatus: entry.outcome.status,
          completedAt: this.now,
        },
      };
    }
    const failure = this.failures.get(commandId);
    if (!failure) return fail(404, 'NOT_FOUND', '没有找到本人发起的该命令结果');
    return {
      status: 200,
      body: {
        commandId,
        status: 'failed',
        commandType: failure.commandType,
        businessType: null,
        businessId: null,
        revision: null,
        httpStatus: failure.status,
        completedAt: this.now,
      },
    };
  }

  private register(body: Record<string, unknown>): Outcome {
    const filename = String(body.filename);
    const extension = filename.split('.').at(-1)?.toLowerCase() ?? '';
    if (body.purpose !== ATTACHMENT_PURPOSE) return fail(400, 'VALIDATION_FAILED', '附件用途不支持');
    if (!/^[a-f0-9]{64}$/.test(String(body.sha256)))
      return fail(400, 'VALIDATION_FAILED', 'sha256 必须为 64 位十六进制');
    if (!MIME[extension]) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '仅支持 jpeg、jpg、gif、png、bmp 格式的图片');
    if (Number(body.byteSize) > 10 * 1024 * 1024) return fail(413, 'PAYLOAD_TOO_LARGE', '附件不能超过 10MiB');
    if (MIME[extension] !== body.contentType)
      return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '仅支持 jpeg、jpg、gif、png、bmp 格式的图片');
    const temporary = [...this.files.values()].filter((file) => ['registered', 'uploaded'].includes(file.status));
    if (temporary.length >= 20) return fail(409, 'ATTACHMENT_TEMP_LIMIT', '未使用的临时附件过多，请先删除不需要的附件');
    const file = this.add({ filename, byteSize: Number(body.byteSize), sha256: String(body.sha256) });
    return { status: 201, body: receiptOf(file) };
  }

  private async upload(id: string, headers: Headers, body: Record<string, unknown>): Promise<Outcome> {
    const file = this.temporary(id);
    if (!file) return fail(404, 'NOT_FOUND', '附件不存在');
    if (String(file.revision) !== headers.get('if-match'))
      return fail(409, 'REVISION_CONFLICT', '附件已变化，请刷新后重新提交');
    if (file.status !== 'registered') return fail(409, 'CONFLICT', '附件已上传，不能重复上传');
    const bytes = Uint8Array.from(atob(String(body.base64)), (char) => char.charCodeAt(0));
    if (bytes.length !== file.byteSize || (await sha256Hex(bytes)) !== file.sha256)
      return fail(400, 'VALIDATION_FAILED', '附件内容与登记的大小或哈希不一致');
    const contentType = sniff(bytes);
    if (!contentType) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '仅支持 jpeg、jpg、gif、png、bmp 格式的图片');
    Object.assign(file, {
      status: 'uploaded',
      contentType,
      bytes,
      uploadedAt: this.now,
      expiresAt: '2026-11-09T02:00:00.000Z',
      revision: file.revision + 1,
    });
    return { status: 200, body: receiptOf(file) };
  }

  private remove(id: string, headers: Headers): Outcome {
    const file = this.temporary(id);
    if (!file) return fail(404, 'NOT_FOUND', '附件不存在');
    if (String(file.revision) !== headers.get('if-match'))
      return fail(409, 'REVISION_CONFLICT', '附件已变化，请刷新后重新提交');
    Object.assign(file, { status: 'pending_cleanup', revision: file.revision + 1 });
    return { status: 200, body: receiptOf(file) };
  }

  private temporary(id: string) {
    const file = this.files.get(id.toLowerCase());
    return file && ['registered', 'uploaded'].includes(file.status) ? file : undefined;
  }

  private meta(id: string): Outcome {
    const file = this.temporary(id);
    return file ? { status: 200, body: receiptOf(file) } : fail(404, 'NOT_FOUND', '附件不存在');
  }

  private content(id: string) {
    const file = this.temporary(id);
    if (!file || file.status !== 'uploaded' || !file.bytes) return json(fail(404, 'NOT_FOUND', '附件不存在'));
    return this.binary(file.bytes, file.contentType!);
  }

  private binary(bytes: Uint8Array, contentType: string) {
    return new Response(bytes as BodyInit, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-disposition': 'attachment; filename="_.png"',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-store',
      },
    });
  }
}
