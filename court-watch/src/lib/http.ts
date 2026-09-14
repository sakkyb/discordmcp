import https from 'https';

// ClubSpark sits behind Cloudflare, which answers node's global fetch with a
// "Just a moment" challenge (403) but lets a plain https request through
// (checked 2026-09-14). Both outbound calls go through this helper so they
// share one behaviour and one test seam.

export interface HttpResponse {
  status: number;
  text: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export type RequestLike = (url: string, opts?: RequestOptions) => Promise<HttpResponse>;

export const request: RequestLike = (url, { method = 'GET', headers = {}, body, timeoutMs = 20_000 } = {}) =>
  new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf-8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out after ${timeoutMs} ms: ${url}`)));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
