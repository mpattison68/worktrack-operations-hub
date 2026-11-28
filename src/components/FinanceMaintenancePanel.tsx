import * as React from 'react';
import {useMutation,useQueryClient} from '@tanstack/react-query';
import {toast} from 'sonner';
import type {AuthSession,Job} from '@/lib/domain/types';
import type {FinanceBundle} from '@/lib/domain/increment-d-types';
import {createCustomerInvoice,createLoanAccount,settleExpense} from '@/lib/data/increment-d-repository';
import {formatZarCents,parseZarToCents,todaySAST} from '@/lib/format';
import {en} from '@/i18n/en';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';

export function FinanceMaintenancePanel({session,finance,jobs=[],kind}:{session:AuthSession;finance:FinanceBundle;jobs?:Job[];kind:'invoice'|'loan'|'settlement'}){
 const qc=useQueryClient();const text=en.financeMaintenance;
 const [name,setName]=React.useState(''),[reference,setReference]=React.useState(''),[amount,setAmount]=React.useState(kind==='loan'?'0.00':''),[date,setDate]=React.useState(todaySAST()),[notes,setNotes]=React.useState(''),[terms,setTerms]=React.useState(''),[selected,setSelected]=React.useState(''),[account,setAccount]=React.useState('');
 const mutation=useMutation({mutationFn:async()=>{
  if(kind==='loan'){
   const openingCents=parseZarToCents(amount || '0');
   if(openingCents===null||openingCents<0)throw new Error('Opening balance must be R0 or a positive ZAR amount.');
   return createLoanAccount(session,{lenderName:name,openingPrincipalCents:openingCents,effectiveDate:date,reference,notes,repaymentTermsNote:terms,openingPrincipalVerified:true});
  }
  const cents=parseZarToCents(amount);if(cents===null||cents<=0)throw new Error(text.positiveAmount);
  if(kind==='invoice')return createCustomerInvoice(session,{jobId:selected,label:name,reference,expectedDate:date,amountCents:cents});
  return settleExpense(session,{expenseId:selected,amountCents:cents,accountId:account,paymentDate:date,reference});
 },onSuccess:()=>{qc.invalidateQueries({queryKey:['finance']});setAmount(kind==='loan'?'0.00':'');setName('');setReference('');setNotes('');setTerms('');toast.success(session.mode==='supabase'?text.savedServer:text.savedDev);},onError:e=>toast.error(e.message)});
 if(session.role==='supervisor'||(kind!=='settlement'&&session.role!=='admin'))return null;
 const unpaid=finance.expenses.filter(e=>e.amountCents>e.paidAmountCents);
 return <form onSubmit={e=>{e.preventDefault();mutation.mutate();}} className="space-y-3 border-y border-border py-4">
 <h3 className="font-semibold">{kind==='loan'?text.newLoan:kind==='invoice'?text.newInvoice:text.paySupplier}</h3>
 {kind!=='settlement'&&<div><Label htmlFor={`${kind}-name`}>{kind==='loan'?text.lender:text.description}</Label><Input id={`${kind}-name`} value={name} onChange={e=>setName(e.target.value)} required /></div>}
 {kind!=='loan'&&<div><Label htmlFor={`${kind}-select`}>{kind==='invoice'?text.job:text.expense}</Label><select id={`${kind}-select`} className="h-11 w-full rounded-md border border-input bg-background px-3" value={selected} onChange={e=>setSelected(e.target.value)} required><option value="">{text.choose}</option>{kind==='invoice'?jobs.map(j=><option key={j.id} value={j.id}>{j.name}</option>):unpaid.map(e=><option key={e.id} value={e.id}>{e.supplierName||e.description} · {formatZarCents(e.amountCents-e.paidAmountCents)}</option>)}</select></div>}
 <div className="grid gap-3 sm:grid-cols-3">
  <div><Label htmlFor={`${kind}-amount`}>{kind==='loan'?text.openingBalance:text.amount}</Label><Input id={`${kind}-amount`} inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} className="tabular-money" required /></div>
  <div><Label htmlFor={`${kind}-date`}>{kind==='loan'?text.effectiveDate:kind==='invoice'?text.dueDate:text.paymentDate}</Label><Input id={`${kind}-date`} type="date" value={date} onChange={e=>setDate(e.target.value)} required /></div>
  <div><Label htmlFor={`${kind}-ref`}>{text.reference}</Label><Input id={`${kind}-ref`} value={reference} onChange={e=>setReference(e.target.value)} required={kind!=='loan'} /></div>
 </div>
 {kind==='loan'&&<div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="loan-terms">{text.terms}</Label><Input id="loan-terms" value={terms} onChange={e=>setTerms(e.target.value)} placeholder="e.g. Zero-interest; repay from contract receipts" /></div><div><Label htmlFor="loan-notes">{text.notes}</Label><Input id="loan-notes" value={notes} onChange={e=>setNotes(e.target.value)} placeholder="e.g. Balance carried over from prior contract" /></div></div>}
 {kind==='settlement'&&<div><Label htmlFor="settlement-account">{text.account}</Label><select id="settlement-account" className="h-11 w-full rounded-md border border-input bg-background px-3" value={account} onChange={e=>setAccount(e.target.value)} required><option value="">{text.choose}</option>{finance.accounts.filter(a=>a.isCashAccount&&!a.isRestricted).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></div>}
 {kind==='loan'&&<p className="text-sm text-muted-foreground">{text.openingLoanNote}</p>}
 <Button disabled={mutation.isPending}>{kind==='loan'?text.createLoan:kind==='invoice'?text.createInvoice:text.recordPayment}</Button>
 </form>;
}
