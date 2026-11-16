import type { FinancialRecordPerspective } from '@/types/financialRecords';

// What was seen in the photos, by part; "Not observed" means the model did not see it, not that it did not happen
export function FuelingPerspective({ perspective }: { perspective: FinancialRecordPerspective }) {
  const { vehicle, odometer, receipt, pump } = perspective.content;
  const seen = (observed: boolean, detail?: string) => (observed ? ['Observed', detail].filter(Boolean).join(', ') : 'Not observed');

  return (
    <div className="text-sm space-y-1">
      {vehicle && <p className="font-medium">Fuel fill: {vehicle.name}</p>}
      <p>Odometer: {seen(odometer.observed, odometer.reading !== null ? `${odometer.reading} km as read` : undefined)}</p>
      <p>Receipt: {seen(receipt.observed, receipt.purchases.length > 0 ? `${receipt.purchases.length} ${receipt.purchases.length === 1 ? 'line' : 'lines'}` : undefined)}</p>
      <p>Fuel pump: {seen(pump.observed, [pump.liters !== null ? `${pump.liters} L` : '', pump.octane ?? ''].filter(Boolean).join(', '))}</p>
      <p className="text-muted-foreground">
        Read by {perspective.model_id} ({perspective.version}) · {new Date(perspective.created_at).toLocaleDateString()}
      </p>
    </div>
  );
}
