import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyScrapeError, breakerDecision } from './breaker.js';

// The scraper's own error messages are the contract here: assertLoggedIn and
// getRecentPosts fail loudly with wording that names the cause.
test('an expired session is classified as logged-out', () => {
  assert.equal(classifyScrapeError(new Error('LinkedIn session is not logged in (landed on https://www.linkedin.com/login). Run …')), 'logged-out');
  assert.equal(classifyScrapeError(new Error('LinkedIn served its logged-out guest wall at https://… so the saved session has expired.')), 'logged-out');
});

test('a security checkpoint is classified as a challenge', () => {
  assert.equal(classifyScrapeError(new Error('LinkedIn is showing a security challenge (landed on https://www.linkedin.com/checkpoint/challenge/x).')), 'challenge');
});

test('an empty feed after the reload is classified as no-cards', () => {
  assert.equal(classifyScrapeError(new Error('No post cards found on the activity page within 120s (after one reload). Either …')), 'no-cards');
});

test('anything else is classified as other', () => {
  assert.equal(classifyScrapeError(new Error('page.goto: Timeout 60000ms exceeded.')), 'other');
});

// Retrying through a login or challenge page 30 more times today is how a
// soft warning becomes a restriction, so those trip on the first sight.
test('logged-out trips the breaker immediately', () => {
  assert.deepEqual(breakerDecision('logged-out', 0), { trip: true, consecutive: 0 });
});

test('a challenge trips the breaker immediately', () => {
  assert.deepEqual(breakerDecision('challenge', 0), { trip: true, consecutive: 0 });
});

// "No post cards" has been a transient slow-load before, so one sighting only
// counts; two in a row trips.
test('a first no-cards failure counts but does not trip', () => {
  assert.deepEqual(breakerDecision('no-cards', 0), { trip: false, consecutive: 1 });
});

test('a second consecutive no-cards failure trips', () => {
  assert.deepEqual(breakerDecision('no-cards', 1), { trip: true, consecutive: 0 });
});

test('an unclassified scrape error is treated like no-cards', () => {
  assert.deepEqual(breakerDecision('other', 0), { trip: false, consecutive: 1 });
  assert.deepEqual(breakerDecision('other', 1), { trip: true, consecutive: 0 });
});
