import {supabase} from '@/lib/supabase';
import type {AuthSession} from '@/lib/domain/types';
import {listJobs} from '@/lib/data/repository';
import {listFinanceBundle} from '@/lib/data/increment-d-repository';
import {listIncrementEBundle} from '@/lib/data/increment-e-repository';
import {listAssessmentsAndBenchmarks} from '@/lib/data/assessment-repository';
import {listJobProgressBundle} from '@/lib/data/increment-c-repository';
export async function listEvidenceParents(session:AuthSession){
 const [jobs,finance,operations,assessments]=await Promise.all([listJobs(session),listFinanceBundle(session),listIncrementEBundle(session),listAssessmentsAndBenchmarks(session)]);
 const progress=await Promise.all(jobs.map(j=>listJobProgressBundle(session,j.id)));
 return [
 ...jobs.map(j=>({id:j.id,label:j.name,type:'job'})),
 ...finance.expenses.map(e=>({id:e.id,label:`${e.expenseDate} · ${e.description||e.supplierName||e.category}`,type:'expense'})),
 ...operations.checks.map(c=>({id:c.id,label:`${c.checkDate} · ${operations.assets.find(a=>a.id===c.assetId)?.name??'Vehicle check'}`,type:'vehicle_check'})),
 ...assessments.assessments.map(a=>({id:a.id,label:a.name,type:'assessment'})),
 ...progress.flatMap(p=>p.entries.map(e=>({id:e.id,label:`${e.reportedDate} · ${e.activity} ${e.startChainageMeters}–${e.endChainageMeters}m`,type:'progress_entry'}))),
 ];
}
export async function listUploadedEvidence(session:AuthSession):Promise<Array<{id:string;file_name:string;linked_label:string;storage_path:string;uploaded_at:string}>>{
 if(session.mode!=='supabase')return [];
 if(!supabase)throw new Error('Connection unavailable.');
 const {data,error}=await supabase.from('evidence_attachments').select('id,file_name,linked_label,storage_path,uploaded_at').eq('business_id',session.businessId).eq('upload_status','uploaded').order('uploaded_at',{ascending:false});
 if(error)throw new Error(error.message);return data;
}
export async function getPrivateEvidenceUrl(path:string):Promise<string>{
 if(!supabase)throw new Error('Connection unavailable.');
 const {data,error}=await supabase.storage.from('worktrack-evidence').createSignedUrl(path,180);
 if(error)throw new Error(error.message);return data.signedUrl;
}
