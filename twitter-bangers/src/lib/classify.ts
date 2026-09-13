// Relevance filter: Claude scores each unseen tweet against rubric.md so the
// weekly list holds content ideas, not whatever went viral worldwide.
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { config, PACKAGE_ROOT } from './config.js';
import type { Tweet, Verdict } from './tweets.js';

export type { Verdict };

export const RUBRIC_FILE = path.join(PACKAGE_ROOT, 'rubric.md');

export function loadRubric(file: string = RUBRIC_FILE): string {
  return fs.readFileSync(file, 'utf-8');
}

const CATEGORIES = ['Everyday UX', 'AI at work', 'Work culture', 'LinkedIn classic', 'Communication', 'Off-topic'];

// Strict schema so the response parses every time; the model cannot wander.
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          relevant: { type: 'boolean' },
          category: { type: 'string', enum: CATEGORIES },
          // enum rather than minimum/maximum: the API rejects range keywords on integers
          score: { type: 'integer', enum: [1, 2, 3, 4, 5] },
          reason: { type: 'string' },
        },
        required: ['id', 'relevant', 'category', 'score', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
} as const;

export function systemPrompt(rubric: string): string {
  return `${rubric.trim()}

You will receive a numbered batch of posts, each with an id, author, like count, text and (usually) its first image. Return one verdict per post, using the exact id given. "relevant" is true when score is 3 or more. "reason" is one short sentence a content creator can read as the angle, e.g. "a fridge magnet that nudges people to waste less food".`;
}

// pbs.twimg.com serves size variants; "small" (max 680px) is plenty to judge a
// post and keeps image tokens low.
export function smallImageUrl(url: string): string {
  return url.includes('?') ? `${url}&name=small` : `${url}?name=small`;
}

export function buildBatchContent(tweets: Tweet[], withImages: boolean): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  tweets.forEach((t, i) => {
    const text = t.text ? t.text : '(no text, image only)';
    blocks.push({
      type: 'text',
      text: `--- Post ${i + 1} ---\nid: ${t.id}\nauthor: @${t.handle} (${t.name})\nlikes: ${t.likes}\ntext: ${text}`,
    });
    if (withImages && t.imageUrls[0]) {
      blocks.push({ type: 'image', source: { type: 'url', url: smallImageUrl(t.imageUrls[0]) } });
    }
  });
  blocks.push({ type: 'text', text: `Return verdicts for all ${tweets.length} posts.` });
  return blocks;
}

// Tolerant reader: keeps only verdicts for ids we asked about, clamps the score
// and derives "relevant" from it so the two can never disagree.
export function parseVerdicts(raw: unknown, ids: string[]): Verdict[] {
  const wanted = new Set(ids);
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { verdicts?: unknown }).verdicts)
    ? ((raw as { verdicts: unknown[] }).verdicts)
    : [];
  const out: Verdict[] = [];
  for (const v of list) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const id = String(o.id ?? '');
    if (!wanted.has(id)) continue;
    const score = Math.min(5, Math.max(1, Math.round(Number(o.score) || 1)));
    out.push({
      id,
      relevant: score >= 3,
      category: typeof o.category === 'string' ? o.category : 'Off-topic',
      score,
      reason: typeof o.reason === 'string' ? o.reason.trim() : '',
    });
  }
  return out;
}

// Relevant tweets, verdict attached, ranked by likes (they are bangers first).
export function applyVerdicts(tweets: Tweet[], verdicts: Verdict[], minScore: number): Tweet[] {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  return tweets
    .map((t) => ({ ...t, verdict: byId.get(t.id) }))
    .filter((t): t is Tweet & { verdict: Verdict } => !!t.verdict && t.verdict.score >= minScore)
    .sort((a, b) => b.likes - a.likes);
}

// The model call is injected so the batching logic is testable without the API.
export type ModelCall = (system: string, content: Anthropic.ContentBlockParam[]) => Promise<unknown>;

export function anthropicCall(model: string): ModelCall {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  return async (system, content) => {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      system,
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
    });
    const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    return JSON.parse(text);
  };
}

export const BATCH_SIZE = 10;

export async function classifyTweets(
  tweets: Tweet[],
  rubric: string,
  call: ModelCall,
  batchSize: number = BATCH_SIZE,
): Promise<Verdict[]> {
  const system = systemPrompt(rubric);
  const verdicts: Verdict[] = [];
  for (let i = 0; i < tweets.length; i += batchSize) {
    const batch = tweets.slice(i, i + batchSize);
    const ids = batch.map((t) => t.id);
    let raw: unknown;
    try {
      raw = await call(system, buildBatchContent(batch, true));
    } catch (err) {
      // A single unreachable image fails the whole request; text-only is a
      // worse judgement but far better than losing the batch.
      console.warn(`Classifier batch ${i / batchSize + 1} failed with images, retrying text-only: ${(err as Error).message}`);
      raw = await call(system, buildBatchContent(batch, false));
    }
    verdicts.push(...parseVerdicts(raw, ids));
  }
  return verdicts;
}
