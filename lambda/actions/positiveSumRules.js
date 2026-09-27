// Positive Sum — pure rules (no database access), shared by the routes in
// positiveSum.js and unit-tested in positiveSum.test.js.
//
// Vocabulary: goal (recipient's initial + desired state) → option (suggested
// by implementors) → approval (recipient) → action → experience.
// Goals, policies and options are all `actions` rows; bookkeeping records
// (option context, approvals, passes, daily lists) are JSON states whose
// state_text starts with STATE_PREFIX so the observations list can hide them.

const STATE_PREFIX = '{"type":"positive_sum.';

const STATE_TYPES = {
  OPTION_CONTEXT: 'positive_sum.option_context',
  APPROVAL: 'positive_sum.approval',
  PASS: 'positive_sum.pass',
  OPPORTUNITY_LIST: 'positive_sum.opportunity_list',
};

// Goals, policies and options not yet chosen stay out of normal action lists,
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
// from someone else's policy (the resource owner hasn't agreed to this case).
function needsImplementorApproval(option) {
  return !implementorIds(option).includes(String(option.created_by));
}

// Association default: auto-approve when the person has a completed,
// evidenced experience with any similar option. Pilot similarity: the past
// option shares a required tool or was built from the same policy.
// past: [{ required_tools, policy_ids, completed, photo_count }]
function qualifiesForAutoApproval(option, optionPolicyIds, past) {
  const tools = new Set(option.required_tools || []);
  const policies = new Set(optionPolicyIds || []);
  return past.some(p =>
    p.completed && p.photo_count > 0 && (
      (p.required_tools || []).some(t => tools.has(t)) ||
      (p.policy_ids || []).some(id => policies.has(id))
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
  hasFreeCapacity,
  valueForOthers,
  sortByValue,
  needsImplementorApproval,
  qualifiesForAutoApproval,
  isApproved,
  dayKey,
};
