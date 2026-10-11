// Positive Sum as a conversation: the person talks with their own AI
// (Gemini, Claude, ChatGPT) using a prompt we build here, then pastes the JSON
// it returns back into the app. Pure functions — no API calls.

export interface ConversationOpportunity {
  kind: 'goal' | 'option';
  title: string;
  initial_state: string | null;
  policy: string | null;
  desired_state: string | null;
  created_by_name?: string | null;
}

// A desired state is kept exactly as the person said it — no "now" or other
// structure — so we can learn what they actually want to say. The initial
// state is recorded later, on the action, when a real deal happens.
export interface ConversationResult {
  desiredStates: string[];
  humanCapital: string[];
  challenges: string[]; // what the person is running into, in their words
}

function describeOpportunity(o: ConversationOpportunity): string {
  const who = o.created_by_name ? ` (${o.created_by_name})` : '';
  if (o.kind === 'goal') {
    return `- Desired state${who}: "${o.desired_state ?? ''}"`;
  }
  return `- Option${who}: ${o.title}. How: ${o.policy ?? ''}. Done when: ${o.desired_state ?? ''}`;
}

// Background so the AI can answer questions. Principles from the "Farmer
// association" doc, until the org's policies hold this text.
const BACKGROUND = `Our principles:
- Make Experience Impactful
- Surface High-Value Actions
- Take Responsibility for Outcomes
- Raise the Standard of Professional Practice — we hold ourselves and those we work with to a higher standard of professional practice, conduct, and accountability.
- Embrace Experimentation, Collaboration, and Refinement — we are taking on a hard problem: how to collaborate for mutual success. We use technologies now available to us to explore forms of collaboration that were previously impossible.
- Value Diversity — we value diversity in people, perspectives, approaches, and experience. Diversity creates strength, resilience, and the possibility of discovering what none of us could see alone.

Who the network supports:
- The purpose of this experiment is to support those who support others. If the network supported people who take more than they contribute, it would weaken and people would stop participating.
- Over time the network learns when a person isn't contributing and offers them ways to contribute.
- People who harm the community are excluded.`;

// Hiligaynon greeting for the hour the prompt is copied.
function maayong(hour: number): string {
  if (hour < 12) return 'Maayong aga';
  if (hour < 18) return 'Maayong hapon';
  return 'Maayong gab-i';
}

export function buildConversationPrompt({ orgName, date, hour, opportunities }: {
  orgName: string;
  date: string;
  hour: number;
  opportunities: ConversationOpportunity[];
}): string {
  const options = opportunities.length
    ? opportunities.map(describeOpportunity).join('\n')
    : '- Nothing is open today.';
  return `You are helping me take part in ${orgName}, part of the Positive Sum network. Today is ${date}.

Ask ONE question at a time and keep your messages short — I may be on a phone or using voice.

1. Open with exactly: "Hello, or should I say ${maayong(hour)}?" Then use whichever language I answer in for the rest of our conversation. In that language, explain the idea in a few short, friendly sentences and invite my questions. Say something close to this:

"Our community is full of people with useful skills and things: rice hull, an idle thresher, corn sold at low prices while someone else buys chicken feed. But we usually don't know who has what, who needs what, or what we could achieve together, so needs go unmet.

Positive Sum is an experiment to fix that. We share capabilities and what we'd like to be different. The network looks for ways to meet people's needs and tracks who is building goodwill. If you create value for someone here, the network will look for ways to create value for you, leaving everyone better off.

Do you have any questions before we start?"

Answer my questions directly and honestly, using this background (don't recite it unless I ask):
${BACKGROUND}

2. Then learn about me. There are only three things: what I can do, situations around me, and my desired states.

What I can do. Ask: "What do people usually come to you for help with?"
  If the answer is vague, ask one follow-up: "What did you do, and how did it turn out?"
  Don't ask about tools, machines, land or other things I own; those are added and shared in the app, not here.

Situations. Ask: "What's happening around here that we could handle better together?"
  A situation is how things are, not what to do about it, and it doesn't need a solution: let me state a problem and leave it there. If I describe a fix, write the fix under my desired states and ask what the situation behind it is.

My desired states. Say: "Most of us would like to earn more, spend less, or have things a bit easier." Then ask, one at a time:
  a) "What would you like to be different, for you or for people around here?"
  b) "Is there anything you'd pay for or trade for, if someone here offered it?"

Keep going until I say I'm done. Let me say several things at once; don't make me go one by one.

3. Then tell me which of these open opportunities in ${orgName} could fit me:
${options}

Rules:
- Write down what I say in my own words. Fix spelling only. Don't add labels or framing.
- If I list several separate things, write each as its own item.
- Don't rephrase things back to me, and don't ask me to approve your wording. Only ask a question if you truly can't tell what I mean.
- Don't invent anything I didn't say. Don't add words that make things sound bigger or smaller.
- You can't see the app or my records. If I ask you to look something up, say so.
- Don't include phone numbers or other people's personal details.
- At the end, show me one list in my words, with three headings: "What you can do", "Situations around you" and "What you'd like to be different". Ask: "Anything missing or wrong?" Change only what I point to.
- The JSON has exactly the items of that list: one entry for each item, in the same words. Don't merge, split, reword or drop any.

When I confirm, reply with ONLY this JSON in one code block (leave out anything I didn't mention):
\`\`\`json
{
  "version": 2,
  "situations": ["how things are, in my words, with no solution attached"],
  "desired_states": ["something I'd like to be different, in my words"],
  "capabilities": [
    { "kind": "human_capital", "narrative": "something I can do, in my words" }
  ]
}
\`\`\`
Then tell me to copy it back into the Positive Sum page.`;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Pulls the conversation's JSON out of whatever was pasted (a fenced code
 * block, or JSON with prose around it) and keeps only well-formed items.
 */
export function parseConversationResult(pasted: string): ConversationResult | { error: string } {
  const fenced = pasted.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : pasted.slice(pasted.indexOf('{'), pasted.lastIndexOf('}') + 1);
  if (!candidate.trim()) return { error: 'No JSON found. Copy the whole block your AI gave you.' };

  let data: unknown;
  try {
    data = JSON.parse(candidate);
  } catch {
    return { error: "That doesn't look like complete JSON. Copy the whole block your AI gave you." };
  }
  if (!data || typeof data !== 'object') return { error: 'Unexpected format.' };
  const obj = data as { desired_states?: unknown; capabilities?: unknown; situations?: unknown; challenges?: unknown };

  // Version 2 is a list of strings; version 1 objects ({ now, would_like })
  // still parse, keeping only what the person would like.
  const desiredStates = (Array.isArray(obj.desired_states) ? obj.desired_states : [])
    .map(d => text(typeof d === 'string' ? d : (d as { would_like?: unknown })?.would_like))
    .filter(Boolean);

  const capabilities = Array.isArray(obj.capabilities) ? obj.capabilities : [];
  const humanCapital = capabilities
    .filter(c => (c as { kind?: unknown })?.kind === 'human_capital')
    .map(c => text((c as { narrative?: unknown }).narrative))
    .filter(Boolean);
  // Situations were first called challenges; results from that prompt still parse.
  const situations = obj.situations ?? obj.challenges;
  const challenges = (Array.isArray(situations) ? situations : []).map(text).filter(Boolean);
  if (!desiredStates.length && !humanCapital.length && !challenges.length) {
    return { error: 'Nothing to save was found in that JSON.' };
  }
  return { desiredStates, humanCapital, challenges };
}
