import type { DatabaseSync } from "node:sqlite";
import type {
  EmbeddingProvider,
  GeminiEmbeddingClient,
  OpenAiEmbeddingClient,
  VoyageEmbeddingClient,
} from "./embeddings.js";
import type { SessionFileEntry } from "./manager-session-parse.js";
import type { MemorySource } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runGeminiEmbeddingBatches, type GeminiBatchRequest } from "./batch-gemini.js";
import {
  OPENAI_BATCH_ENDPOINT,
  type OpenAiBatchRequest,
  runOpenAiEmbeddingBatches,
} from "./batch-openai.js";
import { type VoyageBatchRequest, runVoyageEmbeddingBatches } from "./batch-voyage.js";
import { hashText, parseEmbedding, type MemoryChunk, type MemoryFileEntry } from "./internal.js";

const log = createSubsystemLogger("memory");

const EMBEDDING_BATCH_MAX_TOKENS = 8000;
const EMBEDDING_APPROX_CHARS_PER_TOKEN = 1;
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8000;
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_REMOTE_MS = 2 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_LOCAL_MS = 10 * 60_000;
const BATCH_FAILURE_LIMIT = 2;

export { BATCH_FAILURE_LIMIT };

export type BatchConfig = {
  enabled: boolean;
  wait: boolean;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
};

export type EmbeddingClients = {
  openAi?: OpenAiEmbeddingClient;
  gemini?: GeminiEmbeddingClient;
  voyage?: VoyageEmbeddingClient;
};

export type BatchFailureState = {
  count: number;
  lastError?: string;
  lastProvider?: string;
  lock: Promise<void>;
};

export type EmbeddingCacheConfig = {
  enabled: boolean;
  maxEntries?: number;
};

export const EMBEDDING_CACHE_TABLE = "embedding_cache";

// --- Timeout utility ---

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await promise;
  }
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return (await Promise.race([promise, timeoutPromise])) as T;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

// --- Embedding timeout resolution ---

export function resolveEmbeddingTimeout(providerId: string, kind: "query" | "batch"): number {
  const isLocal = providerId === "local";
  if (kind === "query") {
    return isLocal ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;
  }
  return isLocal ? EMBEDDING_BATCH_TIMEOUT_LOCAL_MS : EMBEDDING_BATCH_TIMEOUT_REMOTE_MS;
}

// --- Retryable error detection ---

export function isRetryableEmbeddingError(message: string): boolean {
  return /(rate[_ ]limit|too many requests|429|resource has been exhausted|5\d\d|cloudflare)/i.test(
    message,
  );
}

export function isBatchTimeoutError(message: string): boolean {
  return /timed out|timeout/i.test(message);
}

// --- Token estimation and batch building ---

function estimateEmbeddingTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / EMBEDDING_APPROX_CHARS_PER_TOKEN);
}

export function buildEmbeddingBatches(chunks: MemoryChunk[]): MemoryChunk[][] {
  const batches: MemoryChunk[][] = [];
  let current: MemoryChunk[] = [];
  let currentTokens = 0;

  for (const chunk of chunks) {
    const estimate = estimateEmbeddingTokens(chunk.text);
    const wouldExceed = current.length > 0 && currentTokens + estimate > EMBEDDING_BATCH_MAX_TOKENS;
    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && estimate > EMBEDDING_BATCH_MAX_TOKENS) {
      batches.push([chunk]);
      continue;
    }
    current.push(chunk);
    currentTokens += estimate;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

// --- Embedding cache operations ---

export function loadEmbeddingCache(
  db: DatabaseSync,
  provider: EmbeddingProvider,
  providerKey: string,
  cacheEnabled: boolean,
  hashes: string[],
): Map<string, number[]> {
  if (!cacheEnabled) {
    return new Map();
  }
  if (hashes.length === 0) {
    return new Map();
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const hash of hashes) {
    if (!hash) {
      continue;
    }
    if (seen.has(hash)) {
      continue;
    }
    seen.add(hash);
    unique.push(hash);
  }
  if (unique.length === 0) {
    return new Map();
  }

  const out = new Map<string, number[]>();
  const baseParams = [provider.id, provider.model, providerKey];
  const batchSize = 400;
  for (let start = 0; start < unique.length; start += batchSize) {
    const batch = unique.slice(start, start + batchSize);
    const placeholders = batch.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE}\n` +
          ` WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
      )
      .all(...baseParams, ...batch) as Array<{ hash: string; embedding: string }>;
    for (const row of rows) {
      out.set(row.hash, parseEmbedding(row.embedding));
    }
  }
  return out;
}

export function upsertEmbeddingCache(
  db: DatabaseSync,
  provider: EmbeddingProvider,
  providerKey: string,
  cacheEnabled: boolean,
  entries: Array<{ hash: string; embedding: number[] }>,
): void {
  if (!cacheEnabled) {
    return;
  }
  if (entries.length === 0) {
    return;
  }
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)\n` +
      ` VALUES (?, ?, ?, ?, ?, ?, ?)\n` +
      ` ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET\n` +
      `   embedding=excluded.embedding,\n` +
      `   dims=excluded.dims,\n` +
      `   updated_at=excluded.updated_at`,
  );
  for (const entry of entries) {
    const embedding = entry.embedding ?? [];
    stmt.run(
      provider.id,
      provider.model,
      providerKey,
      entry.hash,
      JSON.stringify(embedding),
      embedding.length,
      now,
    );
  }
}

export function pruneEmbeddingCacheIfNeeded(db: DatabaseSync, cache: EmbeddingCacheConfig): void {
  if (!cache.enabled) {
    return;
  }
  const max = cache.maxEntries;
  if (!max || max <= 0) {
    return;
  }
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
    | { c: number }
    | undefined;
  const count = row?.c ?? 0;
  if (count <= max) {
    return;
  }
  const excess = count - max;
  db.prepare(
    `DELETE FROM ${EMBEDDING_CACHE_TABLE}\n` +
      ` WHERE rowid IN (\n` +
      `   SELECT rowid FROM ${EMBEDDING_CACHE_TABLE}\n` +
      `   ORDER BY updated_at ASC\n` +
      `   LIMIT ?\n` +
      ` )`,
  ).run(excess);
}

export function seedEmbeddingCache(
  db: DatabaseSync,
  sourceDb: DatabaseSync,
  cacheEnabled: boolean,
): void {
  if (!cacheEnabled) {
    return;
  }
  try {
    const rows = sourceDb
      .prepare(
        `SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM ${EMBEDDING_CACHE_TABLE}`,
      )
      .all() as Array<{
      provider: string;
      model: string;
      provider_key: string;
      hash: string;
      embedding: string;
      dims: number | null;
      updated_at: number;
    }>;
    if (!rows.length) {
      return;
    }
    const insert = db.prepare(
      `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
         embedding=excluded.embedding,
         dims=excluded.dims,
         updated_at=excluded.updated_at`,
    );
    db.exec("BEGIN");
    for (const row of rows) {
      insert.run(
        row.provider,
        row.model,
        row.provider_key,
        row.hash,
        row.embedding,
        row.dims,
        row.updated_at,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

// --- Batch embed with retry ---

export async function embedBatchWithRetry(
  provider: EmbeddingProvider,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  let attempt = 0;
  let delayMs = EMBEDDING_RETRY_BASE_DELAY_MS;
  while (true) {
    try {
      const timeoutMs = resolveEmbeddingTimeout(provider.id, "batch");
      log.debug("memory embeddings: batch start", {
        provider: provider.id,
        items: texts.length,
        timeoutMs,
      });
      return await withTimeout(
        provider.embedBatch(texts),
        timeoutMs,
        `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isRetryableEmbeddingError(message) || attempt >= EMBEDDING_RETRY_MAX_ATTEMPTS) {
        throw err;
      }
      const waitMs = Math.min(
        EMBEDDING_RETRY_MAX_DELAY_MS,
        Math.round(delayMs * (1 + Math.random() * 0.2)),
      );
      log.warn(`memory embeddings rate limited; retrying in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      delayMs *= 2;
      attempt += 1;
    }
  }
}

// --- Embed query with timeout ---

export async function embedQueryWithTimeout(
  provider: EmbeddingProvider,
  text: string,
): Promise<number[]> {
  const timeoutMs = resolveEmbeddingTimeout(provider.id, "query");
  log.debug("memory embeddings: query start", { provider: provider.id, timeoutMs });
  return await withTimeout(
    provider.embedQuery(text),
    timeoutMs,
    `memory embeddings query timed out after ${Math.round(timeoutMs / 1000)}s`,
  );
}

// --- Embed chunks (non-batch) ---

export async function embedChunksInBatches(
  db: DatabaseSync,
  provider: EmbeddingProvider,
  providerKey: string,
  cacheEnabled: boolean,
  chunks: MemoryChunk[],
): Promise<number[][]> {
  if (chunks.length === 0) {
    return [];
  }
  const cached = loadEmbeddingCache(
    db,
    provider,
    providerKey,
    cacheEnabled,
    chunks.map((chunk) => chunk.hash),
  );
  const embeddings: number[][] = Array.from({ length: chunks.length }, () => []);
  const missing: Array<{ index: number; chunk: MemoryChunk }> = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const hit = chunk?.hash ? cached.get(chunk.hash) : undefined;
    if (hit && hit.length > 0) {
      embeddings[i] = hit;
    } else if (chunk) {
      missing.push({ index: i, chunk });
    }
  }

  if (missing.length === 0) {
    return embeddings;
  }

  const missingChunks = missing.map((m) => m.chunk);
  const batches = buildEmbeddingBatches(missingChunks);
  const toCache: Array<{ hash: string; embedding: number[] }> = [];
  let cursor = 0;
  for (const batch of batches) {
    const batchEmbeddings = await embedBatchWithRetry(
      provider,
      batch.map((chunk) => chunk.text),
    );
    for (let i = 0; i < batch.length; i += 1) {
      const item = missing[cursor + i];
      const embedding = batchEmbeddings[i] ?? [];
      if (item) {
        embeddings[item.index] = embedding;
        toCache.push({ hash: item.chunk.hash, embedding });
      }
    }
    cursor += batch.length;
  }
  upsertEmbeddingCache(db, provider, providerKey, cacheEnabled, toCache);
  return embeddings;
}

// --- Batch failure tracking ---

export async function withBatchFailureLock<T>(
  state: BatchFailureState,
  fn: () => Promise<T>,
): Promise<T> {
  let release: () => void;
  const wait = state.lock;
  state.lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await wait;
  try {
    return await fn();
  } finally {
    release!();
  }
}

export async function resetBatchFailureCount(state: BatchFailureState): Promise<void> {
  await withBatchFailureLock(state, async () => {
    if (state.count > 0) {
      log.debug("memory embeddings: batch recovered; resetting failure count");
    }
    state.count = 0;
    state.lastError = undefined;
    state.lastProvider = undefined;
  });
}

export async function recordBatchFailure(
  state: BatchFailureState,
  batch: BatchConfig,
  params: {
    provider: string;
    message: string;
    attempts?: number;
    forceDisable?: boolean;
  },
): Promise<{ disabled: boolean; count: number }> {
  return await withBatchFailureLock(state, async () => {
    if (!batch.enabled) {
      return { disabled: true, count: state.count };
    }
    const increment = params.forceDisable ? BATCH_FAILURE_LIMIT : Math.max(1, params.attempts ?? 1);
    state.count += increment;
    state.lastError = params.message;
    state.lastProvider = params.provider;
    const disabled = params.forceDisable || state.count >= BATCH_FAILURE_LIMIT;
    if (disabled) {
      batch.enabled = false;
    }
    return { disabled, count: state.count };
  });
}

// --- Batch with timeout retry ---

export async function runBatchWithTimeoutRetry<T>(params: {
  provider: string;
  run: () => Promise<T>;
}): Promise<T> {
  try {
    return await params.run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isBatchTimeoutError(message)) {
      log.warn(`memory embeddings: ${params.provider} batch timed out; retrying once`);
      try {
        return await params.run();
      } catch (retryErr) {
        (retryErr as { batchAttempts?: number }).batchAttempts = 2;
        throw retryErr;
      }
    }
    throw err;
  }
}

// --- Batch with fallback ---

export async function runBatchWithFallback<T>(params: {
  provider: string;
  batch: BatchConfig;
  failureState: BatchFailureState;
  run: () => Promise<T>;
  fallback: () => Promise<number[][]>;
}): Promise<T | number[][]> {
  if (!params.batch.enabled) {
    return await params.fallback();
  }
  try {
    const result = await runBatchWithTimeoutRetry({
      provider: params.provider,
      run: params.run,
    });
    await resetBatchFailureCount(params.failureState);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = (err as { batchAttempts?: number }).batchAttempts ?? 1;
    const forceDisable = /asyncBatchEmbedContent not available/i.test(message);
    const failure = await recordBatchFailure(params.failureState, params.batch, {
      provider: params.provider,
      message,
      attempts,
      forceDisable,
    });
    const suffix = failure.disabled ? "disabling batch" : "keeping batch enabled";
    log.warn(
      `memory embeddings: ${params.provider} batch failed (${failure.count}/${BATCH_FAILURE_LIMIT}); ${suffix}; falling back to non-batch embeddings: ${message}`,
    );
    return await params.fallback();
  }
}

// --- Provider-specific batch embedding (unified) ---

type ProviderBatchContext = {
  db: DatabaseSync;
  provider: EmbeddingProvider;
  providerKey: string;
  cacheEnabled: boolean;
  agentId: string;
  batch: BatchConfig;
  failureState: BatchFailureState;
};

function resolveChunkCacheMisses(
  db: DatabaseSync,
  provider: EmbeddingProvider,
  providerKey: string,
  cacheEnabled: boolean,
  chunks: MemoryChunk[],
): {
  embeddings: number[][];
  missing: Array<{ index: number; chunk: MemoryChunk }>;
} {
  const cached = loadEmbeddingCache(
    db,
    provider,
    providerKey,
    cacheEnabled,
    chunks.map((c) => c.hash),
  );
  const embeddings: number[][] = Array.from({ length: chunks.length }, () => []);
  const missing: Array<{ index: number; chunk: MemoryChunk }> = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const hit = chunk?.hash ? cached.get(chunk.hash) : undefined;
    if (hit && hit.length > 0) {
      embeddings[i] = hit;
    } else if (chunk) {
      missing.push({ index: i, chunk });
    }
  }
  return { embeddings, missing };
}

function buildCustomIdMapping(
  missing: Array<{ index: number; chunk: MemoryChunk }>,
  source: MemorySource,
  entryPath: string,
): Map<string, { index: number; hash: string }> {
  const mapping = new Map<string, { index: number; hash: string }>();
  for (const item of missing) {
    const chunk = item.chunk;
    const customId = hashText(
      `${source}:${entryPath}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${item.index}`,
    );
    mapping.set(customId, { index: item.index, hash: chunk.hash });
  }
  return mapping;
}

function applyBatchResults(
  embeddings: number[][],
  mapping: Map<string, { index: number; hash: string }>,
  byCustomId: Map<string, number[]>,
  ctx: ProviderBatchContext,
): void {
  const toCache: Array<{ hash: string; embedding: number[] }> = [];
  for (const [customId, embedding] of byCustomId.entries()) {
    const mapped = mapping.get(customId);
    if (!mapped) {
      continue;
    }
    embeddings[mapped.index] = embedding;
    toCache.push({ hash: mapped.hash, embedding });
  }
  upsertEmbeddingCache(ctx.db, ctx.provider, ctx.providerKey, ctx.cacheEnabled, toCache);
}

export async function embedChunksWithBatch(
  ctx: ProviderBatchContext,
  clients: EmbeddingClients,
  chunks: MemoryChunk[],
  entry: MemoryFileEntry | SessionFileEntry,
  source: MemorySource,
): Promise<number[][]> {
  if (chunks.length === 0) {
    return [];
  }
  const { embeddings, missing } = resolveChunkCacheMisses(
    ctx.db,
    ctx.provider,
    ctx.providerKey,
    ctx.cacheEnabled,
    chunks,
  );
  if (missing.length === 0) {
    return embeddings;
  }

  const mapping = buildCustomIdMapping(missing, source, entry.path);
  const fallback = async () =>
    await embedChunksInBatches(ctx.db, ctx.provider, ctx.providerKey, ctx.cacheEnabled, chunks);

  const debugFn = (message: string, data?: Record<string, unknown>) =>
    log.debug(message, { ...data, source, chunks: chunks.length });

  const batchParams = {
    agentId: ctx.agentId,
    wait: ctx.batch.wait,
    concurrency: ctx.batch.concurrency,
    pollIntervalMs: ctx.batch.pollIntervalMs,
    timeoutMs: ctx.batch.timeoutMs,
    debug: debugFn,
  };

  let batchResult: Map<string, number[]> | number[][];

  if (ctx.provider.id === "voyage" && clients.voyage) {
    const requests: VoyageBatchRequest[] = missing.map((item) => {
      const customId = [...mapping.entries()].find(([, v]) => v.index === item.index)?.[0] ?? "";
      return { custom_id: customId, body: { input: item.chunk.text } };
    });
    batchResult = await runBatchWithFallback({
      provider: "voyage",
      batch: ctx.batch,
      failureState: ctx.failureState,
      run: async () =>
        await runVoyageEmbeddingBatches({ client: clients.voyage!, requests, ...batchParams }),
      fallback,
    });
  } else if (ctx.provider.id === "openai" && clients.openAi) {
    const requests: OpenAiBatchRequest[] = missing.map((item) => {
      const customId = [...mapping.entries()].find(([, v]) => v.index === item.index)?.[0] ?? "";
      return {
        custom_id: customId,
        method: "POST" as const,
        url: OPENAI_BATCH_ENDPOINT,
        body: { model: clients.openAi?.model ?? ctx.provider.model, input: item.chunk.text },
      };
    });
    batchResult = await runBatchWithFallback({
      provider: "openai",
      batch: ctx.batch,
      failureState: ctx.failureState,
      run: async () =>
        await runOpenAiEmbeddingBatches({ openAi: clients.openAi!, requests, ...batchParams }),
      fallback,
    });
  } else if (ctx.provider.id === "gemini" && clients.gemini) {
    const requests: GeminiBatchRequest[] = missing.map((item) => {
      const customId = [...mapping.entries()].find(([, v]) => v.index === item.index)?.[0] ?? "";
      return {
        custom_id: customId,
        content: { parts: [{ text: item.chunk.text }] },
        taskType: "RETRIEVAL_DOCUMENT" as const,
      };
    });
    batchResult = await runBatchWithFallback({
      provider: "gemini",
      batch: ctx.batch,
      failureState: ctx.failureState,
      run: async () =>
        await runGeminiEmbeddingBatches({ gemini: clients.gemini!, requests, ...batchParams }),
      fallback,
    });
  } else {
    return fallback();
  }

  if (Array.isArray(batchResult)) {
    return batchResult;
  }
  applyBatchResults(embeddings, mapping, batchResult, ctx);
  return embeddings;
}

// --- Provider key computation ---

export function computeProviderKey(provider: EmbeddingProvider, clients: EmbeddingClients): string {
  if (provider.id === "openai" && clients.openAi) {
    const entries = Object.entries(clients.openAi.headers)
      .filter(([key]) => key.toLowerCase() !== "authorization")
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, value]);
    return hashText(
      JSON.stringify({
        provider: "openai",
        baseUrl: clients.openAi.baseUrl,
        model: clients.openAi.model,
        headers: entries,
      }),
    );
  }
  if (provider.id === "gemini" && clients.gemini) {
    const entries = Object.entries(clients.gemini.headers)
      .filter(([key]) => {
        const lower = key.toLowerCase();
        return lower !== "authorization" && lower !== "x-goog-api-key";
      })
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, value]);
    return hashText(
      JSON.stringify({
        provider: "gemini",
        baseUrl: clients.gemini.baseUrl,
        model: clients.gemini.model,
        headers: entries,
      }),
    );
  }
  return hashText(JSON.stringify({ provider: provider.id, model: provider.model }));
}
