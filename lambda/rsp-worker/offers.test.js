const test = require('node:test');
const assert = require('node:assert');
const { buildPrompt, settle, isReadable, parseOffer, loadOffers, loadNearest, evaluate } = require('./offers');

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

test('the prompt gives each offer in its payer\'s words with its most, and the nearest notes with who shared them', () => {
  const prompt = buildPrompt({
    offers: [offer()], text: 'Compost pit',
    nearest: [
      { label: 'n1', who: 'you', date: '2026-10-15', shows: 'Goat manure pile' },
      { label: 'n2', who: 'another organization (Azolla Kapwa)', date: '2026-10-02', shows: 'Rice hull mulch' },
    ],
  });
  assert.match(prompt, /offer o1, from Stargazer Farm, pays up to ₱20 for one observation: Organic/);
  assert.match(prompt, /<description>\nCompost pit\n<\/description>/);
  assert.match(prompt, /Earlier notes most like this one, nearest first:\n\[n1\] you, 2026-10-15: Goat manure pile\n\[n2\] another organization \(Azolla Kapwa\), 2026-10-02: Rice hull mulch/);
  assert.match(buildPrompt({ offers: [offer()], text: 'x', nearest: [] }), /nearest first:\n- nothing yet/);
});

test('the notes a reading compared with are kept as the observations they stand for, with what it adds; labels it was not given are dropped', () => {
  const nearest = [{ label: 'n1', state_id: 's-early' }, { label: 'n2', state_id: 's-other' }];
  const input = { shows: 'x', offers: [{ offer_id: 'o1', php: 3, feedback: 'f', compared_with: [
    { note: 'n2', adds: ' a load of 4 per trip ', repeats: false }, { note: 'n9', adds: '', repeats: true }, { note: 'n2', adds: 'again', repeats: true },
    { note: 'n1', adds: '', repeats: true },
  ] }] };
  assert.deepEqual(settle(input, [offer()], [], 'may', null, nearest).offers[0].compared_with, [
    { state_id: 's-other', adds: 'a load of 4 per trip', repeats: false }, { state_id: 's-early', adds: '', repeats: true },
  ]);
  const none = { shows: 'x', offers: [{ offer_id: 'o1', php: 5, feedback: 'f', compared_with: [] }] };
  assert.equal('compared_with' in settle(none, [offer()], [], 'may', null, nearest).offers[0], false);
});

test('the nearest notes are looked up by the stored CLAIM embedding, or by embedding the CLAIM when it is new', async () => {
  const calls = [];
  let embedded = 0;
  const client = stored => ({
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM state_perspectives cp\s+LEFT JOIN unified_embeddings/.test(sql)) return { rows: [{ text: 'Compost pit', embedding: stored }] };
      if (/ORDER BY ue.embedding <=>/.test(sql)) return { rows: [
        { state_id: 's1', person: 'may', org: 'org-a', org_name: 'Stargazer', captured_at: '2026-10-15T01:00:00Z', shows: 'Goat manure pile' },
        { state_id: 's2', person: 'lester', org: 'org-a', org_name: 'Stargazer', captured_at: '2026-10-16T01:00:00Z', shows: 'Mulch' },
        { state_id: 's3', person: 'ana', org: 'org-b', org_name: 'Azolla Kapwa', captured_at: '2026-10-02T01:00:00Z', shows: 'Rice hull' },
      ] };
      return { rows: [] };
    },
  });
  const state = { id: 'obs', organization_id: 'org-a', captured_by: 'may' };
  const embedText = async () => { embedded++; return [0.1, 0.2]; };
  const nearest = await loadNearest(client('[0.3,0.4]'), [offer()], state, embedText);
  assert.deepEqual(nearest.map(n => [n.label, n.state_id, n.who, n.date]), [
    ['n1', 's1', 'you', '2026-10-15'], ['n2', 's2', 'your organization', '2026-10-16'], ['n3', 's3', 'another organization (Azolla Kapwa)', '2026-10-02'],
  ]);
  assert.equal(embedded, 0);
  assert.equal(calls.at(-1).params[2], '[0.3,0.4]');
  await loadNearest(client(null), [offer()], state, embedText);
  assert.equal(embedded, 1);
  assert.equal(calls.at(-1).params[2], '[0.1,0.2]');
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

test('an answer list sent as JSON text is read as the list', () => {
  const input = { shows: 'x', offers: JSON.stringify([{ offer_id: 'o1', php: 2, feedback: 'f', compared_with: JSON.stringify([{ note: 'n1', adds: '', repeats: true }]) }]) };
  const settled = settle(input, [offer()], [], 'may', null, [{ label: 'n1', state_id: 's1' }]).offers[0];
  assert.equal(settled.php, 2);
  assert.deepEqual(settled.compared_with, [{ state_id: 's1', adds: '', repeats: true }]);
});

test('a formula the reading writes out is worked out here', () => {
  assert.equal(evaluate('5 * 0.5^0.5').toFixed(4), '3.5355');
  assert.equal(evaluate('5 × 0.5^(1 + 0.5)').toFixed(4), '1.7678');
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-(2 - 5) * 2'), 6);
  for (const bad of ['', '5 * n', 'process.exit()', '5 *', '(5', '5)']) assert.equal(evaluate(bad), null);
});

test('the amount comes from the calculation when there is one, and from the reading otherwise', () => {
  const read = (calculation, php) => settle({ shows: 'x', offers: [{ offer_id: 'o1', compared_with: [], calculation, php, feedback: 'f' }] }, [offer()], [], 'may').offers[0];
  assert.equal(read('5 * 0.5^0.5', 3).php, 4);
  assert.equal(read('5 * 0.5^0.5', 3).calculation, '5 * 0.5^0.5');
  assert.equal(read('', 3).php, 3);
  assert.equal(read('five', 3).php, 3);
  assert.equal(read('100', 3).php, 20);
});

test('a reading whose answers cannot be read is not settled, rather than paying every offer its most', () => {
  assert.throws(() => settle({ shows: 'x', offers: '[{"offer_id": "o1", "php": 2,' }, [offer()], [], 'may'), /no readable answers/);
  assert.throws(() => settle({ shows: 'x' }, [offer()], [], 'may'), /no readable answers/);
  assert.equal(settle({ shows: 'x', offers: [] }, [offer()], [], 'may').offers[0].php, 20);
});
