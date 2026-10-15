import { Navigate, useLocation } from 'react-router';
import { PageState, usePermissions, useSession } from '../foundation/index.js';
import { ReferenceFrame } from '../transfer/ReferenceView.js';
import { Applications } from './Applications.js';
import { GapSectionPage } from './GapSectionPage.js';
import { menuSections, sectionOf, todosPath, type ApprovalSection } from './page-model.js';
import { TodoCenter } from './TodoCenter.js';
import './approval.css';

/**
 * 审批中心按原站分子页（DEC-489）：我的待办为卡片列表，我的申请为表格，委托与流程管理保留原站结构。
 * 子页可见性直接取侧栏菜单的子项（同一来源）；无权子页回到我的待办。
 */
export function ApprovalPage() {
  const { pathname, search } = useLocation();
  const session = useSession();
  const { menus, loading } = usePermissions();
  const section = sectionOf(pathname);
  const visible = menuSections(menus);
  if (!section || !visible.includes(section)) {
    if (loading) return <PageState kind="loading" />;
    return <Navigate replace to={{ pathname: todosPath, search: section ? '' : search }} />;
  }
  return (
    <ReferenceFrame>
      <section className="approval-page">
        <SectionPage key={`${session.tenantId}/${session.identityKey}`} section={section} visible={visible} />
      </section>
    </ReferenceFrame>
  );
}
function SectionPage({ section, visible }: { section: ApprovalSection; visible: ApprovalSection[] }) {
  if (section === 'todos') return <TodoCenter visible={visible} />;
  if (section === 'applications') return <Applications />;
  return <GapSectionPage page={section} />;
}
