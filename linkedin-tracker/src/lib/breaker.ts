// Circuit breaker for the 15-minute post poller.
//
// At 34 slots a day, a run that lands on a login page, a security challenge or
// an empty feed must NOT be retried 30 more times: hammering a challenge is how
// a soft warning turns into an account restriction, and it also buries the
// error log. So a scrape failure is classified, and the kinds that mean "stop
// touching LinkedIn today" pause every remaining slot until midnight. Slots
// resume on their own next morning; if the cause is still there, the breaker
// trips again and alerts once more — one alert per day until someone fixes it.
export type ScrapeErrorKind = 'logged-out' | 'challenge' | 'no-cards' | 'other';

// The scraper's error messages are the contract: assertLoggedIn and
// getRecentPosts fail loudly with wording that names the cause.
export function classifyScrapeError(err: unknown): ScrapeErrorKind {
  const msg = err instanceof Error ? err.message : String(err);
  if (/security challenge|checkpoint/i.test(msg)) return 'challenge';
  if (/not logged in|guest wall|session has expired/i.test(msg)) return 'logged-out';
  if (/No post cards/i.test(msg)) return 'no-cards';
  return 'other';
}

// How many consecutive "soft" failures (empty feed, timeouts, unclassified
// errors) it takes to trip. One is a transient slow load — that has happened
// before — two in a row is a pattern.
export const SOFT_FAILURE_TRIP = 2;

export function breakerDecision(
  kind: ScrapeErrorKind,
  previousConsecutive: number,
): { trip: boolean; consecutive: number } {
  if (kind === 'logged-out' || kind === 'challenge') return { trip: true, consecutive: 0 };
  const consecutive = previousConsecutive + 1;
  if (consecutive >= SOFT_FAILURE_TRIP) return { trip: true, consecutive: 0 };
  return { trip: false, consecutive };
}
