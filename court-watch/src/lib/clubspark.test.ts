import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionsUrl, bookingPageUrl, fetchVenueSessions } from './clubspark.js';
import type { RequestLike } from './http.js';

test('sessionsUrl targets the venue booking API with the date range', () => {
  const url = sessionsUrl('kenningtonpark', '2026-09-14', '2026-09-21', 123);
  assert.equal(
    url,
    'https://clubspark.lta.org.uk/v0/VenueBooking/kenningtonpark/GetVenueSessions?resourceID=&startDate=2026-09-14&endDate=2026-09-21&roleId=&_=123',
  );
});

test('bookingPageUrl opens BookByDate on the given day as a guest', () => {
  assert.equal(
    bookingPageUrl('BurgessParkSouthwark', '2026-09-19'),
    'https://clubspark.lta.org.uk/BurgessParkSouthwark/Booking/BookByDate#?date=2026-09-19&role=guest',
  );
});

const fake = (status: number, text: string): RequestLike => async () => ({ status, text });

test('fetchVenueSessions rejects on non-2xx', async () => {
  await assert.rejects(fetchVenueSessions('x', '2026-09-14', '2026-09-21', fake(503, '')), /responded 503/);
});

test('fetchVenueSessions rejects on non-JSON (e.g. a bot challenge page)', async () => {
  await assert.rejects(fetchVenueSessions('x', '2026-09-14', '2026-09-21', fake(200, '<html>')), /not JSON/);
});

test('fetchVenueSessions rejects when Resources is missing', async () => {
  await assert.rejects(
    fetchVenueSessions('x', '2026-09-14', '2026-09-21', fake(200, JSON.stringify({ TimeZone: 'Europe/London' }))),
    /no Resources/,
  );
});

test('fetchVenueSessions returns the parsed body and sends an identifying UA', async () => {
  const body = { TimeZone: 'Europe/London', Resources: [] };
  let seen: Record<string, string> | undefined;
  const req: RequestLike = async (_url, opts) => {
    seen = opts?.headers;
    return { status: 200, text: JSON.stringify(body) };
  };
  assert.deepEqual(await fetchVenueSessions('x', '2026-09-14', '2026-09-21', req), body);
  assert.match(seen?.['User-Agent'] ?? '', /court-watch/);
});
