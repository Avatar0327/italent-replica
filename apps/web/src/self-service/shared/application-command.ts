import type { TransferAction, TransferBusiness, TransferFormModel } from '../../transfer/types.js';

export interface ApplicationCommand {
  commandId: string;
  employeeId: string;
  businessId?: string;
  action: TransferAction;
  effectiveDate?: string;
  /** 仅保留本次表单可见值，不用缓存替代后续草稿读取。 */
  summary: Readonly<Record<string, unknown>>;
}
export type ApplicationCommandRunner = (
  command: ApplicationCommand,
  execute: () => Promise<TransferBusiness>,
) => Promise<TransferBusiness>;
export function applicationCommand(
  model: TransferFormModel,
  action: TransferAction,
  commandId: string,
  saved: TransferBusiness | null,
): ApplicationCommand {
  return {
    commandId,
    action,
    employeeId: model.employeeId,
    ...(saved ? { businessId: saved.id } : {}),
    effectiveDate: model.effectiveDate,
    summary: {
      fields: { ...model.preview?.fields, ...model.fields },
      customFields: { ...model.preview?.customFields, ...model.customFields },
    },
  };
}
