// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
let db: PGlite;
const B='d7afd88f-4a5e-4dcd-8af9-c58e835f561e';
const OTHER='22222222-2222-4222-8222-222222222222';
const ADMIN='11111111-1111-4111-8111-111111111111';
const OWNER='33333333-3333-4333-8333-333333333333';
const SUPERVISOR='44444444-4444-4444-8444-444444444444';
async function asUser(user: string, sql: string, params: unknown[]=[]){
 await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub','${user}',false); SELECT set_config('request.headers','{"x-worktrack-epoch":"1"}',false); SET ROLE authenticated;`);
 try { return await db.query(sql,params); } finally { await db.exec('RESET ROLE;'); }
}
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 CREATE TABLE storage.objects(id uuid PRIMARY KEY,bucket_id text,name text,owner_id text,metadata jsonb);
 ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
 CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql AS $$ SELECT string_to_array($1,'/') $$;
 GRANT USAGE ON SCHEMA public,auth,storage TO authenticated,anon,service_role;
 GRANT SELECT,INSERT,DELETE,UPDATE ON storage.objects TO authenticated;`);
 for (const f of readdirSync('db/migrations').filter(f=>f.endsWith('.sql')).sort()) await db.exec(readFileSync('db/migrations/'+f,'utf8').replace(/CREATE EXTENSION[^;]*;/g,''));
 await db.exec(`SELECT set_config('request.jwt.claim.sub','',false);
 INSERT INTO auth.users VALUES ('${ADMIN}','admin@isolated.invalid'),('${OWNER}','owner@isolated.invalid'),('${SUPERVISOR}','supervisor@isolated.invalid');
 INSERT INTO public.businesses(id,name) VALUES ('${B}','Isolated test business'),('${OTHER}','Other tenant');
 INSERT INTO public.memberships(business_id,user_id,email,full_name,role) VALUES ('${B}','${ADMIN}','admin@isolated.invalid','Admin','admin'),('${B}','${OWNER}','owner@isolated.invalid','Owner','owner'),('${B}','${SUPERVISOR}','supervisor@isolated.invalid','Supervisor','supervisor');`);
},60000);
afterAll(async()=>{await db?.close();});
describe('Production database acceptance — isolated PostgreSQL, no live business writes',()=>{
 it('fresh install applies every migration and empty business has no transactions',async()=>{
  const res=await asUser(ADMIN,`SELECT (SELECT count(*) FROM expenses) expenses,(SELECT count(*) FROM journal_entries) journals,(SELECT count(*) FROM loans) loans,(SELECT count(*) FROM jobs) jobs`);
  expect(res.rows[0]).toEqual({expenses:0,journals:0,loans:0,jobs:0});
 });
 it('zero-balance account setup is explicit, repeatable and Admin-only',async()=>{
  await expect(asUser(OWNER,'SELECT worktrack_setup_accounts($1)',[B])).rejects.toThrow('Admin required');
  await asUser(ADMIN,'SELECT worktrack_setup_accounts($1)',[B]);
  await asUser(ADMIN,'SELECT worktrack_setup_accounts($1)',[B]);
  const res=await asUser(ADMIN,'SELECT count(*)::int count,sum(opening_balance_cents)::text balance FROM accounts WHERE business_id=$1',[B]);
  expect(res.rows[0]).toEqual({count:10,balance:'0'});
 });
 it('cross-business read and forged tenant batch are blocked',async()=>{
  expect((await asUser(OWNER,'SELECT id FROM businesses WHERE id=$1',[OTHER])).rows).toEqual([]);
  await expect(asUser(OWNER,'SELECT worktrack_apply_changes($1,1,$2)',[B,JSON.stringify([{table:'loans',before:null,after:{id:crypto.randomUUID(),business_id:OTHER}}])])).rejects.toThrow('Business mismatch');
 });
 it('Supervisor cannot read financial accounts or grant themselves a role',async()=>{
  expect((await asUser(SUPERVISOR,'SELECT * FROM accounts')).rows).toEqual([]);
  await expect(asUser(SUPERVISOR,"UPDATE memberships SET role='admin' WHERE user_id=$1",[SUPERVISOR])).rejects.toThrow();
  const res=await db.query('SELECT role FROM memberships WHERE user_id=$1',[SUPERVISOR]);
  expect(res.rows[0]).toEqual({role:'supervisor'});
 });
 it('stale business epoch rejects obsolete offline records',async()=>{
  await expect(asUser(OWNER,'SELECT worktrack_apply_changes($1,0,$2)',[B,'[]'])).rejects.toThrow('obsolete offline data rejected');
 });
 it('atomic batch rolls back invalid second insert',async()=>{
  const id=crypto.randomUUID();
  const batch=[{table:'loans',before:null,after:{id,business_id:B,lender_name:'Isolated lender',opening_principal_cents:0,opening_principal_verified:true,interest_rate_percent:0,security_asset_note:'',repayment_terms_note:''}},{table:'not_allowlisted',before:null,after:{business_id:B}}];
  await expect(asUser(ADMIN,'SELECT worktrack_apply_changes($1,1,$2)',[B,JSON.stringify(batch)])).rejects.toThrow('Unsupported table');
  expect((await asUser(ADMIN,'SELECT id FROM loans WHERE id=$1',[id])).rows).toEqual([]);
 });
 it('unbalanced journal fails and creates no authoritative posting',async()=>{
  const id=crypto.randomUUID();
  await expect(asUser(ADMIN,`INSERT INTO journal_entries(id,business_id,entry_date,source_type,source_id) VALUES ($1,$2,'2026-11-28','grant_receipt',$1)`,[id,B])).rejects.toThrow('Posting must match its authoritative source amount');
 });
 it('Owner cannot directly approve a weekly report',async()=>{
  await expect(asUser(OWNER,`INSERT INTO weekly_reports(business_id,job_id,week_start,week_end,status) VALUES ($1,$2,'2026-11-23','2026-11-29','approved')`,[B,crypto.randomUUID()])).rejects.toThrow();
 });
});

describe('Live repository paths — isolated database through an API-shaped adapter',()=>{
 let d: typeof import('@/lib/data/increment-d-repository');
 let e: typeof import('@/lib/data/increment-e-repository');
 const session={userId:ADMIN,email:'admin@isolated.invalid',fullName:'Admin',businessId:B,businessName:'Isolated test business',role:'admin' as const,assignedJobIds:[],mode:'supabase' as const};
 let serialized:Promise<unknown>=Promise.resolve();
 function execute(sql:string,params:unknown[]=[]){
  const task=serialized.then(()=>asUser(ADMIN,sql,params));serialized=task.catch(()=>{});return task;
 }
 beforeAll(async()=>{
  const {vi}=await import('vitest');
  const client={
   from:(table:string)=>{
    const filters:Array<[string,unknown]>=[];
    const builder={
     select:(_columns?:string)=>builder,
     eq:(col:string,value:unknown)=>{filters.push([col,value]);return builder;},
     order:()=>builder,
     single:async()=>{const r=await fetchRows();return {data:r.data?.[0]??null,error:r.error};},
     maybeSingle:async()=>{const r=await fetchRows();return {data:r.data?.[0]??null,error:r.error};},
     then:(resolve:(v:unknown)=>unknown,reject?:(v:unknown)=>unknown)=>fetchRows().then(resolve,reject),
    };
    async function fetchRows(){try{
     if(!/^[a-z_]+$/.test(table))throw new Error('Invalid table');
     const where=filters.map(([k],i)=>`"${k}"=$${i+1}`).join(' AND ');
     const r=await execute(`SELECT to_jsonb(t) row FROM public."${table}" t ${where?'WHERE '+where:''}`,filters.map(([,v])=>v));
     return {data:r.rows.map(row=>(row as {row:Record<string,unknown>}).row),error:null};
    }catch(error){return{data:null,error:{message:error instanceof Error?error.message:'Database error'}};}}
    return builder;
   },
   rpc:async(name:string,args:Record<string,unknown>)=>{
    try{
     if(name==='worktrack_read_bundle'){const result=await execute('SELECT worktrack_read_bundle($1,$2) bundle',[args['p_business'],args['p_tables']]);return{data:(result.rows[0] as {bundle:unknown}).bundle,error:null};}
     if(name==='worktrack_setup_accounts')await execute('SELECT worktrack_setup_accounts($1)',[args['p_business']]);
     else if(name==='worktrack_apply_changes')await execute('SELECT worktrack_apply_changes($1,$2,$3)',[args['p_business'],args['p_epoch'],JSON.stringify(args['p_changes'])]);
     else throw new Error('Unsupported RPC');
     return {data:null,error:null};
    }catch(error){return {data:null,error:{message:error instanceof Error?error.message:'Database error'}};}
   },
  };
  vi.doMock('@/lib/supabase',()=>({supabase:client,isSupabaseConfigured:true}));
  d=await import('@/lib/data/increment-d-repository');e=await import('@/lib/data/increment-e-repository');
 });
 it('finance write reads back from a second repository call without localStorage',async()=>{
  const before=await d.listFinanceBundle(session);const account=before.accounts.find(a=>a.accountType==='cash');if(!account)throw new Error('Missing account');
  const expense=await d.recordExpense(session,{jobId:null,expenseDate:'2026-11-28',category:'fuel',classification:'operating',amountCents:25000,paidAmountCents:25000,paymentStatus:'paid',accountId:account.id,method:'cash',supplierName:'Isolated supplier',description:'Synthetic test only',reference:'TEST-LIVE',fuelLitres:null,vehicleOrMachine:'',odometerKm:null,receiptAttachment:null,missingReceiptReason:'Test missing receipt',idempotencyKey:'isolated-expense-once'});
  const after=await d.listFinanceBundle(session);expect(after.expenses.find(x=>x.id===expense.id)?.amountCents).toBe(25000);
  expect(after.journalEntries.filter(j=>j.sourceId===expense.id)).toHaveLength(1);
  const replay=await d.recordExpense(session,{jobId:null,expenseDate:'2026-11-28',category:'fuel',classification:'operating',amountCents:25000,paidAmountCents:25000,paymentStatus:'paid',accountId:account.id,method:'cash',supplierName:'Isolated supplier',description:'Synthetic test only',reference:'TEST-LIVE',fuelLitres:null,vehicleOrMachine:'',odometerKm:null,receiptAttachment:null,missingReceiptReason:'Test missing receipt',idempotencyKey:'isolated-expense-once'});
  expect(replay.id).toBe(expense.id);
 });
 it('concurrent descriptive edits preserve revisions and refuse stale changes',async()=>{
  const finance=await d.listFinanceBundle(session);const expense=finance.expenses[0];if(!expense)throw new Error('Missing expense');
  const changed=await d.updateExpenseWithRevision(session,expense.id,1,{description:'Reviewed description'});expect(changed.serverRevision).toBe(2);
  const stale=await d.updateExpenseWithRevision(session,expense.id,1,{description:'Stale description'});expect(stale.status).toBe('conflict');expect(stale.expense.description).toBe('Reviewed description');
 });
 it('vehicle/check/critical defect and alert survive a fresh database read',async()=>{
  const asset=await e.createAsset(session,{assetType:'truck',name:'Isolated test truck',makeModel:'Test truck',registration:null,vin:null,ownerName:'Test',purchaseCostCents:null,odometerKm:100,serviceIntervalKm:1000,licenceExpiryDate:null,insuranceExpiryDate:null,assignedJobId:null});
  const check=await e.recordPreUseCheck(session,{assetId:asset.id,jobId:null,checkDate:'2026-11-28',odometerKm:110,items:{oil:'problem',coolant:'ok',leaks:'ok',tyres:'ok',brakes_lights:'ok',warning_lights:'ok'},comment:'Critical isolated test',photoNote:null,idempotencyKey:'isolated-check-once'});
  const after=await e.listIncrementEBundle(session);expect(after.assets.find(a=>a.id===asset.id)?.status).toBe('unavailable_defect');expect(after.checks.find(c=>c.id===check.check.id)?.stopUseTriggered).toBe(true);expect(after.notifications.some(n=>n.type==='vehicle_stop_use')).toBe(true);
  if(!check.defect)throw new Error('Missing defect');await e.resolveAssetDefect(session,check.defect.id,'Repaired and verified in isolated test');
  const resolved=await e.listIncrementEBundle(session);expect(resolved.assets.find(a=>a.id===asset.id)?.status).toBe('available');
 });
 it('weekly submit/return/resubmit/approve/amend retains locked snapshots',async()=>{
  const jobId=crypto.randomUUID();await execute("INSERT INTO jobs(id,business_id,name,customer_name,road_or_area) VALUES($1,$2,'Report fixture','Test','Test road')",[jobId,B]);
  const snapshot={businessId:B,jobId,weekStart:'2026-11-23',weekEnd:'2026-11-29',missingReceiptsCount:0,truckChecksCount:1,cumulativeCompletedPercent:10} as unknown as import('@/lib/domain/increment-e-types').WeeklyReportSnapshot;
  const submitted=await e.submitWeeklyReport(session,{snapshot,missingEvidenceAcknowledged:true});
  await e.returnWeeklyReport(session,submitted.id,'Correct field records');
  await e.submitWeeklyReport(session,{snapshot,missingEvidenceAcknowledged:true});
  await e.approveWeeklyReport(session,submitted.id);
  await e.startWeeklyReportAmendment(session,submitted.id,'Corrected source records');
  await e.submitWeeklyReport(session,{snapshot:{...snapshot,cumulativeCompletedPercent:20},missingEvidenceAcknowledged:true});
  await e.approveWeeklyReport(session,submitted.id);
  const after=(await e.listIncrementEBundle(session)).reports.find(r=>r.id===submitted.id);if(!after)throw new Error('Report missing');
  expect(after.currentRevision).toBe(3);expect(after.status).toBe('approved');expect(after.revisions.filter(r=>r.status==='approved').map(r=>r.snapshot.cumulativeCompletedPercent)).toEqual([10,20]);
  await expect(e.submitWeeklyReport(session,{snapshot,missingEvidenceAcknowledged:true})).rejects.toThrow('locked');
 });
});

const JOB='55555555-5555-4555-8555-555555555555',WORKER='66666666-6666-4666-8666-666666666666',ROLE='77777777-7777-4777-8777-777777777777';
async function payrollFixture(){
 await db.exec(`RESET ROLE;SELECT set_config('request.jwt.claim.sub','',false);
 INSERT INTO jobs(id,business_id,name,customer_name,road_or_area) VALUES('${JOB}','${B}','Synthetic approval test','Test customer','Test road');
 INSERT INTO worker_roles(id,business_id,name,role_type,shares_crew_schedule) VALUES('${ROLE}','${B}','Test road role','road_worker',true);
 INSERT INTO workers(id,business_id,full_name,worker_role_id,employment_start_date) VALUES('${WORKER}','${B}','Synthetic approval worker','${ROLE}','2026-11-01');
 INSERT INTO worker_assignments(business_id,worker_id,job_id,assigned_from) VALUES('${B}','${WORKER}','${JOB}','2026-11-01');
 INSERT INTO pay_rules(business_id,worker_role_id,pay_basis,base_rate_cents,normal_hours_per_day,normal_workdays_per_week,effective_from,is_confirmed) VALUES('${B}','${ROLE}','daily',25000,9,5,'2026-11-01',true);
 INSERT INTO team_days(business_id,job_id,work_date,day_status,normal_hours,updated_by_email) SELECT '${B}','${JOB}',d::date,CASE WHEN d::date='2026-11-23' THEN 'worked' ELSE 'no_work' END,CASE WHEN d::date='2026-11-23' THEN 9 ELSE 0 END,'test@isolated.invalid' FROM generate_series('2026-11-23'::date,'2026-11-29'::date,interval '1 day') d;`);
}
async function payrollArgs(revision:number,approve:boolean,net=25000){
 const token=await asUser(ADMIN,'SELECT worktrack_payroll_source_token($1,$2,$3) token',[B,JOB,'2026-11-23']);
 const run={id:crypto.randomUUID(),business_id:B,job_id:JOB,week_start_date:'2026-11-23',week_end_date:'2026-11-29',revision:revision+1,gross_total_cents:25000,adjustments_total_cents:0,deductions_total_cents:0,net_total_cents:net,correction_reason:revision>0?'Verified correction test':null};
 const line={worker_id:WORKER,days_worked:1,normal_hours:9,weekday_ot_hours:0,saturday_hours:0,sunday_hours:0,public_holiday_hours:0,normal_pay_cents:25000,weekday_ot_pay_cents:0,saturday_pay_cents:0,sunday_pay_cents:0,public_holiday_pay_cents:0,gross_pay_cents:25000,adjustments_cents:0,deductions_cents:0,net_pay_cents:net,rule_snapshots:[]};
 return [B,1,JSON.stringify(run),JSON.stringify([line]),'[]',(token.rows[0] as {token:string}).token,revision,approve];
}
const SAVE_PAYROLL='SELECT to_jsonb(worktrack_save_payroll($1,$2,$3,$4,$5,$6,$7,$8)) saved';
describe('Atomic production approval regression tests',()=>{
 it('Owner draft persists complete header/earnings; only Admin approves',async()=>{
  await payrollFixture();const args=await payrollArgs(0,false);
  const saved=await asUser(OWNER,SAVE_PAYROLL,args);const run=(saved.rows[0] as {saved:{id:string;status:string}}).saved;
  expect(run.status).toBe('draft');expect((await asUser(ADMIN,'SELECT count(*)::int count FROM payroll_earnings WHERE payroll_run_id=$1',[run.id])).rows[0]).toEqual({count:1});
  await expect(asUser(OWNER,'SELECT approve_payroll_run($1,$2)',[run.id,'forged'])).rejects.toThrow('Only Admin');
  const approved=await asUser(ADMIN,'SELECT to_jsonb(approve_payroll_run($1,$2)) saved',[run.id,'forged']);expect((approved.rows[0] as {saved:{approved_by_email:string}}).saved.approved_by_email).toBe('admin@isolated.invalid');
 });
 it('approval failure rolls back header and earnings instead of leaving a partial draft',async()=>{
  const before=(await asUser(ADMIN,'SELECT count(*)::int n FROM payroll_runs')).rows[0];
  await expect(asUser(ADMIN,SAVE_PAYROLL,await payrollArgs(1,true,1))).rejects.toThrow('Invalid earning arithmetic');
  expect((await asUser(ADMIN,'SELECT count(*)::int n FROM payroll_runs')).rows[0]).toEqual(before);
 });
 it('correction retains immutable approved history and refuses stale revision',async()=>{
  const args=await payrollArgs(1,true);await asUser(ADMIN,SAVE_PAYROLL,args);
  expect((await asUser(ADMIN,'SELECT status FROM payroll_runs WHERE job_id=$1 ORDER BY revision',[JOB])).rows).toEqual([{status:'superseded'},{status:'approved'}]);
  await expect(asUser(ADMIN,SAVE_PAYROLL,args)).rejects.toThrow('revision changed');
  await expect(asUser(ADMIN,"UPDATE payroll_runs SET correction_reason='changed' WHERE status='superseded'")).rejects.toThrow('immutable');
 });
 it('changed payroll source is rejected before any write',async()=>{
  const args=await payrollArgs(2,true);
  await asUser(ADMIN,"UPDATE team_days SET notes='Another device changed attendance' WHERE job_id=$1 AND work_date='2026-11-23'",[JOB]);
  await expect(asUser(ADMIN,SAVE_PAYROLL,args)).rejects.toThrow('inputs changed');
 });
 it('unknown attendance cannot be approved through the direct RPC',async()=>{
  await asUser(ADMIN,"UPDATE team_days SET day_status='unknown' WHERE job_id=$1 AND work_date='2026-11-23'",[JOB]);
  await expect(asUser(ADMIN,SAVE_PAYROLL,await payrollArgs(2,true))).rejects.toThrow('Unknown attendance');
  await asUser(ADMIN,"UPDATE team_days SET day_status='worked' WHERE job_id=$1 AND work_date='2026-11-23'",[JOB]);
 });
 it('balanced arbitrary journal sources are rejected',async()=>{
  const id=crypto.randomUUID();await expect(asUser(OWNER,"INSERT INTO journal_entries(id,business_id,entry_date,source_type,source_id) VALUES($1,$2,'2026-11-28','invented_source',$1)",[id,B])).rejects.toThrow('Unsupported financial');
 });
 it('milestone received totals cannot change without real receipt history',async()=>{
  await expect(asUser(ADMIN,"INSERT INTO payment_milestones(business_id,job_id,label,expected_date,expected_amount_cents,received_amount_cents,status) VALUES($1,$2,'Forged receipt','2026-11-28',10000,10000,'received')",[B,JOB])).rejects.toThrow('Customer receipts must reconcile');
 });
});

describe('Scope approval transaction and permission regression',()=>{
 it('failed waypoint insertion rolls back planned-job creation and scope approval',async()=>{
  const id=crypto.randomUUID();await asUser(ADMIN,"INSERT INTO assessments(id,business_id,name,customer_name,road_or_area,original_distance_meters,accepted_distance_meters) VALUES($1,$2,'Scope fixture','Test customer','Test road',100,100)",[id,B]);
  const existing=(await asUser(ADMIN,'SELECT to_jsonb(a) row FROM assessments a WHERE id=$1',[id])).rows[0] as {row:Record<string,unknown>};
  const payload={...existing.row,status:'approved',revision:1,benchmark_productivity_sqm:100,productive_crew_size:1,road_worker_daily_rate_cents:25000,workdays_per_week:5,revisions_json:[{revision:1,reason:'Test baseline'}],route_points_json:[{clientPointId:crypto.randomUUID(),pointType:'start',latitude:100,longitude:20,gpsAccuracyMeters:5,captureMethod:'gps'}]};
  const before=(await asUser(ADMIN,'SELECT count(*)::int count FROM jobs')).rows[0];
  await expect(asUser(ADMIN,'SELECT worktrack_save_assessment($1,1,$2,1,$3)',[B,JSON.stringify(payload),crypto.randomUUID()])).rejects.toThrow();
  expect((await asUser(ADMIN,'SELECT count(*)::int count FROM jobs')).rows[0]).toEqual(before);
  const saved=await asUser(ADMIN,'SELECT worktrack_save_assessment($1,1,$2,1,$3) result',[B,JSON.stringify({...payload,route_points_json:[]}),crypto.randomUUID()]);
  const result=(saved.rows[0] as {result:{record:{job_id:string;edit_version:number}}}).result;expect(result.record.job_id).toBeTruthy();
  await expect(asUser(OWNER,'SELECT worktrack_save_assessment($1,1,$2,$3,$4)',[B,JSON.stringify({...payload,status:'draft'}),result.record.edit_version,crypto.randomUUID()])).rejects.toThrow('locked');
 });
});

describe('Operational read and reviewer boundaries',()=>{
 it('assigned Supervisor cannot read raw financial job/worker/scope/report rows',async()=>{
  await db.exec(`RESET ROLE;SELECT set_config('request.jwt.claim.sub','',false);UPDATE memberships SET assigned_job_ids=ARRAY['${JOB}']::uuid[] WHERE user_id='${SUPERVISOR}';UPDATE jobs SET contract_value_cents=123456,opening_cash_allocation_cents=50000 WHERE id='${JOB}';`);
  expect((await asUser(SUPERVISOR,'SELECT contract_value_cents FROM jobs WHERE id=$1',[JOB])).rows).toEqual([]);
  expect((await asUser(SUPERVISOR,'SELECT opening_balance_cents FROM workers')).rows).toEqual([]);
  expect((await asUser(SUPERVISOR,'SELECT road_worker_daily_rate_cents FROM assessments')).rows).toEqual([]);
  expect((await asUser(SUPERVISOR,'SELECT locked_snapshot FROM weekly_reports')).rows).toEqual([]);
  const op=(await asUser(SUPERVISOR,"SELECT worktrack_operational_read($1,'jobs') rows",[B])).rows[0] as {rows:Array<{id:string;contract_value_cents:number;opening_cash_allocation_cents:number}>};
  expect(op.rows.find(j=>j.id===JOB)).toMatchObject({contract_value_cents:0,opening_cash_allocation_cents:0});
  await expect(asUser(SUPERVISOR,"SELECT worktrack_operational_read($1,'jobs')",[OTHER])).rejects.toThrow('Active business');
 });
 it('a field caller cannot self-verify progress or spoof its actor',async()=>{
  const result=await asUser(SUPERVISOR,"INSERT INTO progress_entries(business_id,job_id,section_id,verge_side,activity,reported_date,start_chainage_meters,end_chainage_meters,stage_status,verification_state,submitted_by_email) VALUES($1,$2,'test-section','left','cutting','2026-11-28',0,100,'complete','verified','forged') RETURNING verification_state,submitted_by_email",[B,JOB]);
  expect(result.rows[0]).toEqual({verification_state:'reported',submitted_by_email:'supervisor@isolated.invalid'});
 });
 it('replay receipts are private to the capturing user',async()=>{
  expect((await asUser(SUPERVISOR,'SELECT * FROM sync_idempotency_keys')).rows).toEqual([]);
  expect((await asUser(OWNER,'SELECT * FROM sync_idempotency_keys')).rows).toEqual([]);
  expect((await asUser(ADMIN,'SELECT * FROM sync_idempotency_keys')).rows.length).toBeGreaterThan(0);
 });
});
