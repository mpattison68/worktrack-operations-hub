import { supabase } from '@/lib/supabase';
import type { AuthSession } from '@/lib/domain/types';
import { getPartitionMeta, setPartitionMeta } from '@/lib/offline/idb-store';
export async function getCaptureEpoch(session: AuthSession): Promise<number> {
 if (session.mode !== 'supabase') return 1;
 const cached = await getPartitionMeta(session.businessId, session.userId, 'dataEpoch');
 if (cached) return Number(cached);
 if (!supabase) throw new Error('Connect before capturing your first offline record.');
 const {data,error} = await supabase.from('businesses').select('data_epoch').eq('id',session.businessId).single();
 if (error) throw new Error('Cannot confirm business version. Connect before capturing offline records.');
 await setPartitionMeta(session.businessId,session.userId,'dataEpoch',String(data.data_epoch));
 return Number(data.data_epoch);
}
export async function fetchServerEpoch(session: AuthSession): Promise<number> {
 if (session.mode !== 'supabase') return 1;
 if (!supabase) throw new Error('Connection unavailable.');
 const {data,error}=await supabase.from('businesses').select('data_epoch').eq('id',session.businessId).single();
 if (error) throw new Error('Cannot confirm server connection or active membership. No records were uploaded.');
 return Number(data.data_epoch);
}
