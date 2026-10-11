const {
  STATE_PREFIX,
  STATE_TYPES,
  stateText,
  parseState,
  implementorIds,
  isGoal,
  isChallenge,
  isProposal,
  isSituation,
  proposalText,
  challengeSummaries,
  addressedChallenges,
  takingPart,
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

  it('needs every implementor when built from several owners\' options', () => {
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
    expect(qualifiesForAutoApproval(option, ['o1'], [{ ...evidenced, source_option_ids: ['o1'] }])).toBe(true);
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

describe('Maxwell agent adapter', () => {
  const { toList, toRequest } = require('./agentEvent');

  it('parses list parameters in the forms Bedrock sends', () => {
    expect(toList('["a","b"]')).toEqual(['a', 'b']);
    expect(toList('[a, b]')).toEqual(['a', 'b']);
    expect(toList('a,b')).toEqual(['a', 'b']);
    expect(toList('')).toEqual([]);
    expect(toList(undefined)).toEqual([]);
  });

  it('defaults to the goal being discussed', () => {
    const event = { apiPath: '/createOption', sessionAttributes: { entityId: 'goal-1' } };
    const request = toRequest(event, { initial_state: 's', policy: 'p', final_state: 'f', capacity: '3' });
    expect(request.path).toBe('/api/positive-sum/options');
    expect(request.body.goal_ids).toEqual(['goal-1']);
    expect(request.body.capacity).toBe(3);
    expect(toRequest({ apiPath: '/getGoalContext', sessionAttributes: { entityId: 'goal-1' } }, {}).path)
      .toBe('/api/positive-sum/goals/goal-1/context');
  });

  it('rejects unknown operations', () => {
    expect(toRequest({ apiPath: '/deleteEverything' }, {})).toBeNull();
  });
});

describe('takingPart', () => {
  const goal = { id: 'store', participants: ['may', 'lester'] };
  const comments = [
    { action_id: 'store', person: 'may', text: 'I can run the counter on Saturdays.' },
    { action_id: 'seeds', person: 'may', text: 'About another desired state.' },
    { action_id: 'store', person: 'stefan', text: 'From someone who has not joined.' },
    { action_id: 'store', person: 'may', text: 'We have a shelf to lend.' },
  ];

  it('lists each participant with what they said on this desired state, in order', () => {
    expect(takingPart(goal, comments, { may: 'May' })).toEqual([
      { id: 'may', name: 'May', comments: ['I can run the counter on Saturdays.', 'We have a shelf to lend.'] },
      { id: 'lester', name: null, comments: [] },
    ]);
  });

  it('is empty when nobody has joined', () => {
    expect(takingPart({ id: 'store', participants: null }, comments, {})).toEqual([]);
  });
});

describe('challenges', () => {
  const action = overrides => ({
    id: 'a', organization_id: 'ps', description: null, expected_state: null, policy: null,
    created_by: 'stefan', participants: [], status: 'external_proposal', created_at: '2026-10-11T00:00:00Z', ...overrides,
  });

  it('tells a challenge from a desired state and an option', () => {
    const challenge = action({ description: 'Coconuts are being stolen' });
    const goal = action({ expected_state: 'Less theft' });
    const oldGoal = action({ description: 'Coconuts are being stolen', expected_state: 'Less theft' });
    const option = action({ description: 'Theft at night', expected_state: 'Less theft', policy: 'Take turns watching' });
    expect([challenge, goal, oldGoal, option].map(isChallenge)).toEqual([true, false, false, false]);
    expect([challenge, goal, oldGoal, option].map(isGoal)).toEqual([false, true, true, false]);
  });

  it('shows votes, whether I voted, and the collaborations proposed for each, most votes first', () => {
    const theft = action({ id: 'theft', description: 'Coconuts are being stolen', participants: ['may', 'lester'] });
    const buyers = action({ id: 'buyers', description: 'Copra buyers are unreliable', created_at: '2026-10-12T00:00:00Z' });
    const watch = action({ id: 'watch', title: 'Neighbors report strangers', description: 'Coconuts are being stolen', created_by: 'may', assigned_to: 'may', participants: ['lester'] });
    const summaries = challengeSummaries({
      challenges: [buyers, theft], goals: [watch], userId: 'may', names: { stefan: 'Stefan', may: 'May' },
      collaborations: [{ goal_id: 'watch', challenge_id: 'theft' }, { goal_id: 'deleted', challenge_id: 'theft' }],
    });

    expect(summaries.map(c => c.id)).toEqual(['theft', 'buyers']);
    expect(summaries[0]).toMatchObject({
      text: 'Coconuts are being stolen', owner: 'stefan', owner_name: 'Stefan', votes: 2, voted_by_me: true,
      voters: [{ id: 'may', name: 'May' }, { id: 'lester', name: null }],
      collaborations: [{ id: 'watch', title: 'Neighbors report strangers', created_by_name: 'May', participants: ['lester'] }],
    });
    expect(summaries[1]).toMatchObject({ votes: 0, voted_by_me: false, collaborations: [] });
  });

  it('takes the assignee as the owner, and whoever added it when there is none', () => {
    const [assigned, unassigned] = challengeSummaries({
      challenges: [
        action({ id: 'a', description: 'One', assigned_to: 'may', created_by: 'stefan', participants: ['x'] }),
        action({ id: 'b', description: 'Two', assigned_to: null, created_by: 'stefan' }),
      ],
      goals: [], collaborations: [], userId: 'may', names: { may: 'May', stefan: 'Stefan' },
    });
    expect(assigned).toMatchObject({ owner: 'may', owner_name: 'May', votes: 1 });
    expect(unassigned).toMatchObject({ owner: 'stefan', owner_name: 'Stefan' });
  });
});

describe('addressedChallenges', () => {
  const challenges = [{ id: 'sell', description: 'No place to sell our goods' }, { id: 'theft', description: 'Coconuts are being stolen' }];
  const links = [
    { goal_id: 'store', challenge_id: 'sell', person: 'stefan' },
    { goal_id: 'store', challenge_id: 'closed', person: 'may' },
    { goal_id: 'watch', challenge_id: 'theft', person: 'may' },
  ];

  it('lists the open challenges a desired state is linked to, with who linked each', () => {
    expect(addressedChallenges('store', links, challenges))
      .toEqual([{ id: 'sell', text: 'No place to sell our goods', linked_by: 'stefan' }]);
    expect(addressedChallenges('ponds', links, challenges)).toEqual([]);
  });
});

describe('proposed collaborations', () => {
  const action = overrides => ({ id: 'a', title: '', description: null, expected_state: null, policy: null, ...overrides });

  it('are told by their collaboration record, since their fields read as a situation', () => {
    const proposal = action({ id: 'watch', title: 'Share a night watch', description: 'Coconuts are being stolen' });
    const situation = action({ id: 'theft', title: 'Coconuts are being stolen', description: 'Coconuts are being stolen' });
    const marked = new Set(['watch']);
    expect([isProposal(proposal, marked), isSituation(proposal, marked)]).toEqual([true, false]);
    expect([isProposal(situation, marked), isSituation(situation, marked)]).toEqual([false, true]);
  });

  it('still recognises one saved the old way, by its desired state', () => {
    expect(isProposal(action({ title: 'Less theft', expected_state: 'Less theft' }), new Set())).toBe(true);
  });

  it('reads the text from the title, or from the desired state of an older one with a shortened title', () => {
    const long = 'Compensate people for the time and expense when reporting theft since it benefits the community';
    expect(proposalText(action({ title: long }))).toBe(long);
    expect(proposalText(action({ title: `${long.slice(0, 77)}...`, expected_state: long }))).toBe(long);
    expect(proposalText(action({ title: 'Less theft', expected_state: 'Less theft' }))).toBe('Less theft');
    // A desired state written later on the action is not the proposal's text.
    expect(proposalText(action({ title: long, expected_state: 'Reports are paid within a week' }))).toBe(long);
  });
});
