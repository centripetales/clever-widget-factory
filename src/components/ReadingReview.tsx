import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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

// An empty or non-numeric entry is no value
const toNumber = (text: string): number | null => (text.trim() === '' || Number.isNaN(Number(text)) ? null : Number(text));

/**
 * What was read from the photos, as the person corrects it before it is saved:
 * every value can be changed, since the reading is a starting point.
 */
export function ReadingReview({ reading, onChange, recordAmount, disabled }: ReadingReviewProps) {
  const { purchases, fuel, machines, policies } = reading;

  const setPurchase = (index: number, changes: Partial<ExtractedPurchase>) =>
    onChange({ ...reading, purchases: purchases.map((purchase, i) => (i === index ? { ...purchase, ...changes } : purchase)) });

  const setFuel = (changes: Partial<ExtractedFuelFill>) => fuel && onChange({ ...reading, fuel: { ...fuel, ...changes } });

  const setVehicle = (id: string) => {
    const machine = machines.find((m) => m.id === id);
    if (!machine) return onChange({ ...reading, fuel: null });
    onChange({
      ...reading,
      fuel: {
        meter_reading: null, liters: null, octane: null, rate: null,
        observed: { meter_photo: false, pump_photo: false, receipt_photo: false, full_tank: false },
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

  const observed: [keyof ExtractedFuelFill['observed'], string][] = fuel
    ? [['meter_photo', `${fuel.machine.meter_name} photo`], ['pump_photo', 'Pump photo'], ['receipt_photo', 'Receipt photo'], ['full_tank', 'Full tank']]
    : [];

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
            onChange={(e) => setPurchase(index, { quantity: toNumber(e.target.value) })}
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
            onChange={(e) => setPurchase(index, { amount: toNumber(e.target.value) ?? 0 })}
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {observed.map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2">
                    <Checkbox
                      checked={fuel.observed[key]}
                      onCheckedChange={(checked) => setFuel({ observed: { ...fuel.observed, [key]: checked === true } })}
                      disabled={disabled}
                    />
                    <span>{label}: {fuel.observed[key] ? 'Observed' : 'Not observed'}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {policies.map((policy, policyIndex) => (
        <div key={policy.id} className="rounded border p-3 text-sm space-y-2">
          <p className="font-medium">Policy: {policy.title}</p>
          {policy.not_observed.length === 0 ? (
            <p className="text-muted-foreground">Everything it asks for was observed</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Not observed:</span>
              {policy.not_observed.map((item, itemIndex) => (
                <span key={itemIndex} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5">
                  {item}
                  <button
                    type="button"
                    aria-label={`Remove ${item}`}
                    disabled={disabled}
                    onClick={() => onChange({
                      ...reading,
                      policies: policies.map((p, i) => (i === policyIndex ? { ...p, not_observed: p.not_observed.filter((_, j) => j !== itemIndex) } : p)),
                    })}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
