import { Alert } from 'antd';
import { tr } from './messages.js';

/** DEC-774 / DEC-812：缺契约仅展示未完成说明，不以演示会议或成员代替服务端结果。 */
export function Meetings({ pool = false }: { pool?: boolean }) {
  return (
    <section className="list-page review-unavailable">
      <header className="page-heading">
        <h1>{pool ? tr.pools : tr.meetings}</h1>
      </header>
      <div className="list-card">
        <Alert
          type="info"
          showIcon
          message={tr.unavailable}
          description={pool ? tr.poolUnavailable : tr.meetingUnavailable}
        />
      </div>
    </section>
  );
}
