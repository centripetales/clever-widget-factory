import type { ExpectationModel } from '@/lib/expectations';

// Changing an item's price means saving a new version of its price model with two inputs changed:
// the full price (what a flawless unit sells for, in pesos) and that price as a percent of the
// market price (what buyers see as fair). The market price is not kept on its own: it is the full
// price divided by the percent. Everything else in the model is left as it was.

export interface PriceChange {
  // Both or neither: left out, the prices stay as they were (to change only the sensitivity).
  fullPrice?: number;
  marketPrice?: number;
  // How sharply buyers respond to price: lower is steeper. Left as it was when not given.
  sensitivity?: number;
  reason: string;
  author: string;
  now?: Date;
}

// The market price the model works from: the full price as a percent of what buyers see as fair.
export function marketPriceOf(model: ExpectationModel): number | null {
  const full = model.inputs?.full_price?.value;
  const percent = model.inputs?.price_vs_fair?.value;
  if (!full || !percent) return null;
  return Math.round((full / (percent / 100)) * 100) / 100;
}

// The chance a unit sells when the full price is `percent` of what buyers see as fair.
export function chanceToSell(percent: number, sensitivity: number): number {
  return 1 / (1 + Math.exp(Math.log(percent / 100) / sensitivity));
}

const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;
const peso = (x: number) => `₱${x.toFixed(2)}`;

// A copy of the model, one version on, with the new prices and a record of why.
export function withNewPrice(model: ExpectationModel, change: PriceChange): ExpectationModel {
  const { author } = change;
  const reason = change.reason.trim();
  const inputs = model.inputs;
  if (!inputs?.full_price || !inputs.price_vs_fair) throw new Error('This model has no full price to change');
  const pricesGiven = change.fullPrice !== undefined || change.marketPrice !== undefined;
  const fullPrice = change.fullPrice ?? inputs.full_price.value;
  const marketPrice = change.marketPrice ?? marketPriceOf(model) ?? 0;
  // Changing a price needs a reason; trying a different buyer sensitivity does not.
  if (pricesGiven && !reason) throw new Error('Give a reason for the change');
  if (!(fullPrice > 0) || !(marketPrice > 0)) throw new Error('Both prices must be above 0');

  const percent = pricesGiven ? round((fullPrice / marketPrice) * 100, 1) : inputs.price_vs_fair.value;
  const sensitivity = change.sensitivity ?? inputs.sensitivity?.value ?? 0.25;
  if (!(sensitivity > 0)) throw new Error('Buyer sensitivity must be above 0');
  const sensitivityChanged = inputs.sensitivity !== undefined && sensitivity !== inputs.sensitivity.value;
  const inSix = Math.round(chanceToSell(percent, sensitivity) * 10);
  const day = (change.now ?? new Date()).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const newVersion = String((Number(model.model_metadata.version) || 0) + 1);
  const changes = [
    pricesGiven && `full price set to ${peso(fullPrice)} per kg against a market price of ${peso(marketPrice)} (${percent}%)`,
    sensitivityChanged && `buyer sensitivity set to ${sensitivity}`,
  ].filter(Boolean).join(' and ') || 'saved again with no change';
  const note = `${changes.charAt(0).toUpperCase()}${changes.slice(1)} by ${author} on ${day}${reason ? `: ${reason}` : ''}`;

  // The words about the price follow the numbers, where they are the model's own sentences.
  const description = (pricesGiven ? model.model_metadata.description
    .replace(/set at ₱[\d.,]+ per kg \([^)]*\)/, `set at ${peso(fullPrice)} per kg (${percent}% of a market price of ${peso(marketPrice)})`)
    .replace(/set at [\d.]+% of what buyers see as fair/, `set at ${percent}% of what buyers see as fair`) : model.model_metadata.description)
    .replace(/about \d+ in 10 kilos/, `about ${inSix} in 10 kilos`);

  return {
    ...model,
    model_metadata: { ...model.model_metadata, version: newVersion, author, description },
    inputs: {
      ...inputs,
      full_price: {
        ...inputs.full_price,
        value: fullPrice,
        min: Math.min(inputs.full_price.min, Math.floor(fullPrice / 2)),
        max: Math.max(inputs.full_price.max, Math.ceil(fullPrice * 2)),
      },
      ...(inputs.sensitivity && sensitivityChanged ? {
        sensitivity: {
          ...inputs.sensitivity,
          value: sensitivity,
          min: Math.min(inputs.sensitivity.min, sensitivity),
          max: Math.max(inputs.sensitivity.max, sensitivity),
        },
      } : {}),
      price_vs_fair: {
        ...inputs.price_vs_fair,
        value: percent,
        min: Math.min(inputs.price_vs_fair.min, Math.floor(percent / 2)),
        max: Math.max(inputs.price_vs_fair.max, Math.ceil(percent * 1.5)),
      },
    },
    rationale: `${model.rationale} Price change, version ${newVersion}: ${note}.`,
    evidence: { ...model.evidence, summary: `${model.evidence.summary} ${note}.` },
  };
}
