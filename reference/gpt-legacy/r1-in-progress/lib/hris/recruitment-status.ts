import type {DevelopmentRecord as R} from './development';
export const requisitionAwaitingApproval=(r:R)=>r.kind==='requisition'&&(r.status==='submitted'||r.status==='draft'&&!r.payload.requisitionSubmissionRequired);
export const requisitionStatusLabel=(r:R)=>requisitionAwaitingApproval(r)?'待审批':({draft:'待提交',returned:'待修订',active:'招聘中',closed:'已关闭'} as Record<string,string>)[r.status]??r.status;
export const recruitmentTypes:Record<string,string>={new:'新增',replacement:'顶替',reserve:'储备'};
export const recruitmentUrgencies:Record<string,string>={high:'高',medium:'中',low:'低'};

/** Current eligibility, independent of what target details a reader may see. */
export function recruitmentTargetCurrent(state:import('./model').State,r:import('./development').DevelopmentRecord,includeGrade=true){
 return !!state.positions?.some(p=>p.id===r.positionId&&p.status==='启用')&&(!includeGrade||!r.payload.gradeId||!!state.grades?.some(g=>g.id===r.payload.gradeId&&g.status==='启用'));
}
