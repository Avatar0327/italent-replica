import { offerRow } from './offer-list-fixture.js';

export const mailRow = { ...offerRow, status: 'onboarded', rowActions: { primary: [], menu: ['view'] } };
export const sentMailRow = {
  ...offerRow,
  id: '40000000-0000-4000-8000-000000000234',
  name: '合成已发候选人',
  status: 'sent',
};
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
