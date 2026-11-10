/**
 * 离职终止在途流程的站内消息模板（F-420，DEC-725；规格 30 终止在途流程）。
 * 模板码存在 approval_notifications.template_code，变量快照存在 payload；读取消息列表时用这里的目录渲染标题 / 正文，
 * 收件人看到的是说明文字而不是模板码（DEC-045：文案走资源，不在界面显示英文码）。
 * 目录里没有的模板码（节点消息规则的租户自定义模板等）不在此渲染，由调用方得到 null。
 */

export const FLOW_TERMINATED_BY_EXIT_TEMPLATE = 'flow_terminated_by_exit';
/** 历史离职导入结束：error_count ≥ 1 / = 0 各一个模板，因为 fill 只做占位符替换、没有条件分支。 */
export const EXIT_IMPORT_FINISHED_TEMPLATE = 'exit_import_finished';
export const EXIT_IMPORT_FINISHED_CLEAN_TEMPLATE = 'exit_import_finished_clean';

interface NoticeTemplate {
  readonly title: string;
  readonly body: string;
  /** 正文用到的变量；目录自检（验收）要求正文里的 {占位符} 都在其中，且每个变量都在正文里出现。 */
  readonly variables: readonly string[];
  /**
   * 发送人显示名在 payload 里的变量名（F-493 §8.1，DEC-839②）；不在正文里，自检把它排除在 variables 之外。
   * 不写 = 系统消息，没有发送人。
   */
  readonly sender?: string;
}

export const EXIT_NOTICE_TEMPLATES: Readonly<Record<string, NoticeTemplate>> = {
  [FLOW_TERMINATED_BY_EXIT_TEMPLATE]: {
    title: '因员工离职生效，流程已终止',
    body: '{employeeName} 的离职于 {effectiveDate} 生效，在途流程「{flowName}」已被系统终止，无需再处理。',
    variables: ['employeeName', 'effectiveDate', 'flowName'],
  },
  // F-493 §8.1：正文逐字照北森 N6（「详情请见附件。」后是半角空格）；「查看详情」链接由前端渲染，不写进正文
  [EXIT_IMPORT_FINISHED_TEMPLATE]: {
    title: '历史离职人员导入结果',
    body: '{fileName}导入已结束，出现{errors}个错误。详情请见附件。 文件将于15天后过期，请尽快下载',
    variables: ['fileName', 'errors'],
    sender: 'senderName',
  },
  [EXIT_IMPORT_FINISHED_CLEAN_TEMPLATE]: {
    title: '历史离职人员导入结果',
    body: '{fileName}导入已结束，出现0个错误。',
    variables: ['fileName'],
    sender: 'senderName',
  },
};

/** flow_terminated_by_exit 的变量快照：登记消息时取值，之后流程名称、员工姓名再变也不影响已发出的消息。 */
export interface FlowTerminatedPayload {
  readonly flowName: string;
  readonly employeeName: string;
  /** 离职生效日（租户时区的业务日期 YYYY-MM-DD）。 */
  readonly effectiveDate: string;
}

/**
 * 导入结果通知的变量快照（全部为字符串，fill 只接受字符串）：errors 取错误条数 error_count 而不是错误行数（DEC-840①）；
 * senderName 是提交人显示名快照，之后改名不影响已发出的通知。
 */
export interface ExitImportFinishedPayload {
  readonly fileName: string;
  readonly errors: string;
  readonly senderName: string;
}

export interface RenderedNotice {
  readonly title: string;
  /** 变量缺失（旧数据没有快照）时为 null，不输出未替换的占位符。 */
  readonly body: string | null;
  /** 发送人显示名：模板声明了 sender 且 payload 里对应值是非空串时为该值，否则 null（不拿登录名顶替）。 */
  readonly sender: string | null;
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
  const sender = template.sender ? payload?.[template.sender] : undefined;
  return {
    title: template.title,
    body: fill(template.body, payload),
    sender: typeof sender === 'string' && sender !== '' ? sender : null,
  };
}
