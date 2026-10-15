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
  rewardTerms,
  readReward,
  rewardTally,
  offerTally,
  awaitingReading,
  sharedObservations,
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

describe('offered rewards', () => {
  const reward = { id: 'r1', action_id: 'photos', php: 5, cap_php_per_person: 500, closed_at: null };
  const acceptances = [
    { reward_id: 'r1', person: 'may', accepted_at: '2026-10-12T08:00:00Z' },
    { reward_id: 'r1', person: 'lester', accepted_at: '2026-10-12T09:00:00Z' },
    { reward_id: 'other', person: 'chem', accepted_at: '2026-10-12T09:00:00Z' },
  ];
  const obs = (person, at, overrides = {}) =>
    ({ action_id: 'photos', person, created_at: `2026-10-12T${at}:00Z`, text: 'Where we get water', has_photo: true, ...overrides });

  it('says what is paid, who sees it and how it may be used', () => {
    const terms = rewardTerms({ php: 5, cap_php_per_person: 500, payer_name: 'Stargazer Farm' });
    expect(terms).toContain('Stargazer Farm pays ₱5 for each photo you share here with a description, up to ₱500 per person.');
    expect(terms).toContain('Only you and Stargazer Farm can see what you share.');
    expect(terms).toContain('research and for activities that benefit the group, such as grant proposals');
    expect(terms).toContain('Everyone can see how many each person has shared.');
    expect(rewardTerms({ php: 20, cap_php_per_person: null, payer_name: 'X' })).not.toContain('up to');
  });

  it('counts each person\'s observations with a photo and their own words, made after they accepted', () => {
    const tally = rewardTally(reward, acceptances, [
      obs('may', '08:30'), obs('may', '10:00'),
      obs('may', '07:00'), // before she accepted
      obs('may', '11:00', { has_photo: false }), // the "Joined" note, or any text-only observation
      obs('may', '11:30', { text: '  ' }), // a photo with nothing written
      obs('may', '12:00', { action_id: 'elsewhere' }),
      obs('lester', '09:30'),
      obs('stefan', '09:30'), // never accepted
    ], { may: 'Mae' });
    expect(tally).toEqual([
      { id: 'may', name: 'Mae', count: 2, php: 10 },
      { id: 'lester', name: null, count: 1, php: 5 },
    ]);
  });

  it('stops at the cap per person, and stops counting when the reward closes', () => {
    const many = Array.from({ length: 120 }, () => obs('may', '10:00'));
    expect(rewardTally(reward, acceptances, many, {})[0]).toMatchObject({ id: 'may', count: 120, php: 500 });

    const closed = { ...reward, closed_at: '2026-10-12T09:45:00Z' };
    expect(rewardTally(closed, acceptances, [obs('may', '08:30'), obs('may', '10:00')], {})[0]).toMatchObject({ count: 1, php: 5 });
  });

  it('lists people who accepted but have not shared anything yet', () => {
    expect(rewardTally(reward, acceptances, [], {})).toEqual([
      { id: 'lester', name: null, count: 0, php: 0 },
      { id: 'may', name: null, count: 0, php: 0 },
    ]);
  });
});

describe('offerTally', () => {
  const offer = { id: 'o1', action_id: 'a1', php: 5, cap_php_per_person: 12, closed_at: null };
  const agreements = [{ person: 'may', agreed_at: '2026-10-12T00:00:00Z' }, { person: 'lester', agreed_at: '2026-10-12T00:00:00Z' }];
  const read = (counts, php) => ({ shows: 'x', offers: [{ offer_id: 'o1', counts, php, feedback: 'f' }] });
  const obs = (person, created_at, reading) => ({ action_id: 'a1', person, created_at, reading });

  it('sums what the readings say counted; one not read yet earns nothing so far', () => {
    const tally = offerTally(offer, agreements, [
      obs('may', '2026-10-12T01:00:00Z', read(true, 5)),
      obs('may', '2026-10-12T02:00:00Z', read(false, 0)),
      obs('may', '2026-10-12T03:00:00Z', null),
      obs('may', '2026-10-11T03:00:00Z', read(true, 5)), // before agreeing
    ], { may: 'May' });
    expect(tally).toEqual([{ id: 'may', name: 'May', count: 1, php: 5 }]);
  });

  it('stops at the cap and leaves out people with nothing counted', () => {
    const many = [1, 2, 3, 4].map(h => obs('may', `2026-10-12T0${h}:00:00Z`, read(true, 5)));
    expect(offerTally(offer, agreements, many, {})).toEqual([{ id: 'may', name: null, count: 4, php: 12 }]);
  });

  it('tells a person how many of theirs are waiting for a reading, and how many have waited too long', () => {
    const observations = [
      obs('may', '2026-10-12T05:55:00Z', null), obs('may', '2026-10-12T03:00:00Z', null),
      obs('may', '2026-10-12T04:00:00Z', read(true, 5)), obs('lester', '2026-10-12T05:58:00Z', null),
    ];
    expect(awaitingReading(offer, agreements, observations, 'may', new Date('2026-10-12T06:00:00Z'))).toEqual({ waiting: 1, unread: 1 });
    expect(awaitingReading(offer, agreements, observations, 'nobody', new Date('2026-10-12T06:00:00Z'))).toEqual({ waiting: 0, unread: 0 });
  });

  it('counts an observation changed after its reading as waiting again, and leaves out a comment left when joining', () => {
    const now = new Date('2026-10-12T06:00:00Z');
    const changed = { ...obs('may', '2026-10-12T01:00:00Z', read(true, 5)), read_at: '2026-10-12T01:01:00Z', updated_at: '2026-10-12T05:58:00Z' };
    const joined = { ...obs('may', '2026-10-12T05:59:00Z', null), queued: false };
    expect(awaitingReading(offer, agreements, [changed, joined], 'may', now)).toEqual({ waiting: 1, unread: 0 });
  });

  it('gives a person their own rows for an offer, and its owner everyone\'s', () => {
    const now = new Date('2026-10-12T06:00:00Z');
    const mine = { ...obs('may', '2026-10-12T01:00:00Z', { shows: 'x', offers: [{ offer_id: 'o1', counts: true, php: 5, was_php: 3, feedback: 'f' }] }), id: 's1', text: 'Compost pit', photos: [{ url: 'p.jpg', description: 'The pit' }] };
    const theirs = { ...obs('lester', '2026-10-12T05:58:00Z', null), id: 's2', text: 'Mulch' };
    const owned = { ...offer, owner: 'stefan' };
    expect(sharedObservations(owned, [mine, theirs], 'may', { may: 'May' }, now)).toEqual([{
      id: 's1', person: 'may', name: 'May', mine: true, text: 'Compost pit', photos: [{ url: 'p.jpg', description: 'The pit' }],
      created_at: '2026-10-12T01:00:00Z', reading: 'read', php: 5, was_php: 3, feedback: 'f',
    }]);
    const all = sharedObservations(owned, [mine, theirs], 'stefan', {}, now);
    expect(all.map(o => [o.id, o.mine, o.reading, o.php])).toEqual([['s2', false, 'waiting', null], ['s1', false, 'read', 5]]);
  });
});

describe('readReward', () => {
  it('reads an offer with an evaluator and limits', () => {
    const r = readReward({ evaluator: { kind: 'prompt', prompt: ' Practices ' }, max_php_per_observation: 20, max_php_per_person: 400, budget_php: 5000 });
    expect([r.prompt, r.php, r.cap_php_per_person, r.budget_php]).toEqual(['Practices', 20, 400, 5000]);
  });

  it('reads one made before those existed, and one that pays for any photo with a description', () => {
    expect(readReward({ condition: 'Practices', php: 5, cap_php_per_person: 500 }).prompt).toBe('Practices');
    const fixed = readReward({ condition: null, php: 5, cap_php_per_person: 500 });
    expect([fixed.prompt, fixed.php, fixed.cap_php_per_person, fixed.budget_php]).toEqual([null, 5, 500, null]);
  });
});
