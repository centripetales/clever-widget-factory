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
  // A collaboration (desired state) proposed for a challenge.
  COLLABORATION: 'positive_sum.collaboration',
  // The transaction an action was made from, and the other organization in it.
  TRANSACTION_CONTEXT: 'positive_sum.transaction_context',
  // What someone entered as the opportunity cost of each party's time in an action's rewards.
  OPPORTUNITY_COSTS: 'positive_sum.opportunity_costs',
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
  takingPart,
  hasFreeCapacity,
  valueForOthers,
  sortByValue,
  needsImplementorApproval,
  qualifiesForAutoApproval,
  isApproved,
  dayKey,
};
