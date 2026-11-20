// F-326 S7b（主设计 §5.5 ④）：本位置自动变量的回显摘要，放在“指定人员”来源下方。
// 人员取当前表单选择（与将提交的一致），未改动时即待生效值优先 / 变量当前值；“发布后生效”只在仍是持久化的待生效人员时标。
// 停用标记、重新生成提示与引用数取持久化的变量元数据；引用流程数 ≥ 2 用提示色：改这里的人员会影响其他流程。
import { Tag, Typography } from 'antd';
import { useDesignerPeople } from './FallbackHandlers.js';
import { autoPeople, type AutoVariableView } from './auto-variables.js';
import { s } from './source-messages.js';

const same = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

export function AutoVariableInfo({ auto, people }: { auto: AutoVariableView; people: readonly string[] }) {
  const pending = !!auto.pendingUserIds && same(people, autoPeople(auto));
  const { known } = useDesignerPeople([...people]);
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
        {pending && <Tag color="processing">{s.auto.pending}</Tag>}
        {auto.status === 'disabled' && <Tag>{s.auto.disabled}</Tag>}
      </div>
      {auto.status === 'disabled' && <Typography.Text type="secondary">{s.auto.regenerate}</Typography.Text>}
      <Typography.Text className="flow-auto-usage" type={count >= 2 ? 'warning' : 'secondary'}>
        {s.auto.usage(count)}
      </Typography.Text>
    </div>
  );
}
