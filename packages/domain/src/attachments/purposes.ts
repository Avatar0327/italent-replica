/**
 * F-479 附件用途表（docs/08_设计/F-479_通用附件能力_设计.md §1.3）。
 * 用途是服务端的权威配置：个数、大小、类型、扩展名、临时文件有效期都在这里，前后端共用同一份。
 * 本期只有一个用途；表结构支持扩展，但不预置其他用途（§0.3）。
 */
export const ATTACHMENT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp'] as const;
export type AttachmentImageType = (typeof ATTACHMENT_IMAGE_TYPES)[number];

export interface AttachmentPurposeConfig {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly types: readonly AttachmentImageType[];
  readonly extensions: readonly string[];
  /** 未绑定的临时文件有效期（小时），到期由清理任务（S3）处理。 */
  readonly tempTtlHours: number;
  /** 同一所有人未绑定的临时文件数上限，防止无限登记。 */
  readonly maxTemporaryPerOwner: number;
  /** 绑定载体（S2 起使用）。 */
  readonly carrier: string;
}

export const ATTACHMENT_PURPOSES = {
  'exit.handwritten_application': {
    maxFiles: 5,
    maxBytes: 10 * 1024 * 1024, // 10,485,760 字节允许，多 1 字节拒绝（Q-1 已取证）
    types: ATTACHMENT_IMAGE_TYPES,
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp'],
    tempTtlHours: 24,
    maxTemporaryPerOwner: 20,
    carrier: 'employment.exit',
  },
} as const satisfies Record<string, AttachmentPurposeConfig>;

export type AttachmentPurpose = keyof typeof ATTACHMENT_PURPOSES;

export const ATTACHMENT_PURPOSE_CODES = Object.keys(ATTACHMENT_PURPOSES) as AttachmentPurpose[];

export function attachmentPurpose(code: string): AttachmentPurposeConfig | undefined {
  return Object.hasOwn(ATTACHMENT_PURPOSES, code) ? ATTACHMENT_PURPOSES[code as AttachmentPurpose] : undefined;
}
