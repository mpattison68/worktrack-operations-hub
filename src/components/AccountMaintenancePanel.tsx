import * as React from 'react';
import {useMutation,useQueryClient} from '@tanstack/react-query';
import {useServerFn} from '@tanstack/react-start';
import {toast} from 'sonner';
import type {AuthSession,Membership,Job,AppRole} from '@/lib/domain/types';
import {supabase} from '@/lib/supabase';
import {createBusinessUser,recoverBusinessPassword} from '@/lib/user-admin.functions';
import {en} from '@/i18n/en';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Checkbox} from '@/components/ui/checkbox';
import {Dialog,DialogContent,DialogTitle} from '@/components/ui/dialog';
import {Card,CardHeader,CardTitle,CardContent} from '@/components/ui/card';

export function PersonalAccountPanel({session}:{session:AuthSession}){
 const [current,setCurrent]=React.useState(''),[password,setPassword]=React.useState(''),[confirm,setConfirm]=React.useState(''),[email,setEmail]=React.useState('');
 const change=useMutation({mutationFn:async()=>{
  if(!supabase || session.mode!=='supabase') throw new Error(en.account.liveRequired);
  if(password.length<12 || password!==confirm) throw new Error(en.account.passwordValidation);
  const reauth=await supabase.auth.signInWithPassword({email:session.email,password:current});
  if(reauth.error) throw new Error(en.account.currentIncorrect);
  const changed=await supabase.auth.updateUser({password}); if(changed.error) throw new Error(changed.error.message);
  await supabase.auth.signOut({scope:'others'});
 },onSuccess:()=>{setCurrent('');setPassword('');setConfirm('');toast.success(en.account.passwordSaved);},onError:e=>toast.error(e.message)});
 const emailChange=useMutation({mutationFn:async()=>{
  if(!supabase) throw new Error(en.account.liveRequired);
  const {error}=await supabase.auth.updateUser({email}); if(error) throw new Error(error.message);
 },onSuccess:()=>{setEmail('');toast.success(en.account.emailVerification);},onError:e=>toast.error(e.message)});
 return <Card><CardHeader><CardTitle>{en.account.title}</CardTitle></CardHeader><CardContent className="space-y-5">
 <form onSubmit={e=>{e.preventDefault();change.mutate();}} className="grid gap-3 sm:grid-cols-3">
 <div><Label htmlFor="account-current">{en.account.currentPassword}</Label><Input id="account-current" type="password" autoComplete="current-password" value={current} onChange={e=>setCurrent(e.target.value)} required /></div>
 <div><Label htmlFor="account-new">{en.account.newPassword}</Label><Input id="account-new" type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} minLength={12} required /></div>
 <div><Label htmlFor="account-confirm">{en.account.confirmPassword}</Label><Input id="account-confirm" type="password" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} required /></div>
 <Button disabled={change.isPending || session.mode!=='supabase'}>{en.account.changePassword}</Button></form>
 <form onSubmit={e=>{e.preventDefault();emailChange.mutate();}} className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><Label htmlFor="account-email">{en.account.verifiedEmail}</Label><Input id="account-email" type="email" value={email} onChange={e=>setEmail(e.target.value)} required /></div><Button variant="outline" disabled={emailChange.isPending || session.mode!=='supabase'}>{en.account.requestEmailChange}</Button></form>
 </CardContent></Card>;
}

export function UserAdministrationPanel({session,members,jobs}:{session:AuthSession;members:Membership[];jobs:Job[]}){
 const qc=useQueryClient(),createUser=useServerFn(createBusinessUser),recover=useServerFn(recoverBusinessPassword);
 const [name,setName]=React.useState(''),[email,setEmail]=React.useState(''),[role,setRole]=React.useState<AppRole>('supervisor'),[temporary,setTemporary]=React.useState(false),[password,setPassword]=React.useState('');
 const [editing,setEditing]=React.useState<Membership|null>(null),[selectedJobs,setSelectedJobs]=React.useState<string[]>([]),[editRole,setEditRole]=React.useState<AppRole>('supervisor'),[active,setActive]=React.useState(true),[recovery,setRecovery]=React.useState('');
 const created=useMutation({mutationFn:()=>createUser({data:{businessId:session.businessId,email,fullName:name,role,jobs:[],...(temporary?{password}:{})}}),onSuccess:res=>{setName('');setEmail('');setPassword('');qc.invalidateQueries({queryKey:['members']});toast.success(res.invitationSent?en.account.invitationSent:en.account.userCreated);},onError:e=>toast.error(e.message)});
 const saved=useMutation({mutationFn:async()=>{
  if(!supabase || !editing) throw new Error(en.account.liveRequired);
  const {error}=await supabase.rpc('worktrack_manage_membership',{p_business:session.businessId,p_user:editing.userId,p_role:editRole,p_active:active,p_jobs:selectedJobs,p_name:editing.fullName});
  if(error) throw new Error(error.message);
 },onSuccess:()=>{setEditing(null);qc.invalidateQueries({queryKey:['members']});toast.success(en.account.membershipSaved);},onError:e=>toast.error(e.message)});
 const recovered=useMutation({mutationFn:()=>{if(!editing) throw new Error(en.account.liveRequired);return recover({data:{businessId:session.businessId,userId:editing.userId,password:recovery}});},onSuccess:()=>{setRecovery('');toast.success(en.account.recoverySaved);},onError:e=>toast.error(e.message)});
 if(session.role!=='admin') return null;
 return <div className="space-y-4">
 <form onSubmit={e=>{e.preventDefault();created.mutate();}} className="grid gap-3 sm:grid-cols-3">
 <div><Label htmlFor="user-name">{en.account.fullName}</Label><Input id="user-name" value={name} onChange={e=>setName(e.target.value)} required /></div>
 <div><Label htmlFor="user-email">{en.auth.emailLabel}</Label><Input id="user-email" type="email" value={email} onChange={e=>setEmail(e.target.value)} required /></div>
 <div><Label htmlFor="user-role">{en.account.role}</Label><select id="user-role" className="h-11 w-full rounded-md border border-input bg-background px-3" value={role} onChange={e=>setRole(e.target.value as AppRole)}>{(['admin','owner','supervisor'] as const).map(r=><option key={r} value={r}>{en.roles[r]}</option>)}</select></div>
 <label className="flex min-h-11 items-center gap-2"><Checkbox checked={temporary} onCheckedChange={v=>setTemporary(v===true)} />{en.account.temporaryPassword}</label>
 {temporary&&<div><Label htmlFor="user-password">{en.account.newPassword}</Label><Input id="user-password" type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} minLength={12} required /></div>}
 <Button disabled={created.isPending || session.mode!=='supabase'}>{en.account.createUser}</Button></form>
 {members.map(m=><div key={m.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-2"><p className="text-sm">{m.fullName} · {en.roles[m.role]} · {m.active?en.account.active:en.account.inactive}</p><Button variant="outline" onClick={()=>{setEditing(m);setEditRole(m.role);setActive(m.active);setSelectedJobs(m.assignedJobIds);setRecovery('');}} disabled={session.mode!=='supabase'}>{en.account.manage}</Button></div>)}
 <Dialog open={Boolean(editing)} onOpenChange={open=>{if(!open)setEditing(null);}}><DialogContent><DialogTitle>{editing?.fullName}</DialogTitle>
 <Label>{en.account.role}<select className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3" value={editRole} onChange={e=>setEditRole(e.target.value as AppRole)}>{(['admin','owner','supervisor'] as const).map(r=><option key={r} value={r}>{en.roles[r]}</option>)}</select></Label>
 <label className="flex min-h-11 items-center gap-2"><Checkbox checked={active} onCheckedChange={v=>setActive(v===true)} />{en.account.active}</label>
 <div className="max-h-48 overflow-y-auto"><Label>{en.account.assignedJobs}</Label>{jobs.map(j=><label className="flex min-h-11 items-center gap-2" key={j.id}><Checkbox checked={selectedJobs.includes(j.id)} onCheckedChange={v=>setSelectedJobs(ids=>v===true?[...ids,j.id]:ids.filter(id=>id!==j.id))}/>{j.name}</label>)}</div>
 <Button disabled={saved.isPending} onClick={()=>saved.mutate()}>{en.common.save}</Button>
 <div className="border-t border-border pt-3"><Label htmlFor="user-recovery">{en.account.recoveryPassword}</Label><Input id="user-recovery" type="password" autoComplete="new-password" value={recovery} onChange={e=>setRecovery(e.target.value)} minLength={12}/><Button variant="outline" className="mt-2" disabled={recovery.length<12 || recovered.isPending} onClick={()=>recovered.mutate()}>{en.account.resetPassword}</Button></div>
 </DialogContent></Dialog>
 </div>;
}
