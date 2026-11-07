import { Button, Checkbox, Empty, Input, Radio, Switch, Table, Tag, type TableColumnsType } from 'antd';
import type { ReactNode } from 'react';
import { display } from './model.js';
import { mx, tr } from './messages.js';
import type { ReviewRecord } from './types.js';

export interface Cell {
  cellNo: number;
  xLevelNo: number;
  yLevelNo: number;
  name: string;
  color: string;
  textColor: string;
  exportOrder: number | null;
  countsGreen: boolean;
}
interface Rule {
  operator: string;
  pctLow: number;
  pctHigh: number | null;
  cellNos: number[];
}
interface Group {
  id: string;
  name: string;
  isDefault: boolean;
  controlScope: string;
  controlMode: string;
  minPopulation: number;
  rules: Rule[];
}
export interface SectionProps {
  record: ReviewRecord;
  /** 字段可见性：被裁剪的字段整行不显示，不用别的字段顶替（DEC-502① d）。 */
  visible(field: string): boolean;
  fieldName(id: unknown): string;
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="matrix-section" id={id}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="matrix-row">
      <span className="matrix-label">{label}</span>
      <span>{children}</span>
    </div>
  );
}
const Unavailable = () => <Tag className="matrix-unavailable">{tr.unavailable}</Tag>;
const Flag = ({ value }: { value: unknown }) => <Switch size="small" disabled checked={value === true} />;
/** 未执行过的写动作：只保留入口位置，禁用并说明未验证（R3cd spec §3.2）。 */
const Unverified = ({ label }: { label: string }) => (
  <Button size="small" disabled title={tr.unverified}>
    {label}
  </Button>
);

export function BasicSection({ record, visible, fieldName }: SectionProps) {
  const positions = (record.positionFields ?? []) as { role: string; fieldId: string }[];
  const position = (role: string) => positions.find((item) => item.role === role)?.fieldId;
  return (
    <Section id="matrix-basic" title={mx.sections.basic}>
      {visible('enabled') && (
        <Row label={mx.enabled}>
          <Flag value={record.enabled} />
        </Row>
      )}
      {visible('xFieldId') && <Row label={mx.xField}>{fieldName(record.xFieldId)}</Row>}
      {visible('xDraggable') && (
        <Row label={mx.xDraggable}>
          <Flag value={record.xDraggable} />
        </Row>
      )}
      {visible('yFieldId') && <Row label={mx.yField}>{fieldName(record.yFieldId)}</Row>}
      {visible('yDraggable') && (
        <Row label={mx.yDraggable}>
          <Flag value={record.yDraggable} />
        </Row>
      )}
      <Row label={mx.fieldText}>
        <Unavailable />
      </Row>
      {visible('greenRateReference') && (
        <Row label={mx.greenRate}>
          <Flag value={record.greenRateReference} />
        </Row>
      )}
      {visible('zFieldId') && <Row label={mx.third}>{fieldName(record.zFieldId)}</Row>}
      {visible('positionFields') && (
        <Row label={mx.position}>
          <span className="matrix-required">*</span>
          {mx.before}
          {fieldName(position('before'))}
          <span className="matrix-gap" />
          <span className="matrix-required">*</span>
          {mx.after}
          {fieldName(position('after'))}
        </Row>
      )}
      {visible('placementSource') && (
        <Row label={mx.placement}>{mx.placements[String(record.placementSource)] ?? tr.missing}</Row>
      )}
    </Section>
  );
}

export function DisplaySection({ record, visible }: SectionProps) {
  const cells = visible('cells') ? ((record.cells ?? []) as Cell[]) : [];
  return (
    <Section id="matrix-display" title={mx.sections.display}>
      <Row label={mx.displayOptions}>
        <Unavailable />
      </Row>
      {!visible('cells') ? null : !cells.length ? <Empty description={tr.noCells} /> : <CellGrid cells={cells} />}
      {cells.length > 0 && (
        <Table
          size="small"
          rowKey="cellNo"
          pagination={false}
          dataSource={[...cells].sort((a, b) => a.cellNo - b.cellNo)}
          columns={[
            { dataIndex: 'cellNo', title: mx.cellColumns.no, width: 72 },
            { dataIndex: 'name', title: mx.cellColumns.name },
            { dataIndex: 'textColor', title: mx.cellColumns.text, render: (value: string) => <Swatch color={value} /> },
            { dataIndex: 'color', title: mx.cellColumns.color, render: (value: string) => <Swatch color={value} /> },
            {
              dataIndex: 'countsGreen',
              title: mx.cellColumns.green,
              render: (value: boolean) => (value ? tr.yes : tr.no),
            },
          ]}
        />
      )}
    </Section>
  );
}
const Swatch = ({ color }: { color: string }) => (
  <span className="matrix-swatch">
    <i style={{ background: color }} />
    {color}
  </span>
);
function CellGrid({ cells }: { cells: Cell[] }) {
  // 服务端 checkCells 保证从 1 连续铺满全部轴段；直接用格子坐标，不假定三档；纵轴高段在上。
  const xLevels = Math.max(...cells.map((cell) => cell.xLevelNo));
  const yLevels = Math.max(...cells.map((cell) => cell.yLevelNo));
  return (
    <div
      className="review-grid"
      style={{
        gridTemplateColumns: `repeat(${xLevels}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${yLevels}, auto)`,
      }}
    >
      {cells.map((cell) => (
        <div
          className="review-cell"
          key={cell.cellNo}
          style={{
            gridColumn: cell.xLevelNo,
            gridRow: yLevels - cell.yLevelNo + 1,
            background: cell.color,
            color: cell.textColor,
          }}
        >
          {cell.name}
        </div>
      ))}
    </div>
  );
}

export function RatioSection({ record, visible }: SectionProps) {
  const groups = visible('ratioGroups') ? ((record.ratioGroups ?? []) as Group[]) : undefined;
  const cells = (visible('cells') ? (record.cells ?? []) : []) as Cell[];
  return (
    <Section id="matrix-ratio" title={mx.sections.ratio}>
      <Row label={mx.ratioSwitch}>
        <Unavailable />
      </Row>
      <p className="matrix-note">{mx.ratioNote}</p>
      {groups && (
        <div className="matrix-actions">
          <Unverified label={mx.addGroup} />
        </div>
      )}
      {groups && !groups.length && <Empty description={mx.noGroups} />}
      {groups?.map((group) => (
        <RatioGroup key={group.id} group={group} cells={cells} />
      ))}
    </Section>
  );
}
function RatioGroup({ group, cells }: { group: Group; cells: Cell[] }) {
  return (
    <div className="matrix-group">
      <div className="matrix-group-head">
        <Row label={mx.groupName}>{group.name}</Row>
        <Checkbox disabled checked={group.isDefault}>
          {mx.isDefault}
        </Checkbox>
        <Unverified label={mx.copy} />
        <Unverified label={mx.remove} />
      </div>
      <Row label={mx.scope}>
        <Radio.Group disabled value={group.controlScope} options={mx.scopes} />
      </Row>
      <Row label={mx.minPopulation}>{group.minPopulation}</Row>
      <Row label={mx.mode}>
        <Radio.Group
          disabled
          value={group.controlMode}
          options={[
            { value: 'warn', label: mx.warn },
            { value: 'block', label: mx.block[group.controlScope] ?? mx.block.project_meeting },
          ]}
        />
      </Row>
      <Row label={mx.expression}>
        <Input disabled size="small" className="matrix-expression" />
        <Unavailable />
      </Row>
      <Table
        size="small"
        tableLayout="fixed"
        rowKey={(_, index) => String(index)}
        pagination={false}
        dataSource={group.rules}
        columns={ruleColumns(cells)}
      />
      <div className="matrix-actions">
        <Unverified label={mx.add} />
      </div>
    </div>
  );
}
const required = (title: string) => (
  <>
    <span className="matrix-required">*</span>
    {title}
  </>
);
/** 规则表列与列宽按原站（R3cd spec §3.2）：序号 72 / *格子名称 342 / *运算符 202 / *值 152 / 操作 86。 */
function ruleColumns(cells: Cell[]): TableColumnsType<Rule> {
  const cellName = (no: number) => cells.find((cell) => cell.cellNo === no)?.name ?? String(no);
  return [
    { key: 'no', title: mx.ruleColumns.no, width: 72, render: (_, __, index) => index + 1 },
    {
      key: 'cells',
      title: required(mx.ruleColumns.cells),
      width: 342,
      render: (_, rule) => rule.cellNos.map(cellName).join('、'),
    },
    {
      key: 'operator',
      title: required(mx.ruleColumns.operator),
      width: 202,
      render: (_, rule) => mx.operators[rule.operator] ?? display(rule.operator),
    },
    {
      key: 'value',
      title: required(mx.ruleColumns.value),
      width: 152,
      render: (_, rule) => (rule.operator === 'between' ? `${rule.pctLow}%～${rule.pctHigh}%` : `${rule.pctLow}%`),
    },
    {
      key: 'actions',
      title: mx.ruleColumns.actions,
      width: 86,
      render: () => (
        <Button
          size="small"
          type="link"
          className="matrix-delete"
          aria-label={mx.remove}
          disabled
          title={tr.unverified}
        />
      ),
    },
  ];
}

export function ExportSection({ record, visible }: SectionProps) {
  if (!visible('cells'))
    return (
      <Section id="matrix-export" title={mx.sections.export}>
        {null}
      </Section>
    );
  const cells = (record.cells ?? []) as Cell[];
  const ordered = cells.filter((cell) => cell.exportOrder !== null).sort((a, b) => a.exportOrder! - b.exportOrder!);
  const unset = cells.filter((cell) => cell.exportOrder === null);
  return (
    <Section id="matrix-export" title={mx.sections.export}>
      <Row label={mx.exportOrder}>
        <ol className="matrix-export">
          {ordered.map((cell, index) => (
            <li key={cell.cellNo}>{`${index + 1}.${cell.name}`}</li>
          ))}
        </ol>
      </Row>
      {unset.length > 0 && <Row label={mx.exportUnset}>{unset.map((cell) => cell.name).join('、')}</Row>}
    </Section>
  );
}
