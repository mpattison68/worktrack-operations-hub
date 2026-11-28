import { supabase } from '@/lib/supabase';
import type { AuthSession } from '@/lib/domain/types';

type Row = Record<string, unknown>;
export type DatabaseStore = Record<string, unknown>;
export interface TableMapping { key: string; table: string; rename?: Record<string, string>; children?: { key: string; table: string; foreignKey: string }; }
const snapshots = new WeakMap<object, Map<string, Row>>();
const versions = new WeakMap<object, number>();
const snake = (s: string) => s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
export function decodeRow(row: Row, mapping: TableMapping): Row {
  for(const [key,value] of Object.entries(row))if(key.endsWith('_cents')&&value!==null&&!Number.isSafeInteger(Number(value)))throw new Error('A monetary value exceeds the supported exact integer-cent range.');
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [Object.entries(mapping.rename ?? {}).find(([, value]) => value === k)?.[0] ?? camel(k), k.endsWith('_cents') && v !== null ? Number(v) : v]));
}
export function encodeRow(row: Row, mapping: TableMapping): Row {
  return Object.fromEntries(Object.entries(row).filter(([k]) => k !== mapping.children?.key).map(([k,v]) => [mapping.rename?.[k] ?? snake(k), v]));
}
export async function readDatabaseStore(session: AuthSession, mappings: TableMapping[]): Promise<DatabaseStore> {
  if (!supabase) throw new Error('Connection not configured. No demonstration records are used.');
  const tables=[...new Set(mappings.flatMap(m=>[m.table,...(m.children?[m.children.table]:[])]))];
  if(tables.includes('assets'))tables.push('asset_private');
  if(tables.includes('notifications'))tables.push('notification_receipts');
  const {data:bundle,error}=await supabase.rpc('worktrack_read_bundle',{p_business:session.businessId,p_tables:tables});
  if(error)throw new Error(error.message);
  const rows=bundle.tables as Record<string,Row[]>;
  const state: DatabaseStore = {}; const baseline = new Map<string, Row>();
  await Promise.all(mappings.map(async mapping => {
    const res = {data:rows[mapping.table] ?? []};
    const children=mapping.children?{data:rows[mapping.children.table]??[]}:null;
    state[mapping.key] = (res.data ?? []).map((r: Row) => {
      baseline.set(`${mapping.table}:${String(r['id'] ?? r['business_id'])}`, r);
      const value = decodeRow(r, mapping);
      if (mapping.children) {
        const childMapping = { key: mapping.children.key, table: mapping.children.table };
        value[mapping.children.key] = (children?.data ?? []).filter((c: Row) => c[mapping.children?.foreignKey ?? ''] === r['id']).map((c: Row) => {
          baseline.set(`${childMapping.table}:${String(c['id'])}`, c);
          return decodeRow(c, childMapping);
        });
      }
      return value;
    });
  }));
  if (state['assets'] && session.role !== 'supervisor') {
    const privateRows={data:rows["asset_private"]??[]};
    for(const asset of state['assets'] as Row[]){const extra=privateRows.data.find((r:Row)=>r['asset_id']===asset['id']);if(extra){asset['vin']=extra["vin"];asset['purchaseCostCents']=extra["purchase_cost_cents"]===null?null:Number(extra["purchase_cost_cents"]);}}
  }
  if(state['notifications']){
    const receipts={data:(rows['notification_receipts']??[]).filter(r=>r['user_id']===session.userId)};
    for(const notification of state['notifications'] as Row[]){const receipt=receipts.data.find((r:Row)=>r['notification_id']===notification['id']);notification['readAt']=receipt?.["read_at"]??null;notification['acknowledgedAt']=receipt?.["acknowledged_at"]??null;}
  }
  snapshots.set(state, baseline); versions.set(state, Number(bundle.epoch)); return state;
}
export async function writeDatabaseStore(session: AuthSession, state: object, mappings: TableMapping[]): Promise<void> {
  if (!supabase) throw new Error('Connection unavailable.');
  const baseline = snapshots.get(state);
  if (!baseline) throw new Error('Server snapshot missing; refresh before saving.');
  const changes: Array<{ table: string; before: Row | null; after: Row }> = [];
  function collect(table: string, after: Row) {
    const before = baseline?.get(`${table}:${String(after['id'] ?? after['business_id'])}`) ?? null;
    if(before && table==='assets'){delete after['vin'];delete after['purchase_cost_cents'];}
    if(before && table==='notifications'){delete after['read_at'];delete after['acknowledged_at'];delete after['acknowledged_by'];}
    // Compare only fields controlled by this adapter, retaining database-only fields.
    if (before && Object.entries(after).every(([k,v]) => JSON.stringify(before[k]) === JSON.stringify(v))) return;
    changes.push({ table, before, after });
  }
  for (const mapping of mappings) {
    const rows = (state as DatabaseStore)[mapping.key] as Row[];
    for (const row of rows ?? []) {
      collect(mapping.table, encodeRow(row, mapping));
      if (mapping.children) for (const child of (row[mapping.children.key] as Row[] ?? [])) {
        const after = encodeRow(child, { key: '', table: mapping.children.table });
        delete after['account_type']; // display-only lookup, not a journal column
        after['business_id'] = session.businessId;
        after[mapping.children.foreignKey] = row['id'];
        collect(mapping.children.table, after);
      }
    }
  }
  if (!changes.length) return;
  const { error } = await supabase.rpc('worktrack_apply_changes', { p_business: session.businessId, p_epoch: versions.get(state), p_changes: changes });
  if (error) throw new Error(error.code === '40001' ? 'This record changed on another device. Refresh and review before saving.' : error.message);
}
