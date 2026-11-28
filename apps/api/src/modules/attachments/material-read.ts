/**
 * 16a-4b0 入职材料附件契约常量（docs/08_设计/R2-T01_信息采集扫码与融入设计.md §4.2）。
 * 材料用的是独立用途，不与离职、人员子集混用；用途未挂任何 HTTP 路由，由 16a-4b 在材料办理里经受信端口调用：
 * - 登记 / 上传：registerFile / uploadFile，用途 MATERIAL_PURPOSE，登记标记 materialTargetTag(材料项 ID)；
 * - 绑定 / 释放：bindAttachmentRefs 传 carrier = MATERIAL_CARRIER（归属类型由载体固定为 MATERIAL_BUSINESS_TYPE）、
 *   targetTag（材料项标记）、employeeId（目标员工，二者必填，缺任一即拒），businessId 取材料提交（版本）ID，
 *   下一版引用列表为空即释放；
 * - 摘要 / 下载：attachmentSummaries / readCarrierAttachment 传 MATERIAL_BUSINESS_TYPE，下载必须另传再验权回调
 *   （缺回调与回调返回否同为 404，都在读字节前）。
 */
export const MATERIAL_PURPOSE = 'onboarding.material_attachment';
export const MATERIAL_CARRIER = 'onboarding.material';
/** 绑定后的 business_type。 */
export const MATERIAL_BUSINESS_TYPE = 'onboarding.material';

/** 未绑定行的登记标记：绑定时按材料项复核，别的材料项的文件不能绑进来（与子集的字段标记同一做法）。 */
export const materialTargetTag = (itemId: string) => `${MATERIAL_BUSINESS_TYPE}:${itemId}`;
