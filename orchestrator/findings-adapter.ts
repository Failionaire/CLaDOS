/**
 * Reviewer Findings Adapter
 *
 * Converts freeform markdown from a reviewer-mode custom agent
 * into the standard Finding[] format using a utility LLM call.
 */

import type { Finding, FindingSeverity } from './types.js';

const EXTRACTION_PROMPT = `You are a structured-extraction assistant. Extract findings from this code review.

For each issue, output a JSON array of objects with these fields:
  - severity: "must_fix" if the reviewer says "must", "critical", "blocking", "error"; "should_fix" if "should", "recommend", "consider"; otherwise "suggestion"
  - category: a short category label (e.g. "error-handling", "security", "style", "performance")
  - description: the issue description
  - file: the file path if mentioned, otherwise null
  - line: the line number if mentioned, otherwise null

Output ONLY the JSON array, no other text.`;

interface RawFinding {
  severity?: string;
  category?: string;
  description?: string;
  file?: string | null;
  line?: number | null;
}

/**
 * Adapt freeform reviewer markdown into structured Finding[].
 *
 * @param rawMarkdown - The reviewer agent's freeform output
 * @param reviewerName - The reviewer agent's name (used in finding IDs)
 * @param phase - The pipeline phase number
 * @param callLLM - Function to call the utility LLM for extraction
 */
export async function adaptReviewerOutput(
  rawMarkdown: string,
  reviewerName: string,
  phase: number,
  callLLM: (systemPrompt: string, userMessage: string) => Promise<string>,
): Promise<Finding[]> {
  if (!rawMarkdown.trim()) return [];

  const response = await callLLM(EXTRACTION_PROMPT, rawMarkdown);

  let parsed: RawFinding[];
  try {
    // Extract JSON array from response (may have surrounding text)
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed.map((item, index): Finding => {
    const severity: FindingSeverity =
      item.severity === 'must_fix' || item.severity === 'should_fix' || item.severity === 'suggestion'
        ? item.severity
        : 'suggestion';

    return {
      id: `${phase}-${reviewerName}-${item.category ?? 'general'}-${index}`,
      severity,
      category: item.category ?? 'general',
      description: item.description ?? '',
      file: item.file ?? undefined,
      line: item.line ?? undefined,
      status: 'new',
    };
  });
}
