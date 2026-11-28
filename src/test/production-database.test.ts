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
  await expect(asUser(ADMIN,`INSERT INTO journal_entries(id,business_id,entry_date,source_type,source_id) VALUES ($1,$2,'2026-11-28','grant_receipt',$1)`,[id,B])).rejects.toThrow('Journal must balance');
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
});
