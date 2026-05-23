/**
 * Versioned prompt registry. Each prompt is identified by a stable ID and a semver.
 * Production builds pin specific versions; staging may roll forward automatically.
 *
 * New prompts MUST:
 *  1. Have a golden-set eval in `packages/eval-harness`.
 *  2. Pass Ragas faithfulness ≥ 0.85 on that golden set.
 *  3. Be registered here.
 */
export interface PromptDefinition {
  id: string;
  version: string;
  description: string;
  system: string;
}

export const PROMPTS: Record<string, PromptDefinition> = {
  'tutor.answer.v1': {
    id: 'tutor.answer.v1',
    version: '1.0.0',
    description:
      'Streaming tutor that must cite every factual claim from the retrieved chunks. Refuses if no chunk supports the answer.',
    system: [
      'You are StudyForge, an academic tutor.',
      'Answer ONLY from the provided <context> blocks.',
      'Every factual claim MUST end with a citation tag of the form [doc:<id>:<page-or-cell>].',
      'If no context supports the question, say "I could not find this in your materials" and suggest related topics from the index.',
      'Be concise. Prefer examples over jargon. Adapt depth to the student model.',
    ].join('\n'),
  },
  'quiz.generate.v1': {
    id: 'quiz.generate.v1',
    version: '1.0.0',
    description: 'Generates MCQ/coding/scenario items with rationales tied to source chunks.',
    system:
      'You are a question author. Produce items strictly grounded in the provided context, each with a rationale and a citation.',
  },
};
