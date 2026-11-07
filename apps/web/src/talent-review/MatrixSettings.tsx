import { Alert, Anchor, Button, Empty, Radio, Tabs } from 'antd';
import { useEffect } from 'react';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { BasicSection, DisplaySection, ExportSection, RatioSection, Section } from './MatrixSections.js';
import { display } from './model.js';
import { mx, tr } from './messages.js';
import { useCollection } from './useCollection.js';
import { useReviewController } from './useReviewController.js';

const FIELD_OBJECT = 'TalentReview.Field';

/**
 * 九宫格详细设置 / 通用设置整页（R3cd spec §3.2）：配置胶囊切换九宫格，四个分区只读呈现真实配置。原站本页没有保存按钮、
 * 增删复制未执行过，复刻不开放写入；缺后端字段的显示项标未完成（docs/02_业务建模 盘点九宫格；DEC-774、DEC-812）。
 */
export function MatrixSettings() {
  return (
    <section className="matrix-settings">
      <header className="page-heading">
        <h1>{mx.title}</h1>
      </header>
      <DecisionNote id="talent-review-matrices" />
      <Tabs
        items={[
          { key: 'detail', label: mx.detail, children: <MatrixDetail /> },
          { key: 'general', label: mx.general, children: <MatrixGeneral /> },
        ]}
      />
    </section>
  );
}

function MatrixDetail() {
  const { permission, result, selected, select, detail, error, refresh } = useReviewController('matrices');
  const items = result.data.items;
  useEffect(() => {
    if (!selected && items[0]) select({ id: items[0].id });
  }, [items, selected, select]);
  const fieldPermission = usePermissions(FIELD_OBJECT);
  const catalog = useCollection('fields', !!fieldPermission.snapshot.objects[FIELD_OBJECT]);
  // 字段目录读不到（无权或失败）时回显字段 ID，不猜名称。
  const fieldName = (id: unknown) =>
    typeof id === 'string' ? display(catalog.data.items.find((row) => row.id === id)?.name ?? id) : tr.missing;
  if (result.loading) return <PageState kind="loading" />;
  if (result.error) return <PageState kind="error" error={result.error} />;
  if (!items.length) return <Empty description={mx.empty} />;
  const record = detail && detail.id === selected?.id ? detail : undefined;
  const props = record && { record, visible: (field: string) => permission.field(field).visible, fieldName };
  return (
    <>
      <Radio.Group
        className="matrix-pills"
        optionType="button"
        buttonStyle="solid"
        value={selected?.id}
        onChange={(event) => select({ id: String(event.target.value) })}
        options={items.map((row) => ({
          value: row.id,
          label: permission.field('name').visible ? display(row.name) : tr.missing,
        }))}
      />
      {!!error && (
        <Alert
          type="error"
          showIcon
          message={error instanceof Error ? error.message : tr.unknown}
          action={<Button onClick={refresh}>{tr.refresh}</Button>}
        />
      )}
      {!props && !error && <PageState kind="loading" />}
      {props && (
        <div className="matrix-layout">
          <div>
            <BasicSection {...props} />
            <DisplaySection {...props} />
            <RatioSection {...props} />
            <ExportSection {...props} />
          </div>
          <Anchor
            affix={false}
            items={Object.entries({
              'matrix-basic': mx.sections.basic,
              'matrix-display': mx.sections.display,
              'matrix-ratio': mx.sections.ratio,
              'matrix-export': mx.sections.export,
            }).map(([key, title]) => ({ key, href: `#${key}`, title }))}
          />
        </div>
      )}
    </>
  );
}

/** 租户设置契约（settings-service）没有姓名宽度与导出字段，选项只读展示原站结构，标未完成。 */
function MatrixGeneral() {
  return (
    <div className="matrix-general">
      <Alert type="info" message={tr.unavailable} />
      <Section id="matrix-name-width" title={mx.nameWidth}>
        <Button type="link" disabled title={tr.unverified}>
          {mx.example}
        </Button>
        <Radio.Group disabled options={mx.widths} />
      </Section>
      <Section id="matrix-export-fields" title={mx.exportFields}>
        <span className="matrix-unavailable">{tr.unavailable}</span>
      </Section>
    </div>
  );
}
