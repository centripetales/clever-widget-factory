const {
  STATE_PREFIX,
  STATE_TYPES,
  stateText,
  parseState,
  implementorIds,
  hasFreeCapacity,
  valueForOthers,
  sortByValue,
  needsImplementorApproval,
  qualifiesForAutoApproval,
  isApproved,
  dayKey,
} = require('./positiveSumRules');

describe('state records', () => {
  it('starts with the prefix the observations list filters on', () => {
    const text = stateText(STATE_TYPES.APPROVAL, { option_id: 'o1', basis: 'recipient' });
    expect(text.startsWith(STATE_PREFIX)).toBe(true);
    expect(parseState(text)).toEqual({ type: STATE_TYPES.APPROVAL, option_id: 'o1', basis: 'recipient' });
  });

  it('ignores ordinary observations and malformed JSON', () => {
    expect(parseState('Aphids on the pineapple')).toBeNull();
    expect(parseState('{"type":"maxwell_interaction"}')).toBeNull();
    expect(parseState(`${STATE_PREFIX}broken`)).toBeNull();
    expect(parseState(null)).toBeNull();
  });
});

describe('implementors and capacity', () => {
  const option = { assigned_to: 'juan', participants: ['lester', 'juan'] };

  it('are the assignee plus participants, deduplicated', () => {
    expect(implementorIds(option)).toEqual(['juan', 'lester']);
    expect(implementorIds({ assigned_to: null, participants: null })).toEqual([]);
  });

  it('has free capacity until implementors reach capacity', () => {
    expect(hasFreeCapacity(option, 3)).toBe(true);
    expect(hasFreeCapacity(option, 2)).toBe(false);
    expect(hasFreeCapacity({ assigned_to: 'juan' }, undefined)).toBe(false);
  });
});

describe('value for others', () => {
  const implementorsByOption = { o1: ['juan'], o2: ['juan', 'lester'], o3: ['maria'] };
  const approvals = [
    { approver: 'maria', option_id: 'o1', basis: 'recipient' },
    { approver: 'pedro', option_id: 'o2', basis: 'recipient' },
    { approver: 'juan', option_id: 'o2', basis: 'implementor' }, // a co-implementor isn't a recipient
    { approver: 'juan', option_id: 'o3', basis: 'recipient' },
  ];

  it('counts recipient approvals by others of options the person implements', () => {
    expect(valueForOthers('juan', approvals, implementorsByOption)).toBe(2);
    expect(valueForOthers('lester', approvals, implementorsByOption)).toBe(1);
    expect(valueForOthers('maria', approvals, implementorsByOption)).toBe(1);
    expect(valueForOthers('pedro', approvals, implementorsByOption)).toBe(0);
  });

  it('sorts suggestions highest value first, oldest first on ties', () => {
    const options = [
      { id: 'late', created_at: '2026-09-27T10:00:00Z', v: 1 },
      { id: 'high', created_at: '2026-09-27T11:00:00Z', v: 5 },
      { id: 'early', created_at: '2026-09-27T09:00:00Z', v: 1 },
    ];
    expect(sortByValue(options, o => o.v).map(o => o.id)).toEqual(['high', 'early', 'late']);
  });
});

describe('approval', () => {
  const byImplementor = { created_by: 'juan', assigned_to: 'juan', participants: [] };
  const byRecipient = { created_by: 'maria', assigned_to: 'juan', participants: [] };

  it('needs the implementors only when a recipient built the option', () => {
    expect(needsImplementorApproval(byImplementor)).toBe(false);
    expect(needsImplementorApproval(byRecipient)).toBe(true);
  });

  it('is approved once a recipient approves and implementors agreed', () => {
    const recipient = { basis: 'recipient' };
    expect(isApproved(byImplementor, [])).toBe(false);
    expect(isApproved(byImplementor, [recipient])).toBe(true);
    expect(isApproved(byRecipient, [recipient])).toBe(false);
    expect(isApproved(byRecipient, [recipient, { basis: 'implementor', approver: 'juan' }])).toBe(true);
    expect(isApproved(byRecipient, [recipient, { basis: 'association_default' }])).toBe(true);
    expect(isApproved(byRecipient, [{ basis: 'implementor' }])).toBe(false);
  });

  it('needs every implementor when built from several owners\' policies', () => {
    const twoOwners = { created_by: 'maria', assigned_to: 'juan', participants: ['lester'] };
    const recipient = { basis: 'recipient', approver: 'maria' };
    expect(isApproved(twoOwners, [recipient, { basis: 'implementor', approver: 'juan' }])).toBe(false);
    expect(isApproved(twoOwners, [recipient, { basis: 'implementor', approver: 'juan' },
      { basis: 'implementor', approver: 'lester' }])).toBe(true);
    expect(isApproved(twoOwners, [recipient, { basis: 'association_default', approver: 'maria' }])).toBe(true);
  });

  it('auto-approves with a completed, evidenced, similar experience', () => {
    const option = { required_tools: ['picker'] };
    const evidenced = { completed: true, photo_count: 2 };
    expect(qualifiesForAutoApproval(option, [], [{ ...evidenced, required_tools: ['picker'] }])).toBe(true);
    expect(qualifiesForAutoApproval(option, ['p1'], [{ ...evidenced, policy_ids: ['p1'] }])).toBe(true);
    expect(qualifiesForAutoApproval(option, [], [{ ...evidenced, required_tools: ['auger'] }])).toBe(false);
    expect(qualifiesForAutoApproval(option, [], [{ completed: false, photo_count: 2, required_tools: ['picker'] }])).toBe(false);
    expect(qualifiesForAutoApproval(option, [], [{ completed: true, photo_count: 0, required_tools: ['picker'] }])).toBe(false);
    expect(qualifiesForAutoApproval(option, [], [])).toBe(false);
  });
});

describe('dayKey', () => {
  it('uses the farm calendar day (Asia/Manila)', () => {
    // 2026-09-27 17:00 UTC is already 2026-09-28 in Manila
    expect(dayKey(new Date('2026-09-27T17:00:00Z'))).toBe('2026-09-28');
    expect(dayKey(new Date('2026-09-27T15:00:00Z'))).toBe('2026-09-27');
  });
});
