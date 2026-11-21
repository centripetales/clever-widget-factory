import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useOrganizations } from '@/hooks/useOrganizations';
import { useOrganization } from '@/hooks/useOrganization';
import { normalizeBatchPrefix } from '@/lib/batchCodes';

interface EditableBatchCodePrefixProps {
  organization: { id: string; settings?: { batch_code_prefix?: string } | null };
  canEdit: boolean;
}

// The start of the codes a batch is given when something is added to inventory, such as SF for
// Stargazer Farm: SF112126LA01. Saved in the organization's settings.
export function EditableBatchCodePrefix({ organization, canEdit }: EditableBatchCodePrefixProps) {
  const organizationId = organization.id;
  const currentPrefix = organization.settings?.batch_code_prefix;
  const { updateOrganization } = useOrganizations();
  const { refreshOrganization } = useOrganization();
  const [value, setValue] = useState(currentPrefix ?? '');
  const [saving, setSaving] = useState(false);
  const cleaned = normalizeBatchPrefix(value);
  const changed = cleaned !== (currentPrefix ?? '');

  if (!canEdit) {
    return <p className="text-sm">{currentPrefix || <span className="text-muted-foreground">Not set</span>}</p>;
  }

  const save = async () => {
    setSaving(true);
    // The server merges settings, so only this one is sent.
    const ok = await updateOrganization(organizationId, { settings: { batch_code_prefix: cleaned } });
    if (ok) {
      setValue(cleaned);
      // The organization the rest of the app reads is kept for a day: read it again.
      await refreshOrganization();
    }
    setSaving(false);
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Input
          id="batch-code-prefix"
          value={value}
          onChange={(e) => setValue(normalizeBatchPrefix(e.target.value))}
          placeholder="e.g. SF"
          maxLength={6}
          className="max-w-[8rem] uppercase"
        />
        <Button size="sm" onClick={save} disabled={!changed || saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Starts the code a batch gets when it is added to inventory, followed by the date, two letters of the item and a number, such as SF112126LA01.
      </p>
    </div>
  );
}
