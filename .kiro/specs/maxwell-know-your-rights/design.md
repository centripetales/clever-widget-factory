# Design: Maxwell "Know Your Rights" Skill

## 1. Architecture Overview

The Know Your Rights skill is a **prompt mode addition** to the existing Maxwell architecture. It follows the identical pattern used by storage and quantitative modes: keyword regex detection → prompt file loading → instruction block prepended to user message.

```
User Message
    │
    ▼
detectPromptMode(message)        ← NEW: RIGHTS_KEYWORDS regex checked here
    │
    ├─ RIGHTS_KEYWORDS match  → RIGHTS_PROMPT (loaded from rights.txt)
    ├─ STORAGE_KEYWORDS match → STORAGE_PROMPT
    ├─ QUANTITATIVE_KEYWORDS  → QUANTITATIVE_PROMPT
    └─ default                → GENERAL_PROMPT
    │
    ▼
buildInstructionPrefix()
    │
    ▼
"[Instructions: ${TONE_PROMPT}\n\n${RIGHTS_PROMPT}]\n\n" + context + message
    │
    ▼
Bedrock Agent (CNV04Q1OAZ)
    │
    ├─ Uses GetEntityObservations (with dateFrom/dateTo) for evidence
    ├─ Uses UnifiedSearch for cross-entity context
    └─ Returns markdown with ![photo](url) for evidence images
    │
    ▼
Response streamed to client → Rich copy via copyConversationRich()
```

**No new infrastructure required:**
- No new Lambda functions
- No new API endpoints
- No new database tables
- No new Bedrock Agent action groups
- No new frontend components

The three sub-modes (proactive, evaluative, report) are handled **within the prompt itself** — the LLM distinguishes intent from the user's message content. A single `rights.txt` prompt file covers all three modes with explicit instructions for each.

## 2. Prompt Mode Detection

### Priority Order

Rights detection is inserted **before** storage and quantitative in the detection chain. This is because rights-related queries could incidentally contain quantitative words (e.g., "how much time did SSS make me wait") but should be routed to the rights mode.

```javascript
// New constant loaded at cold start
const RIGHTS_PROMPT = loadPrompt('rights.txt');

// New regex — checks BEFORE storage and quantitative
const RIGHTS_KEYWORDS = /\b(rights?|file|report|complain(t|ts)?|violat(e|ed|ion|ions)|charter|consumer|accountability|escalat(e|ion)|who do i report|arta|dti|npc|dole|ntc|due process|red tape|anti.?red.?tape|citizen.?s?.?charter|refund|return policy|labor (code|law|rights)|tenant.?s?.?rights?|landlord)\b/i;
```

### Updated `detectPromptMode` Function

```javascript
function detectPromptMode(message) {
  if (RIGHTS_PROMPT && RIGHTS_KEYWORDS.test(message)) return RIGHTS_PROMPT;
  if (STORAGE_PROMPT && STORAGE_KEYWORDS.test(message)) return STORAGE_PROMPT;
  if (QUANTITATIVE_PROMPT && QUANTITATIVE_KEYWORDS.test(message)) return QUANTITATIVE_PROMPT;
  return GENERAL_PROMPT;
}
```

### Sub-Mode Detection (Within the Prompt)

The three sub-modes are **not** detected by separate regexes. Instead, the prompt instructs the LLM to determine the mode from context:

| Sub-Mode | Detection Signal (by LLM) | Trigger Examples |
|----------|--------------------------|------------------|
| **Proactive** | User asks about rights in a hypothetical/upcoming situation, OR no entity context is available | "What are my rights at SSS?", "What should I expect from Lazada returns?" |
| **Evaluative** | User asks for assessment of a past experience; entity observations exist | "Were my rights violated?", "Did they follow proper procedure?" |
| **Report** | User explicitly requests a report or document for filing | "Generate a report", "Help me file against SSS", "I want to report this" |

This keeps the implementation simple (one regex, one prompt file) while giving the LLM clear instructions to adapt its response format.

## 3. Prompt File Content

File: `lambda/ws-maxwell-worker/prompts/sonnet46/rights.txt`

```
The user is asking about their rights in relation to a counterparty (government agency, seller, employer, service provider, landlord, telco, platform, etc.).

Determine which mode applies based on the user's message and available context:

---

MODE 1: PROACTIVE (Rights Awareness)
Trigger: The user asks what their rights are in a situation, OR asks what to expect. No assessment of a past event is requested.

Use this response format:

**Your Rights: [Situation]**

**Applicable Framework**
- Name the specific law, regulation, charter, or policy that applies (e.g., "Anti-Red Tape Act (RA 11032)", "DTI Consumer Act (RA 7394)", "Lazada Return & Refund Policy")
- Jurisdiction: Philippines unless user specifies otherwise

**What You're Entitled To**
- Each specific right or standard, with concrete details (processing times, fees, required documents)
- Use bullet points, bold the key obligation

**If They Don't Comply**
- Escalation path: which oversight body, how to file, contact details if known
- Timeline: how long they have to respond to a complaint

**Practical Tips**
- What to document (photos, names, timestamps) in case you need to escalate later

---

MODE 2: EVALUATIVE (Were My Rights Violated?)
Trigger: The user asks Maxwell to assess whether their rights were violated based on their experience. Entity observations are typically available.

First, call GetEntityObservations to retrieve the user's logged experience. If the user mentions a date range, use dateFrom/dateTo parameters.

Use this response format:

**Rights Assessment: [Entity/Counterparty]**

**Applicable Standard**
- The specific law/charter/policy and what it requires

**What Happened (from your observations)**
- Chronological summary drawn from observations, citing dates and details
- Include photos inline: ![description](url)

**Assessment**
For each relevant standard:
- ✅ **[Standard]**: Met — [brief explanation]
- ❌ **[Standard]**: Violated — [what the standard requires vs. what happened]

**Conclusion**
- Clear factual statement: "Based on [N] documented interactions, [X] of [Y] applicable standards were not met."
- If no violations found: "Your experience appears compliant with [framework]. Here's why: [explanation]"

**If You Want to Escalate**
- Which oversight body has jurisdiction
- Whether the evidence is sufficient (photos, timestamps, documented interactions)
- What additional documentation would strengthen a case

---

MODE 3: REPORT (Rights Violation Report Generation)
Trigger: The user explicitly asks for a report, wants to file a complaint, or says "generate a report", "help me file", "I want to report this".

First, call GetEntityObservations to retrieve ALL observations (with photos). Use dateFrom/dateTo if the user specifies a period. If no entity context exists, ask the user which entity contains their evidence.

Use this response format:

# Rights Violation Report

**Filed Against:** [Counterparty name and branch/location if known]
**Complainant:** [From organization context — do not ask unless unavailable]
**Date of Report:** [Today's date]
**Period Covered:** [Date range of observations]

## Applicable Rights & Standards

[List each applicable law, regulation, charter commitment, or policy with its specific relevant provisions. Cite section numbers where possible.]

## Timeline of Events

[Chronological account drawn from observations. Each entry:]

**[Date] — [Summary]**
[Details from observation text]

![Photo description](photo_url)
*[Caption explaining what the photo shows as evidence]*

[Repeat for each relevant observation]

## Violations Identified

| # | Standard/Provision | Requirement | What Happened | Evidence |
|---|---|---|---|---|
| 1 | [e.g., RA 11032 §9] | [What it requires] | [What actually happened] | [Date, photo ref] |

## Complainant's Statement

[Include any additional context the user provided in their prompt that isn't in the observations. Label clearly: "Complainant states: ..."]

## Supporting Evidence Summary

- **Documented observations:** [count] entries with timestamps
- **Photo evidence:** [count] photos
- **Period documented:** [first date] to [last date]

## Recommended Filing

**Oversight Body:** [e.g., ARTA, DTI, NPC, DOLE, NTC, or relevant court]
**How to File:**
- Online: [portal URL if known]
- Email: [address if known]
- In person: [office location if known]
**Expected Response Time:** [statutory timeframe if applicable]

---

IMPORTANT RULES FOR ALL MODES:
- Default jurisdiction: Philippines. Adapt if the user mentions another country.
- Use the LLM's training knowledge for laws, charters, and policies. Do NOT claim you need to look up a database — you know Philippine consumer protection law, ARTA, labor code, etc.
- When referencing observations, always use data from GetEntityObservations. Never fabricate observation content.
- Display ALL photos from observations inline as ![description](url) — these are critical evidence.
- When no observations are available and the user is in evaluative/report mode, inform them: "I don't see any logged observations for this entity. Would you like me to explain your rights (proactive mode), or can you point me to the entity where you logged your experience?"
- In report mode, distinguish between documented evidence (observations with timestamps/photos) and user-stated claims (verbal context provided in the prompt). Label user-stated claims as "Complainant states:" in the report.
- Be factual and precise. State what the standard requires vs. what happened. Do NOT render legal judgments (e.g., don't say "they are liable"). State facts and let the oversight body adjudicate.
- When the user provides supplemental context in their message (e.g., "I spent 4 hours", "they made me come back 3 times"), incorporate it in the report under "Complainant's Statement" — clearly marked as unverified user-reported context.
```

## 4. Data Flow

### Proactive Mode (No Observations Needed)

```
User: "What are my rights at SSS?"
    │
    ▼
RIGHTS_KEYWORDS matches "rights"
    │
    ▼
buildInstructionPrefix → prepends rights.txt prompt
    │
    ▼
Bedrock Agent receives:
  "[Instructions: {tone}\n\n{rights prompt}]\n\n[Today's date: 2026-06-30] What are my rights at SSS?"
    │
    ▼
Agent responds from LLM knowledge (Philippine SSS Citizens' Charter, RA 11032)
  — NO tool calls needed
    │
    ▼
Response streamed to client
```

### Evaluative Mode (Observations Retrieved)

```
User: "Were my rights violated at SSS today?"
(with entity context: entityId="sss-sapian", entityType="action", entityName="SSS Visit")
    │
    ▼
RIGHTS_KEYWORDS matches "rights" and "violated"
    │
    ▼
buildInstructionPrefix → prepends rights.txt prompt
    │
    ▼
Enhanced message includes [Context: You are discussing action "SSS Visit" (ID: sss-sapian)]
    │
    ▼
Bedrock Agent:
  1. Calls GetEntityObservations(entityId="sss-sapian", entityType="action")
  2. Receives observations: [{text, photos: [{photo_url, photo_description, transcription}], metrics, created_at}]
  3. LLM compares observations against SSS Citizens' Charter standards
    │
    ▼
Response includes:
  - Chronological summary citing observation dates
  - Photos inline: ![Long queue at SSS window 3](https://cdn.../photo.jpg)
  - ✅/❌ assessment per standard
    │
    ▼
Response streamed to client
```

### Report Mode (Full Evidence Compilation)

```
User: "Generate a rights violation report against SSS. I spent 4 hours and they made me come back twice."
(with entity context available)
    │
    ▼
RIGHTS_KEYWORDS matches "report"
    │
    ▼
buildInstructionPrefix → prepends rights.txt prompt
    │
    ▼
Bedrock Agent:
  1. Calls GetEntityObservations(entityId=..., entityType=...) — retrieves ALL observations
  2. Observations include photos: [{photo_url, photo_description, transcription}]
  3. LLM structures the formal report per the template
  4. Incorporates user's supplemental context ("4 hours", "come back twice") under Complainant's Statement
    │
    ▼
Response is a structured markdown report:
  - # Rights Violation Report
  - Photos as ![caption](url) — inline evidence
  - Violations table
  - Filing instructions (ARTA online portal, etc.)
    │
    ▼
Response streamed to client
```

### Photo Data Flow Detail

```
GetEntityObservations response:
{
  observations: [
    {
      id: "obs-123",
      text: "Waited 2.5 hours, only 1 window open",
      photos: [
        {
          photo_url: "https://d2xyz.cloudfront.net/orgs/xxx/photos/abc.jpg",
          photo_description: "Single service window with 40+ people in queue",
          transcription: null
        }
      ],
      created_at: "2026-06-28T09:15:00Z"
    }
  ]
}
    │
    ▼
Maxwell renders in response:
"**2026-06-28 — Long wait at SSS Sapian**
Waited 2.5 hours with only 1 window open despite 40+ people in queue.

![Single service window with 40+ people in queue](https://d2xyz.cloudfront.net/orgs/xxx/photos/abc.jpg)
*Photo evidence: Only one service window was operational during peak hours.*"
```

## 5. Rich Copy Behavior

**No changes needed.** The existing `copyConversationRich()` infrastructure handles everything:

### Flow When User Clicks "Copy Conversation"

```
Maxwell response (markdown with images)
    │
    ▼
copyConversationRich(messages)
    │
    ├─ conversationToHtml(messages)
    │   └─ Converts ![alt](url) → <img src="url" alt="alt" style="..." />
    │   └─ Converts **bold** → <strong>bold</strong>
    │   └─ Converts headers, lists, etc. to HTML
    │
    ├─ Writes to clipboard as ClipboardItem:
    │   ├─ text/html: Full HTML with <img> tags (renders in Gmail, Google Docs, ChatGPT)
    │   └─ text/plain: Raw markdown with ![alt](url) links preserved
    │
    ▼
User pastes into:
  - Gmail/Google Docs → Images render inline ✓
  - Web forms (ARTA portal) → Plain text with URLs ✓
  - ChatGPT → Images render inline ✓
```

### Why This Works for Rights Violation Reports

1. **Photos as evidence**: The report contains `![caption](photo_url)` which becomes `<img>` in rich paste — recipient sees the evidence inline
2. **CloudFront URLs**: Photos use full CloudFront URLs (not signed/expiring), so they remain accessible to the recipient
3. **Structured format**: Headers, tables, and bold formatting all survive the HTML conversion
4. **Plain text fallback**: If pasting into a plain-text form, the URLs are still present as clickable links

## 6. Implementation Scope

### Files to Create

| File | Purpose |
|------|---------|
| `lambda/ws-maxwell-worker/prompts/sonnet46/rights.txt` | Rights mode prompt (content in Section 3) |
| `lambda/maxwell-chat/prompts/sonnet46/rights.txt` | Same file, copied for REST-based Maxwell |

### Files to Modify

| File | Change |
|------|--------|
| `lambda/ws-maxwell-worker/index.js` | Add `RIGHTS_PROMPT` loading, `RIGHTS_KEYWORDS` regex, update `detectPromptMode()` |
| `lambda/maxwell-chat/index.js` | Same changes as ws-maxwell-worker |

### Exact Code Changes

#### `lambda/ws-maxwell-worker/index.js`

**Add after existing prompt loading (line ~30):**
```javascript
const RIGHTS_PROMPT = loadPrompt('rights.txt');
```

**Add after existing keyword regexes (line ~35):**
```javascript
const RIGHTS_KEYWORDS = /\b(rights?|file|report|complain(t|ts)?|violat(e|ed|ion|ions)|charter|consumer|accountability|escalat(e|ion)|who do i report|arta|dti|npc|dole|ntc|due process|red tape|anti.?red.?tape|citizen.?s?.?charter|refund|return policy|labor (code|law|rights)|tenant.?s?.?rights?|landlord)\b/i;
```

**Update `detectPromptMode` function:**
```javascript
function detectPromptMode(message) {
  if (RIGHTS_PROMPT && RIGHTS_KEYWORDS.test(message)) return RIGHTS_PROMPT;
  if (STORAGE_PROMPT && STORAGE_KEYWORDS.test(message)) return STORAGE_PROMPT;
  if (QUANTITATIVE_PROMPT && QUANTITATIVE_KEYWORDS.test(message)) return QUANTITATIVE_PROMPT;
  return GENERAL_PROMPT;
}
```

#### `lambda/maxwell-chat/index.js`

Identical changes to the three items above.

### Deployment

After implementation, deploy both Lambdas using the fast deployment script:

```bash
./scripts/deploy/deploy-lambda-fast.sh ws-maxwell-worker ws-maxwell-worker
./scripts/deploy/deploy-lambda-fast.sh maxwell-chat maxwell-chat-lambda
```

Note: Since this only adds a `.txt` file and modifies `index.js` (no new npm dependencies), fast deployment is sufficient.

## 7. Example Interactions

### Example 1: Proactive Mode

**User prompt:** "What are my rights when transacting at SSS?"

**Detected by:** `rights` matches `RIGHTS_KEYWORDS`

**Expected Maxwell response:**

> **Your Rights: SSS Transactions**
>
> **Applicable Framework**
> - Anti-Red Tape Act (RA 11032) — all government frontline services
> - SSS Citizens' Charter — specific processing time commitments
>
> **What You're Entitled To**
> - **Processing time**: Simple transactions (ID validation, contribution inquiry) must be completed within **3 working days**. Complex transactions within **7 working days**.
> - **Single-window service**: You should NOT be required to visit multiple offices for a single transaction
> - **No fixing**: No employee may demand payment beyond official fees
> - **Posted fees and timelines**: The Citizens' Charter must be visibly displayed
> - **First-come-first-served**: Unless a priority lane system is posted
>
> **If They Don't Comply**
> - **File with ARTA**: [arta.gov.ph](https://arta.gov.ph) → Report a Concern
> - **Contact Center ng Bayan**: Call 8888 (landline) or text 0908-881-6565
> - **Response time**: ARTA must act within 7 working days of receiving complaint
>
> **Practical Tips**
> - Photo the Citizens' Charter display (or its absence)
> - Note the time you arrive and the time you're served
> - Get the name of the attending employee (check their ID or desk nameplate)
> - Keep all queue numbers and receipts

### Example 2: Evaluative Mode

**User prompt:** "Were my rights violated at SSS today? Look at my observations."

**Context:** Entity "SSS Sapian Visit" is selected in Maxwell panel

**Detected by:** `rights` and `violated` match `RIGHTS_KEYWORDS`

**Expected Maxwell response:**

> **Rights Assessment: SSS Sapian Visit**
>
> **Applicable Standard**
> - Anti-Red Tape Act (RA 11032): Simple transactions ≤ 3 working days; no unnecessary requirements
> - SSS Citizens' Charter: Contribution payment processing ≤ 20 minutes
>
> **What Happened (from your observations)**
>
> **2026-06-28, 9:15 AM** — Arrived at SSS Sapian. Only 1 window operational despite 40+ people in queue.
>
> ![Single window with long queue](https://d2xyz.cloudfront.net/photos/abc.jpg)
>
> **2026-06-28, 11:45 AM** — Finally served after 2.5 hours. Told payment system is offline, asked to "come back tomorrow."
>
> ![System offline notice](https://d2xyz.cloudfront.net/photos/def.jpg)
>
> **Assessment**
> - ❌ **Processing time (≤ 20 min for contributions)**: Violated — 2.5-hour wait, then transaction not completed
> - ❌ **No unnecessary return visits**: Violated — told to return the next day due to system issue (their system, not your obligation)
> - ❌ **Adequate service capacity**: Violated — only 1 window open during peak hours for 40+ clients
> - ✅ **Posted Citizens' Charter**: Met — charter was displayed (visible in photo)
>
> **Conclusion**
> Based on 2 documented observations with photo evidence, 3 of 4 applicable standards were not met. The 2.5-hour wait alone exceeds the Citizens' Charter commitment by 7.5x.
>
> **If You Want to Escalate**
> Your evidence is strong — timestamped observations with photos. You can file with ARTA via arta.gov.ph. Would you like me to generate a formal Rights Violation Report?

### Example 3: Report Mode

**User prompt:** "Generate a report against SSS Sapian. I spent 4 hours total across 2 visits and they still haven't processed my contribution payment."

**Context:** Entity "SSS Sapian Visit" is selected

**Detected by:** `report` matches `RIGHTS_KEYWORDS`

**Expected Maxwell response:**

> # Rights Violation Report
>
> **Filed Against:** Social Security System (SSS) — Sapian, Capiz Branch
> **Complainant:** [Organization member name from context]
> **Date of Report:** 2026-06-30
> **Period Covered:** 2026-06-28 to 2026-06-29
>
> ## Applicable Rights & Standards
>
> 1. **Republic Act 11032** (Anti-Red Tape Act of 2018)
>    - §9: Processing time for simple transactions shall not exceed 3 working days
>    - §7: No unnecessary requirements or steps shall be imposed
>    - §10: Government offices must maintain adequate staffing for frontline services
>
> 2. **SSS Citizens' Charter**
>    - Contribution payment processing: ≤ 20 minutes
>    - System availability: Service windows must be operational during posted hours
>
> ## Timeline of Events
>
> **2026-06-28, 9:15 AM — First Visit**
> Arrived at SSS Sapian. Only 1 service window operational with 40+ people ahead in queue.
>
> ![Single service window with 40+ people in queue](https://d2xyz.cloudfront.net/photos/abc.jpg)
> *Photo evidence: Inadequate service capacity — one window for 40+ clients*
>
> **2026-06-28, 11:45 AM — Service Denied**
> After 2.5 hours of waiting, informed that the payment system is offline. Instructed to return the next day.
>
> ![System offline notice on counter](https://d2xyz.cloudfront.net/photos/def.jpg)
> *Photo evidence: System offline notice; transaction could not be completed*
>
> **2026-06-29, 8:30 AM — Second Visit**
> Returned as instructed. Queue already at 25+ people.
>
> ![Morning queue at SSS](https://d2xyz.cloudfront.net/photos/ghi.jpg)
> *Photo evidence: Significant queue on return visit*
>
> ## Violations Identified
>
> | # | Standard/Provision | Requirement | What Happened | Evidence |
> |---|---|---|---|---|
> | 1 | RA 11032 §9 | Simple transaction ≤ 3 working days | Transaction incomplete after 2 visits across 2 days | Observations 2026-06-28, 2026-06-29 |
> | 2 | SSS Charter | Processing ≤ 20 minutes | 2.5-hour wait, then denied service | Photo: queue + offline notice |
> | 3 | RA 11032 §10 | Adequate staffing | 1 window for 40+ clients | Photo: single operational window |
> | 4 | RA 11032 §7 | No unnecessary steps | Required to make a second visit due to their system failure | Observation 2026-06-28 |
>
> ## Complainant's Statement
>
> Complainant states: "I spent 4 hours total across 2 visits and they still haven't processed my contribution payment."
>
> *Note: Total time expenditure (4 hours) is self-reported by complainant across both documented visits.*
>
> ## Supporting Evidence Summary
>
> - **Documented observations:** 3 entries with timestamps
> - **Photo evidence:** 3 photos
> - **Period documented:** 2026-06-28 to 2026-06-29
>
> ## Recommended Filing
>
> **Oversight Body:** Anti-Red Tape Authority (ARTA)
> **How to File:**
> - Online: https://arta.gov.ph — "Report a Concern" → select SSS
> - Hotline: Contact Center ng Bayan — call 8888 or text 0908-881-6565
> - Email: complaints@arta.gov.ph
> **Expected Response Time:** ARTA must act within 7 working days (RA 11032 §21)
>
> ---
> *This report was generated from documented observations with photo evidence. Copy and paste into the ARTA online portal or email to complaints@arta.gov.ph.*

### Example 4: Ambiguous Intent (Defaults to Proactive)

**User prompt:** "Lazada consumer protection"

**Detected by:** `consumer` matches `RIGHTS_KEYWORDS`

**Expected Maxwell response:**

Maxwell responds in proactive mode (explaining rights under DTI consumer protection for e-commerce), then asks: "Would you like me to evaluate a specific Lazada experience, or generate a report if your rights were violated?"

### Example 5: Report Mode with Date Filtering

**User prompt:** "Generate a report about my Lazada dispute from last week"

**Detected by:** `report` matches `RIGHTS_KEYWORDS`

**Expected behavior:** Bedrock Agent calls `GetEntityObservations` with `dateFrom` set to 7 days ago. The report covers only observations from that period.

## 8. Edge Cases & Fallback Behavior

| Scenario | Behavior |
|----------|----------|
| Rights keywords match but user is asking about storage ("Where do I file my reports?") | `RIGHTS_KEYWORDS` takes priority. However, "file" in the context of "where do I file my reports" would trigger rights mode. The word "file" is intentionally in the regex because filing complaints is core to the skill. If the user is genuinely asking about physical file storage, the LLM should recognize from context and respond appropriately — the tone/general prompts instruct Maxwell to follow what the question actually needs. |
| No entity context and user asks for evaluation | Prompt instructs Maxwell to inform the user: "I don't see any logged observations. Would you like me to explain your rights, or can you point me to the entity where you logged your experience?" |
| User asks about non-Philippine jurisdiction | Prompt defaults to Philippine law but adapts if user specifies another country (e.g., "What are my consumer rights in the US?") |
| Keyword "refund" triggers rights mode for a simple financial question | The regex priority (rights before quantitative) means "How much is my SSS refund?" would route to rights mode. This is acceptable because refund inquiries typically are rights-related. If it becomes problematic, the regex can be narrowed. |

## 9. Testing Plan

### Manual Testing (Post-Deploy)

1. **Proactive mode**: Send "What are my rights at SSS?" — verify structured rights response without tool calls
2. **Evaluative mode**: Open an entity with observations, send "Were my rights violated?" — verify GetEntityObservations is called and assessment is returned
3. **Report mode**: Same entity, send "Generate a rights violation report" — verify full report format with photos
4. **Fallback to general**: Send "What's the weather?" — verify rights mode is NOT triggered
5. **Rich copy**: Copy a report with photos, paste into Gmail — verify images render inline
6. **Date filtering**: "Generate a report from last week" — verify date parameters passed to GetEntityObservations

### Keyword Regression

Verify these do NOT trigger rights mode:
- "Store the file cabinet in the shed" → should trigger storage (or general)
- "How much did we spend this month?" → should trigger quantitative (or general)

Verify these DO trigger rights mode:
- "What are my rights?"
- "File a complaint"
- "Generate a report against SSS"
- "Was my consumer protection violated?"
- "ARTA red tape"
