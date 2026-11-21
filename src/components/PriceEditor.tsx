import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Info } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useProfile } from '@/hooks/useProfile';
import { useAuth } from '@/hooks/useCognitoAuth';
import { useCreateStateSpaceModel, useCreateModelAssociation } from '@/hooks/useStateSpaceModels';
import { chanceToSell, marketPriceOf, withNewPrice, type PriceChange } from '@/lib/priceChange';
import type { ExpectationModel } from '@/lib/expectations';
import type { StateSpaceModel } from '@/lib/stateSpaceSchema';

// Saves a new version of an item's price model, with the person's name, and attaches it to the item.
export function useSavePriceModel(partId: string) {
  const { toast } = useToast();
  const { user } = useAuth();
  const { fullName } = useProfile();
  const createModel = useCreateStateSpaceModel();
  const associate = useCreateModelAssociation();

  const save = async (model: ExpectationModel, change: Omit<PriceChange, 'author'>): Promise<boolean> => {
    try {
      const next = withNewPrice(model, { ...change, author: fullName || user?.email || 'Unknown' });
      const created = await createModel.mutateAsync({ model_definition: next as unknown as StateSpaceModel });
      await associate.mutateAsync({ modelId: created.data.id, entityType: 'part', entityId: partId });
      toast({ title: 'Price saved', description: `Price model version ${next.model_metadata.version}` });
      return true;
    } catch (error) {
      toast({ title: 'Could not save the price', description: error instanceof Error ? error.message : 'Try again', variant: 'destructive' });
      return false;
    }
  };
  return { save, saving: createModel.isPending || associate.isPending };
}

interface PriceEditorProps {
  partId: string;
  unit: string;
  model: ExpectationModel;
}

// Change the full price and the market price: saves a new version of the price model, with the reason.
export function PriceEditor({ partId, unit, model }: PriceEditorProps) {
  const { save: saveModel, saving } = useSavePriceModel(partId);

  const [open, setOpen] = useState(false);
  const [percentText, setPercentText] = useState('');
  const [sensitivity, setSensitivity] = useState(0.25);
  const [market, setMarket] = useState('');
  const [reason, setReason] = useState('');

  const begin = () => {
    setPercentText(String(model.inputs?.price_vs_fair?.value ?? ''));
    setSensitivity(model.inputs?.sensitivity?.value ?? 0.25);
    setMarket(String(marketPriceOf(model) ?? ''));
    setReason('');
    setOpen(true);
  };

  // The full price is entered as a percent of the market price, and kept in pesos.
  const marketPrice = Number(market);
  const percent = Number(percentText);
  const fullPrice = Math.round(marketPrice * percent) / 100;
  const valid = fullPrice > 0 && marketPrice > 0 && reason.trim() !== '';
  const chance = percent > 0 ? chanceToSell(percent, sensitivity) : null;
  // The sliders end a little past the larger value; typing a number can go beyond them.
  const marketMax = Math.max(100, Math.ceil(Math.max(marketPrice, model.inputs?.full_price?.max ?? 0) / 10) * 10);
  const percentMax = Math.max(150, Math.ceil(percent / 10) * 10);

  const save = async () => {
    if (await saveModel(model, { fullPrice, marketPrice, sensitivity, reason })) setOpen(false);
  };

  if (!open) {
    return <Button variant="outline" size="sm" onClick={begin}>Set price</Button>;
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="space-y-3">
        {([
          ['market-price', `Market price (₱ per ${unit})`, 'What buyers see as fair for a flawless one.', market, setMarket, marketMax, 0.5],
          ['full-percent', 'Full price (% of market price)', `What a flawless ${unit} sells for, as a percent of the market price. Under 100% is cheaper than the market.`, percentText, setPercentText, percentMax, 1],
        ] as const).map(([id, label, hint, value, set, max, step]) => (
          <div key={id} className="space-y-1">
            <div className="flex items-center gap-1">
              <Label htmlFor={id}>{label}</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" aria-label={`About ${label}`} className="text-muted-foreground hover:text-foreground"><Info className="h-4 w-4" /></button>
                </PopoverTrigger>
                <PopoverContent className="text-sm">{hint}</PopoverContent>
              </Popover>
            </div>
            <div className="grid grid-cols-[1fr_6rem] items-center gap-3">
              <Slider min={0} max={max} step={step} value={[Math.min(Number(value) || 0, max)]} onValueChange={([x]) => set(String(x))} />
              <Input id={id} type="number" inputMode="decimal" min="0" step={step} value={value} onChange={(e) => set(e.target.value)} />
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <Label htmlFor="sensitivity">Buyer sensitivity</Label>
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" aria-label="About buyer sensitivity" className="text-muted-foreground hover:text-foreground"><Info className="h-4 w-4" /></button>
            </PopoverTrigger>
            <PopoverContent className="text-sm">How sharply buyers react to price. Lower is steeper: a small rise above the market price loses many buyers. Until sales show how buyers respond, this is a guess.</PopoverContent>
          </Popover>
        </div>
        <div className="grid grid-cols-[1fr_6rem] items-center gap-3">
          <Slider min={0.05} max={0.6} step={0.01} value={[Math.min(Math.max(sensitivity, 0.05), 0.6)]} onValueChange={([x]) => setSensitivity(x)} />
          <Input id="sensitivity" type="number" inputMode="decimal" min="0.01" step="0.01" value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))} />
        </div>
      </div>
      {chance !== null && fullPrice > 0 && (
        <p className="text-sm">
          Full price is ₱{fullPrice.toFixed(2)} per {unit}. About {Math.round(chance * 100)} in 100 {unit} are expected to sell at it.
        </p>
      )}
      <div className="space-y-1">
        <Label htmlFor="price-reason">Why</Label>
        <Textarea id="price-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: Mae says it sells for 25 to 30 pesos" />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={!valid || saving}>{saving ? 'Saving…' : 'Save price'}</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}
