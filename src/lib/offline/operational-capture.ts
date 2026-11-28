import {supabase} from '@/lib/supabase';
import type {AuthSession} from '@/lib/domain/types';
import {encodeRow} from '@/lib/data/database-store';
import {createInterruption,createProgressEntries,resetWorkerDayToTeam,upsertTeamDay,upsertWorkerAttendanceOverride} from '@/lib/data/increment-c-repository';
import {getCaptureEpoch} from '@/lib/offline/data-epoch';
export type OperationalKind='team'|'exception'|'reset_exception'|'progress'|'interruption';
export async function applyOperationalCapture(session:AuthSession,kind:OperationalKind,input:Record<string,unknown>,baseRevision:number,key:string,epoch?:number):Promise<{status:'saved'|'conflict';entityId?:string;server?:Record<string,unknown>;revision?:number}>{
 if(session.mode!=='supabase'){
  if(kind==='team'){const row=await upsertTeamDay(session,input as unknown as Parameters<typeof upsertTeamDay>[1]);return{status:'saved',entityId:row.id};}
  if(kind==='exception'){const row=await upsertWorkerAttendanceOverride(session,input as unknown as Parameters<typeof upsertWorkerAttendanceOverride>[1]);return{status:'saved',entityId:row.id};}
  if(kind==='reset_exception'){await resetWorkerDayToTeam(session,String(input['jobId']??''),String(input['workerId']??''),String(input['workDate']??''));return{status:'saved',entityId:`${String(input['workerId']??'')}-${String(input['workDate']??'')}`};}
  if(kind==='interruption'){const row=await createInterruption(session,{...(input as unknown as Parameters<typeof createInterruption>[1]),idempotencyKey:key});return{status:'saved',entityId:row.id};}
  const rows=await createProgressEntries(session,{...(input as unknown as Parameters<typeof createProgressEntries>[1]),idempotencyKey:key});return{status:'saved',entityId:rows[0]?.id??''};
 }
 if(!supabase)throw new Error('Connection unavailable.');
 const raw=encodeRow(input,{key:'',table:''});
 if(kind==='progress'){raw['section_id']=(input['section'] as {id:string}).id;delete raw['section'];raw['verification_state']='reported';raw['conflict_reason']=null;}
 const {data,error}=await supabase.rpc('worktrack_capture_offline',{p_business:session.businessId,p_epoch:epoch??await getCaptureEpoch(session),p_key:key,p_kind:kind,p_payload:raw,p_base_revision:baseRevision});
 if(error)throw new Error(error.message);return data;
}
