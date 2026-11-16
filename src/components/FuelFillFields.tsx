import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import type { FinancialRecordFuelFill, FinancialRecordMachine } from '@/types/financialRecords';

interface FuelFillFieldsProps {
  fuelFill: FinancialRecordFuelFill | null;
  machines: FinancialRecordMachine[];
  onSave: (fill: { machine_id: string | null; meter_reading: number | null; liters: number | null }) => Promise<void>;
  disabled?: boolean;
}

const NO_VEHICLE = 'none';
const text = (value: number | null) => (value === null ? '' : String(value));
// An empty or non-numeric entry is no value
const toNumber = (value: string): number | null => (value.trim() === '' || Number.isNaN(Number(value)) ? null : Number(value));

/**
 * The fuel fill saved on an expense, as fields the person can correct: the vehicle, its odometer and the
 * liters. What was read from the photos fills them; a mistake is easy to see and to fix here.
 */
export function FuelFillFields({ fuelFill, machines, onSave, disabled }: FuelFillFieldsProps) {
  const [machineId, setMachineId] = useState(fuelFill?.machine.id ?? NO_VEHICLE);
  const [meter, setMeter] = useState(text(fuelFill?.meter_reading ?? null));
  const [liters, setLiters] = useState(text(fuelFill?.liters ?? null));
  const [isSaving, setIsSaving] = useState(false);

  // What is saved is what the fields show again
  useEffect(() => {
    setMachineId(fuelFill?.machine.id ?? NO_VEHICLE);
    setMeter(text(fuelFill?.meter_reading ?? null));
    setLiters(text(fuelFill?.liters ?? null));
  }, [fuelFill]);

  const machine = machines.find((m) => m.id === machineId);
  const dirty =
    machineId !== (fuelFill?.machine.id ?? NO_VEHICLE) ||
    toNumber(meter) !== (fuelFill?.meter_reading ?? null) ||
    toNumber(liters) !== (fuelFill?.liters ?? null);

  // The rate these give, for the person to check (worked out, not saved)
  const previous = fuelFill && fuelFill.machine.id === machineId ? fuelFill.previous : null;
  const reading = toNumber(meter);
  const amount = toNumber(liters);
  const used = previous && reading !== null ? reading - previous.meter_reading : null;
  const rate = machine && used !== null && used > 0 && amount
    ? Math.round((machine.rate_unit === 'km/l' ? used / amount : amount / used) * 100) / 100
    : null;

  const save = async () => {
    setIsSaving(true);
    try {
      await onSave({ machine_id: machine?.id ?? null, meter_reading: machine ? reading : null, liters: machine ? amount : null });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Fuel fill for</Label>
        <Select value={machineId} onValueChange={setMachineId} disabled={disabled || isSaving}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_VEHICLE}>Not a fuel fill</SelectItem>
            {machines.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.name.trim()}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {machine && (
        <div className="flex flex-wrap gap-3">
          <div className="space-y-1">
            <Label>{machine.meter_name} ({machine.meter_unit})</Label>
            <Input className="w-32" inputMode="decimal" value={meter} onChange={(e) => setMeter(e.target.value)} disabled={disabled || isSaving} />
          </div>
          <div className="space-y-1">
            <Label>Liters</Label>
            <Input className="w-28" inputMode="decimal" value={liters} onChange={(e) => setLiters(e.target.value)} disabled={disabled || isSaving} />
          </div>
        </div>
      )}
      {rate !== null && previous && machine && (
        <p className="text-sm">
          <span className="font-medium">{rate} {machine.rate_unit}</span>
          <span className="text-muted-foreground"> since {previous.meter_reading} {machine.meter_unit} on {new Date(previous.date).toLocaleDateString()}</span>
        </p>
      )}
      {dirty && !disabled && (
        <Button size="sm" onClick={save} disabled={isSaving}>
          {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Save fuel fill
        </Button>
      )}
    </div>
  );
}
