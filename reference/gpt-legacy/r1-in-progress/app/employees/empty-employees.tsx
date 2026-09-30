import {Button} from '@/components/ui/button';
export default function EmptyEmployees({filtered,filter,onReset}:{filtered:boolean;filter:string;onReset:()=>void}){
 return <div className="empty"><p>{filtered?`当前${filter==='all'?'':`“${filter}”`}筛选下没有员工。`:'暂无可见员工。'}</p><p className="my-3">{filtered?'清除筛选后查看已建员工；新增员工默认进入“试用”。':'先新增合成员工，再从员工行进入人事申请、档案、附件和任职历史。'}</p>{filtered&&<Button variant="outline" onClick={onReset}>清除筛选，查看全部员工</Button>}</div>;
}
