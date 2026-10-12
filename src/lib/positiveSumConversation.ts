// Positive Sum as a conversation: the person talks with their own AI
// (Gemini, Claude, ChatGPT) using a prompt we build here, then pastes the JSON
// it returns back into the app. Pure functions — no API calls.
//
// The conversation is for getting to know the person: a typical day, what
// people come to them for, and where they think we could improve. It asks for
// their own view first: what other people said is not read out, and the page
// shows it only once the person has saved a conversation. It does not create
// proposed collaborations.

// Everything is kept as the person said it.
export interface ConversationResult {
  typicalDay: string;
  humanCapital: string[]; // what people come to them for
  situations: string[]; // where they think we could improve
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

export function buildConversationPrompt({ orgName, date, hour }: {
  orgName: string;
  date: string;
  hour: number;
}): string {
  return `You are helping me take part in ${orgName}, part of the Positive Sum network. Today is ${date}.

Ask ONE question at a time and keep your messages short — I may be on a phone or using voice.

1. Open with exactly: "Hello, or should I say ${maayong(hour)}?" Then use whichever language I answer in for the rest of our conversation. In that language, explain the idea in a few short, friendly sentences and invite my questions. Say something close to this:

"Our community is full of people with useful skills and things: rice hull, an idle thresher, corn sold at low prices while someone else buys chicken feed. But we usually don't know who has what, who needs what, or what we could achieve together, so needs go unmet.

Positive Sum is an experiment to fix that. If you create value for someone here, the network will look for ways to create value for you, leaving everyone better off.

I'd like to get to know you a little. Every question is optional: answer only what you're comfortable with, and skip the rest. What you share is used to help set up win-win interactions between people here.

Do you have any questions before we start?"

Answer my questions directly and honestly, using this background (don't recite it unless I ask):
${BACKGROUND}

2. Then get to know me. Ask these one at a time. If I'd rather not answer one, move on without pressing.
  a) "What does a typical day look like for you?"
  b) "What do people usually come to you for help with?"
  For either, if my answer is vague, ask one follow-up: "Can you tell me a bit more about that?"
  Don't ask about tools, machines, land or other things I own; those are added and shared in the app, not here.

3. Then ask: "What makes things harder than they need to be around here?"
  I'm describing how things are, not what to do about it, and it doesn't need a solution: let me state a problem and leave it there. If I describe a fix, ask what is behind it and write that.
  Don't suggest examples or tell me what other people have said; this is my own view.

Keep going until I say I'm done. Let me say several things at once; don't make me go one by one.

Rules:
- Write down what I say in my own words. Fix spelling only. Don't add labels or framing.
- If I list several separate things, write each as its own item.
- Don't rephrase things back to me, and don't ask me to approve your wording. Only ask a question if you truly can't tell what I mean.
- Don't invent anything I didn't say. Don't add words that make things sound bigger or smaller.
- You can't see the app or my records. If I ask you to look something up, say so.
- Don't include phone numbers or other people's personal details.
- At the end, show me one list in my words, with three headings: "A typical day", "What people come to you for" and "Where we could improve". Ask: "Anything missing or wrong?" Change only what I point to.
- The JSON has exactly the items of that list: one entry for each item, in the same words. Don't merge, split, reword or drop any.

When I confirm, reply with ONLY this JSON in one code block (leave out anything I didn't mention):
\`\`\`json
{
  "version": 3,
  "typical_day": "my typical day, in my words",
  "capabilities": [
    { "kind": "human_capital", "narrative": "something people come to me for, in my words" }
  ],
  "situations": ["where we could improve, in my words, with no solution attached"]
}
\`\`\`
Then tell me to copy it back into the Positive Sum page.`;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const texts = (v: unknown): string[] => (Array.isArray(v) ? v : []).map(text).filter(Boolean);

/**
 * Pulls the conversation's JSON out of whatever was pasted (a fenced code
 * block, or JSON with prose around it) and keeps only well-formed items.
 * Results from earlier prompts still parse; what they said people would like
 * to be different is left out, since the conversation no longer adds proposals.
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
  const obj = data as { typical_day?: unknown; capabilities?: unknown; situations?: unknown; challenges?: unknown };

  const humanCapital = (Array.isArray(obj.capabilities) ? obj.capabilities : [])
    .filter(c => (c as { kind?: unknown })?.kind === 'human_capital')
    .map(c => text((c as { narrative?: unknown }).narrative))
    .filter(Boolean);
  const result: ConversationResult = {
    typicalDay: text(obj.typical_day),
    humanCapital,
    // Situations were first called challenges.
    situations: texts(obj.situations ?? obj.challenges),
  };
  if (!result.typicalDay && !humanCapital.length && !result.situations.length) {
    return { error: 'Nothing to save was found in that JSON.' };
  }
  return result;
}
