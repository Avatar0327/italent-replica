/**
 * 电子签服务商适配接口（F-481 设计 §7；DEC-842①）。S1 只定接口与“模拟服务商”：方法都是空操作、不联网。
 * 真实服务商（企业认证、印章、实名三要素）不在本单范围；S2 起 `initiateTransferSign` 经此接口发起，
 * 不允许在业务代码里直接调用某个具体服务商。
 */
export interface EnvelopeFile {
  /** 任务文件序号（esign_task_files.seq）。 */
  readonly seq: number;
  readonly fileName: string;
  /** 变量替换后的正文（domain renderTemplateBody 产物）。 */
  readonly content: string;
}

export interface CreateEnvelopeInput {
  readonly tenantId: string;
  readonly taskId: string;
  readonly files: readonly EnvelopeFile[];
  readonly expiresAt: Date;
}

export interface EnvelopeReceipt {
  /** 服务商侧的信封编号；模拟服务商不产生真实编号。 */
  readonly envelopeRef: string;
}

export interface ESignProvider {
  readonly name: string;
  createEnvelope(input: CreateEnvelopeInput): Promise<EnvelopeReceipt>;
  /** 撤销信封（任务被撤销或过期时调用）。 */
  revoke(tenantId: string, envelopeRef: string): Promise<void>;
  /** 催签（提醒个人节点）。 */
  remind(tenantId: string, envelopeRef: string): Promise<void>;
}

/** 空实现：测试与本地开发默认使用；不发网络请求，信封编号取任务 ID，保证可重复执行（幂等）。 */
export const simulatedProvider: ESignProvider = {
  name: 'simulated',
  createEnvelope: async (input) => ({ envelopeRef: `simulated:${input.taskId}` }),
  revoke: async () => undefined,
  remind: async () => undefined,
};
