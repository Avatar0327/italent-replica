// F-326 S7b（主设计 §5.5 ④）：本位置自动变量的回显摘要，放在“指定人员”来源下方。
// 人员取待生效值优先（发布后生效）；引用流程数 ≥ 2 用提示色：改这里的人员会影响其他流程。
import { Tag, Typography } from 'antd';
import { useDesignerPeople } from './FallbackHandlers.js';
import { autoPeople, type AutoVariableView } from './auto-variables.js';
import { s } from './source-messages.js';

export function AutoVariableInfo({ auto }: { auto: AutoVariableView }) {
  const people = autoPeople(auto);
  const { known } = useDesignerPeople(people);
  const names = people.map(
    (userId) => known?.choices.find((choice) => choice.value === userId)?.label ?? s.personUnavailable,
  );
  const count = auto.referencingProcessCount;
  return (
    <div className="flow-auto-variable">
      <div>
        <Typography.Text>{s.auto.summary(names.length ? names.join('、') : s.unselected)}</Typography.Text>{' '}
        <Typography.Text type="secondary" className="flow-auto-code">
          {auto.code}
        </Typography.Text>
        {auto.pendingUserIds && <Tag color="processing">{s.auto.pending}</Tag>}
        {auto.status === 'disabled' && <Tag>{s.auto.disabled}</Tag>}
      </div>
      {auto.status === 'disabled' && <Typography.Text type="secondary">{s.auto.regenerate}</Typography.Text>}
      <Typography.Text className="flow-auto-usage" type={count >= 2 ? 'warning' : 'secondary'}>
        {s.auto.usage(count)}
      </Typography.Text>
    </div>
  );
}
