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

export interface ConversationAsset {
  name: string;
  narrative: string;
}

export interface ConversationResult {
  desiredStates: ConversationDesiredState[];
  humanCapital: string[];
  assets: ConversationAsset[];
}

// From the "Farmer association" doc (Mission, Vision & Principles), until the
// org's policies hold this text.
const MISSION = `Mission: To make collaboration easier and more valuable for farmers.

Vision: Communities where collaboration is transparent, investment is grounded in demonstrated value, and people can benefit from the value they create for others.

Principles:
- Make Experience Impactful
- Surface High-Value Actions
- Take Responsibility for Outcomes
- Raise the Standard of Professional Practice — we hold ourselves and those we work with to a higher standard of professional practice, conduct, and accountability.
- Embrace Experimentation, Collaboration, and Refinement — we are taking on a hard problem: how to collaborate for mutual success. We use technologies now available to us to explore forms of collaboration that were previously impossible.
- Value Diversity — we value diversity in people, perspectives, approaches, and experience. Diversity creates strength, resilience, and the possibility of discovering what none of us could see alone.`;

const EXPECTATIONS = `What's asked of members:
- Be honest about what you have and what you can do. Describing a capability is not a promise to do anything.
- Say plainly what you would like to be different.
- When you do take part in something, follow through, and document what happened (a short note or photo) — that is how trust is built.
- Nobody is paid per transaction; help comes back from the network over time.`;

function describeOpportunity(o: ConversationOpportunity): string {
  const who = o.created_by_name ? ` (${o.created_by_name})` : '';
  if (o.kind === 'goal') {
    return `- Someone would like this to be different${who}: now "${o.initial_state ?? ''}" → would like "${o.desired_state ?? ''}"`;
  }
  return `- Option${who}: ${o.title}. How: ${o.policy ?? ''}. Done when: ${o.desired_state ?? ''}`;
}

export function buildConversationPrompt({ orgName, date, opportunities }: {
  orgName: string;
  date: string;
  opportunities: ConversationOpportunity[];
}): string {
  const options = opportunities.length
    ? opportunities.map(describeOpportunity).join('\n')
    : '- Nothing is open today.';
  return `You are helping me take part in ${orgName}, part of the Positive Sum network. Today is ${date}.

Talk with me in whatever language I use. Ask ONE question at a time and keep your messages short — I may be on a phone or using voice.

1. First, explain our mission, vision and principles in a few friendly sentences and invite my questions:
${MISSION}

${EXPECTATIONS}

2. Then learn about me, one question at a time:
- My capabilities, in two forms:
  a) Human capital — skills and experience (e.g. "I've grafted mango for 5 years").
  b) Assets I have and want to track (e.g. a carabao, a truck, a fruit picker) — what each is and its condition.
- What I would like to be different: how things are now, and how I'd like them to be. Help me say both clearly.

3. Then tell me which of these open opportunities in ${orgName} could fit me:
${options}

Rules:
- Don't invent anything I didn't say. Keep my own words where you can, or restate them briefly and densely without adding judgement.
- Don't include phone numbers or other people's personal details.
- Before finishing, show me a short summary and ask me to confirm it.

When I confirm, reply with ONLY this JSON in one code block (leave out anything I didn't mention):
\`\`\`json
{
  "version": 1,
  "desired_states": [{ "now": "how things are now", "would_like": "how I'd like them to be" }],
  "capabilities": [
    { "kind": "human_capital", "narrative": "a skill or experience, in my words" },
    { "kind": "asset", "name": "short name", "narrative": "what it is and its condition, in my words" }
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
  const assets = capabilities
    .filter(c => (c as { kind?: unknown })?.kind === 'asset')
    .map(c => {
      const narrative = text((c as { narrative?: unknown }).narrative);
      const name = text((c as { name?: unknown }).name) || narrative.split(/[,.]/)[0].slice(0, 60);
      return { name, narrative };
    })
    .filter(a => a.name);

  if (!desiredStates.length && !humanCapital.length && !assets.length) {
    return { error: 'Nothing to save was found in that JSON.' };
  }
  return { desiredStates, humanCapital, assets };
}
