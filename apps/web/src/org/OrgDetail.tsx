import { Button, Descriptions, Dropdown, Tag } from 'antd';
import { DetailPage } from '../foundation/index.js';
import { PersonName } from './PersonFields.js';
import { orgActions, orgCreatable, orgDetailFields, orgLabel, type OrgAction, type OrgRow } from './page-model.js';
import { useRemote, RemoteContent, type PageAccess } from './page-support.js';
import { detailText, pageText as m, text } from './messages.js';

/** 列表与详情共用的取值显示：状态用标签，虚拟组织显示是 / 否。 */
export function orgValue(field: string, value: unknown) {
  if (field === 'enabled' && typeof value === 'boolean')
    return <Tag color={value ? 'green' : 'default'}>{value ? m.enabled : m.disabled}</Tag>;
  if (field === 'isVirtual' && typeof value === 'boolean') return value ? m.yes : m.no;
  return String(value ?? m.missing);
}
interface Props {
  selected?: string;
  date: string;
  detail: ReturnType<typeof useRemote<OrgRow>>;
  access: PageAccess;
  onClose(): void;
  onCreate(parentId: string): void;
  onEdit(original: OrgRow, action: OrgAction): void;
}
type MoreKey = OrgAction | 'createChild';
/**
 * 原站详情头部为「编辑」与「更多操作▾」，停用在「更多操作」里（B2_06、B2_07）；
 * 变更、新建下级同样收进「更多操作」（原站下拉全部项未取证，未验证）。导出无接口，列入缺口。
 */
function OrgDetailActions({ detail, access, onCreate, onEdit }: Props) {
  const original = detail.data;
  if (!original) return null;
  const actions = orgActions(access, original);
  const more: MoreKey[] = [
    ...actions.filter((action) => action !== 'edit'),
    ...(orgCreatable(access) ? (['createChild'] as const) : []),
  ];
  return (
    <>
      {actions.includes('edit') && <Button onClick={() => onEdit(original, 'edit')}>{m.edit}</Button>}
      {more.length > 0 && (
        <Dropdown
          trigger={['click']}
          menu={{
            items: more.map((key) => ({ key, label: m[key] })),
            onClick: ({ key }) => (key === 'createChild' ? onCreate(original.id) : onEdit(original, key as OrgAction)),
          }}
        >
          <Button>{m.moreActions}</Button>
        </Dropdown>
      )}
    </>
  );
}
/** 上级只存 ID；名称按当前权限读取上级详情，读不到（范围外 / 已失效）时明确提示，不补写。 */
function OrgParentName({ id, date }: { id: string; date: string }) {
  const parent = useRemote<OrgRow>(`/api/tenant/org/organizations/${id}?asOf=${date}`);
  if (parent.error) return <>{text.hiddenParent}</>;
  if (!parent.data) return <>{m.missing}</>;
  return <>{parent.data.name ?? m.unavailable}</>;
}
function detailValue(field: string, value: unknown) {
  if (field === 'personInChargeId' && typeof value === 'string' && value) return <PersonName id={value} />;
  return orgValue(field, value);
}
function parentName(id: string | null | undefined, date: string) {
  return id ? <OrgParentName id={id} date={date} /> : m.missing;
}
function parentSection({ detail, date }: Props) {
  return {
    key: 'parents',
    title: m.parent,
    children: (
      <Descriptions
        className="r1-detail-fields"
        column={1}
        items={(['admin', 'business', 'product'] as const)
          .filter((key) => detail.data?.parents?.[key])
          .map((key) => ({
            key,
            label: detailText[key],
            children: parentName(detail.data?.parents?.[key]?.parentId, date),
          }))}
      />
    ),
  };
}
/** 原站详情另有「组织变更记录」「组织操作记录」页签；复刻暂无对应读取接口，列入后端缺口，不放空页签。 */
export function OrgDetail(props: Props) {
  const { detail, access } = props;
  return (
    <DetailPage
      open={!!props.selected}
      onClose={props.onClose}
      summary={<RemoteContent state={detail}>{null}</RemoteContent>}
      title={access.field('name').visible ? (detail.data?.name ?? m.detail) : m.detail}
      actions={<OrgDetailActions {...props} />}
      tabs={[{ key: 'organization', label: m.organizationUnit }]}
      sections={[
        {
          key: 'basic',
          title: m.basic,
          children: (
            <Descriptions
              className="r1-detail-fields"
              column={2}
              size="small"
              items={orgDetailFields(access)
                .filter((field) => detail.data?.[field] !== undefined)
                .map((field) => ({
                  key: field,
                  label: orgLabel(field, 'detail'),
                  children: detailValue(field, detail.data?.[field]),
                }))}
            />
          ),
        },
        ...(access.field('parents').visible ? [parentSection(props)] : []),
      ].filter(() => !!detail.data)}
    />
  );
}
