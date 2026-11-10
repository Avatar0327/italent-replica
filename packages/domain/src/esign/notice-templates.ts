/**
 * 电子签署站内消息模板（F-481 设计 §7，复刻自拟，D4）。
 * 同 employment/exit-notice-templates.ts：模板码存在 approval_notifications.template_code，变量快照存在 payload，
 * 读取消息列表时用这里的目录渲染标题 / 正文；目录里没有的模板码返回 null。payload 只存显示值，不存证件、手机号。
 */

export const ESIGN_REMIND_TEMPLATE = 'esign_remind';
export const ESIGN_REVOKED_INITIATOR_TEMPLATE = 'esign_revoked_initiator';
export const ESIGN_REVOKED_EMPLOYEE_TEMPLATE = 'esign_revoked_employee';
export const ESIGN_COMPLETED_EMPLOYEE_TEMPLATE = 'esign_completed_employee';
export const ESIGN_COMPLETED_INITIATOR_TEMPLATE = 'esign_completed_initiator';

/** 站内消息的业务类型（notifyMessage 的 businessType）。 */
export const ESIGN_NOTICE_BUSINESS_TYPE = 'esign_task';

/** `{场景}` 固定值（设计 §7）。 */
export const ESIGN_SCENE_LABEL = '调动电子签署';

interface NoticeTemplate {
  readonly title: string;
  readonly body: string;
  /** 正文用到的变量；目录自检要求正文里的 {占位符} 都在其中，且每个变量都在正文里出现。 */
  readonly variables: readonly string[];
}

export const ESIGN_NOTICE_TEMPLATES: Readonly<Record<string, NoticeTemplate>> = {
  [ESIGN_REMIND_TEMPLATE]: {
    title: '电子签署提醒',
    body: '您有一份{场景}待签署：{文件名称}，请在 {截止时间} 前到「我的签署」完成签署。',
    variables: ['场景', '文件名称', '截止时间'],
  },
  [ESIGN_REVOKED_INITIATOR_TEMPLATE]: {
    title: '电子签署已撤销',
    body: '{员工姓名}的{场景}（{文件名称}）已撤销。',
    variables: ['员工姓名', '场景', '文件名称'],
  },
  [ESIGN_REVOKED_EMPLOYEE_TEMPLATE]: {
    title: '电子签署已撤销',
    body: '您的{场景}（{文件名称}）已撤销，无需再签署。',
    variables: ['场景', '文件名称'],
  },
  [ESIGN_COMPLETED_EMPLOYEE_TEMPLATE]: {
    title: '电子签署已完成',
    body: '您的{场景}（{文件名称}）已签署完成，可在「我的签署」下载。',
    variables: ['场景', '文件名称'],
  },
  [ESIGN_COMPLETED_INITIATOR_TEMPLATE]: {
    title: '电子签署已完成',
    body: '{员工姓名}的{场景}（{文件名称}）已签署完成。',
    variables: ['员工姓名', '场景', '文件名称'],
  },
};

export interface EsignNoticePayload {
  readonly 场景: string;
  readonly 文件名称: string;
  readonly 员工姓名?: string;
  /** 租户时区、到分钟的显示值，如 2026-11-30 18:00。 */
  readonly 截止时间?: string;
}

/** `{文件名称}`：各文件模板名称以“、”连接，超过 3 个写“等 N 份文件”。 */
export function esignFileLabel(templateNames: readonly string[]): string {
  return templateNames.length > 3 ? `等 ${templateNames.length} 份文件` : templateNames.join('、');
}

export interface RenderedEsignNotice {
  readonly title: string;
  /** 变量缺失（旧数据没有快照）时为 null，不输出未替换的占位符。 */
  readonly body: string | null;
}

function fill(text: string, payload: Readonly<Record<string, unknown>> | null): string | null {
  let missing = false;
  const filled = text.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const value = payload?.[name];
    if (typeof value !== 'string' || value === '') missing = true;
    return typeof value === 'string' ? value : '';
  });
  return missing ? null : filled;
}

/** 渲染站内消息：模板码不在目录里返回 null；标题不含变量，正文变量缺失时只有正文为 null。 */
export function renderEsignNotice(
  templateCode: string | null,
  payload: Readonly<Record<string, unknown>> | null,
): RenderedEsignNotice | null {
  const template = templateCode ? ESIGN_NOTICE_TEMPLATES[templateCode] : undefined;
  if (!template) return null;
  return { title: template.title, body: fill(template.body, payload) };
}
