import { Badge } from '@/components/ui/badge';

const LABELS: Record<string, string> = {
  external_proposal: 'Open',
  not_started: 'Approved',
  in_progress: 'In progress',
  completed: 'Done',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={status === 'completed' ? 'default' : 'secondary'}>{LABELS[status] ?? status}</Badge>;
}
