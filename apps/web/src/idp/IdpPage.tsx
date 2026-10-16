import { Navigate, useLocation } from 'react-router';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import { useSession } from '../foundation/Session.js';
import { OBJECTS } from './api.js';
import { PlanList } from './PlanList.js';
import { ProcessList } from './ProcessList.js';
import { IdpCommands } from './commands.js';
import { TemplateList } from './TemplateList.js';
import './idp.css';
import { TutorshipList, CareerList, WorkShiftList } from './InfoList.js';

const SECTIONS = [
  { key: 'plans', object: OBJECTS.plan, page: PlanList },
  { key: 'templates', object: OBJECTS.template, page: TemplateList },
  { key: 'processes', object: OBJECTS.process, page: ProcessList },
  { key: 'tutorships', object: 'IDP.TutorShip', page: TutorshipList },
  { key: 'careers', object: 'IDP.Career', page: CareerList },
  { key: 'work-shifts', object: 'IDP.WorkShift', page: WorkShiftList },
] as const;

/** 人才发展计划：/idp/plans | templates | processes 三张列表，无面包屑；计划与模板详情为整页（?plan= / ?template=）。 */
export function IdpPage() {
  return (
    <IdpCommands>
      <IdpContent />
    </IdpCommands>
  );
}
function IdpContent() {
  const { pathname } = useLocation();
  const session = useSession();
  const { snapshot, loading } = usePermissions();
  const visible = SECTIONS.filter((section) => !!snapshot.objects[section.object]);
  const current = visible.find((section) => pathname === `/idp/${section.key}`);
  if (!current) {
    if (visible[0]) return <Navigate replace to={`/idp/${visible[0].key}`} />;
    return <PageState kind={loading ? 'loading' : 'forbidden'} />;
  }
  const Page = current.page;
  return (
    <div className="idp-page">
      <Page key={`${session.tenantId}/${session.identityKey}`} />
    </div>
  );
}
