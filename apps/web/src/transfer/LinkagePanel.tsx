/** 联动执行情况（AC-LNK-04）：失败数与失败明细，失败子项可单独重试（revision 校验，不盲重试）。 */
import { linkageText } from './messages.js';
import type { LinkageItemView, LinkageView } from './types.js';

export function LinkagePanel(props: { view: LinkageView; busy?: boolean; onRetry?: (item: LinkageItemView) => void }) {
  const { view } = props;
  // 电子签选择随联动选项保存，生效前就要能看到，所以未执行时也显示（F-481 §8.1）。
  if (!view.executedAt)
    return (
      <section className="transfer-linkage" aria-label={linkageText.detail}>
        <h3>{linkageText.detail}</h3>
        <p>{linkageText.pending}</p>
        <EsignLine view={view} />
      </section>
    );
  return (
    <section className="transfer-linkage" aria-label={linkageText.detail}>
      <h3>{linkageText.detail}</h3>
      <p>
        {linkageText.executedAt}：{view.executedAt}
      </p>
      <EsignLine view={view} />
      {view.contract && <p>{linkageText.contractChanged}</p>}
      {view.onTrial && (
        <p>
          {linkageText.trial}：{view.onTrial.startDate} ～ {view.onTrial.expectedEndDate}
        </p>
      )}
      {view.handover && (
        <p>
          {linkageText.handover}：{view.handover.handoverStatus}
        </p>
      )}
      {view.salaryReminder && <p>{linkageText.salaryReminder}</p>}
      {view.dutyTransfer && (
        <>
          <h4>
            {linkageText.dutySummary} {view.dutyTransfer.total} · {linkageText.failedCount}{' '}
            {view.dutyTransfer.failedCount}
          </h4>
          <ItemList items={view.dutyTransfer.items} {...props} />
        </>
      )}
      {view.insuranceArchive && (
        <>
          <h4>{linkageText.insuranceArchive}</h4>
          <ItemList items={[view.insuranceArchive]} {...props} />
        </>
      )}
      {view.partTimes.length > 0 && (
        <>
          <h4>{linkageText.partTimes}</h4>
          <ItemList items={view.partTimes} {...props} />
        </>
      )}
    </section>
  );
}

/** esign 键缺席 = 两字段任一不可见，整行不显示；null = 否。 */
function EsignLine({ view }: { view: LinkageView }) {
  if (view.esign === undefined) return null;
  if (view.esign === null)
    return (
      <p>
        {linkageText.electronicSignature}：{linkageText.esignNo}
      </p>
    );
  const names = view.esign.templates.flatMap(({ name, available }) => {
    if (name === null) return [];
    return [available ? name : linkageText.esignDisabled(name)];
  });
  return (
    <p>
      {linkageText.electronicSignature}：{linkageText.esignYes}
      {names.length > 0 && `（${names.join('、')}）`}
    </p>
  );
}

function ItemList(props: {
  items: readonly LinkageItemView[];
  busy?: boolean;
  onRetry?: (item: LinkageItemView) => void;
}) {
  return (
    <ul>
      {props.items.map((item) => (
        <li key={item.id}>
          {item.effectiveDate} · {statusText(item.status)} · {item.attemptCount}
          {linkageText.attempts}
          {item.failure && <span role="alert">：{item.failure.message}</span>}
          {item.status === 'failed' && (
            <button type="button" data-retry-item={item.id} disabled={props.busy} onClick={() => props.onRetry?.(item)}>
              {linkageText.retry}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function statusText(status: LinkageItemView['status']) {
  return status === 'succeeded'
    ? linkageText.succeeded
    : status === 'failed'
      ? linkageText.failed
      : linkageText.waiting;
}
