import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useOrganization } from '@/hooks/useOrganization';

interface OrgPickerProps {
  value: string;
  onChange: (orgId: string) => void;
}

// Where a goal or offer is posted — only people in that org can see it.
// Hidden when the person belongs to a single org.
export function OrgPicker({ value, onChange }: OrgPickerProps) {
  const { accessibleOrganizations } = useOrganization();
  if (accessibleOrganizations.length <= 1) return null;
  return (
    <div className="space-y-1">
      <Label>Share with</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="Choose an organization" />
        </SelectTrigger>
        <SelectContent>
          {accessibleOrganizations.map(org => (
            <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
