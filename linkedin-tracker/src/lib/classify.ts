// Decides which planned "Content schedule" row a live post belongs to, by
// comparing the post's text against the short working names on the planned
// rows. Matching on content rather than on date is what lets the table stay
// correct when a plan slips a day, when two posts go out together, or when a
// plan is never posted at all.
//
// Everything here except `classifyPost` is pure — `chooseRow` takes the
// classifier as a parameter so the decision rules can be tested without a
// network call.

export interface Candidate {
  id: string; // Notion page id
  name: string; // the row's "Post name" — shorthand written before posting
  date: string | null; // planned date, YYYY-MM-DD, or null if unset
}

export interface MatchResult {
  match: number; // 1-based index into the candidate list; 0 means none of them
  confidence: 'high' | 'low';
  reason: string;
}

export type Decision =
  | { kind: 'match'; candidate: Candidate; reason: string }
  | { kind: 'none'; reason: string }
  | { kind: 'unavailable' }; // the classifier could not be reached — caller falls back

export const MAX_POST_CHARS = 600;

export function buildPrompt(postText: string, candidates: Candidate[]): string {
  const list = candidates
    .map((c, i) => `${i + 1}. ${c.name}${c.date ? ` (planned for ${c.date})` : ' (no date set)'}`)
    .join('\n');

  return [
    'A LinkedIn post just went live. Below is its text, followed by planned posts from a content calendar.',
    'Each planned post has a short working name written before it was posted. The name describes the subject in shorthand — it is not the text of the post. For example, a plan named "Munich ramp repost" corresponds to a repost about a wheelchair ramp in Munich.',
    '',
    'Decide which planned post this is.',
    'Return 0 if none of them clearly describes this post. That is a normal and expected answer — posts are often written without a plan.',
    'Use "high" confidence only when one plan clearly describes this specific post. If two plans could both fit, or the connection relies on a guess, use "low".',
    '',
    '--- POST THAT JUST WENT LIVE ---',
    postText.slice(0, MAX_POST_CHARS),
    '',
    '--- PLANNED POSTS ---',
    list,
  ].join('\n');
}

// Only a confident, in-range match claims a row. Everything else is treated as
// "no match", which is safe: the caller creates a separate row rather than
// stamping the wrong plan.
export function decide(result: MatchResult, candidates: Candidate[]): Candidate | null {
  if (result.confidence !== 'high') return null;
  if (!Number.isInteger(result.match) || result.match < 1 || result.match > candidates.length) return null;
  return candidates[result.match - 1];
}

export async function chooseRow(
  postText: string,
  candidates: Candidate[],
  classify: (text: string, candidates: Candidate[]) => Promise<MatchResult | null>,
): Promise<Decision> {
  if (candidates.length === 0) {
    return { kind: 'none', reason: 'No unstamped rows within the date window.' };
  }
  const result = await classify(postText, candidates);
  if (result === null) return { kind: 'unavailable' };
  const candidate = decide(result, candidates);
  return candidate ? { kind: 'match', candidate, reason: result.reason } : { kind: 'none', reason: result.reason };
}
