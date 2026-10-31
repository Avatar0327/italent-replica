import { Button, Descriptions, Tabs } from 'antd';
import { DetailPage } from '../foundation/templates.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useRead } from '../part-time/useRead.js';
import { actions, detailSections, m } from './messages.js';
import {
  apiRoot,
  canReadMail,
  displayValue,
  errorKind,
  object,
  openMail,
  visibleColumn,
  type OfferRow,
} from './model.js';

/** 详情以真实 ID 独立读取，不把列表快照当作详情；失败时不保留上一条记录。 */
export function OfferDetail({ id, close }: { id: string; close(): void }) {
  const result = useRead<OfferRow>(`${apiRoot}/${encodeURIComponent(id)}`);
  const permission = usePermissions(object);
  const row = result.data;
  const error = result.error ?? permission.error;
  const ready = !error && !result.loading && !permission.loading && row;
  let summary = <Tabs items={[{ key: 'offer', label: 'Offer' }]} />;
  if (!ready) summary = <PageState kind="loading" />;
  if (error) summary = <PageState kind={errorKind(error)} retry={result.refresh} />;
  return (
    <DetailPage
      open
      onClose={close}
      title={ready && permission.field('name').visible ? displayValue(row, '姓名') : actions.view}
      actions={ready && canReadMail(row) && <Button onClick={() => openMail(row.id)}>{actions.mail}</Button>}
      summary={summary}
      sections={
        ready
          ? detailSections.map((section) => ({
              key: section.title,
              title: section.title,
              children: (
                <Descriptions
                  column={3}
                  size="small"
                  colon={false}
                  items={section.fields
                    .filter((label) => visibleColumn(label, (field) => permission.field(field).visible, [row]))
                    .map((label) => ({ key: label, label, children: displayValue(row, label) || m.empty }))}
                />
              ),
            }))
          : []
      }
    />
  );
}
