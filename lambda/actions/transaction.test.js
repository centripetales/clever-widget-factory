const { canView, validateDraft, draftContext, similarOrgs, isSameName, contextPrefix } = require('./transaction');

const STARGAZER = '11111111-1111-1111-1111-111111111111';
const LESTER = '22222222-2222-2222-2222-222222222222';
const RECORD = '99999999-9999-9999-9999-999999999999';

const orgs = [
  { id: STARGAZER, name: 'Stargazer Farm' },
  { id: LESTER, name: "Lester's parents" },
  { id: 'c', name: 'Mambusao Farm Supply' },
];
const record = {
  id: RECORD, organization_id: STARGAZER, organization_name: 'Stargazer Farm', created_by: 'stefan',
  transaction_date: '2026-10-03T00:00:00Z', amount: '200.00', payment_method: 'Cash',
  description: "6 banana suckers from Lester's parents", photo_text: null,
};

describe('canView', () => {
  const auth = overrides => ({ userId: 'may', accessibleOrgIds: [STARGAZER], canReadOrgData: false, ...overrides });

  it('is the recorder, or someone who reads the org\'s data', () => {
    expect(canView(record, auth({ userId: 'stefan' }))).toBe(true);
    expect(canView(record, auth({ canReadOrgData: true }))).toBe(true);
    expect(canView(record, auth())).toBe(false);
  });

  it('is never someone outside the org, or a missing record', () => {
    expect(canView(record, auth({ userId: 'stefan', accessibleOrgIds: [LESTER] }))).toBe(false);
    expect(canView(null, auth({ canReadOrgData: true }))).toBe(false);
  });
});

describe('contextPrefix', () => {
  it('is how a transaction\'s context state starts', () => {
    expect(contextPrefix(RECORD)).toBe(`{"type":"positive_sum.transaction_context","financial_record_id":"${RECORD}"`);
  });
});

describe('draftContext', () => {
  it('gives the transaction and every other organization', () => {
    const text = draftContext(record, orgs);
    expect(text).toContain('Paying organization: Stargazer Farm');
    expect(text).toContain('Amount: ₱200 (Cash) on 2026-10-03');
    expect(text).toContain("Description: 6 banana suckers from Lester's parents");
    expect(text).toContain(`- Lester's parents (org id ${LESTER})`);
    expect(text).not.toContain(`org id ${STARGAZER}`);
    expect(text).not.toContain('Photos:');
  });
});

describe('validateDraft', () => {
  const draft = overrides => ({ other_org_id: LESTER, other_org_name: 'Lesters parents', ...overrides });

  it('uses the listed organization', () => {
    expect(validateDraft(draft(), orgs, STARGAZER)).toEqual({ other_org: { id: LESTER, name: "Lester's parents" } });
  });

  it('keeps only the name when the organization is not listed or is the paying one', () => {
    expect(validateDraft(draft({ other_org_id: 'made-up' }), orgs, STARGAZER).other_org).toEqual({ id: null, name: 'Lesters parents' });
    expect(validateDraft(draft({ other_org_id: STARGAZER }), orgs, STARGAZER).other_org.id).toBeNull();
  });

  it('handles a missing draft', () => {
    expect(validateDraft(null, orgs, STARGAZER)).toEqual({ other_org: { id: null, name: '' } });
  });
});

describe('similarOrgs', () => {
  const names = name => similarOrgs(name, orgs).map(o => o.name);

  it('finds a name written another way', () => {
    expect(names('Lester parents')).toEqual(["Lester's parents"]);
    expect(names('lesters')).toEqual(["Lester's parents"]);
    expect(names('Stargazer')).toEqual(['Stargazer Farm']);
  });

  it('finds a name joined to another word, with or without the apostrophe', () => {
    const joined = [{ id: 'd', name: 'LesterLuna' }];
    expect(similarOrgs('Lesters parents', joined)).toEqual(joined);
    expect(similarOrgs("Lester's parents", joined)).toEqual(joined);
  });

  it('does not match on words every farm shares, or on very short names', () => {
    expect(names('Dela Cruz Farm')).toEqual([]);
    expect(names('La')).toEqual([]);
  });
});

describe('isSameName', () => {
  it('ignores case, spacing and punctuation', () => {
    expect(isSameName("Lester's Parents", 'lesters parents')).toBe(true);
    expect(isSameName("Lester's parents", 'Lester')).toBe(false);
  });
});
