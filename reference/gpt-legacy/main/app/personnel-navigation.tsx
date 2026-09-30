import Link from 'next/link';
const destinations=[['/organizations','组织管理'],['/positions','岗位与职级'],['/employees','人员信息'],['/settings','成员与审批流程'],['/approvals','人事审批']];
export default function PersonnelNavigation({current,admin=false}:{current:string;admin?:boolean}){
 return <nav aria-label="组织与人员操作入口" className="personnel-navigation">{[...destinations,...(admin?[['/audit','操作审计']]:[])].map(([href,label])=><Link key={href} href={href} aria-current={current===href?'page':undefined}>{label}</Link>)}</nav>;
}
