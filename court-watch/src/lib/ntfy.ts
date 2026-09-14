import { request, type RequestLike } from './http.js';
import type { Notification } from './report.js';

export interface NtfyTarget {
  server: string; // e.g. https://ntfy.sh
  topic: string;
}

// JSON publish to the server root: unlike the header form it takes UTF-8
// titles and labels without any encoding dance.
export async function publish(n: Notification, { server, topic }: NtfyTarget, requestFn: RequestLike = request): Promise<void> {
  const payload: Record<string, unknown> = {
    topic,
    title: n.title,
    message: n.body,
    tags: n.tags,
  };
  if (n.click) payload.click = n.click;
  if (n.priority) payload.priority = n.priority;
  if (n.actions.length) payload.actions = n.actions.map((a) => ({ action: 'view', label: a.label, url: a.url }));
  const res = await requestFn(`${server}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`ntfy publish failed (${res.status}): ${res.text}`);
  }
}

// Operational alert on the same topic, high priority, so a broken job is
// never silent.
export async function alert(text: string, target: NtfyTarget, requestFn: RequestLike = request): Promise<void> {
  await publish(
    { title: 'court-watch failed', body: text.slice(0, 3500), click: '', actions: [], tags: ['warning'], priority: 4 },
    target,
    requestFn,
  );
}
