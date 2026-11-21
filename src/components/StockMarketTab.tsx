import { useMemo, useState } from 'react';
import { LineChart, Line, Legend, ReferenceArea, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceDot, ReferenceLine } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { format } from 'date-fns';
import { CombinedAsset } from '@/hooks/useCombinedAssets';
import { usePartHistory, type Observation } from '@/hooks/usePartHistory';
import { getImageUrl, getThumbnailUrl, openImage } from '@/lib/imageUtils';
import { useStateSpaceModelsByEntity } from '@/hooks/useStateSpaceModels';
import { latestMarketModel, demandCurve, firstSpot, priceNow } from '@/lib/marketCurves';
import { batchesFrom, batchCurve } from '@/lib/batchCurves';
import { marketPriceOf } from '@/lib/priceChange';
import { batchRipeness, expectedRipeness } from '@/lib/ripeness';
import { useToolsData } from '@/hooks/tools/useToolsData';
import { Link } from 'react-router-dom';
import { PriceEditor } from '@/components/PriceEditor';
import { SensitivityControl } from '@/components/SensitivityControl';
import { useAuth } from '@/hooks/useCognitoAuth';
import { useOrganization } from '@/hooks/useOrganization';

interface StockMarketTabProps {
  stock: CombinedAsset;
}

const MOST_RECENT_NOTES = 3;

const day = (date: string) => format(new Date(`${date}T00:00:00+08:00`), 'MMM d');

// One colour for each batch, repeating after six.
const BATCH_COLOURS = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#ca8a04'];

function Photos({ photos }: { photos: NonNullable<Observation['photos']> }) {
  return (
    <div className="grid grid-cols-2 gap-2 mt-2">
      {photos.map((photo) => (
        <div key={photo.id}>
          <a
            href={getImageUrl(photo.photo_url) || ''}
            onClick={(e) => { e.preventDefault(); openImage(photo.photo_url); }}
            target="_blank"
            rel="noopener noreferrer"
            className="block"
          >
            <img
              src={getThumbnailUrl(photo.photo_url) || getImageUrl(photo.photo_url) || ''}
              alt={photo.photo_description || 'Photo'}
              className="w-full h-40 object-cover rounded border"
              onError={(e) => {
                const target = e.target as HTMLImageElement;
                const fullUrl = getImageUrl(photo.photo_url);
                if (fullUrl && target.src !== fullUrl) target.src = fullUrl;
              }}
            />
          </a>
          {photo.photo_description && <p className="text-xs text-muted-foreground mt-1">{photo.photo_description}</p>}
        </div>
      ))}
    </div>
  );
}

// What a person would want to know about an item that is for sale: what it is, how much
// there is, what it looks like now and where it came from. The price and where the money
// goes come later, when the item has a pricing model.
export function StockMarketTab({ stock }: StockMarketTabProps) {
  const { history, observations, loading } = usePartHistory(stock.id);
  const unit = stock.unit || 'pieces';

  // The item's price model (set with Claude): when spoilage is expected, and how likely it is to
  // sell at each price. Without one of those, these two cards are left out.
  const { data: modelsData } = useStateSpaceModelsByEntity('part', stock.id);
  const model = useMemo(() => latestMarketModel(modelsData?.data ?? []), [modelsData]);
  const fairPrice = useMemo(() => (model ? marketPriceOf(model) : null), [model]);
  // Buyer sensitivity being tried on the chart, not yet saved.
  const [trySensitivity, setTrySensitivity] = useState<number | null>(null);
  const demand = useMemo(() => {
    if (!model) return null;
    const sensitivity = model.inputs?.sensitivity;
    return demandCurve(trySensitivity !== null && sensitivity
      ? { ...model, inputs: { ...model.inputs, sensitivity: { ...sensitivity, value: trySensitivity } } }
      : model);
  }, [model, trySensitivity]);
  const spots = useMemo(() => (model ? firstSpot(model) : null), [model]);
  const price = useMemo(() => (model ? priceNow(model) : null), [model]);

  // The price is changed by an administrator or the person accountable for the item.
  const { user } = useAuth();
  const { isAdmin } = useOrganization();
  const canSetPrice = isAdmin || (!!user?.userId && stock.accountable_person_id === user.userId);

  const ownObservations = observations
    .filter((o) => !o.share_info)
    .sort((a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime());
  const latestWithPhotos = ownObservations.find((o) => o.photos && o.photos.length > 0);

  // Each batch (a lightweight tool made when adding to inventory, with a serial number) gets the price
  // model started on the day it began, so its curve and its first spoilage are its own. A batch that
  // is removed or concluded is no longer in the tools in use, so it drops out.
  const { tools } = useToolsData(false);
  const batches = useMemo(() => batchesFrom(observations, tools), [observations, tools]);
  const batchCurves = useMemo(() => (model ? batches.map((b) => batchCurve(model, b)) : []), [model, batches]);
  // One chart: the chance spoilage has begun, the stage the fruit is expected to be at, and each
  // batch's own ripeness readings, by days since harvest (or since the batch began).
  const spoilageRows = useMemo(() => {
    if (!model || !spots) return [];
    const rows = new Map<number, Record<string, number>>();
    const row = (d: number) => rows.get(d) ?? rows.set(d, { day: d }).get(d)!;
    spots.byDay.forEach((p) => { row(p.day).chance = p.chance; });
    expectedRipeness(spots.median, model.horizon_days).forEach((p) => { row(p.day).expected = p.stage; });
    batches.forEach((b) => batchRipeness(observations, b).forEach((r) => { row(r.day)[b.code] = r.stage; }));
    return [...rows.values()].sort((a, b) => a.day - b.day);
  }, [model, spots, batches, observations]);
  const batchTimes = batchCurves.flatMap((c) => c.path.map((p) => p.time));
  const origin = ownObservations.filter((o) => o.observation_text?.trim()).slice(0, MOST_RECENT_NOTES);

  const lastChange = history
    .filter((h) => h.change_type === 'quantity_add' || h.change_type === 'quantity_remove')
    .map((h) => new Date(h.changed_at).getTime())
    .reduce<number | null>((latest, time) => (latest === null || time > latest ? time : latest), null);

  const quantity = stock.current_quantity ?? 0;
  const availability = quantity === 0
    ? <Badge variant="destructive">Out of stock</Badge>
    : stock.minimum_quantity && quantity <= stock.minimum_quantity
      ? <Badge variant="outline">Low stock</Badge>
      : <Badge variant="default">In stock</Badge>;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6 flex flex-col sm:flex-row gap-4">
          {stock.image_url && (
            <img
              src={getThumbnailUrl(stock.image_url) || getImageUrl(stock.image_url) || ''}
              alt={stock.name}
              className="w-full sm:w-48 h-48 object-cover rounded-md flex-shrink-0"
            />
          )}
          <div className="space-y-2 min-w-0">
            <h2 className="text-xl font-semibold">{stock.name}</h2>
            <p className="text-sm text-muted-foreground">{stock.description || 'No description yet.'}</p>
          </div>
        </CardContent>
      </Card>

      {price && (
        <Card>
          <CardHeader>
            <CardTitle>Price</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="text-2xl font-semibold">₱{price.full.toFixed(2)} per {unit}</span>
              <span className="text-sm text-muted-foreground">full price, for a flawless {unit}</span>
            </div>
            {price.today && (
              <p className="text-sm">
                Expected today: <span className="font-semibold">₱{price.today.mean.toFixed(2)}</span>
                {price.today.p10 !== price.today.p90 && <> (most likely ₱{price.today.p10.toFixed(2)} to ₱{price.today.p90.toFixed(2)})</>}
              </p>
            )}
            <p className="text-xs text-muted-foreground">The price stays at full until spoilage begins, then falls. It is set by the price model.</p>
            {model && canSetPrice && <div className="pt-2"><PriceEditor partId={stock.id} unit={unit} model={model} /></div>}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Availability</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold">{quantity} {unit}</span>
            {availability}
          </div>
          {lastChange !== null && (
            <p className="text-sm text-muted-foreground">Last changed {format(new Date(lastChange), 'PPp')}</p>
          )}
        </CardContent>
      </Card>

      {model && spots && (
        <Card>
          <CardHeader>
            <CardTitle>When spoilage is expected</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {spots.median !== null && spots.medianDate ? (
              <p className="text-sm">
                Around <span className="font-semibold">{day(spots.medianDate)}</span>, about {Math.round(spots.median)} days after harvest
                {spots.p10 !== null && spots.p90 !== null && spots.p10Date && spots.p90Date && (
                  <> (most likely {day(spots.p10Date)} to {day(spots.p90Date)})</>
                )}.
              </p>
            ) : (
              <p className="text-sm">Later than the model covers.</p>
            )}
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={spoilageRows} margin={{ top: 8, right: 0, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
                <XAxis dataKey="day" type="number" domain={[0, model.horizon_days]} fontSize={12} tickFormatter={(d) => `${d}d`} />
                <YAxis yAxisId="chance" domain={[0, 100]} fontSize={12} tickFormatter={(v) => `${v}%`} />
                <YAxis yAxisId="stage" orientation="right" domain={[1, 7]} ticks={[1, 2, 3, 4, 5, 6, 7]} fontSize={12} width={28} />
                <Tooltip
                  labelFormatter={(d) => `${d} days after harvest`}
                  formatter={(value, name) => [name === 'Chance spoilage has begun' ? `${Math.round(Number(value))}%` : `stage ${Number(value).toFixed(1)}`, name]}
                />
                <Legend verticalAlign="bottom" height={28} wrapperStyle={{ fontSize: 12 }} />
                <Line yAxisId="chance" dataKey="chance" name="Chance spoilage has begun" stroke="#dc2626" dot={false} strokeWidth={2} isAnimationActive={false} />
                <Line yAxisId="stage" dataKey="expected" name="Expected ripeness stage" stroke="#6b7280" strokeDasharray="5 4" dot={false} strokeWidth={2} isAnimationActive={false} />
                {batches.map((b, i) => (
                  <Line key={b.toolId} yAxisId="stage" dataKey={b.code} name={b.code} stroke={BATCH_COLOURS[i % BATCH_COLOURS.length]} connectNulls strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
            <p className="text-xs text-muted-foreground">
              Chance spoilage has begun by each day after harvest (left scale). For bananas, spoilage shows as the first brown spots. Ripeness stage (right scale, 1 green to 7 yellow with spoilage spots) is expected to rise in a straight line to stage 7 on the day spoilage is expected, an assumption for now. Each batch's line joins the ripeness readings recorded for it, in days since it began. Starting values from the {model.model_metadata.name} model (version {model.model_metadata.version}), not yet fitted to what has been seen.
            </p>
          </CardContent>
        </Card>
      )}

      {model && (
        <Card>
          <CardHeader>
            <CardTitle>Batches</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {batchCurves.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No batches yet. Press Add batch No when adding to inventory, and each batch gets its own tool, curve and first-spoilage date. It is optional, for studying a batch over time with metrics.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1 pr-3 font-medium">Batch</th>
                        <th className="py-1 pr-3 font-medium">Added</th>
                        <th className="py-1 pr-3 font-medium">Age</th>
                        <th className="py-1 pr-3 font-medium">First spoilage expected</th>
                        <th className="py-1 font-medium">Price today</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchCurves.map((c, i) => (
                        <tr key={c.code} className="border-t">
                          <td className="py-1 pr-3 font-mono whitespace-nowrap">
                            <span className="inline-block h-2 w-2 rounded-full mr-2" style={{ background: BATCH_COLOURS[i % BATCH_COLOURS.length] }} />
                            <Link to={`/combined-assets/${c.toolId}/details`} className="underline-offset-2 hover:underline">{c.code}</Link>
                          </td>
                          <td className="py-1 pr-3 whitespace-nowrap">{format(c.start, 'MMM d')}</td>
                          <td className="py-1 pr-3 whitespace-nowrap">{c.ageDays} {c.ageDays === 1 ? 'day' : 'days'}</td>
                          <td className="py-1 pr-3 whitespace-nowrap">
                            {c.spoilage.medianDate ? <>{day(c.spoilage.medianDate)}{c.spoilage.p10Date && c.spoilage.p90Date && <span className="text-muted-foreground"> ({day(c.spoilage.p10Date)} to {day(c.spoilage.p90Date)})</span>}</> : 'later than the model covers'}
                          </td>
                          <td className="py-1 whitespace-nowrap">{c.priceToday?.today ? `₱${c.priceToday.today.mean.toFixed(2)}` : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
                    <XAxis
                      dataKey="time" type="number" scale="time" fontSize={12}
                      domain={[Math.min(...batchTimes), Math.max(...batchTimes)]}
                      tickFormatter={(time) => format(new Date(Number(time)), 'MMM d')}
                    />
                    <YAxis domain={[0, 100]} fontSize={12} tickFormatter={(v) => `${v}%`} />
                    <Tooltip
                      labelFormatter={(time) => format(new Date(Number(time)), 'MMM d')}
                      formatter={(value, name) => [`${Math.round(Number(value))}% of full price`, String(name)]}
                    />
                    <ReferenceLine x={Date.now()} stroke="#6b7280" strokeDasharray="4 3" label={{ value: 'Today', fontSize: 11, position: 'insideTopRight' }} />
                    {batchCurves.map((c, i) => (
                      <Line
                        key={c.code} data={c.path} dataKey="mean" name={c.code}
                        stroke={BATCH_COLOURS[i % BATCH_COLOURS.length]} dot={false} strokeWidth={2} isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
                <p className="text-xs text-muted-foreground">
                  Expected price of each batch as a percent of full price, from the day it was added. Each batch uses the same starting values until its own photos and readings are used to fit it.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {model && demand && (
        <Card>
          <CardHeader>
            <CardTitle>Chance it sells at each price</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm">
              At the full price, {Math.round(demand.posted.price)}% of what buyers see as fair, about{' '}
              <span className="font-semibold">{Math.round(demand.posted.chance)}%</span> of kilos are expected to sell.
              {' '}Each kilo put up for sale earns the most at <span className="font-semibold">{Math.round(demand.best.price)}%</span> of fair
              {fairPrice !== null && <> (₱{(fairPrice * demand.best.price / 100).toFixed(2)} per {unit})</>}
              , where about {Math.round(demand.best.chance)}% sell.
            </p>
            <ResponsiveContainer width="100%" height={272}>
              <LineChart data={demand.points} margin={{ top: 40, right: 24, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
                <XAxis
                  dataKey="price" type="number" domain={[40, 160]} fontSize={12} height={40}
                  tick={({ x, y, payload }) => (
                    <text x={x} y={y + 12} textAnchor="middle" fontSize={12} fill="currentColor" opacity={0.7}>
                      <tspan x={x}>{payload.value}%</tspan>
                      {fairPrice !== null && <tspan x={x} dy={14}>₱{(fairPrice * payload.value / 100).toFixed(2)}</tspan>}
                    </text>
                  )}
                />
                <YAxis domain={[0, 100]} fontSize={12} tickFormatter={(v) => `${v}%`} />
                <Tooltip
                  labelFormatter={(p) => `Price at ${p}% of fair value${fairPrice !== null ? `, ₱${(fairPrice * Number(p) / 100).toFixed(2)} per ${unit}` : ''}`}
                  formatter={(value) => [`${Math.round(Number(value))}%`, 'Chance it sells']}
                />
                <Line dataKey="chance" stroke="#2563eb" dot={false} strokeWidth={2} isAnimationActive={false} />
                <ReferenceArea x1={40} x2={demand.best.price} y1={0} y2={demand.best.chance} fill="#16a34a" fillOpacity={0.12} stroke="#16a34a" strokeOpacity={0.5} ifOverflow="hidden" />
                <ReferenceDot x={demand.best.price} y={demand.best.chance} r={5} fill="#16a34a" stroke="none"
                  label={({ viewBox }) => (
                    <text x={viewBox.x + -8} y={viewBox.y - 22} textAnchor="end" fontSize={12} fontWeight={600} fill="#16a34a">
                      <tspan x={viewBox.x + -8}>{Math.round(demand.best.price)}%</tspan>
                      {fairPrice !== null && <tspan x={viewBox.x + -8} dy={14} fontWeight={400}>₱{(fairPrice * demand.best.price / 100).toFixed(2)}</tspan>}
                    </text>
                  )} />
                <ReferenceDot x={demand.posted.price} y={demand.posted.chance} r={5} fill="#111827" stroke="none"
                  label={({ viewBox }) => (
                    <text x={viewBox.x + 8} y={viewBox.y - 22} textAnchor="start" fontSize={12} fontWeight={600} fill="#111827">
                      <tspan x={viewBox.x + 8}>{Math.round(demand.posted.price)}%</tspan>
                      {fairPrice !== null && <tspan x={viewBox.x + 8} dy={14} fontWeight={400}>₱{(fairPrice * demand.posted.price / 100).toFixed(2)}</tspan>}
                    </text>
                  )} />
              </LineChart>
            </ResponsiveContainer>
            {model && <SensitivityControl partId={stock.id} model={model} trying={trySensitivity} onTry={setTrySensitivity} canSave={canSetPrice} />}
            <p className="text-xs text-muted-foreground">
              Price as a percent of what buyers see as fair for the fruit's condition. Buyers are indifferent at 100%. The black dot is the full price. The green box is price times the chance it sells: the largest box is the price that earns the most for each kilo put up for sale, before counting spoilage of what does not sell. A starting assumption until sales show how buyers respond.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Latest condition</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : latestWithPhotos ? (
            <>
              <p className="text-sm text-muted-foreground">
                {latestWithPhotos.observed_by_name}, {format(new Date(latestWithPhotos.observed_at), 'PPp')}
              </p>
              {latestWithPhotos.observation_text && <p className="text-sm mt-1">{latestWithPhotos.observation_text}</p>}
              <Photos photos={latestWithPhotos.photos!} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No photos yet. Add an observation with photos to show what it looks like.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Origin</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : origin.length > 0 ? (
            origin.map((o) => (
              <div key={o.id}>
                <p className="text-sm">{o.observation_text}</p>
                <p className="text-xs text-muted-foreground">{o.observed_by_name}, {format(new Date(o.observed_at), 'PPp')}</p>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No notes yet about where this came from.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
