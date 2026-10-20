import { offerExamples } from '../src/demo-stubs/offers.js';

// 沿用 Offer 列表的合成样例；仅测试拦截返回此数据，产品读取真实接口。
export const mailRow = offerExamples().find((row) => row.state === 'onboarded')!;
export const mailFixture = {
  offerId: mailRow.id,
  name: mailRow.name,
  recipient: 'candidate@example.com',
  subject: '录用通知' as const,
  notice: { title: '录用通知书' as const, paragraphs: ['合成候选人您好：', '欢迎加入合成研发团队。'] },
  attachments: [] as [],
  cc: ['copy@example.com'],
  bcc: ['blind@example.com'],
};
