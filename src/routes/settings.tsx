import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, MailPlus, ShieldAlert, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { en } from "@/i18n/en";
import { useWorkTrackAuth } from "@/lib/auth-context";
import {
  listJobs,
  getBusiness,
  listAuditEvents,
  listMembershipsAndInvitations,
  updateBusiness,
} from "@/lib/data/repository";
import { PersonalAccountPanel, UserAdministrationPanel } from "@/components/AccountMaintenancePanel";
import { can } from "@/lib/permissions";
import { formatDateSA } from "@/lib/format";
import type { AppRole, VatBasis } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Business settings — WorkTrack" },
      { name: "description", content: "Business configuration and invitation-only user management." },
      { property: "og:title", content: "Business settings — WorkTrack" },
      { property: "og:description", content: "Business configuration and invitation-only user management." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { session } = useWorkTrackAuth();
  const queryClient = useQueryClient();

  const allowed = can(session?.role, "business.view");
  const canEdit = can(session?.role, "business.edit");
  const canManageUsers = can(session?.role, "users.manage");

  const bizQuery = useQuery({
    queryKey: ["business", session?.businessId],
    queryFn: () => getBusiness(session!),
    enabled: Boolean(session && allowed),
  });

  const membersQuery = useQuery({
    queryKey: ["members", session?.businessId],
    queryFn: () => listMembershipsAndInvitations(session!),
    enabled: Boolean(session && allowed),
  });

  const auditQuery = useQuery({
    queryKey: ["audit", session?.businessId],
    queryFn: () => listAuditEvents(session!),
    enabled: Boolean(session && can(session.role, "audit.view")),
  });

  const [bizName, setBizName] = React.useState("");
  const [regNumber, setRegNumber] = React.useState("");
  const [vatNumber, setVatNumber] = React.useState("");
  const [vatBasis, setVatBasis] = React.useState<VatBasis>("not_registered");

  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteName, setInviteName] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState<AppRole>("supervisor");

  React.useEffect(() => {
    if (bizQuery.data) {
      setBizName(bizQuery.data.name);
      setRegNumber(bizQuery.data.registrationNumber ?? "");
      setVatNumber(bizQuery.data.vatNumber ?? "");
      setVatBasis(bizQuery.data.defaultVatBasis);
    }
  }, [bizQuery.data]);

  const updateBizMutation = useMutation({
    mutationFn: () =>
      updateBusiness(session!, {
        name: bizName,
        registrationNumber: regNumber || null,
        vatNumber: vatNumber || null,
        defaultVatBasis: vatBasis,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["business"] });
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      toast.success("Business settings saved.");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save settings."),
  });

  const jobsQuery = useQuery({queryKey:['jobs',session?.businessId,session?.userId],queryFn:()=>{if(!session)throw new Error('Sign in required');return listJobs(session);},enabled:Boolean(session && canManageUsers)});

  if (!session) return null;

  if (!allowed) {
    return (
      <div className="mx-auto max-w-xl space-y-4"><PersonalAccountPanel session={session}/><Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-status-danger">
            <ShieldAlert className="h-5 w-5" />
            Access restricted
          </CardTitle>
          <CardDescription>{en.settings.accessDenied}</CardDescription>
        </CardHeader>
      </Card></div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{en.settings.title}</h1>
        <p className="text-sm text-muted-foreground">{en.settings.subtitle}</p>
      </div>

      <PersonalAccountPanel session={session}/>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Building2 className="h-4 w-4" />
            {en.settings.businessSection}
          </CardTitle>
          <CardDescription>
            Calendar defaults: Africa/Johannesburg (SAST), Mon–Sun week, ZAR currency.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              updateBizMutation.mutate();
            }}
            className="grid gap-4 sm:grid-cols-2"
          >
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="biz-name">Business name</Label>
              <Input
                id="biz-name"
                value={bizName}
                onChange={(e) => setBizName(e.target.value)}
                disabled={!canEdit}
                className="touch-target"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="biz-reg">Registration number</Label>
              <Input
                id="biz-reg"
                value={regNumber}
                onChange={(e) => setRegNumber(e.target.value)}
                disabled={!canEdit}
                className="touch-target"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="biz-vat">VAT number (optional)</Label>
              <Input
                id="biz-vat"
                value={vatNumber}
                onChange={(e) => setVatNumber(e.target.value)}
                disabled={!canEdit}
                className="touch-target"
              />
            </div>
            <div className="space-y-1">
              <Label>Default VAT basis</Label>
              <Select
                value={vatBasis}
                onValueChange={(v) => setVatBasis(v as VatBasis)}
                disabled={!canEdit}
              >
                <SelectTrigger className="touch-target"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="not_registered">Not VAT registered</SelectItem>
                  <SelectItem value="exclusive">VAT exclusive</SelectItem>
                  <SelectItem value="inclusive">VAT inclusive</SelectItem>
                  <SelectItem value="exempt">VAT exempt</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {canEdit && (
              <div className="flex items-end sm:justify-end">
                <Button type="submit" disabled={updateBizMutation.isPending} className="touch-target">
                  {en.common.save}
                </Button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <UserCheck className="h-4 w-4" />
            {en.settings.membersSection}
          </CardTitle>
          <CardDescription>
            Accounts are invitation-only. Permissions are enforced per business and role.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {canManageUsers && <UserAdministrationPanel session={session} members={membersQuery.data?.memberships ?? []} jobs={jobsQuery.data ?? []}/>}

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Active members
            </p>
            {(membersQuery.data?.memberships ?? []).map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
                <div>
                  <p className="font-medium">{m.fullName}</p>
                  <p className="text-xs text-muted-foreground">{m.email}</p>
                </div>
                <Badge variant="secondary">{en.roles[m.role]}</Badge>
              </div>
            ))}
          </div>

          {(membersQuery.data?.invitations ?? []).length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Invitations
              </p>
              {(membersQuery.data?.invitations ?? []).map((inv) => (
                <div key={inv.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-border p-3 text-sm">
                  <div>
                    <p className="font-medium">{inv.fullName}</p>
                    <p className="text-xs text-muted-foreground">
                      {inv.email} · Expires {formatDateSA(inv.expiresAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{en.roles[inv.role]}</Badge>
                    <Badge variant="secondary">{inv.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {can(session.role, "audit.view") && (auditQuery.data ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recent audit events</CardTitle>
            <CardDescription>Immutable log of configuration and permission changes.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {(auditQuery.data ?? []).slice(0, 8).map((ev) => (
              <div key={ev.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2 last:border-0">
                <span>
                  <strong>{ev.entityType}</strong> · {ev.action} by {ev.actorEmail}
                </span>
                <span className="text-muted-foreground">{formatDateSA(ev.createdAt)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}