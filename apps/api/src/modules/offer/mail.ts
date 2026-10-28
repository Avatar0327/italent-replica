/**
 * 查看 Offer 邮件读口（F-234BE；原站为新标签详情页 OfferEmailDetailView，F234A B5 / B6）。收件人 / 抄送 / 密送取该 Offer 最近一条
 * 发送记录（send.ts 写入），姓名与正文字段取当前 Offer 行。不返回发送时间 / 发送人 / 历史 / 投递状态（原站不展示）。
 * 权限 = 查看 Offer（loadOffer 同 GET /:id 的数据范围）；收件人 / 抄送 / 密送按 personalEmail 查看字段权，正文字段各按自己的查看字段权。
 */
import { and, desc, eq, lte, offerSendRecords, orgVersions, withTenant, type Tx } from '@italent/db';
import { OFFER_OBJECT, tenantLocalDate } from '@italent/domain';
import type { Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { uuidParam } from '../job/context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import { offerReadContext, type OfferContext } from './context.js';
import { loadOffer } from './service.js';

const MISSING = '--';
export const OFFER_MAIL_SUBJECT = '录用通知';
const NOTICE_TITLE = '录用通知书';

/** 内置固定模板（复刻没有邮件模板引擎）：纯文本段落，{键} 由 renderNotice 一次性替换；不含标记，不生成答复链接（F-183）。 */
const NOTICE_TEMPLATE = [
  '{name}：',
  '您好！感谢您对我们的关注与信任，经综合评估，我们决定录用您，期待您加入{department}。',
  '应聘职位：{appliedPosition}。',
  '预计入职日期：{plannedEntryDate}。',
  '工作地点：{workPlace}。',
  '请您在收到本通知后尽快确认是否接受本 Offer；如有疑问，请与招聘负责人联系。',
  '报到时请携带身份证明、学历学位证明及离职证明等材料，具体报到安排以招聘负责人通知为准。',
  '本通知书内容仅供收件人本人查阅，请勿转发。',
] as const;

type NoticeValues = Readonly<
  Record<'name' | 'department' | 'appliedPosition' | 'plannedEntryDate' | 'workPlace', string>
>;

/** 渲染正文的单一入口：单次扫描替换占位，取值里即便含 `{x}` 也不会二次展开。 */
export const renderNotice = (values: NoticeValues): string[] =>
  NOTICE_TEMPLATE.map((line) => line.replace(/\{(\w+)\}/g, (_, key: keyof NoticeValues) => values[key]));

export async function offerMail(tx: Tx, ctx: OfferContext, id: string, viewable: ReadonlySet<string> | undefined) {
  const offer = await loadOffer(tx, ctx, id);
  const [record] = await tx
    .select()
    .from(offerSendRecords)
    .where(and(eq(offerSendRecords.tenantId, ctx.tenantId), eq(offerSendRecords.offerId, id)))
    .orderBy(desc(offerSendRecords.createdAt), desc(offerSendRecords.id))
    .limit(1);
  if (!record) throw new AppError('NOT_FOUND', 'Offer 邮件尚未发送', { reason: 'OFFER_MAIL_NOT_SENT' });
  const shown = (field: string) => viewable === undefined || viewable.has(field);
  const text = (field: string, value: string | null) => (shown(field) && value ? value : MISSING);
  const emailShown = shown('personalEmail');
  const department =
    shown('departmentId') && offer.departmentId ? await departmentName(tx, ctx, offer.departmentId) : MISSING;
  return {
    offerId: offer.id,
    name: text('name', offer.name),
    recipient: emailShown ? record.recipient : null,
    subject: OFFER_MAIL_SUBJECT,
    notice: {
      title: NOTICE_TITLE,
      paragraphs: renderNotice({
        name: text('name', offer.name),
        department,
        appliedPosition: text('appliedPosition', offer.appliedPosition),
        plannedEntryDate: text('plannedEntryDate', offer.plannedEntryDate),
        workPlace: text('workPlace', offer.workPlace),
      }),
    },
    attachments: [],
    cc: emailShown ? record.cc : null,
    bcc: emailShown ? record.bcc : null,
  };
}

/** 录用部门当前名称（按租户时区的今天取已生效的最新版本）；取不到按缺省值。 */
async function departmentName(tx: Tx, ctx: OfferContext, orgId: string) {
  const [version] = await tx
    .select({ name: orgVersions.name })
    .from(orgVersions)
    .where(
      and(
        eq(orgVersions.tenantId, ctx.tenantId),
        eq(orgVersions.orgId, orgId),
        lte(orgVersions.startDate, tenantLocalDate(ctx.now, ctx.timezone)),
      ),
    )
    .orderBy(desc(orgVersions.startDate), desc(orgVersions.versionNo))
    .limit(1);
  return version?.name ?? MISSING;
}

export function registerOfferMail(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.get('/:id/mail', async (c) => {
    const ctx = await offerReadContext(c, deps);
    const id = uuidParam(c);
    const viewable = await getModuleViewableFields(deps, ctx, OFFER_OBJECT);
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => offerMail(tx, ctx, id, viewable)));
  });
}
