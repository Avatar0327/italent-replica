import { createContext, useContext } from 'react';
import type { ModelImageCommand } from './model-image-api.js';

export interface TalentTenantSession {
  readonly tenantId: string;
  /** 驻留在 TalentPage：切换页签 / 关闭详情后仍可按原命令核对，租户之间使用独立键。 */
  readonly modelImageCommands: Map<string, ModelImageCommand>;
}

/** 独立详情能力取当前租户，避免让表单承担模型图上传。 */
export const TalentTenantContext = createContext<TalentTenantSession | null>(null);
export const useTalentTenant = () => useContext(TalentTenantContext)?.tenantId ?? null;
export const useTalentModelCommands = () => useContext(TalentTenantContext)?.modelImageCommands;
