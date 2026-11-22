import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useOrganization } from '@/hooks/useOrganization';
import { useOrganizationMembersByOrg } from '@/hooks/useOrganizationMembers';
import { apiService, getApiData } from '@/lib/apiService';
import { Loader2, Nfc } from 'lucide-react';

// Web NFC (Chrome on Android) is not in TypeScript's DOM types.
interface NdefRecordLike { recordType: string; data?: DataView; encoding?: string }
interface NdefReaderLike {
  write(message: { records: { recordType: string; data: string }[] }): Promise<void>;
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  onreading: ((event: { message: { records: NdefRecordLike[] } }) => void) | null;
  onreadingerror: (() => void) | null;
}
declare const NDEFReader: { new (): NdefReaderLike };

interface MemberCard {
  id: string;
  cognito_user_id: string;
  full_name: string;
  email: string;
  created_at: string;
  revoked_at: string | null;
}

const newSecret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// Waits for one card to be tapped and returns the secret in its /card/<secret> URL.
const readCardSecret = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const controller = new AbortController();
    const reader = new NDEFReader();
    reader.onreadingerror = () => { controller.abort(); reject(new Error('Could not read that card.')); };
    reader.onreading = ({ message }) => {
      controller.abort();
      for (const record of message.records) {
        if (record.recordType !== 'url' && record.recordType !== 'text') continue;
        const text = new TextDecoder(record.encoding || 'utf-8').decode(record.data);
        const secret = text.match(/\/card\/([A-Za-z0-9_-]{20,200})/)?.[1];
        if (secret) return resolve(secret);
      }
      reject(new Error('That card has no card address on it.'));
    };
    reader.scan({ signal: controller.signal }).catch(reject);
  });

export default function CardAdmin() {
  const { toast } = useToast();
  const { organization } = useOrganization();
  const organizationId = organization?.id;
  const { members } = useOrganizationMembersByOrg(organizationId);
  const [personId, setPersonId] = useState('');
  const [busy, setBusy] = useState<'write' | 'read' | null>(null);

  const supported = typeof window !== 'undefined' && 'NDEFReader' in window;
  const people = members.filter((m) => m.is_active && m.cognito_user_id);

  const { data: cards = [], refetch } = useQuery({
    queryKey: ['member_cards', organizationId],
    queryFn: async () => getApiData<MemberCard[]>(await apiService.get(`/member-cards?organization_id=${organizationId}`)) || [],
    enabled: !!organizationId,
  });

  const assign = async (secret: string) => {
    await apiService.post('/member-cards', { organization_id: organizationId, cognito_user_id: personId, secret });
    await refetch();
  };

  const run = async (mode: 'write' | 'read') => {
    setBusy(mode);
    try {
      if (mode === 'write') {
        const secret = newSecret();
        toast({ title: 'Hold a blank card to the back of the phone' });
        await new NDEFReader().write({ records: [{ recordType: 'url', data: `${window.location.origin}/card/${secret}` }] });
        await assign(secret);
      } else {
        toast({ title: 'Hold the card to the back of the phone' });
        await assign(await readCardSecret());
      }
      toast({ title: 'Card assigned' });
    } catch (e) {
      toast({ title: 'Card not assigned', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (id: string) => {
    try {
      await apiService.post('/member-cards/revoke', { id });
      await refetch();
      toast({ title: 'Card revoked' });
    } catch (e) {
      toast({ title: 'Could not revoke', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Assign a card</CardTitle>
          <CardDescription>Choose a person, then tap a card. Tapping the card later signs them in.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!supported && (
            <Alert variant="destructive">
              <AlertDescription>This browser cannot read or write cards. Use Chrome on an Android phone or tablet.</AlertDescription>
            </Alert>
          )}
          <Select value={personId} onValueChange={setPersonId}>
            <SelectTrigger><SelectValue placeholder="Choose a person" /></SelectTrigger>
            <SelectContent>
              {people.map((m) => (
                <SelectItem key={m.cognito_user_id} value={m.cognito_user_id!}>{m.full_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Button disabled={!supported || !personId || !!busy} onClick={() => run('write')}>
              {busy === 'write' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Nfc className="h-4 w-4 mr-2" />}
              Write a new card
            </Button>
            <Button variant="outline" disabled={!supported || !personId || !!busy} onClick={() => run('read')}>
              {busy === 'read' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Nfc className="h-4 w-4 mr-2" />}
              Use a card already written
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Cards</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {cards.length === 0 && <p className="text-sm text-muted-foreground">No cards assigned yet.</p>}
          {cards.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-2 border rounded-md p-2">
              <div>
                <div className="font-medium">{c.full_name || c.email}</div>
                <div className="text-xs text-muted-foreground">Assigned {new Date(c.created_at).toLocaleDateString()}</div>
              </div>
              {c.revoked_at ? (
                <Badge variant="secondary">Revoked</Badge>
              ) : (
                <Button size="sm" variant="outline" onClick={() => revoke(c.id)}>Revoke</Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
