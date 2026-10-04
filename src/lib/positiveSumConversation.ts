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

export interface ConversationDesiredState {
  now: string;
  would_like: string;
}

export interface ConversationResult {
  desiredStates: ConversationDesiredState[];
  humanCapital: string[];
}

function describeOpportunity(o: ConversationOpportunity): string {
  const who = o.created_by_name ? ` (${o.created_by_name})` : '';
  if (o.kind === 'goal') {
    return `- Someone would like this to be different${who}: now "${o.initial_state ?? ''}" → would like "${o.desired_state ?? ''}"`;
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

2. Then learn about me, one question at a time:
- My capabilities. Ask these two questions, in this order:
  a) "What do people usually come to you for help with?"
  b) "What's something you've done or made that turned out well — something you're proud of?"
  If an answer is general, ask one follow-up: what did I do, and how did it turn out?
- What I would like to be different. Say: "Most of us would like to earn more, spend less, or have things a bit easier." Then ask, one at a time:
  a) "Do you see an opportunity — something that could work here if the right people or things came together?"
  b) "What's costing you money, time or peace of mind right now?"
  For each answer, work out with me how things are now and how I'd like them to be, and check it with me.

3. Then tell me which of these open opportunities in ${orgName} could fit me:
${options}

Rules:
- Don't invent anything I didn't say. Keep my own words where you can, or restate them briefly and densely without adding judgement.
- Don't add words that make things sound bigger or smaller than I said (e.g. "frequently", "impossible").
- You can't see the app or my records. If I ask you to look something up, say so.
- Don't include phone numbers or other people's personal details.
- Before finishing, show me a short summary and ask me to confirm it.

When I confirm, reply with ONLY this JSON in one code block (leave out anything I didn't mention):
\`\`\`json
{
  "version": 1,
  "desired_states": [{ "now": "how things are now", "would_like": "how I'd like them to be" }],
  "capabilities": [
    { "kind": "human_capital", "narrative": "a skill or experience, in my words" }
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
  const obj = data as { desired_states?: unknown; capabilities?: unknown };

  const desiredStates = (Array.isArray(obj.desired_states) ? obj.desired_states : [])
    .map(d => ({ now: text((d as ConversationDesiredState)?.now), would_like: text((d as ConversationDesiredState)?.would_like) }))
    .filter(d => d.now && d.would_like);

  const capabilities = Array.isArray(obj.capabilities) ? obj.capabilities : [];
  const humanCapital = capabilities
    .filter(c => (c as { kind?: unknown })?.kind === 'human_capital')
    .map(c => text((c as { narrative?: unknown }).narrative))
    .filter(Boolean);
  if (!desiredStates.length && !humanCapital.length) {
    return { error: 'Nothing to save was found in that JSON.' };
  }
  return { desiredStates, humanCapital };
}
