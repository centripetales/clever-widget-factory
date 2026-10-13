// Positive Sum — pure rules (no database access), shared by the routes in
// positiveSum.js and unit-tested in positiveSum.test.js.
//
// Vocabulary: goal (recipient's initial + desired state) → option (suggested
// by implementors) → approval (recipient) → action → experience.
// Desired states (goals) and options are `actions` rows; bookkeeping records
// (option context, approvals, passes, daily lists) are JSON states whose
// state_text starts with STATE_PREFIX so the observations list can hide them.

const STATE_PREFIX = '{"type":"positive_sum.';

const STATE_TYPES = {
  OPTION_CONTEXT: 'positive_sum.option_context',
  APPROVAL: 'positive_sum.approval',
  PASS: 'positive_sum.pass',
  OPPORTUNITY_LIST: 'positive_sum.opportunity_list',
  // The person saved a conversation: they have given their own input, so they
  // now see what other people said about where we could improve.
  // A reward someone attached to an action: what they pay, to whom, on what
  // conditions. An action can carry several, from different parties.
  REWARD: 'positive_sum.reward',
  // A person accepted a reward's terms: from then on their observations on
  // the action can earn it, and its owner may see them.
  REWARD_ACCEPTANCE: 'positive_sum.reward_acceptance',
  // A collaboration (desired state) proposed for a challenge.
  COLLABORATION: 'positive_sum.collaboration',
  // The transaction an action was made from, and the other organization in it.
  TRANSACTION_CONTEXT: 'positive_sum.transaction_context',
  // What someone entered as the opportunity cost of each party's time in an action's rewards.
  OPPORTUNITY_COSTS: 'positive_sum.opportunity_costs',
  // A person agreed that what they share through Positive Sum goes to the offers it fits.
  SHARING_AGREEMENT: 'positive_sum.sharing_agreement',
};

// Open desired states and options not yet chosen stay out of normal action lists,
// which only show not_started / in_progress / blocked.
const OPEN_STATUS = 'external_proposal';

const DAILY_LIST_SIZE = 5;

// `type` must be the first key so the state_text starts with STATE_PREFIX.
function stateText(type, payload) {
  return JSON.stringify({ type, ...payload });
}

function parseState(text) {
  if (typeof text !== 'string' || !text.startsWith(STATE_PREFIX)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// A desired state says how someone would like things to be; an option also
// says how. A challenge is only how things are: something a person is
// running into, with nothing proposed yet.
function isGoal(a) {
  return !!(a.expected_state && a.expected_state.trim()) && !(a.policy && a.policy.trim());
}

function isChallenge(a) {
  return !!(a.description && a.description.trim()) && !(a.expected_state && a.expected_state.trim()) &&
    !(a.policy && a.policy.trim());
}

// The open challenges of an org as people see them: votes (people who joined
// it), whether the viewer voted, and the collaborations proposed for each.
// Most votes first, then newest.
// A proposed collaboration is an action whose title says what to do and whose
// existing state (description) is the situation it answers, copied when it was
// proposed. It is marked by a collaboration record — linked to a situation, or
// not yet — because by its fields alone it would read as a situation. Ones
// saved before that kept their text as the desired state.
const isProposal = (a, proposalIds) => proposalIds.has(a.id) || isGoal(a);
const isSituation = (a, proposalIds) => isChallenge(a) && !proposalIds.has(a.id);

// What a proposal says: its title. Older ones hold the full text as the
// desired state under a title cut short from it.
function proposalText(a) {
  const old = (a.expected_state || '').trim();
  const title = (a.title || '').trim();
  const cutShort = title.endsWith('...') && old.startsWith(title.slice(0, -3));
  return old && (title === old || cutShort) ? old : title;
}

// A proposal can be joined until it is done. It leaves "open proposal" for
// "not started" when the first person joins, which puts it in action lists.
const JOINABLE_STATUSES = [OPEN_STATUS, 'not_started', 'in_progress', 'blocked'];

// A challenge's owner is its assignee (whoever added it, for ones added before
// challenges had an assignee). Only the owner edits or deletes it.
const challengeOwner = c => String(c.assigned_to || c.created_by);

function challengeSummaries({ challenges, goals, collaborations, names, userId }) {
  const voters = c => (c.participants || []).map(String);
  return challenges
    .map(c => ({
      id: c.id,
      organization_id: c.organization_id,
      text: c.description,
      owner: challengeOwner(c),
      owner_name: names[challengeOwner(c)] || null,
      created_at: c.created_at,
      votes: voters(c).length,
      voted_by_me: voters(c).includes(String(userId)),
      // Who voted: besides the org's people, they are who it can be assigned to.
      voters: voters(c).map(id => ({ id, name: names[id] || null })),
      collaborations: collaborations
        .filter(link => link.challenge_id === c.id)
        .map(link => goals.find(g => g.id === link.goal_id))
        .filter(Boolean)
        .map(g => ({
          id: g.id, title: proposalText(g), status: g.status,
          created_by: String(g.created_by), created_by_name: names[String(g.created_by)] || null,
          participants: (g.participants || []).map(String), // who joined
        })),
    }))
    .sort((a, b) => b.votes - a.votes || new Date(b.created_at) - new Date(a.created_at));
}

// The open challenges a desired state is linked to as a collaboration, with
// who made each link (so they can undo it).
function addressedChallenges(goalId, collaborations, challenges) {
  return collaborations
    .filter(link => link.goal_id === goalId)
    .map(link => ({ link, challenge: challenges.find(c => c.id === link.challenge_id) }))
    .filter(({ challenge }) => challenge)
    .map(({ link, challenge }) => ({ id: challenge.id, text: challenge.description, linked_by: link.person }));
}

// A reward record as the rest of the code reads it. One that is read by AI
// holds an evaluator (only the `prompt` kind exists: the payer's own words)
// and hard limits; `php` and `cap_php_per_person` are then the most for one
// observation and per person. Ones made before the evaluator existed hold the
// prompt as `condition`. One with no prompt pays for any photo with a description.
function readReward(data) {
  const prompt = data.evaluator?.kind === 'prompt' ? data.evaluator.prompt : data.condition;
  return {
    ...data,
    php: Number(data.max_php_per_observation ?? data.php) || 0,
    cap_php_per_person: Number(data.max_php_per_person ?? data.cap_php_per_person) || null,
    budget_php: Number(data.budget_php) || null,
    prompt: typeof prompt === 'string' && prompt.trim() ? prompt.trim() : null,
  };
}

// What a reward's owner tells a person before they accept it: what is paid,
// who sees what they share, and how it may be used. General on purpose.
function rewardTerms({ php, cap_php_per_person: cap, payer_name: payer, condition }) {
  // An offer that says what it is looking for: sharing through Positive Sum is
  // the agreement, once for every such offer.
  if (condition) {
    return [
      'What you share through Positive Sum goes to every offer it fits, and each offer pays its own price.',
      'An AI reads each observation against what the offers ask for. You see its reading, and whoever pays has the final say.',
      'Those who pay may use what you share for research and for activities that benefit the group, such as grant proposals, including with partners outside the Philippines.',
      'Everyone can see how many each person has shared and what it earned.',
    ].join(' ');
  }
  return [
    `${payer} pays ₱${php} for each photo you share here with a description${cap ? `, up to ₱${cap} per person` : ''}.`,
    `Only you and ${payer} can see what you share.`,
    `${payer} may use it for research and for activities that benefit the group, such as grant proposals, including with partners outside the Philippines.`,
    'Everyone can see how many each person has shared.',
  ].join(' ');
}

// What each person who accepted a reward has earned on its action. Nothing is
// stored: it is counted from their observations there that have a photo and
// their own words, made after they accepted and before the reward closed,
// times the amount, up to the cap. `observations` are those on the action.
function rewardTally(reward, acceptances, observations, names) {
  const closed = reward.closed_at ? new Date(reward.closed_at) : null;
  return acceptances
    .filter(a => a.reward_id === reward.id)
    .map(a => {
      const count = observations.filter(o =>
        o.action_id === reward.action_id && String(o.person) === a.person && o.has_photo && (o.text || '').trim() &&
        new Date(o.created_at) >= new Date(a.accepted_at) && (!closed || new Date(o.created_at) <= closed)
      ).length;
      const php = count * reward.php;
      return {
        id: a.person, name: names[a.person] || null, count,
        php: reward.cap_php_per_person ? Math.min(php, reward.cap_php_per_person) : php,
      };
    })
    .sort((a, b) => b.count - a.count || (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id));
}

// A person's observations that an offer can pay for: on its action, made after
// they agreed to share and before the offer closed.
function eligibleObservations(reward, agreement, observations) {
  const closed = reward.closed_at ? new Date(reward.closed_at) : null;
  return observations.filter(o =>
    o.action_id === reward.action_id && String(o.person) === agreement.person &&
    new Date(o.created_at) >= new Date(agreement.agreed_at) && (!closed || new Date(o.created_at) <= closed));
}

// The tally of an offer that is read by AI. Each observation on its action has
// a reading (see lambda/rsp-worker/offers.js) that says what it earned. One not
// read yet earns nothing so far: an amount is never shown and then taken back.
// `observations`: [{ action_id, person, created_at, reading }]
function offerTally(reward, agreements, observations, names) {
  return agreements
    .map(a => {
      const earned = eligibleObservations(reward, a, observations).map(o => {
        const entry = (o.reading?.offers || []).find(e => e.offer_id === reward.id);
        return entry?.counts ? Number(entry.php) || 0 : null;
      }).filter(php => php !== null);
      const php = earned.reduce((sum, n) => sum + n, 0);
      return {
        id: a.person, name: names[a.person] || null, count: earned.length,
        php: reward.cap_php_per_person ? Math.min(php, reward.cap_php_per_person) : php,
      };
    })
    .filter(person => person.count > 0)
    .sort((a, b) => b.count - a.count || (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id));
}

// How many of a person's observations for an offer are still waiting for their
// reading. `waiting`: made in the last ten minutes, so it is on its way.
// `unread`: older than that, so something went wrong and it needs another look.
function awaitingReading(reward, agreements, observations, userId, now = new Date()) {
  const agreement = agreements.find(a => a.person === String(userId));
  const pending = agreement ? eligibleObservations(reward, agreement, observations).filter(o => !o.reading) : [];
  const recent = pending.filter(o => now - new Date(o.created_at) < 10 * 60 * 1000).length;
  return { waiting: recent, unread: pending.length - recent };
}

// What the reading said to a person about their latest observation for an offer.
function latestReading(reward, observations, userId) {
  const read = observations
    .filter(o => String(o.person) === String(userId) && o.reading)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(o => ({ shows: o.reading.shows || '', entry: (o.reading.offers || []).find(e => e.offer_id === reward.id) }))
    .find(r => r.entry);
  return read ? { shows: read.shows, counts: !!read.entry.counts, php: Number(read.entry.php) || 0, feedback: read.entry.feedback || '' } : null;
}

// Who is taking part in a desired state, each with what they said about their
// ideas and how they want to be involved (their observations on it, oldest first).
function takingPart(goal, comments, names) {
  return (goal.participants || []).map(String).map(id => ({
    id,
    name: names[id] || null,
    comments: comments.filter(c => c.action_id === goal.id && String(c.person) === id).map(c => c.text),
  }));
}

// Implementors = the assignee (lead) plus participants.
function implementorIds(action) {
  const ids = [action.assigned_to, ...(action.participants || [])].filter(Boolean).map(String);
  return [...new Set(ids)];
}

function hasFreeCapacity(action, capacity) {
  return implementorIds(action).length < (capacity || 1);
}

// Impact on others (pilot definition): the number of recipient approvals, by
// someone other than the person, of options where the person is an implementor.
// approvals: [{ approver, option_id, basis }]; implementorsByOption: { option_id: [ids] }
function valueForOthers(personId, approvals, implementorsByOption) {
  return approvals.filter(a =>
    a.basis === 'recipient' &&
    a.approver !== personId &&
    (implementorsByOption[a.option_id] || []).includes(personId)
  ).length;
}

// Suggestions for a goal, highest value-for-others first (ties: oldest first,
// so nobody is bumped by a later suggestion from someone with equal value).
function sortByValue(options, valueOf) {
  return [...options].sort((a, b) =>
    (valueOf(b) - valueOf(a)) ||
    (new Date(a.created_at) - new Date(b.created_at))
  );
}

// An option needs the implementors' own approval when a recipient built it
// from someone else's open option (the owner hasn't agreed to this case).
function needsImplementorApproval(option) {
  return !implementorIds(option).includes(String(option.created_by));
}

// Association default: auto-approve when the person has a completed,
// evidenced experience with any similar option. Pilot similarity: the past
// option shares a required tool or was built from the same open option.
// past: [{ required_tools, source_option_ids, completed, photo_count }]
function qualifiesForAutoApproval(option, sourceOptionIds, past) {
  const tools = new Set(option.required_tools || []);
  const sources = new Set(sourceOptionIds || []);
  return past.some(p =>
    p.completed && p.photo_count > 0 && (
      (p.required_tools || []).some(t => tools.has(t)) ||
      (p.source_option_ids || []).some(id => sources.has(id))
    )
  );
}

// An option becomes an action (not_started) once a recipient has approved and
// the implementors have agreed — by suggesting it themselves, each approving
// it, or through the association default.
function isApproved(option, approvals) {
  const hasRecipient = approvals.some(a => a.basis === 'recipient');
  if (!hasRecipient) return false;
  if (!needsImplementorApproval(option)) return true;
  if (approvals.some(a => a.basis === 'association_default')) return true;
  const agreed = new Set(approvals.filter(a => a.basis === 'implementor').map(a => String(a.approver)));
  return implementorIds(option).every(id => agreed.has(id));
}

// "Once a day" follows the farm's calendar day.
function dayKey(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

module.exports = {
  STATE_PREFIX,
  STATE_TYPES,
  OPEN_STATUS,
  DAILY_LIST_SIZE,
  stateText,
  parseState,
  implementorIds,
  isGoal,
  isChallenge,
  isProposal,
  isSituation,
  proposalText,
  JOINABLE_STATUSES,
  challengeOwner,
  challengeSummaries,
  addressedChallenges,
  rewardTerms,
  readReward,
  rewardTally,
  offerTally,
  awaitingReading,
  latestReading,
  takingPart,
  hasFreeCapacity,
  valueForOthers,
  sortByValue,
  needsImplementorApproval,
  qualifiesForAutoApproval,
  isApproved,
  dayKey,
};
