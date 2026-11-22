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
  onreading: ((event: { serialNumber: string; message: { records: NdefRecordLike[] } }) => void) | null;
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

const SCAN_SECONDS = 30;

// Scans until a card is read (a read error while the card is only partly in range does not
// end the scan) or the time runs out. onNote reports read errors as they happen.
const scanForCard = <T,>(
  onNote: (text: string) => void,
  onCard: (event: { serialNumber: string; message: { records: NdefRecordLike[] } }) => T,
  onTimeout: (readErrors: number) => Error,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const controller = new AbortController();
    let readErrors = 0;
    const timer = setTimeout(() => { controller.abort(); reject(onTimeout(readErrors)); }, SCAN_SECONDS * 1000);
    const reader = new NDEFReader();
    reader.onreadingerror = () => {
      readErrors += 1;
      onNote(`The card was seen but not read (${readErrors}). Keep it flat and still against the phone.`);
    };
    reader.onreading = (event) => {
      clearTimeout(timer);
      controller.abort();
      try { resolve(onCard(event)); } catch (e) { reject(e); }
    };
    reader.scan({ signal: controller.signal }).catch((e) => { clearTimeout(timer); reject(e); });
  });

// Waits for one card to be tapped and returns the secret in its /card/<secret> URL.
const readCardSecret = (onNote: (text: string) => void): Promise<string> =>
  scanForCard(
    onNote,
    ({ message }) => {
      for (const record of message.records) {
        if (record.recordType !== 'url' && record.recordType !== 'text') continue;
        const text = new TextDecoder(record.encoding || 'utf-8').decode(record.data);
        const secret = text.match(/\/card\/([A-Za-z0-9_-]{20,200})/)?.[1];
        if (secret) return secret;
      }
      throw new Error('That card has no card address on it.');
    },
    (errors) => new Error(errors ? `The card was seen ${errors} times but never read. It may not be a writable NFC tag type.` : `No card detected in ${SCAN_SECONDS} seconds.`),
  );

// Waits for a card and says what was found, to tell whether the phone detects it.
const checkCard = (onNote: (text: string) => void): Promise<string> =>
  scanForCard(
    onNote,
    ({ serialNumber, message }) => {
      const hasAddress = message.records.some((r) => r.recordType === 'url' && new TextDecoder().decode(r.data).includes('/card/'));
      return `Card detected (serial ${serialNumber}). ${message.records.length} record(s); ${hasAddress ? 'it has a card address.' : 'no card address yet.'}`;
    },
    (errors) => new Error(errors ? `A card was seen ${errors} times but could not be read. It may not be a writable NFC tag type.` : `No card detected in ${SCAN_SECONDS} seconds.`),
  );

export default function CardAdmin() {
  const { toast } = useToast();
  const { organization } = useOrganization();
  const organizationId = organization?.id;
  const { members } = useOrganizationMembersByOrg(organizationId);
  const [personId, setPersonId] = useState('');
  const [busy, setBusy] = useState<'write' | 'read' | 'check' | null>(null);
  const [status, setStatus] = useState('');

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
        setStatus('Waiting for a card. Hold it flat and still against the back of the phone until this says assigned.');
        await new NDEFReader().write({ records: [{ recordType: 'url', data: `${window.location.origin}/card/${secret}` }] });
        await assign(secret);
      } else {
        setStatus('Waiting for a card. Hold it flat and still against the back of the phone.');
        await assign(await readCardSecret(setStatus));
      }
      setStatus('');
      toast({ title: 'Card assigned' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus('');
      toast({
        title: 'Card not assigned',
        description: /IO error/i.test(message)
          ? 'The card was detected but the write failed. Keep it still against the phone, or it may not be a writable NFC tag (NTAG213/215/216).'
          : message,
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy('check');
    setStatus('Waiting for a card. Hold it flat against the back of the phone.');
    try {
      setStatus(await checkCard(setStatus));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
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
            <Button variant="ghost" disabled={!supported || !!busy} onClick={check}>
              {busy === 'check' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Nfc className="h-4 w-4 mr-2" />}
              Check a card
            </Button>
          </div>
          {status && (
            <Alert>
              <AlertDescription>{status}</AlertDescription>
            </Alert>
          )}
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
