import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Plus, X } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PolicyFormDialog } from '@/components/PolicyFormDialog';
import { useOrganization } from '@/hooks/useOrganization';
import { PolicyChange, usePolicies, useSavePolicy } from '@/hooks/usePolicies';
import type { Policy, PolicySource } from '@/types/policies';

const sourceLink = (s: PolicySource) => (s.type === 'observation' ? `/observations/edit/${s.id}` : `/experiences/${s.id}`);
const sourceKind = (s: PolicySource) => (s.type === 'observation' ? 'Observation' : 'Experience');
const plain = (text: string) => text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

interface Confirmation {
  title: string;
  description: string;
  action: string;
  change: PolicyChange;
}

// The active organization's policies: everyone reads them, leadership and
// admins write them.
export default function Policies() {
  const navigate = useNavigate();
  const { organization, organizationMember } = useOrganization();
  const { data: policies = [], isLoading, isError } = usePolicies(organization?.id);
  const savePolicy = useSavePolicy(organization?.id);
  const canEdit = ['admin', 'leadership'].includes(organizationMember?.role ?? '');

  const [search, setSearch] = useState('');
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [showRetired, setShowRetired] = useState(false);
  // undefined: the form is closed; null: a new policy
  const [editing, setEditing] = useState<Policy | null | undefined>(undefined);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);

  const wanted = search.trim().toLowerCase();
  const matching = policies.filter((p) => !wanted || `${p.title}\n${p.description_text}`.toLowerCase().includes(wanted));
  const active = matching.filter((p) => p.status === 'active');
  const retired = matching.filter((p) => p.status !== 'active');

  const toggle = (id: string) => setOpenIds((ids) => (ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]));

  const renderPolicy = (policy: Policy) => {
    const open = openIds.includes(policy.id);
    return (
      <li key={policy.id} className="rounded-md border bg-card">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-3 text-left font-medium hover:bg-muted"
          aria-expanded={open}
          onClick={() => toggle(policy.id)}
        >
          {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <span className="break-words">{policy.title}</span>
        </button>
        {open && (
          <div className="space-y-4 border-t px-3 py-3 text-sm">
            <p className="whitespace-pre-wrap break-words">{policy.description_text}</p>
            {policy.reasoning && (
              <div>
                <h3 className="font-medium text-muted-foreground">Reasoning</h3>
                <p className="whitespace-pre-wrap break-words">{policy.reasoning}</p>
              </div>
            )}
            {policy.sources.length > 0 && (
              <div>
                <h3 className="font-medium text-muted-foreground">Based on</h3>
                <ul className="space-y-1">
                  {policy.sources.map((source) => (
                    <li key={source.id} className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        {source.date ? (
                          <Link to={sourceLink(source)} className="text-primary underline">
                            {[sourceKind(source), source.by?.trim(), format(new Date(source.date), 'MMM d, yyyy')].filter(Boolean).join(' · ')}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">{sourceKind(source)} you cannot see</span>
                        )}
                        {source.text && <p className="line-clamp-2 break-words text-muted-foreground">{plain(source.text)}</p>}
                      </div>
                      {canEdit && (
                        <Button
                          variant="ghost" size="sm" aria-label={`Remove this ${source.type}`}
                          onClick={() => setConfirming({
                            title: 'Remove this source?',
                            description: `The ${source.type} itself is kept. Claude can link it again.`,
                            action: 'Remove',
                            change: { kind: 'sources', id: policy.id, sources: policy.sources.filter((s) => s.id !== source.id) },
                          })}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-auto text-xs text-muted-foreground">
                Used by {policy.action_count} {policy.action_count === 1 ? 'action' : 'actions'}
              </span>
              {canEdit && (
                <>
                  <Button variant="outline" size="sm" onClick={() => setEditing(policy)}>Edit</Button>
                  {policy.status === 'active' ? (
                    <Button
                      variant="outline" size="sm"
                      onClick={() => setConfirming({
                        title: `Retire "${policy.title}"?`,
                        description: 'Actions that use it keep it. It cannot be linked to new ones, and you can restore it.',
                        action: 'Retire',
                        change: { kind: 'status', id: policy.id, status: 'deprecated' },
                      })}
                    >
                      Retire
                    </Button>
                  ) : (
                    <Button
                      variant="outline" size="sm" disabled={savePolicy.isPending}
                      onClick={() => savePolicy.mutate({ kind: 'status', id: policy.id, status: 'active' })}
                    >
                      Restore
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="min-h-screen bg-background p-4 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <h1 className="mr-auto text-xl font-semibold">Policies</h1>
        {canEdit && (
          <Button size="sm" className="gap-1" onClick={() => setEditing(null)}>
            <Plus className="h-4 w-4" />
            New policy
          </Button>
        )}
      </div>
      {isLoading ? (
        <div className="flex items-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading policies…
        </div>
      ) : isError && policies.length === 0 ? (
        <p className="text-sm text-destructive">Could not load the policies.</p>
      ) : policies.length === 0 ? (
        <p className="text-sm text-muted-foreground">No policies yet.</p>
      ) : (
        <>
          <Input aria-label="Search policies" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          {active.length > 0 ? (
            <ul className="space-y-2">{active.map(renderPolicy)}</ul>
          ) : (
            <p className="text-sm text-muted-foreground">{wanted ? 'No active policy matches.' : 'No active policies.'}</p>
          )}
          {retired.length > 0 && (
            <section className="space-y-2">
              <Button variant="ghost" size="sm" onClick={() => setShowRetired((v) => !v)}>
                {showRetired ? 'Hide retired' : `Show retired (${retired.length})`}
              </Button>
              {showRetired && <ul className="space-y-2 opacity-75">{retired.map(renderPolicy)}</ul>}
            </section>
          )}
        </>
      )}
      {editing !== undefined && (
        <PolicyFormDialog
          key={editing?.id ?? 'new'}
          policy={editing}
          saving={savePolicy.isPending}
          onClose={() => setEditing(undefined)}
          onSave={(change) => savePolicy.mutate(change, { onSuccess: () => setEditing(undefined) })}
        />
      )}
      <AlertDialog open={!!confirming} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirming && savePolicy.mutate(confirming.change)}>
              {confirming?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
