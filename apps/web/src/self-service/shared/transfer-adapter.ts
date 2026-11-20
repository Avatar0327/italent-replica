import type { TransferAction, TransferBusiness, TransferFormModel, Choice } from '../../transfer/types.js';

/** 自助入口只适配传输协议与候选策略，预览/命令生命周期仍使用同一 Hook。 */
export interface TransferFormAdapter {
  readonly initialModel: TransferFormModel;
  readonly loadPreview: (
    tenantId: string,
    model: TransferFormModel,
    signal: AbortSignal,
  ) => Promise<Partial<TransferFormModel> & { unavailable?: boolean }>;
  readonly save: (
    tenantId: string,
    model: TransferFormModel,
    action: TransferAction,
    commandId: string,
    /** F-026：非严格控编超编，用户确认后重提时为 true。 */
    confirmed?: boolean,
  ) => Promise<TransferBusiness>;
  readonly queryReferences: (
    tenantId: string,
    model: TransferFormModel,
    code: string,
    name: string,
    page: number,
  ) => Promise<{ items: Choice[] }>;
}
