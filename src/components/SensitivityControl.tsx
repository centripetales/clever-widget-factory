import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Info } from 'lucide-react';
import { useSavePriceModel } from '@/components/PriceEditor';
import type { ExpectationModel } from '@/lib/expectations';

interface SensitivityControlProps {
  partId: string;
  model: ExpectationModel;
  // The value being tried on the chart, or null when it is the saved one.
  trying: number | null;
  onTry: (value: number | null) => void;
  // Whether this person may save a change to the price model.
  canSave: boolean;
}

// Buyer sensitivity beside the demand chart: moving it redraws the chart at once, and saving it
// writes a new version of the price model, with a reason.
export function SensitivityControl({ partId, model, trying, onTry, canSave }: SensitivityControlProps) {
  const { save, saving } = useSavePriceModel(partId);
  const saved = model.inputs?.sensitivity?.value ?? 0.25;
  const value = trying ?? saved;
  const changed = trying !== null && trying !== saved;

  const saveIt = async () => {
    if (await save(model, { sensitivity: value, reason: '' })) onTry(null);
  };

  return (
    <div className="space-y-2 rounded-md bg-muted/50 p-3">
      <div className="flex items-center gap-1">
        <Label htmlFor="chart-sensitivity">Buyer sensitivity</Label>
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-label="About buyer sensitivity" className="text-muted-foreground hover:text-foreground"><Info className="h-4 w-4" /></button>
          </PopoverTrigger>
          <PopoverContent className="text-sm">How sharply buyers react to price. Lower is steeper: a small rise above the market price loses many buyers. Move it to see whether the curve fits what has sold. Nothing is saved until you press Save.</PopoverContent>
        </Popover>
      </div>
      <div className="grid grid-cols-[1fr_6rem] items-center gap-3">
        <Slider min={0.05} max={0.6} step={0.01} value={[Math.min(Math.max(value, 0.05), 0.6)]} onValueChange={([x]) => onTry(x)} />
        <Input id="chart-sensitivity" type="number" inputMode="decimal" min="0.01" step="0.01" value={value} onChange={(e) => onTry(Number(e.target.value) > 0 ? Number(e.target.value) : null)} />
      </div>
      {changed && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Not saved. The saved value is {saved}.</p>
          {canSave && (
            <>
              <div className="flex gap-2">
                <Button size="sm" onClick={saveIt} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
                <Button size="sm" variant="ghost" onClick={() => onTry(null)} disabled={saving}>Reset</Button>
              </div>
            </>
          )}
          {!canSave && <Button size="sm" variant="ghost" onClick={() => onTry(null)}>Reset</Button>}
        </div>
      )}
    </div>
  );
}
