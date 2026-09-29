import { CheckCircle, Circle, Camera } from 'lucide-react';
import type { ActionEvidence } from '@/types/positiveSum';

// Association defaults for actions that came from an option: photograph any
// problems with a borrowed tool before using it; to finish, a photo of the
// result and a return photo of each tool.
export function EvidenceChecklist({ evidence }: { evidence: ActionEvidence }) {
  if (!evidence.is_option) return null;
  const missingResult = evidence.missing.some(m => m.kind === 'result_photo');
  const missingReturn = new Set(evidence.missing.filter(m => m.kind === 'return_photo').map(m => m.tool_id));
  const Item = ({ done, children }: { done: boolean; children: React.ReactNode }) => (
    <li className="flex items-start gap-2">
      {done ? <CheckCircle className="h-4 w-4 mt-0.5 text-green-600 shrink-0" /> : <Circle className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />}
      <span>{children}</span>
    </li>
  );
  return (
    <div className="rounded-md border p-3 space-y-2 text-sm">
      {evidence.required_tools.length > 0 && (
        <p className="flex items-start gap-2 text-muted-foreground">
          <Camera className="h-4 w-4 mt-0.5 shrink-0" />
          Before using {evidence.required_tools.map(t => t.name).join(', ')}, photograph any problems with it.
        </p>
      )}
      <p className="font-medium">To finish</p>
      <ul className="space-y-1">
        <Item done={!missingResult}>A photo of the result</Item>
        {evidence.required_tools.map(t => (
          <Item key={t.id} done={!missingReturn.has(t.id)}>Return photo of the {t.name}</Item>
        ))}
      </ul>
    </div>
  );
}
