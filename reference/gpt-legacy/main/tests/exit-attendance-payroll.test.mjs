import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,act,get,expect,request,grant,dev} from './support/foundation-scenario.mjs';
import {moveEmployee} from './support/performance-scenario.mjs';
const attendance=await import('../app/api/attendance/route.ts'),periods=await import('../app/api/attendance-periods/route.ts'),payroll=await import('../app/api/payroll/route.ts');
const post=async(api,command,status=200)=>expect(await api.POST(request('/api/test',{revision:(await get()).revision,command})),status);
test('exit preserves authorized retrospective attendance settlement and final payroll without allowing new shifts or changing published money',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());await grant('finalPayWriter','payroll_editor',null,[f.org.id]);await grant('finalPayReviewer','payroll_reviewer',null,[f.org.id]);
 const shift=await post(attendance,{action:'shift',employeeId:f.e.id,date:'2026-01-05',name:'离职前合成班次',startAt:'2026-01-05T09:00:00+08:00',endAt:'2026-01-05T18:00:00+08:00'}),type=await post(attendance,{action:'leaveType',code:'FINAL-LEAVE',name:'合成历史休假',paid:true,requiresBalance:false});
 act('employee');const leave=await post(attendance,{action:'leave',employeeId:f.e.id,shiftId:shift.id,leaveTypeId:type.id,startAt:'2026-01-05T09:00:00+08:00',endAt:'2026-01-05T18:00:00+08:00',reason:'离职前已提交待独立核实的合成休假'});
 await moveEmployee(f,'exit');act('hr');await post(attendance,{action:'shift',employeeId:f.e.id,date:'2026-01-06',name:'离职后不得新增班次',startAt:'2026-01-06T09:00:00+08:00',endAt:'2026-01-06T18:00:00+08:00'},400);
 await post(periods,{action:'freeze',employeeId:f.e.id,start:'2026-01-05',end:'2026-01-05',evidence:'尚有待审历史假勤不可冻结'},400);
 act('manager');await post(attendance,{action:'decideLeave',id:leave.id,accepted:true,evidence:'独立核实离职前的原始休假依据'});act('hr');const period=await post(periods,{action:'freeze',employeeId:f.e.id,start:'2026-01-05',end:'2026-01-05',evidence:'离职末期完整出勤依据核对后冻结'});
 act('finalPayWriter');const batch=await post(payroll,{action:'batch',name:'合成末期工资',orgId:f.org.id,period:'2026-01',currency:'CNY',policyReference:'既有规则允许末期核定工资，不自动计算或付款'}),slip=await post(payroll,{action:'slip',batchId:batch.id,employeeId:f.e.id,attendancePeriodIds:[period.id],items:[{name:'合成已核定末期金额',category:'earning',amountCents:123456,source:'合成核定单，与请假分钟不自动换算'}]});
 await post(payroll,{action:'submit',id:batch.id,evidence:'提交末期金额与冻结依据供独立复核'});act('finalPayReviewer');await post(payroll,{action:'approve',id:batch.id,evidence:'独立复核合成末期核定金额'});act('finalPayWriter');await post(payroll,{action:'publish',id:batch.id,evidence:'内部发布合成末期工资条，不触发支付'});
 act('hr');await post(periods,{action:'reopen',id:period.id,reason:'核查新出现的历史依据，保留原冻结版本'});act('finalPayWriter');const result=await expect(await payroll.GET());assert.equal(result.records.find(r=>r.id===slip.id).payload.netCents,123456);assert.equal(result.records.find(r=>r.id===batch.id).status,'published');assert.equal(result.attendanceIssues[slip.id].length,1);assert.equal(result.records.find(r=>r.id===slip.id).payload.payrollAttendance[0].version,1);
 act('owner');const history=await expect(await dev.GET(request('/api/development?id='+period.id)));assert.ok(history.items.some(r=>r.snapshot.status==='frozen'&&r.snapshot.payload.attendanceSnapshot.totals.approvedLeaveMinutes===540));
});
