/**
 * Gap Computation and Severity Functions for the Growth Learning Module.
 *
 * Pure functions that power the growth checklist by computing skill gaps
 * between a person's demonstrated capability and an action's required levels.
 *
 * Bloom's taxonomy scale: 0-5 integers
 *   0 = No exposure, 1 = Remember, 2 = Understand, 3 = Apply, 4 = Analyze, 5 = Create
 *
 * The Understand threshold (level 2) is the minimum bar before starting a task.
 */

import type { SkillProfile, SkillAxis } from '@/hooks/useSkillProfile';
import type { CapabilityProfile, CapabilityAxis } from '@/hooks/useCapability';
import type { QuestionType } from '@/lib/progressionUtils';

// --- Types ---

export type GapSeverity = 'needs_learning' | 'partial_readiness' | 'met';

export interface GapItem {
  axisKey: string;
  axisLabel: string;
  requiredLevel: number;
  currentLevel: number;
  severity: GapSeverity;
  distanceBelowUnderstand: number; // max(0, 2 - currentLevel)
}

/** The Understand threshold on Bloom's taxonomy scale */
const UNDERSTAND_THRESHOLD = 2;

/** Maximum Bloom's taxonomy level */
const MAX_BLOOM_LEVEL = 5;

// --- Helpers ---

/**
 * Ensure a Bloom's level is a valid integer in [0, 5].
 *
 * The skill profile stores required_level as an integer on the Bloom's
 * 0–5 scale (same scale as the capability profile). This function
 * clamps and rounds the value for safety.
 */
export function toBloomLevel(level: number): number {
  return Math.max(0, Math.min(MAX_BLOOM_LEVEL, Math.round(level)));
}

// --- Core Functions ---

/**
 * Classify the severity of a gap on a single axis.
 *
 * - 'needs_learning': currentLevel < 2 (Understand) AND currentLevel < requiredLevel
 * - 'partial_readiness': currentLevel >= 2 AND currentLevel < requiredLevel
 * - 'met': currentLevel >= requiredLevel
 *
 * Both levels are on the Bloom's 0–5 integer scale.
 */
export function classifyGapSeverity(
  requiredLevel: number,
  currentLevel: number
): GapSeverity {
  if (currentLevel >= requiredLevel) {
    return 'met';
  }
  if (currentLevel < UNDERSTAND_THRESHOLD) {
    return 'needs_learning';
  }
  return 'partial_readiness';
}

/**
 * Compute gap items from a skill profile and capability profile.
 *
 * Returns a GapItem for every axis where currentLevel < requiredLevel.
 * When all axes are met, returns an empty array.
 *
 * Both required_level and capability level are on the Bloom's 0–5 integer scale.
 */
export function computeGapItems(
  skillProfile: SkillProfile,
  capabilityProfile: CapabilityProfile
): GapItem[] {
  const capabilityByKey = new Map<string, CapabilityAxis>();
  for (const axis of capabilityProfile.axes) {
    capabilityByKey.set(axis.key, axis);
  }

  const gaps: GapItem[] = [];

  for (const skillAxis of skillProfile.axes) {
    const requiredLevel = toBloomLevel(skillAxis.required_level);
    const capAxis = capabilityByKey.get(skillAxis.key);
    const currentLevel = capAxis?.level ?? 0;

    if (currentLevel < requiredLevel) {
      const severity = classifyGapSeverity(requiredLevel, currentLevel);
      gaps.push({
        axisKey: skillAxis.key,
        axisLabel: skillAxis.label,
        requiredLevel,
        currentLevel,
        severity,
        distanceBelowUnderstand: Math.max(0, UNDERSTAND_THRESHOLD - currentLevel),
      });
    }
  }

  return gaps;
}

/**
 * Sort gap items by severity — axes furthest below Bloom's level 2 listed first.
 *
 * Orders by distanceBelowUnderstand descending. Items with the same distance
 * maintain their original relative order (stable sort).
 */
export function sortGapsBySeverity(gaps: GapItem[]): GapItem[] {
  // Array.prototype.sort is stable in modern JS engines (ES2019+)
  return [...gaps].sort(
    (a, b) => b.distanceBelowUnderstand - a.distanceBelowUnderstand
  );
}

/**
 * Compute a gap summary: total axes and how many have gaps.
 *
 * Returns { total, gaps } where total is the number of skill axes
 * and gaps is the count of axes where currentLevel < requiredLevel.
 */
export function computeGapSummary(
  skillProfile: SkillProfile,
  capabilityProfile: CapabilityProfile
): { total: number; gaps: number } {
  const total = skillProfile.axes.length;
  const gapItems = computeGapItems(skillProfile, capabilityProfile);
  return { total, gaps: gapItems.length };
}

// --- Quiz Evaluation Types ---

export interface QuizAnswer {
  questionId: string;
  objectiveId: string;
  selectedAnswer: string;
  correctAnswer: string;
  wasFirstAttempt: boolean;
  wasCorrect: boolean;
  timestamp: string;
}

// --- Quiz Evaluation Functions ---

/**
 * Determine which objectives still need a correct first-attempt answer.
 *
 * An objective is "complete" when there exists at least one answer where
 * objectiveId matches, wasFirstAttempt is true, and wasCorrect is true.
 * Returns the IDs from objectiveIds that lack such an answer.
 */
export function getIncompleteObjectives(
  objectiveIds: string[],
  answers: QuizAnswer[]
): string[] {
  const completedObjectives = new Set<string>();

  for (const answer of answers) {
    if (answer.wasFirstAttempt && answer.wasCorrect) {
      completedObjectives.add(answer.objectiveId);
    }
  }

  return objectiveIds.filter((id) => !completedObjectives.has(id));
}

/**
 * Check if the quiz is complete — all objectives have a correct first-attempt answer.
 *
 * Returns true iff getIncompleteObjectives returns an empty array.
 */
export function isQuizComplete(
  objectiveIds: string[],
  answers: QuizAnswer[]
): boolean {
  return getIncompleteObjectives(objectiveIds, answers).length === 0;
}

/**
 * Compute quiz summary statistics.
 *
 * Returns the total number of unique questions answered and how many
 * had a correct first attempt.
 */
export function computeQuizSummary(
  answers: QuizAnswer[]
): { totalQuestions: number; correctFirstAttempt: number } {
  const seenQuestions = new Set<string>();
  let correctFirstAttempt = 0;

  for (const answer of answers) {
    if (!seenQuestions.has(answer.questionId)) {
      seenQuestions.add(answer.questionId);
      if (answer.wasFirstAttempt && answer.wasCorrect) {
        correctFirstAttempt++;
      }
    }
  }

  return {
    totalQuestions: seenQuestions.size,
    correctFirstAttempt,
  };
}

// --- Learning Progress Types ---

export type ObjectiveStatus = 'not_started' | 'in_progress' | 'completed';
export type CompletionType = 'quiz' | 'demonstrated' | null;

export interface ObjectiveProgress {
  objectiveId: string;
  status: ObjectiveStatus;
  completionType: CompletionType;
}

export interface KnowledgeState {
  objectiveId: string;
  wasFirstAttempt: boolean;
  wasCorrect: boolean;
  isDemonstration: boolean;
}

// --- Learning Progress Functions ---

/**
 * Derive the status and completion type for a single learning objective
 * based on its associated knowledge states.
 *
 * Priority: quiz completion (correct first-attempt) takes precedence over
 * demonstration if both exist.
 *
 * - 'completed'/'quiz': at least one knowledge state with wasFirstAttempt=true and wasCorrect=true
 * - 'completed'/'demonstrated': at least one knowledge state with isDemonstration=true (and no quiz completion)
 * - 'in_progress': knowledge states exist but none match the above
 * - 'not_started': no knowledge states for this objective
 */
export function deriveObjectiveStatus(
  objectiveId: string,
  knowledgeStates: KnowledgeState[]
): { status: ObjectiveStatus; completionType: CompletionType } {
  const relevant = knowledgeStates.filter(
    (ks) => ks.objectiveId === objectiveId
  );

  if (relevant.length === 0) {
    return { status: 'not_started', completionType: null };
  }

  const hasQuizCompletion = relevant.some(
    (ks) => ks.wasFirstAttempt && ks.wasCorrect
  );
  if (hasQuizCompletion) {
    return { status: 'completed', completionType: 'quiz' };
  }

  const hasDemonstration = relevant.some((ks) => ks.isDemonstration);
  if (hasDemonstration) {
    return { status: 'completed', completionType: 'demonstrated' };
  }

  return { status: 'in_progress', completionType: null };
}

/**
 * Check if all objectives for an axis are completed.
 *
 * Returns true iff every objective in the array has status 'completed'.
 * An empty array returns true (vacuously true — no objectives to complete).
 */
export function isAxisComplete(objectives: ObjectiveProgress[]): boolean {
  return objectives.every((obj) => obj.status === 'completed');
}

/**
 * Check if all objectives across all axes are completed.
 *
 * Returns true iff isAxisComplete is true for every axis in the map.
 * An empty map returns true (vacuously true — no axes to complete).
 */
export function isAllLearningComplete(
  axisObjectives: Map<string, ObjectiveProgress[]>
): boolean {
  for (const objectives of axisObjectives.values()) {
    if (!isAxisComplete(objectives)) {
      return false;
    }
  }
  return true;
}

/**
 * Compute progress summary for an axis.
 *
 * Returns the count of completed objectives and the total number of objectives.
 */
export function computeAxisProgress(
  objectives: ObjectiveProgress[]
): { completed: number; total: number } {
  const completed = objectives.filter(
    (obj) => obj.status === 'completed'
  ).length;
  return { completed, total: objectives.length };
}

// --- Self-Assessment Comparison Types ---

export interface VerificationResult {
  confirmed: string[];   // Both person and AI agree
  unconfirmed: string[]; // Person claimed, AI didn't see evidence
  aiDetected: string[];  // AI found evidence person didn't claim
}

// --- Self-Assessment Comparison Functions ---

/**
 * Compare a person's self-assessed objective IDs against AI-evaluated objective IDs.
 *
 * Produces three disjoint sets whose union equals the union of the two inputs:
 * - confirmed: intersection of selfAssessedIds and aiEvaluatedIds
 * - unconfirmed: selfAssessedIds minus aiEvaluatedIds
 * - aiDetected: aiEvaluatedIds minus selfAssessedIds
 *
 * Duplicate IDs within either input are treated as a single entry.
 */
export function compareAssessments(
  selfAssessedIds: string[],
  aiEvaluatedIds: string[]
): VerificationResult {
  const selfSet = new Set(selfAssessedIds);
  const aiSet = new Set(aiEvaluatedIds);

  const confirmed: string[] = [];
  const unconfirmed: string[] = [];
  const aiDetected: string[] = [];

  for (const id of selfSet) {
    if (aiSet.has(id)) {
      confirmed.push(id);
    } else {
      unconfirmed.push(id);
    }
  }

  for (const id of aiSet) {
    if (!selfSet.has(id)) {
      aiDetected.push(id);
    }
  }

  return { confirmed, unconfirmed, aiDetected };
}

// --- Similarity Threshold Constants ---

/** Score at or above which prior learning is classified as 'likely_covered' */
export const LIKELY_COVERED_THRESHOLD = 0.8;

/** Score at or above which prior learning is classified as 'related_learning' */
export const RELATED_LEARNING_THRESHOLD = 0.5;

// --- Similarity Classification Types ---

export type SimilarityClassification = 'likely_covered' | 'related_learning' | 'new_material';

// --- Similarity Classification Functions ---

/**
 * Classify a similarity score into one of three categories for UI display.
 *
 * - 'likely_covered': score >= 0.8 — optional review
 * - 'related_learning': 0.5 <= score < 0.8 — recommended review
 * - 'new_material': score < 0.5 — required
 *
 * These thresholds are frontend-only constants used to drive UI decisions.
 * The backend returns raw similarity scores (0.0–1.0).
 */
export function classifySimilarity(score: number): SimilarityClassification {
  if (score >= LIKELY_COVERED_THRESHOLD) return 'likely_covered';
  if (score >= RELATED_LEARNING_THRESHOLD) return 'related_learning';
  return 'new_material';
}

// --- State Text Format Types ---

export interface ParsedLearningObjectiveStateText {
  axisKey: string;
  actionId: string;
  userId: string;
  objectiveText: string;
}

export interface ParsedLearningTakeaway {
  axisKey: string;
  actionId: string;
  userId: string;
  takeawayText: string;
}

export interface ParsedKnowledgeStateText {
  objectiveText: string;
  questionText: string;
  selectedAnswer: string;
  wasCorrect: boolean;
}

// --- State Text Format Functions ---

/**
 * Compose a learning objective state_text in the canonical format:
 *   [learning_objective] axis=<key> action=<id> user=<id> | <text>
 *
 * The [learning_objective] prefix and metadata allow querying objectives by type.
 * The human-readable text after the pipe separator is the actual objective.
 */
export function composeLearningObjectiveStateText(
  axisKey: string,
  actionId: string,
  userId: string,
  objectiveText: string
): string {
  return `[learning_objective] axis=${axisKey} action=${actionId} user=${userId} | ${objectiveText}`;
}

/**
 * Parse a learning objective state_text, extracting the axis key, action ID,
 * user ID, and objective text from the canonical format.
 *
 * Returns null if the format doesn't match (does not throw).
 */
export function parseLearningObjectiveStateText(
  stateText: string
): ParsedLearningObjectiveStateText | null {
  const match = stateText.match(
    /^\[learning_objective\] axis=(\S+) action=(\S+) user=(\S+) \| (.+)$/
  );
  if (!match) {
    return null;
  }
  return {
    axisKey: match[1],
    actionId: match[2],
    userId: match[3],
    objectiveText: match[4],
  };
}

/**
 * Compose a learning takeaway state_text in the canonical format:
 *   [learning_takeaway] axis=<key> action=<id> user=<id> | <text>
 *
 * The [learning_takeaway] prefix and metadata allow querying takeaways by type.
 * The human-readable text after the pipe separator is the actual takeaway.
 */
export function composeLearningTakeawayStateText(
  axisKey: string,
  actionId: string,
  userId: string,
  takeawayText: string
): string {
  return `[learning_takeaway] axis=${axisKey} action=${actionId} user=${userId} | ${takeawayText}`;
}

/**
 * Parse a learning takeaway state_text, extracting the axis key, action ID,
 * user ID, and takeaway text from the canonical format.
 *
 * Returns null if the format doesn't match (does not throw).
 */
export function parseLearningTakeawayStateText(
  stateText: string
): ParsedLearningTakeaway | null {
  const match = stateText.match(
    /^\[learning_takeaway\] axis=(\S+) action=(\S+) user=(\S+) \| (.+)$/
  );
  if (!match) {
    return null;
  }
  return {
    axisKey: match[1],
    actionId: match[2],
    userId: match[3],
    takeawayText: match[4],
  };
}

// --- Policy Append Helpers ---

/**
 * Escape HTML special characters in a string to prevent XSS
 * when embedding user-provided text into HTML content.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Append a takeaway to an action's policy HTML.
 *
 * If the policy is empty/blank (null, undefined, empty string, or TipTap
 * empty-editor placeholders), sets the takeaway as the initial content.
 * Adds a 📝 prefix to visually distinguish appended takeaways.
 *
 * The takeaway text is HTML-escaped before embedding in the paragraph tag.
 */
export function appendTakeawayToPolicy(
  currentPolicy: string | null | undefined,
  takeawayText: string
): string {
  const takeawayHtml = `<p>📝 ${escapeHtml(takeawayText)}</p>`;
  const trimmed = (currentPolicy || '').trim();
  const isEmpty = !trimmed
    || trimmed === '<p></p>'
    || trimmed === '<p><br></p>'
    || trimmed === '<p>&nbsp;</p>';

  if (isEmpty) {
    return takeawayHtml;
  }
  return `${trimmed}${takeawayHtml}`;
}

// --- Copy Context Helpers ---

/**
 * Strip HTML tags from a string, returning plain text.
 * Uses DOMParser for safe, accurate HTML-to-text conversion.
 */
export function stripHtmlToPlainText(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent || '';
}

/**
 * Build a formatted plain text block for clipboard copy.
 * Includes action context fields and learning takeaways.
 * Only includes sections for non-empty fields.
 * Omits "Takeaways:" section entirely when takeaways array is empty.
 */
export function buildCopyContextText(
  action: {
    title?: string;
    description?: string;
    expected_state?: string;
    policy?: string;
  },
  takeaways: string[]
): string {
  const sections: string[] = [];

  if (action.title) sections.push(`Title: ${action.title}`);
  if (action.description) sections.push(`Description: ${action.description}`);
  if (action.expected_state) sections.push(`Expected State: ${action.expected_state}`);

  const policyText = stripHtmlToPlainText(action.policy || '');
  if (policyText.trim()) sections.push(`Current Plan:\n${policyText}`);

  if (takeaways.length > 0) {
    sections.push(`Takeaways:\n${takeaways.map(t => `- ${t}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

// --- Knowledge State Format Functions ---

/**
 * Compose a knowledge state state_text in the canonical format:
 *   For learning objective '<objective>' and question '<question>', I selected '<answer>' which was the correct|incorrect answer.
 */
export function composeKnowledgeStateText(
  objectiveText: string,
  questionText: string,
  selectedAnswer: string,
  wasCorrect: boolean
): string {
  const correctness = wasCorrect ? 'correct' : 'incorrect';
  return `For learning objective '${objectiveText}' and question '${questionText}', I selected '${selectedAnswer}' which was the ${correctness} answer.`;
}

/**
 * Parse a knowledge state state_text, extracting the objective text, question text,
 * selected answer, and correctness flag from the canonical format.
 *
 * Returns null if the format doesn't match (does not throw).
 */
export function parseKnowledgeStateText(
  stateText: string
): ParsedKnowledgeStateText | null {
  const match = stateText.match(
    /^For learning objective '(.+)' and question '(.+)', I selected '(.+)' which was the (correct|incorrect) answer\.$/
  );
  if (!match) {
    return null;
  }
  return {
    objectiveText: match[1],
    questionText: match[2],
    selectedAnswer: match[3],
    wasCorrect: match[4] === 'correct',
  };
}

// --- Open-Form State Text Types ---

export interface ParsedOpenFormState {
  objectiveText: string;
  questionType: QuestionType;
  questionText: string;
  responseText: string;
  idealAnswer: string;
  evaluationStatus: 'pending' | 'sufficient' | 'insufficient' | 'error';
  continuousScore: number | null;
  reasoning: string | null;
  demonstratedLevel?: number | null;
  conceptDemonstrated?: string | null;
  nextLevelHint?: string | null;
}

// --- Open-Form State Text Functions ---

/**
 * Compose an open-form knowledge state text in the canonical format:
 *   For learning objective '{objective}' and {question_type} question '{question}',
 *   I responded: '{response}'. Ideal answer: '{ideal}'. Evaluation: pending.
 *
 * The initial evaluation status is always 'pending' — async evaluation
 * updates the state text later via appendEvaluationToStateText.
 */
export function composeOpenFormStateText(
  objectiveText: string,
  questionType: QuestionType,
  questionText: string,
  responseText: string,
  idealAnswer: string
): string {
  return `For learning objective '${objectiveText}' and ${questionType} question '${questionText}', I responded: '${responseText}'. Ideal answer: '${idealAnswer}'. Evaluation: pending.`;
}

/**
 * Parse an open-form knowledge state text back to its component fields.
 *
 * Handles all evaluation statuses: pending, sufficient, insufficient, error.
 * Returns null if the text doesn't match the open-form format.
 */
export function parseOpenFormStateText(
  stateText: string
): ParsedOpenFormState | null {
  // Match the core structure: objective, question type, question, response, ideal answer
  const corePattern =
    /^For learning objective '(.+?)' and (\S+) question '(.+?)', I responded: '(.+?)'\. Ideal answer: '(.+?)'\. Evaluation: (.+)$/s;

  const match = stateText.match(corePattern);
  if (!match) {
    return null;
  }

  const objectiveText = match[1];
  const questionType = match[2] as QuestionType;
  const questionText = match[3];
  const responseText = match[4];
  const idealAnswer = match[5];
  const evaluationPart = match[6];

  // Parse the evaluation portion
  if (evaluationPart === 'pending.') {
    return {
      objectiveText,
      questionType,
      questionText,
      responseText,
      idealAnswer,
      evaluationStatus: 'pending',
      continuousScore: null,
      reasoning: null,
    };
  }

  if (evaluationPart === 'error.') {
    return {
      objectiveText,
      questionType,
      questionText,
      responseText,
      idealAnswer,
      evaluationStatus: 'error',
      continuousScore: null,
      reasoning: null,
    };
  }

  // Match: sufficient (score: 2.4). Reasoning text.
  // or:   insufficient (score: 1.2). Reasoning text.
  // Optionally followed by: [bloom: level=N, demonstrated=..., nextHint=...]
  const evalPattern =
    /^(sufficient|insufficient) \(score: ([\d.]+)\)\. (.+?)\.(?:\s*\[bloom: level=(\d+), demonstrated=(.*?), nextHint=(.*?)\])?$/s;
  const evalMatch = evaluationPart.match(evalPattern);
  if (!evalMatch) {
    return null;
  }

  const continuousScore = parseFloat(evalMatch[2]);
  const result: ParsedOpenFormState = {
    objectiveText,
    questionType,
    questionText,
    responseText,
    idealAnswer,
    evaluationStatus: evalMatch[1] as 'sufficient' | 'insufficient',
    continuousScore,
    reasoning: evalMatch[3],
  };

  // Extract structured Bloom feedback fields if present
  if (evalMatch[4] != null) {
    result.demonstratedLevel = parseInt(evalMatch[4], 10);
    result.conceptDemonstrated = (evalMatch[5] || '').replace(/\\]/g, ']');
    result.nextLevelHint = (evalMatch[6] || '').replace(/\\]/g, ']');
  } else {
    // Fallback: derive demonstratedLevel from score for older states
    result.demonstratedLevel = continuousScore >= 4.0 ? 5 : continuousScore >= 3.0 ? 4 : continuousScore >= 2.0 ? 3 : continuousScore >= 1.0 ? 2 : 1;
    result.conceptDemonstrated = null;
    result.nextLevelHint = null;
  }

  return result;
}

/**
 * Update an open-form state text with evaluation results.
 *
 * Replaces "Evaluation: pending." with the evaluation outcome:
 *   Evaluation: sufficient (score: 2.4). Reasoning summary. [bloom: level=3, demonstrated=..., nextHint=...]
 *   Evaluation: insufficient (score: 1.2). Reasoning summary. [bloom: level=2, demonstrated=..., nextHint=...]
 */
export function appendEvaluationToStateText(
  stateText: string,
  evaluation: {
    score: number;
    sufficient: boolean;
    reasoning: string;
    demonstratedLevel?: number;
    conceptDemonstrated?: string;
    nextLevelHint?: string;
  }
): string {
  const sufficiency = evaluation.sufficient ? 'sufficient' : 'insufficient';
  let replacement = `Evaluation: ${sufficiency} (score: ${evaluation.score}). ${evaluation.reasoning}.`;

  // Append structured Bloom feedback if available
  if (evaluation.demonstratedLevel != null) {
    const demonstrated = (evaluation.conceptDemonstrated || '').replace(/]/g, '\\]');
    const nextHint = (evaluation.nextLevelHint || '').replace(/]/g, '\\]');
    replacement += ` [bloom: level=${evaluation.demonstratedLevel}, demonstrated=${demonstrated}, nextHint=${nextHint}]`;
  }

  return stateText.replace(
    /Evaluation: pending\.$/,
    replacement
  );
}

/**
 * Update an open-form state text with error status.
 *
 * Replaces "Evaluation: pending." with "Evaluation: error."
 * Used when the Bedrock evaluation call fails or times out.
 */
export function appendEvaluationErrorToStateText(stateText: string): string {
  return stateText.replace(/Evaluation: pending\.$/, 'Evaluation: error.');
}
