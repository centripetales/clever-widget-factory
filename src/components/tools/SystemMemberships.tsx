import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useToast } from '@/hooks/use-toast';
import { stateService } from '@/services/stateService';
import { partHistoryQueryKey, toolHistoryQueryKey, toolsQueryKey } from '@/lib/queryKeys';
import { assetMembershipsQueryKey, useAssetMemberships, type Membership } from '@/hooks/useAssetMemberships';

// A membership is recorded as observations, as the Claude connector does: a
// "part of" observation on the member, linked to the System (part_of), dated
// the day it joined; ending it is a later observation linked to that one
// (ends). Nothing is deleted. Dates are farm-calendar days (Asia/Manila).
const manilaDay = (when: string | Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(when));
const dayStart = (day: string) => `${day}T00:00:00+08:00`;
const dayEnd = (day: string) => `${day}T23:59:59+08:00`;

interface AssetOption { id: string; type: 'tool' | 'part'; name: string; }
interface Side { id: string; type: 'tool' | 'part'; name: string; }

// A plain search-and-pick list: the app's cmdk Command crashes when rendered
// here ("Cannot use 'in' operator… in null"), taking the page down with it.
function AssetPicker({ options, placeholder, onPick }: { options: AssetOption[]; placeholder: string; onPick: (o: AssetOption) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const shown = options.filter((o) => o.name.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 50);
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setSearch(''); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="flex-1 justify-between font-normal">
          {placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2">
        <Input autoFocus placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="mb-2 h-8" />
        <div className="max-h-60 overflow-y-auto">
          {shown.length === 0 ? (
            <p className="px-2 py-1 text-sm text-muted-foreground">Nothing found.</p>
          ) : shown.map((o) => (
            <button
              key={o.id}
              type="button"
              className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
              onClick={() => { onPick(o); setOpen(false); setSearch(''); }}
            >
              {o.name}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MembershipRow({ label, membership, busy, onRedate, onEnd }: {
  label: string;
  membership: Membership;
  busy: boolean;
  onRedate: (day: string) => void;
  onEnd: (until: string, reason: string) => void;
}) {
  const today = manilaDay(new Date());
  const since = manilaDay(membership.since);
  const [ending, setEnding] = useState(false);
  const [until, setUntil] = useState(today);
  const [reason, setReason] = useState('');
  return (
    <li className="space-y-2 rounded-md border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 min-w-0 break-words text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">since</span>
        <Input
          type="date"
          className="h-8 w-40"
          value={since}
          max={today}
          disabled={busy}
          onChange={(e) => { if (e.target.value && e.target.value !== since) onRedate(e.target.value); }}
        />
        {!ending && (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEnding(true)}>Remove</Button>
        )}
      </div>
      {ending && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">until</span>
          <Input type="date" className="h-8 w-40" value={until} min={since} max={today} onChange={(e) => setUntil(e.target.value)} />
          <Input className="h-8 flex-1 min-w-[8rem]" placeholder="Why (optional), e.g. sold" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button type="button" size="sm" disabled={busy || !until || until < since} onClick={() => onEnd(until, reason)}>Remove</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEnding(false)}>Cancel</Button>
        </div>
      )}
    </li>
  );
}

function FormerList({ memberships }: { memberships: Membership[] }) {
  if (memberships.length === 0) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs">Former ({memberships.length})</Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
          {memberships.map((m) => (
            <li key={m.observation_id}>{m.name}: {manilaDay(m.since)} – {m.until ? manilaDay(m.until) : ''}</li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

// The Systems this tool is part of and, for a System, what it is made of —
// viewed and changed from either side. Each change saves at once.
export function SystemMemberships({ toolId, toolName, isSystem }: { toolId: string; toolName: string; isSystem: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data } = useAssetMemberships(toolId);
  const [busy, setBusy] = useState(false);
  const [pickedSystem, setPickedSystem] = useState<AssetOption | null>(null);
  const [pickedComponent, setPickedComponent] = useState<AssetOption | null>(null);
  const [systemSince, setSystemSince] = useState(manilaDay(new Date()));
  const [componentSince, setComponentSince] = useState(manilaDay(new Date()));
  const today = manilaDay(new Date());

  const partOf = data?.part_of ?? [];
  const components = data?.components ?? [];
  const self: Side = { id: toolId, type: 'tool', name: toolName };

  // Tools and parts are already loaded for the asset list; read them from the cache.
  const { systems, assets } = useMemo(() => {
    const tools = queryClient.getQueryData<{ id: string; name: string; category?: string; status?: string }[]>(toolsQueryKey()) ?? [];
    const parts = queryClient.getQueryData<{ id: string; name: string }[]>(['parts']) ?? [];
    const live = tools.filter((t) => t.status !== 'removed' && t.status !== 'concluded' && t.id !== toolId);
    return {
      systems: live.filter((t) => t.category === 'System').map((t): AssetOption => ({ id: t.id, type: 'tool', name: t.name })),
      assets: [
        ...live.map((t): AssetOption => ({ id: t.id, type: 'tool', name: t.name })),
        ...parts.map((p): AssetOption => ({ id: p.id, type: 'part', name: p.name })),
      ].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [queryClient, toolId]);
  // Not the same link twice, and not both ways round.
  const linked = new Set([...partOf, ...components].filter((m) => !m.until).map((m) => m.asset_id));
  const systemOptions = systems.filter((s) => !linked.has(s.id));
  const componentOptions = assets.filter((a) => !linked.has(a.id));

  const refresh = (member: Side, system: Side) => {
    for (const side of [member, system]) {
      if (side.type === 'tool') queryClient.invalidateQueries({ queryKey: assetMembershipsQueryKey(side.id) });
      queryClient.invalidateQueries({ queryKey: side.type === 'tool' ? toolHistoryQueryKey(side.id) : partHistoryQueryKey(side.id) });
    }
  };
  const run = async (member: Side, system: Side, work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      refresh(member, system);
    } catch (err) {
      toast({ title: 'Could not save', description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };
  const link = (member: Side, system: Side, since: string) => run(member, system, () => stateService.createState({
    state_text: `${member.name} is part of ${system.name}.`,
    captured_at: dayStart(since),
    photos: [],
    links: [{ entity_type: member.type, entity_id: member.id }, { entity_type: 'part_of', entity_id: system.id }],
  }));
  const redate = (member: Side, system: Side, m: Membership, day: string) => run(member, system, () =>
    stateService.updateState(m.observation_id, { captured_at: dayStart(day) }));
  const end = (member: Side, system: Side, m: Membership, until: string, reason: string) => run(member, system, () => stateService.createState({
    state_text: `${member.name} removed from ${system.name}.${reason.trim() ? ` ${reason.trim()}` : ''}`,
    // A day before today ends at that day's close; today is now.
    ...(until < today ? { captured_at: dayEnd(until) } : {}),
    photos: [],
    links: [{ entity_type: member.type, entity_id: member.id }, { entity_type: 'ends', entity_id: m.observation_id }],
  }));

  const asSide = (m: Membership): Side => ({ id: m.asset_id, type: m.type, name: m.name });

  return (
    <div className="space-y-4 rounded-md border p-3">
      <div className="space-y-2">
        <Label>Part of</Label>
        <ul className="space-y-2">
          {partOf.filter((m) => !m.until).map((m) => (
            <MembershipRow key={m.observation_id} label={m.name} membership={m} busy={busy}
              onRedate={(day) => redate(self, asSide(m), m, day)}
              onEnd={(until, reason) => end(self, asSide(m), m, until, reason)} />
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <AssetPicker options={systemOptions} placeholder={pickedSystem?.name ?? 'Add to a System…'} onPick={setPickedSystem} />
          <Input type="date" className="h-9 w-40" value={systemSince} max={today} onChange={(e) => setSystemSince(e.target.value)} />
          <Button type="button" size="sm" disabled={busy || !pickedSystem || !systemSince}
            onClick={() => { if (pickedSystem) link(self, pickedSystem, systemSince).then(() => setPickedSystem(null)); }}>Add</Button>
        </div>
        <FormerList memberships={partOf.filter((m) => m.until)} />
      </div>

      {isSystem && (
        <div className="space-y-2">
          <Label>Components</Label>
          <ul className="space-y-2">
            {components.filter((m) => !m.until).map((m) => (
              <MembershipRow key={m.observation_id} label={m.name} membership={m} busy={busy}
                onRedate={(day) => redate(asSide(m), self, m, day)}
                onEnd={(until, reason) => end(asSide(m), self, m, until, reason)} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <AssetPicker options={componentOptions} placeholder={pickedComponent?.name ?? 'Add a component…'} onPick={setPickedComponent} />
            <Input type="date" className="h-9 w-40" value={componentSince} max={today} onChange={(e) => setComponentSince(e.target.value)} />
            <Button type="button" size="sm" disabled={busy || !pickedComponent || !componentSince}
              onClick={() => { if (pickedComponent) link(pickedComponent, self, componentSince).then(() => setPickedComponent(null)); }}>Add</Button>
          </div>
          <FormerList memberships={components.filter((m) => m.until)} />
        </div>
      )}
    </div>
  );
}
