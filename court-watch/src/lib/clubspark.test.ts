import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionsUrl, bookingPageUrl, fetchVenueSessions, type FetchLike } from './clubspark.js';

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

const fake = (status: number, body: unknown): FetchLike => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('fetchVenueSessions rejects on non-2xx', async () => {
  await assert.rejects(fetchVenueSessions('x', '2026-09-14', '2026-09-21', fake(503, {})), /responded 503/);
});

test('fetchVenueSessions rejects when Resources is missing', async () => {
  await assert.rejects(fetchVenueSessions('x', '2026-09-14', '2026-09-21', fake(200, { TimeZone: 'Europe/London' })), /no Resources/);
});

test('fetchVenueSessions returns the parsed body', async () => {
  const body = { TimeZone: 'Europe/London', Resources: [] };
  assert.deepEqual(await fetchVenueSessions('x', '2026-09-14', '2026-09-21', fake(200, body)), body);
});
