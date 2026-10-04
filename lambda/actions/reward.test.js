const { buildContext, validateClaims, validateNextBestOption, personIds } = require('./reward');

const STARGAZER = '11111111-1111-1111-1111-111111111111';
const PASTOR_ORG = '22222222-2222-2222-2222-222222222222';
const ASSOCIATION = '33333333-3333-3333-3333-333333333333';
const OBS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const action = {
  title: 'Trip to Iloilo', description: 'Pick up goats from the DA', policy: null, status: 'completed',
  organization_id: STARGAZER, created_by: 'stefan', assigned_to: 'pastor', participants: ['stefan'],
  completed_at: '2026-09-20T10:00:00Z',
};
const observations = [
  { id: OBS, captured_by: 'stefan', created_at: '2026-09-20T09:00:00Z', text: 'We paid Pastor 1500 for driving and 3000 for gas.' },
];
const people = [
  { user_id: 'stefan', name: 'Stefan', orgs: [{ id: STARGAZER, name: 'Stargazer Farm' }, { id: ASSOCIATION, name: 'Positive Sum' }] },
];
const orgs = [
  { id: PASTOR_ORG, name: 'Pastor', is_association: false },
  { id: ASSOCIATION, name: 'Positive Sum', is_association: true },
  { id: STARGAZER, name: 'Stargazer Farm', is_association: false },
];

const claim = overrides => ({
  name: 'Paid Pastor for gas', from_org_id: STARGAZER, from_name: 'Stargazer Farm', to_org_id: PASTOR_ORG, to_name: 'Pastor',
  php: 3000, hours: null, cost_basis_method: 'purchase_price', claim: 'Stefan: paid Pastor 3000 for gas.', source_state_ids: [OBS],
  ...overrides,
});

describe('personIds', () => {
  it('collects everyone on the action once', () => {
    expect(personIds(action, observations).sort()).toEqual(['pastor', 'stefan']);
  });
});

describe('buildContext', () => {
  it('names the action org, the people, every listed org and each observation', () => {
    const text = buildContext(action, observations, people, orgs);
    expect(text).toContain(`Action: Trip to Iloilo (organization: Stargazer Farm, org id ${STARGAZER})`);
    expect(text).toContain('- Stefan: Stargazer Farm; Positive Sum');
    expect(text).toContain(`- Pastor (org id ${PASTOR_ORG})`);
    expect(text).toContain(`- Positive Sum (org id ${ASSOCIATION}, association)`);
    expect(text).toContain(`[observation ${OBS}] 2026-09-20 — Stefan: We paid Pastor`);
    expect(text).not.toContain('Policy:');
  });
});

describe('validateClaims', () => {
  const orgIds = orgs.map(o => o.id);
  const check = list => validateClaims({ claims: list }, orgIds, [OBS]);

  it('keeps claims that fit the contract', () => {
    expect(check([claim()])).toEqual([claim()]);
  });

  it('keeps unstated amounts as null, not zero', () => {
    const [kept] = check([claim({ php: null, hours: undefined, cost_basis_method: null })]);
    expect(kept).toMatchObject({ php: null, hours: null, cost_basis_method: null });
  });

  it('allows an org to itself for its own time', () => {
    const own = claim({ to_org_id: STARGAZER, to_name: 'Stargazer Farm', php: null, hours: 24, cost_basis_method: null });
    expect(check([own])).toEqual([own]);
  });

  it('keeps a name when the party is not a listed org, and drops unknown ids', () => {
    const [kept] = check([claim({ from_org_id: 'not-an-org', from_name: 'JSJ Goat Farm' })]);
    expect(kept).toMatchObject({ from_org_id: null, from_name: 'JSJ Goat Farm' });
  });

  it('drops claims with no party, no claim text, or bad amounts', () => {
    expect(check([
      claim({ from_org_id: null, from_name: '' }),
      claim({ claim: '  ' }),
      claim({ php: 'lots' }),
      claim({ hours: -2 }),
    ])).toEqual([]);
  });

  it('drops an unknown cost basis and foreign source ids', () => {
    const [kept] = check([claim({ cost_basis_method: 'cash', source_state_ids: [OBS, 'other'] })]);
    expect(kept).toMatchObject({ cost_basis_method: null, source_state_ids: [OBS] });
  });

  it('handles a missing list', () => {
    expect(validateClaims(null, orgIds, [OBS])).toEqual([]);
  });
});

describe('validateNextBestOption', () => {
  const option = overrides => ({
    name: 'Hire a truck to Iloilo', php: 6000, hours: null, replaces: ['Paid Pastor for gas', 'Driving payment'],
    claim: 'Stefan: 1.5k driver + 4.5k gas = 6000.', source_state_ids: [OBS], ...overrides,
  });

  it('keeps the option and only replacements that are existing claims', () => {
    expect(validateNextBestOption({ next_best_option: option() }, ['Paid Pastor for gas'], [OBS]))
      .toEqual(option({ replaces: ['Paid Pastor for gas'] }));
  });

  it('is null when none was given or it does not fit', () => {
    expect(validateNextBestOption({ next_best_option: null }, [], [OBS])).toBeNull();
    expect(validateNextBestOption({}, [], [OBS])).toBeNull();
    expect(validateNextBestOption({ next_best_option: option({ claim: '' }) }, [], [OBS])).toBeNull();
    expect(validateNextBestOption({ next_best_option: option({ php: -1 }) }, [], [OBS])).toBeNull();
  });
});
