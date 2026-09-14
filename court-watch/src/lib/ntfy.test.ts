import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish, alert } from './ntfy.js';
import type { RequestLike, RequestOptions } from './http.js';

interface Captured {
  url: string;
  opts?: RequestOptions;
}

const capture = (status = 200): { calls: Captured[]; requestFn: RequestLike } => {
  const calls: Captured[] = [];
  const requestFn: RequestLike = async (url, opts) => {
    calls.push({ url, opts });
    return { status, text: status === 200 ? '{}' : 'nope' };
  };
  return { calls, requestFn };
};

const target = { server: 'https://ntfy.example', topic: 'courts-abc' };

test('publish POSTs one JSON message to the server root', async () => {
  const { calls, requestFn } = capture();
  await publish(
    {
      title: 'Kennington Park: 2 new slots',
      body: 'Sat 19 Sep — Court 1 09:00–10:00 £8',
      click: 'https://clubspark.lta.org.uk/kenningtonpark/Booking/BookByDate#?date=2026-09-19&role=guest',
      actions: [{ label: 'Sat 19 Sep', url: 'https://example/a' }],
      tags: ['tennis'],
    },
    target,
    requestFn,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ntfy.example/');
  assert.equal(calls[0].opts?.method, 'POST');
  assert.equal(calls[0].opts?.headers?.['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0].opts?.body)), {
    topic: 'courts-abc',
    title: 'Kennington Park: 2 new slots',
    message: 'Sat 19 Sep — Court 1 09:00–10:00 £8',
    tags: ['tennis'],
    click: 'https://clubspark.lta.org.uk/kenningtonpark/Booking/BookByDate#?date=2026-09-19&role=guest',
    actions: [{ action: 'view', label: 'Sat 19 Sep', url: 'https://example/a' }],
  });
});

test('publish rejects on a non-2xx response', async () => {
  const { requestFn } = capture(429);
  await assert.rejects(
    publish({ title: 't', body: 'b', click: '', actions: [], tags: [] }, target, requestFn),
    /ntfy publish failed \(429\): nope/,
  );
});

test('alert is a high-priority warning with no click or actions', async () => {
  const { calls, requestFn } = capture();
  await alert('Kennington Park: responded 503', target, requestFn);
  const body = JSON.parse(String(calls[0].opts?.body));
  assert.equal(body.title, 'court-watch failed');
  assert.equal(body.priority, 4);
  assert.deepEqual(body.tags, ['warning']);
  assert.equal(body.click, undefined);
  assert.equal(body.actions, undefined);
});
