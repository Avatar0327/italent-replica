/**
 * 电子签服务商适配接口（F-481 设计 §5.3；DEC-842①）。S1 建服务接口；S3b 增加已签文件渲染。模拟路径不联网。
 * 真实服务商（企业认证、印章、实名三要素）不在本单范围；S2 起发起、S3b 起撤销 / 提醒经此接口调用，
 * 不允许在业务代码里直接调用某个具体服务商。`signedFiles` 由 S3b 加入（只有下载用它）。
 */
import { renderPdf, type Doc } from '../survey360/export-files.js';
import { boundedSize } from '../qualification/chart-files.js';
export type SignNode = 'employee' | 'enterprise';

export interface EnvelopeFile {
  /** 任务文件序号（esign_task_files.seq）。 */
  readonly seq: number;
  readonly name: string;
  /** 变量替换后的正文（domain renderTemplateBody 产物）。 */
  readonly content: string;
}

export interface EnvelopeSigner {
  readonly node: SignNode;
  readonly userId: string;
}

export interface CreateEnvelopeInput {
  readonly tenantId: string;
  readonly taskId: string;
  readonly files: readonly EnvelopeFile[];
  readonly signers: readonly EnvelopeSigner[];
  readonly expiresAt: Date;
}

export interface EnvelopeReceipt {
  /** 服务商侧的信封编号；模拟服务商不产生真实编号，固定为 null。 */
  readonly providerRef: string | null;
}

interface EnvelopeTarget {
  readonly tenantId: string;
  readonly taskId: string;
  readonly providerRef: string | null;
}

export interface ESignProvider {
  /** 'simulated' 或将来的服务名。 */
  readonly name: string;
  createEnvelope(input: CreateEnvelopeInput): Promise<EnvelopeReceipt>;
  /** 撤销信封（任务被撤销或过期时调用）。 */
  revoke(input: EnvelopeTarget): Promise<void>;
  /** 催签（提醒指定个人节点）。 */
  remind(input: EnvelopeTarget & { readonly node: SignNode }): Promise<void>;
  /** 模拟路径由调用者传入已授权的快照版面；服务商无需读库或重新解析模板。 */
  signedFiles(
    input: EnvelopeTarget & { readonly documents: readonly Doc[]; readonly signal?: AbortSignal },
  ): Promise<readonly { name: string; bytes: Uint8Array }[]>;
}

/** 模拟服务商：发起、撤销与提醒为空操作；文件由已授权快照渲染，不产生服务商编号。 */
export const simulatedProvider: ESignProvider = {
  name: 'simulated',
  createEnvelope: async () => ({ providerRef: null }),
  revoke: async () => undefined,
  remind: async () => undefined,
  signedFiles: async (input) => {
    const files = [];
    let bytes = 0;
    for (const doc of input.documents) {
      const data = await renderPdf(doc, input.signal);
      bytes += data.length;
      boundedSize(bytes);
      files.push({ name: doc.title, bytes: data });
    }
    return files;
  },
};
