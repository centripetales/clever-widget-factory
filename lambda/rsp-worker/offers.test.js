const test = require('node:test');
const assert = require('node:assert');
const { buildPrompt, settle, isReadable, parseOffer, loadOffers } = require('./offers');

const offer = (over = {}) => ({
  id: 'o1', action_id: 'a1', payer_name: 'Stargazer Farm', closed_at: null,
  prompt: 'Organic and non-organic farming practices',
  max_php_per_observation: 20, max_php_per_person: 45, budget_php: null, ...over,
});
const answer = php => ({ shows: ' Compost pit ', offers: [{ offer_id: 'o1', php, feedback: 'f' }] });
const row = data => ({ id: 'o1', state_text: JSON.stringify({ type: 'positive_sum.reward', action_id: 'a1', payer_name: 'Stargazer Farm', closed_at: null, ...data }) });

test('an offer is read from its evaluator and limits, or from the fields used before those existed', () => {
  const made = parseOffer(row({ evaluator: { kind: 'prompt', prompt: ' Practices ' }, max_php_per_observation: 20, max_php_per_person: 400, budget_php: 5000 }));
  assert.deepEqual([made.prompt, made.max_php_per_observation, made.max_php_per_person, made.budget_php], ['Practices', 20, 400, 5000]);
  const older = parseOffer(row({ condition: 'Practices', php: 5, cap_php_per_person: 500 }));
  assert.deepEqual([older.prompt, older.max_php_per_observation, older.max_php_per_person, older.budget_php], ['Practices', 5, 500, null]);
});

test('only open offers with a prompt are read', () => {
  assert.equal(isReadable(offer()), true);
  assert.equal(isReadable(parseOffer(row({ condition: null, php: 5 }))), false);
  assert.equal(isReadable(offer({ closed_at: '2026-10-12T00:00:00Z' })), false);
});

test('the prompt gives each offer in its payer\'s words with its most, and keeps the two sets of notes apart', () => {
  const prompt = buildPrompt({
    offers: [offer()], text: 'Compost pit', person: 'may',
    earlier: [{ person: 'may', shows: 'Goat manure pile' }, { person: 'lester', shows: 'Rice hull mulch' }],
  });
  assert.match(prompt, /offer o1, from Stargazer Farm, pays up to ₱20 for one observation: Organic/);
  assert.match(prompt, /<description>\nCompost pit\n<\/description>/);
  assert.match(prompt, /Already shared by this person:\n- Goat manure pile/);
  assert.match(prompt, /Already shared by other people:\n- Rice hull mulch/);
});

test('an observation earns what the reading gives, rounded, within the most for one observation', () => {
  assert.deepEqual(settle(answer(20), [offer()], [], 'may'), {
    shows: 'Compost pit',
    offers: [{ offer_id: 'o1', action_id: 'a1', counts: true, php: 20, feedback: 'f' }],
  });
  assert.equal(settle(answer(7.4), [offer()], [], 'may').offers[0].php, 7);
  assert.equal(settle(answer(900), [offer()], [], 'may').offers[0].php, 20);
  assert.deepEqual(settle(answer(0), [offer()], [], 'may').offers.map(o => [o.counts, o.php]), [[false, 0]]);
});

test('it stops at what is left for the person and at what is left of the budget', () => {
  const earlier = [
    { person: 'may', offers: [{ offer_id: 'o1', php: 20 }] }, { person: 'may', offers: [{ offer_id: 'o1', php: 20 }] },
    { person: 'lester', offers: [{ offer_id: 'o1', php: 20 }] },
  ];
  assert.equal(settle(answer(20), [offer()], earlier, 'may').offers[0].php, 5);
  assert.equal(settle(answer(20), [offer()], earlier, 'lester').offers[0].php, 20);
  assert.equal(settle(answer(20), [offer({ budget_php: 70 })], earlier, 'lester').offers[0].php, 10);
  assert.equal(settle(answer(20), [offer({ budget_php: 60 })], earlier, 'lester').offers[0].php, 0);
});

test('an offer the model skipped pays its most', () => {
  assert.equal(settle({ shows: 'x', offers: [] }, [offer({ max_php_per_person: null })], [], 'may').offers[0].php, 20);
});

test('read again after an edit, an amount can rise but never falls, and a closed offer keeps what it paid', () => {
  const previous = { offers: [{ offer_id: 'o1', php: 10, counts: true }, { offer_id: 'closed', action_id: 'a9', php: 5, counts: true }] };
  const raised = settle(answer(20), [offer()], [], 'may', previous);
  assert.deepEqual([raised.offers[0].php, raised.offers[0].was_php], [20, 10]);
  assert.deepEqual(raised.offers[1], { offer_id: 'closed', action_id: 'a9', php: 5, counts: true });
  const lower = settle(answer(4), [offer()], [], 'may', previous);
  assert.deepEqual([lower.offers[0].php, 'was_php' in lower.offers[0]], [10, false]);
});

test('an offer where the observation was shared counts only when its person joined that offer', async () => {
  const reward = (id, action_id) => ({ id, state_text: JSON.stringify({ type: 'positive_sum.reward', action_id, closed_at: null, evaluator: { kind: 'prompt', prompt: 'Practices' }, max_php_per_observation: 20 }) });
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/\$6/.test(sql)) return { rows: [reward('joined', 'a-joined'), reward('other', 'a-other')] };
      if (/FROM actions/.test(sql)) return { rows: [{ id: 'a-joined' }] };
      return { rows: [] };
    },
  };
  const state = { id: 's1', organization_id: 'org-a', captured_by: 'lester', captured_at: '2026-10-01T00:00:00Z' };
  const offers = await loadOffers(client, [{ entity_type: 'action', entity_id: 'harvest' }], state);
  assert.deepEqual(offers.map(o => o.id), ['joined']);
  const shared = calls.find(c => /\$6/.test(c.sql));
  assert.deepEqual(shared.params.slice(0, 3), ['s1', 'org-a', 'lester']);
  assert.equal(shared.params[5], state.captured_at);
});
