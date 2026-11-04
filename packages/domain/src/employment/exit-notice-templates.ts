/**
 * 离职终止在途流程的站内消息模板（F-420，DEC-725；规格 30 终止在途流程）。
 * 模板码存在 approval_notifications.template_code，变量快照存在 payload；读取消息列表时用这里的目录渲染标题 / 正文，
 * 收件人看到的是说明文字而不是模板码（DEC-045：文案走资源，不在界面显示英文码）。
 * 目录里没有的模板码（节点消息规则的租户自定义模板等）不在此渲染，由调用方得到 null。
 */

export const FLOW_TERMINATED_BY_EXIT_TEMPLATE = 'flow_terminated_by_exit';

interface NoticeTemplate {
  readonly title: string;
  readonly body: string;
  /** 正文用到的变量；目录自检（验收）要求正文里的 {占位符} 都在其中，且每个变量都在正文里出现。 */
  readonly variables: readonly string[];
}

export const EXIT_NOTICE_TEMPLATES: Readonly<Record<string, NoticeTemplate>> = {
  [FLOW_TERMINATED_BY_EXIT_TEMPLATE]: {
    title: '因员工离职生效，流程已终止',
    body: '{employeeName} 的离职于 {effectiveDate} 生效，在途流程「{flowName}」已被系统终止，无需再处理。',
    variables: ['employeeName', 'effectiveDate', 'flowName'],
  },
};

/** flow_terminated_by_exit 的变量快照：登记消息时取值，之后流程名称、员工姓名再变也不影响已发出的消息。 */
export interface FlowTerminatedPayload {
  readonly flowName: string;
  readonly employeeName: string;
  /** 离职生效日（租户时区的业务日期 YYYY-MM-DD）。 */
  readonly effectiveDate: string;
}

export interface RenderedNotice {
  readonly title: string;
  /** 变量缺失（旧数据没有快照）时为 null，不输出未替换的占位符。 */
  readonly body: string | null;
}

/** 无变量（或变量不全）时返回 null 的单个替换；占位符形如 {name}。 */
function fill(text: string, payload: Readonly<Record<string, unknown>> | null): string | null {
  let missing = false;
  const filled = text.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = payload?.[name];
    if (typeof value !== 'string' || value === '') missing = true;
    return typeof value === 'string' ? value : '';
  });
  return missing ? null : filled;
}

/** 渲染站内消息：模板码不在目录里返回 null；标题不含变量，正文变量缺失时只有正文为 null。 */
export function renderExitNotice(
  templateCode: string | null,
  payload: Readonly<Record<string, unknown>> | null,
): RenderedNotice | null {
  const template = templateCode ? EXIT_NOTICE_TEMPLATES[templateCode] : undefined;
  if (!template) return null;
  return { title: template.title, body: fill(template.body, payload) };
}
