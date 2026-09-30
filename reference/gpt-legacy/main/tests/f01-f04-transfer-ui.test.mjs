import './support/runtime.mjs';
import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import test from 'node:test';
import assert from 'node:assert/strict';
registerHooks({resolve(specifier,context,next){return next(specifier==='next/link'?'next/link.js':specifier,context);},load(url,context,next){if(url.startsWith('file:')&&url.endsWith('.tsx')&&!url.includes('/node_modules/'))return {format:'module',source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return next(url,context);}});
const {default:Review}=await import('../app/approvals/transfer-review.tsx');
const {projectApprovalDetails}=await import('../lib/hris/personnel-transfer.ts');
const employee={orgId:'A',orgName:'合成来源',positionId:'pA',job:'合成原岗位',gradeId:'g1',level:'合成T1',status:'正式'};
const approval={id:'request-1',employeeId:'e1',kind:'transfer',orgId:'B',reason:'合成调动原因',status:'pending',currentStep:1,created:'2026-09-08T00:00:00Z',createdBy:'hr',steps:[{userId:'reviewA',name:'调出',decision:'approved'},{userId:'reviewB',name:'调入'}],details:{transfer:{policy:'two-party-dated-v1',gradeChanged:true,effectiveOn:'2099-01-01',eligibleAt:'2098-12-31T16:00:00Z',employeeName:'合成员工',employeeCode:'F-UAT-E1',source:employee,target:{...employee,orgId:'B',orgName:'合成目标',positionId:'pB',job:'合成新岗位',gradeId:'g2',level:'合成T2'},execution:'waiting',attempts:0}}};
const render=(a,options={})=>renderToStaticMarkup(React.createElement(Review,{approval:a,state:{orgs:[{id:'B'}],employees:[],approvals:[a],audit:[]},userId:'reviewB',canMaintain:false,canDecide:true,viewLevel:true,busy:false,mutate:async()=>{},resubmit:()=>{},...options}));
test('目标审批界面无需完整员工档案即可显示双方任职和前后职级，驳回留空不能提交',()=>{const html=render(approval);for(const label of ['合成员工','合成来源','合成目标','合成T1','合成T2','业务生效日','最早执行时点','实际生效时间','2099-01-01'])assert.ok(html.includes(label),label);assert.match(html,/<button[^>]*disabled[^>]*>驳回<\/button>/);assert.ok(!html.includes('href="/employees/'));});
test('撤销职级读取权限后的审批界面不泄漏前后值，并禁用通过',()=>{const a=projectApprovalDetails(approval,{role:'approver',viewLevel:false});const html=render(a,{viewLevel:false});assert.ok(!html.includes('合成T1')&&!html.includes('合成T2'));assert.ok(html.includes('禁止盲审'));assert.match(html,/<button[^>]*disabled[^>]*>通过本级审批<\/button>/);});
test('批准未生效不是已完成人事调动；HR提前执行按钮禁用，失败有恢复说明',()=>{const a=structuredClone(approval);a.status='approved';let html=render(a,{canMaintain:true,state:{orgs:[{id:'A'},{id:'B'}],employees:[],approvals:[a],audit:[]}});assert.ok(html.includes('已批准 · 待生效'));assert.match(html,/<button[^>]*disabled[^>]*>执行生效<\/button>/);a.details.transfer.execution='failed';a.details.transfer.failure='目标岗位编制不足';html=render(a,{canMaintain:true});assert.ok(html.includes('目标岗位编制不足'));assert.ok(html.includes('档案尚未变更'));assert.ok(html.includes('修复原因后重试'));});


const {default:PersonnelNavigation}=await import('../app/personnel-navigation.tsx');
const {default:EmptyEmployees}=await import('../app/employees/empty-employees.tsx');
test('首包页面导航直接暴露岗位职级、成员流程、审批入口；审计按管理员条件显示',()=>{const html=renderToStaticMarkup(React.createElement(PersonnelNavigation,{current:'/employees',admin:true}));for(const href of ['/organizations','/positions','/employees','/settings','/approvals','/audit'])assert.ok(html.includes('href="'+href+'"'),href);assert.ok(html.includes('aria-current="page"'));const limited=renderToStaticMarkup(React.createElement(PersonnelNavigation,{current:'/employees'}));assert.ok(!limited.includes('href="/audit"'));});
test('离职空筛选有恢复入口并解释新增为试用；真正空表提示先建员工再操作记录',()=>{let html=renderToStaticMarkup(React.createElement(EmptyEmployees,{filtered:true,filter:'离职',onReset:()=>{}}));assert.ok(html.includes('离职'));assert.ok(html.includes('清除筛选，查看全部员工'));assert.ok(html.includes('新增员工默认进入'));html=renderToStaticMarkup(React.createElement(EmptyEmployees,{filtered:false,filter:'all',onReset:()=>{}}));assert.ok(html.includes('先新增合成员工'));assert.ok(html.includes('附件和任职历史'));assert.ok(!html.includes('清除筛选，查看全部员工'));});
