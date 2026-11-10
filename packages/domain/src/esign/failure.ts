/** 发起签署失败的原因与显示文案（F-481 设计 §4.4，复刻自拟，DEC-842①）。 */

export const ESIGN_FAILURE_REASONS = [
  'TEMPLATE_UNAVAILABLE',
  'EMPLOYEE_NO_ACCOUNT',
  'INITIATOR_NO_ACCOUNT',
  'RENDER_FAILED',
] as const;

export type EsignFailureReason = (typeof ESIGN_FAILURE_REASONS)[number];

export const ESIGN_FAILURE_COPY: Readonly<Record<EsignFailureReason, string>> = {
  TEMPLATE_UNAVAILABLE: '所选签署模板已停用',
  EMPLOYEE_NO_ACCOUNT: '员工没有可登录的账号，无法签署',
  INITIATOR_NO_ACCOUNT: '签署发起人账号不可用，无法完成企业确认',
  RENDER_FAILED: '签署文件生成失败',
};

export function isEsignFailureReason(value: unknown): value is EsignFailureReason {
  return typeof value === 'string' && (ESIGN_FAILURE_REASONS as readonly string[]).includes(value);
}

/** 按原因取显示文案；库里出现目录外的原因（旧数据 / 将来对接的回调原因）时不泄露原始字符串。 */
export function esignFailureText(reason: string | null): string | null {
  if (reason === null) return null;
  return isEsignFailureReason(reason) ? ESIGN_FAILURE_COPY[reason] : '签署发起失败';
}
