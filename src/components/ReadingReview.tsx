import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, X } from 'lucide-react';
import type { ExtractedFuelFill, ExtractedPurchase, ExtractedReading } from '@/services/financialRecordsService';

interface ReadingReviewProps {
  reading: ExtractedReading;
  onChange: (reading: ExtractedReading) => void;
  recordAmount: number;
  disabled?: boolean;
}

const NO_VEHICLE = 'none';

// What the reader looks for in the photos
const PARTS: [keyof ExtractedReading['observed'], string][] = [['odometer', 'Odometer'], ['receipt', 'Receipt'], ['pump', 'Fuel pump']];

// An empty or non-numeric entry is no value
const toNumber = (text: string): number | null => (text.trim() === '' || Number.isNaN(Number(text)) ? null : Number(text));

/**
 * What was read from the photos, as the person corrects it before it is saved:
 * every value can be changed, since the reading is a starting point.
 */
export function ReadingReview({ reading, onChange, recordAmount, disabled }: ReadingReviewProps) {
  const { purchases, fuel, observed, machines, policies } = reading;

  const setPurchase = (index: number, changes: Partial<ExtractedPurchase>) =>
    onChange({ ...reading, purchases: purchases.map((purchase, i) => (i === index ? { ...purchase, ...changes } : purchase)) });

  const setFuel = (changes: Partial<ExtractedFuelFill>) => fuel && onChange({ ...reading, fuel: { ...fuel, ...changes } });

  const setVehicle = (id: string) => {
    const machine = machines.find((m) => m.id === id);
    if (!machine) return onChange({ ...reading, fuel: null });
    onChange({
      ...reading,
      fuel: {
        meter_reading: null, meter_reading_read: null, liters: null, octane: null, rate: null,
        ...fuel,
        machine,
        previous: fuel?.machine.id === machine.id ? fuel.previous : null,
      },
    });
  };

  // The rate this gives, for the person to check (not saved: it is worked out from the readings)
  const used = fuel?.previous && fuel.meter_reading !== null ? fuel.meter_reading - fuel.previous.meter_reading : null;
  const rate = fuel && used !== null && used > 0 && fuel.liters
    ? Math.round((fuel.machine.rate_unit === 'km/l' ? used / fuel.liters : fuel.liters / used) * 100) / 100
    : null;

  const total = purchases.reduce((sum, purchase) => sum + purchase.amount, 0);

  return (
    <div className="space-y-3">
      {purchases.length === 0 && <p className="text-sm text-muted-foreground">No purchases could be read from the photos.</p>}
      {purchases.map((purchase, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <Input
            className="flex-1 min-w-[10rem]"
            aria-label="Purchase"
            value={purchase.purchase_text}
            onChange={(e) => setPurchase(index, { purchase_text: e.target.value })}
            disabled={disabled}
          />
          <Input
            className="w-20"
            aria-label="Quantity"
            placeholder="Qty"
            inputMode="decimal"
            value={purchase.quantity ?? ''}
            onChange={(e) => setPurchase(index, { quantity: toNumber(e.target.value), unit_price: null })}
            disabled={disabled}
          />
          <Input
            className="w-20"
            aria-label="Unit"
            placeholder="Unit"
            value={purchase.unit ?? ''}
            onChange={(e) => setPurchase(index, { unit: e.target.value.trim() === '' ? null : e.target.value })}
            disabled={disabled}
          />
          <Input
            className="w-28"
            aria-label="Amount"
            placeholder="₱"
            inputMode="decimal"
            value={purchase.amount}
            onChange={(e) => setPurchase(index, { amount: toNumber(e.target.value) ?? 0, unit_price: null })}
            disabled={disabled}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remove purchase"
            onClick={() => onChange({ ...reading, purchases: purchases.filter((_, i) => i !== index) })}
            disabled={disabled}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange({ ...reading, purchases: [...purchases, { purchase_text: '', quantity: null, unit: null, unit_price: null, amount: 0 }] })}
        disabled={disabled}
      >
        <Plus className="h-4 w-4 mr-2" />
        Add a purchase
      </Button>
      {purchases.length > 0 && Math.abs(total - recordAmount) > 0.005 && (
        <p className="text-sm text-amber-600">
          These add up to ₱{total.toFixed(2)}, not the record's ₱{recordAmount.toFixed(2)}.
        </p>
      )}

      {machines.length > 0 && (
        <div className="rounded border p-3 text-sm space-y-3">
          <div className="space-y-1">
            <Label>Fuel fill for</Label>
            <Select value={fuel?.machine.id ?? NO_VEHICLE} onValueChange={setVehicle} disabled={disabled}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_VEHICLE}>Not a fuel fill</SelectItem>
                {machines.map((machine) => (
                  <SelectItem key={machine.id} value={machine.id}>{machine.name.trim()}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {fuel && (
            <>
              <div className="flex flex-wrap gap-3">
                <div className="space-y-1">
                  <Label>{fuel.machine.meter_name} ({fuel.machine.meter_unit})</Label>
                  <Input
                    className="w-32"
                    inputMode="decimal"
                    value={fuel.meter_reading ?? ''}
                    onChange={(e) => setFuel({ meter_reading: toNumber(e.target.value) })}
                    disabled={disabled}
                  />
                  {fuel.meter_reading_read !== null && (
                    <p className="text-xs text-muted-foreground">read as {fuel.meter_reading_read}</p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label>Liters</Label>
                  <Input
                    className="w-28"
                    inputMode="decimal"
                    value={fuel.liters ?? ''}
                    onChange={(e) => setFuel({ liters: toNumber(e.target.value) })}
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Octane</Label>
                  <Input
                    className="w-28"
                    value={fuel.octane ?? ''}
                    onChange={(e) => setFuel({ octane: e.target.value.trim() === '' ? null : e.target.value })}
                    disabled={disabled}
                  />
                </div>
              </div>
              {rate !== null && fuel.previous && (
                <p>
                  <span className="font-medium">{rate} {fuel.machine.rate_unit}</span>
                  <span className="text-muted-foreground"> since {fuel.previous.meter_reading} {fuel.machine.meter_unit} on {new Date(fuel.previous.date).toLocaleDateString()}</span>
                </p>
              )}
            </>
          )}
        </div>
      )}

      {(policies.length > 0 || fuel) && (
        <div className="rounded border p-3 text-sm space-y-1">
          {policies.map((policy) => (
            <p key={policy.id} className="font-medium">Policy: {policy.title}</p>
          ))}
          <p className="text-muted-foreground">
            {PARTS.map(([key, label]) => `${label}: ${observed[key] ? 'Observed' : 'Not observed'}`).join(' · ')}
          </p>
        </div>
      )}
    </div>
  );
}
