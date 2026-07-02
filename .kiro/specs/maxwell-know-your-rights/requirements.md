# Requirements Document

## Introduction

The "Know Your Rights" Maxwell skill empowers users to understand their rights in any situation where another party has obligations to them — whether a government agency, e-commerce platform, telco, employer, landlord, or financial institution. The skill operates in three modes depending on user intent: proactive (what are my rights?), evaluative (were my rights violated?), and action (generate a Rights Violation Report with evidence). It leverages the LLM's knowledge of laws, regulations, consumer protection standards, and platform policies, and connects to the user's logged observations when building evidence-based cases.

## Glossary

- **Rights Context**: The situation-specific set of laws, regulations, standards, contracts, or policies that define what a user is entitled to from a counterparty
- **Counterparty**: Any entity with obligations to the user — government agency, seller, employer, service provider, landlord, platform, etc.
- **Observation**: A recorded state (text + optional photos + optional metrics) linked to an entity in CWF, representing a logged interaction or event
- **Rights Violation Report**: A structured, factual document presenting evidence that the user's rights were violated, intended for submission to the appropriate oversight body for adjudication
- **Oversight Body**: The entity with authority to adjudicate or enforce — e.g., ARTA for red tape, DTI for consumer issues, NPC for data privacy, DOLE for labor, NTC for telcos, courts for civil matters
- **Maxwell Skill**: A prompt-driven capability within Maxwell that is triggered by user intent detection and shapes the response format

## Requirements

### Requirement 1: Proactive Rights Awareness

**User Story:** As a user about to engage with a counterparty (government agency, seller, service provider, etc.), I want to ask Maxwell what my rights are in that situation, so that I know what to expect and can identify violations as they happen.

**Acceptance Criteria:**

1. WHEN a user asks about their rights in a given situation (e.g., "What are my rights at SSS?", "What should I expect when disputing a Lazada order?", "What does my landlord owe me?"), THE System SHALL detect the rights-awareness intent
2. THE System SHALL respond with the relevant legal/regulatory/contractual framework that applies to the user's situation
3. THE System SHALL include practical details: processing time commitments, required documents, applicable fees, escalation paths
4. THE System SHALL NOT require the user to have logged observations — this mode works from situation description alone
5. THE System SHALL identify the jurisdiction and applicable laws (Philippine law by default given the user base, but adaptable if the user specifies otherwise)

### Requirement 2: Evaluative Mode — Were My Rights Violated?

**User Story:** As a user who has interacted with a counterparty and logged observations, I want Maxwell to evaluate whether my rights were violated based on my recorded experience, so that I can make an informed decision about whether to escalate.

**Acceptance Criteria:**

1. WHEN a user asks Maxwell to evaluate their experience (e.g., "Were my rights violated at SSS today?", "Did Lazada follow the return policy?", "Look at my SSS interactions and tell me if there's a case"), THE System SHALL detect the evaluative intent
2. THE System SHALL pull observations from the referenced entity using the existing `GetEntityObservations` tool
3. THE System SHALL compare the observed experience against the applicable rights framework (laws, charter, platform policy)
4. THE System SHALL clearly state which specific rights or standards were violated, and which were met
5. THE System SHALL present its assessment factually — stating what the standard requires vs. what happened — without rendering a legal judgment
6. WHEN no violations are identified, THE System SHALL inform the user and explain why the experience appears compliant

### Requirement 3: Rights Violation Report Generation

**User Story:** As a user whose rights were violated, I want Maxwell to generate a Rights Violation Report from my observations and photos, so that I can submit it to the appropriate oversight body for adjudication.

**Acceptance Criteria:**

1. WHEN a user requests a Rights Violation Report (e.g., "Generate a report against SSS", "Help me file about my Lazada dispute", "I want to report this"), THE System SHALL detect the report-generation intent
2. THE System SHALL pull observations (with photos) from the referenced entity, applying date filters if the user specifies a time range
3. THE report SHALL include: counterparty identified, applicable rights/standards, specific violations with evidence, chronological timeline from observations, photo evidence as links with captions, the appropriate oversight body and filing method
4. THE report SHALL format photos as markdown links so they render in the Maxwell panel and survive rich copy: `![caption](photo_url)`
5. THE report SHALL be structured so the user can copy-paste it (via existing rich copy) into an email, web form, or ChatGPT for final modification
6. THE System SHALL clearly label which oversight body the report should be directed to and how to submit it (online portal URL, email address, physical office if applicable)

### Requirement 4: Skill Detection & Prompt Routing

**User Story:** As the system, I need to detect when a user's message relates to rights awareness, evaluation, or report generation, so that Maxwell applies the correct prompt mode and response format.

**Acceptance Criteria:**

1. THE System SHALL detect rights-related intent via keyword patterns (e.g., "rights", "file", "report", "complain", "violated", "charter", "consumer", "accountability", "escalate", "who do I report to")
2. WHEN rights-related intent is detected, THE System SHALL prepend a prompt instruction block that guides Maxwell to respond in the appropriate mode (proactive, evaluative, or report)
3. THE System SHALL determine the mode from context: proactive when no observations are referenced, evaluative when the user asks for assessment, report when the user requests a document for filing
4. THE System SHALL follow the existing prompt-mode pattern used by storage, quantitative, and general modes in the Maxwell worker lambda
5. WHEN intent is ambiguous, THE System SHALL default to proactive mode (inform the user of their rights) and ask if they'd like an evaluation or report

### Requirement 5: No New Infrastructure Required

**User Story:** As a developer, I want this skill to work within the existing Maxwell architecture, so that it can be shipped without new Lambda functions, API endpoints, or database changes.

**Acceptance Criteria:**

1. THE skill SHALL be implemented as a new prompt mode in the existing `ws-maxwell-worker` lambda (and/or `maxwell-chat` lambda), following the same pattern as storage/quantitative/general modes
2. THE skill SHALL use the existing `GetEntityObservations` tool (with its date filtering) to retrieve evidence — no new action groups required
3. THE skill SHALL use the existing `UnifiedSearch` tool when additional context is needed (e.g., searching for related observations across entities)
4. THE skill SHALL NOT require storing Citizens' Charter or legal reference data locally — it relies on the LLM's training knowledge
5. THE skill SHALL use the existing rich copy infrastructure (`copyConversationRich`) for output — no new frontend components required
6. THE skill SHALL NOT require new API endpoints, Lambda functions, database tables, or Bedrock Agent action groups

### Requirement 6: Supplemental User Context

**User Story:** As a user generating a Rights Violation Report, I want to be able to add context that wasn't captured in my observations (e.g., total time wasted, number of visits, verbal interactions), so that the report reflects the full picture.

**Acceptance Criteria:**

1. WHEN generating a report, THE System SHALL incorporate any additional context provided in the user's prompt (e.g., "I spent 4 hours", "they made me come back 3 times", "the guard told me to come back tomorrow")
2. THE System SHALL distinguish between evidence from logged observations (with timestamps/photos) and user-stated context (verbal claims without documentation)
3. THE report SHALL label user-stated context appropriately (e.g., "Complainant states:" vs. evidence with photo/timestamp references)

### Requirement 7: Rich Copy with Inline Evidence

**User Story:** As a user who has generated a Rights Violation Report, I want to copy the complete report (text + photo evidence) so I can paste it into emails, web forms, or ChatGPT with images preserved inline.

**Acceptance Criteria:**

1. WHEN a user copies the Maxwell response containing a Rights Violation Report, THE System SHALL use the existing rich copy mechanism (HTML + plain text clipboard)
2. THE rich copy SHALL include photos as `<img>` tags so they render inline when pasted into rich-text destinations (Gmail, Google Docs, ChatGPT)
3. THE plain text fallback SHALL include photo URLs as clickable links with descriptive captions so the report remains useful in plain-text destinations (web forms, ARTA portal)
4. THE System SHALL use the existing "Copy conversation" button in the Maxwell panel — no new UI required
5. WHEN photos are referenced in the report, THE System SHALL use the full CloudFront/S3 URL so images are accessible to the recipient

