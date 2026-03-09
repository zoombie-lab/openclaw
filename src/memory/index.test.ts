import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

let embedBatchCalls = 0;
let failEmbeddings = false;

vi.mock("./embeddings.js", () => {
  const embedText = (text: string) => {
    const lower = text.toLowerCase();
    const alpha = lower.split("alpha").length - 1;
    const beta = lower.split("beta").length - 1;
    return [alpha, beta];
  };
  return {
    createEmbeddingProvider: async (options: { model?: string }) => ({
      requestedProvider: "openai",
      provider: {
        id: "mock",
        model: options.model ?? "mock-embed",
        embedQuery: async (text: string) => embedText(text),
        embedBatch: async (texts: string[]) => {
          embedBatchCalls += 1;
          if (failEmbeddings) {
            throw new Error("mock embeddings failed");
          }
          return texts.map(embedText);
        },
      },
    }),
  };
});

describe("memory index", () => {
  let workspaceDir: string;
  let indexPath: string;
  let stateDir: string;
  let previousStateDir: string | undefined;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    embedBatchCalls = 0;
    failEmbeddings = false;
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.\nAnother line.",
    );
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Beta knowledge base entry.");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  const buildSessionsConfig = (overrides?: {
    sources?: Array<"memory" | "sessions">;
    extraPaths?: string[];
    sessionStorePath?: string;
    query?: Record<string, unknown>;
  }) => ({
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: { path: indexPath, vector: { enabled: false } },
          experimental: { sessionMemory: true },
          sources: overrides?.sources ?? ["memory", "sessions"],
          extraPaths: overrides?.extraPaths,
          sync: { watch: false, onSessionStart: false, onSearch: true },
          query: { minScore: 0, ...overrides?.query },
        },
      },
      list: [{ id: "main", default: true }],
    },
    ...(overrides?.sessionStorePath ? { session: { store: overrides.sessionStorePath } } : {}),
  });

  async function writeSessionStore(storePath: string, payload: Record<string, unknown>) {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(payload, null, 2), "utf-8");
  }

  it("indexes memory files and searches by vector", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0 },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await result.manager.sync({ force: true });
    const results = await result.manager.search("alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toContain("memory/2026-01-12.md");
    const status = result.manager.status();
    expect(status.sourceCounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "memory",
          files: status.files,
          chunks: status.chunks,
        }),
      ]),
    );
  });

  it("reindexes when the embedding model changes", async () => {
    const base = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0 },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const first = await getMemorySearchManager({
      cfg: {
        ...base,
        agents: {
          ...base.agents,
          defaults: {
            ...base.agents.defaults,
            memorySearch: {
              ...base.agents.defaults.memorySearch,
              model: "mock-embed-v1",
            },
          },
        },
      },
      agentId: "main",
    });
    expect(first.manager).not.toBeNull();
    if (!first.manager) {
      throw new Error("manager missing");
    }
    await first.manager.sync({ force: true });
    await first.manager.close();

    const second = await getMemorySearchManager({
      cfg: {
        ...base,
        agents: {
          ...base.agents,
          defaults: {
            ...base.agents.defaults,
            memorySearch: {
              ...base.agents.defaults.memorySearch,
              model: "mock-embed-v2",
            },
          },
        },
      },
      agentId: "main",
    });
    expect(second.manager).not.toBeNull();
    if (!second.manager) {
      throw new Error("manager missing");
    }
    manager = second.manager;
    await second.manager.sync({ reason: "test" });
    const results = await second.manager.search("alpha");
    expect(results.length).toBeGreaterThan(0);
  });

  it("reuses cached embeddings on forced reindex", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0 },
            cache: { enabled: true },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await manager.sync({ force: true });
    const afterFirst = embedBatchCalls;
    expect(afterFirst).toBeGreaterThan(0);

    await manager.sync({ force: true });
    expect(embedBatchCalls).toBe(afterFirst);
  });

  it("preserves existing index when forced reindex fails", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0 },
            cache: { enabled: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    await manager.sync({ force: true });
    const before = manager.status();
    expect(before.files).toBeGreaterThan(0);

    failEmbeddings = true;
    await expect(manager.sync({ force: true })).rejects.toThrow(/mock embeddings failed/i);

    const after = manager.status();
    expect(after.files).toBe(before.files);
    expect(after.chunks).toBe(before.chunks);

    const files = await fs.readdir(workspaceDir);
    expect(files.some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("finds keyword matches via hybrid search when query embedding is zero", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: {
              minScore: 0,
              hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    const status = manager.status();
    if (!status.fts?.available) {
      return;
    }

    await manager.sync({ force: true });
    const results = await manager.search("zebra");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toContain("memory/2026-01-12.md");
  });

  it("hybrid weights can favor vector-only matches over keyword-only matches", async () => {
    const manyAlpha = Array.from({ length: 200 }, () => "Alpha").join(" ");
    await fs.writeFile(
      path.join(workspaceDir, "memory", "vector-only.md"),
      "Alpha beta. Alpha beta. Alpha beta. Alpha beta.",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "keyword-only.md"),
      `${manyAlpha} beta id123.`,
    );

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: {
              minScore: 0,
              maxResults: 200,
              hybrid: {
                enabled: true,
                vectorWeight: 0.99,
                textWeight: 0.01,
                candidateMultiplier: 10,
              },
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    const status = manager.status();
    if (!status.fts?.available) {
      return;
    }

    await manager.sync({ force: true });
    const results = await manager.search("alpha beta id123");
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map((r) => r.path);
    expect(paths).toContain("memory/vector-only.md");
    expect(paths).toContain("memory/keyword-only.md");
    const vectorOnly = results.find((r) => r.path === "memory/vector-only.md");
    const keywordOnly = results.find((r) => r.path === "memory/keyword-only.md");
    expect((vectorOnly?.score ?? 0) > (keywordOnly?.score ?? 0)).toBe(true);
  });

  it("hybrid weights can favor keyword matches when text weight dominates", async () => {
    const manyAlpha = Array.from({ length: 200 }, () => "Alpha").join(" ");
    await fs.writeFile(
      path.join(workspaceDir, "memory", "vector-only.md"),
      "Alpha beta. Alpha beta. Alpha beta. Alpha beta.",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "keyword-only.md"),
      `${manyAlpha} beta id123.`,
    );

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: {
              minScore: 0,
              maxResults: 200,
              hybrid: {
                enabled: true,
                vectorWeight: 0.01,
                textWeight: 0.99,
                candidateMultiplier: 10,
              },
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    const status = manager.status();
    if (!status.fts?.available) {
      return;
    }

    await manager.sync({ force: true });
    const results = await manager.search("alpha beta id123");
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map((r) => r.path);
    expect(paths).toContain("memory/vector-only.md");
    expect(paths).toContain("memory/keyword-only.md");
    const vectorOnly = results.find((r) => r.path === "memory/vector-only.md");
    const keywordOnly = results.find((r) => r.path === "memory/keyword-only.md");
    expect((keywordOnly?.score ?? 0) > (vectorOnly?.score ?? 0)).toBe(true);
  });

  it("reports vector availability after probe", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    const available = await result.manager.probeVectorAvailability();
    const status = result.manager.status();
    expect(status.vector?.enabled).toBe(true);
    expect(typeof status.vector?.available).toBe("boolean");
    expect(status.vector?.available).toBe(available);
  });

  it("rejects reading non-memory paths", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: true },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await expect(result.manager.readFile({ relPath: "NOTES.md" })).rejects.toThrow("path required");
  });

  it("allows reading from additional memory paths and blocks symlinks", async () => {
    const extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "extra.md"), "Extra content.");

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            extraPaths: [extraDir],
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await expect(result.manager.readFile({ relPath: "extra/extra.md" })).resolves.toEqual({
      path: "extra/extra.md",
      text: "Extra content.",
    });

    const linkPath = path.join(extraDir, "linked.md");
    let symlinkOk = true;
    try {
      await fs.symlink(path.join(extraDir, "extra.md"), linkPath, "file");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        symlinkOk = false;
      } else {
        throw err;
      }
    }
    if (symlinkOk) {
      await expect(result.manager.readFile({ relPath: "extra/linked.md" })).rejects.toThrow(
        "path required",
      );
    }
  });

  it("discovers recursive history jsonl files and dedupes normalized session paths", async () => {
    const historyFile = path.join(
      stateDir,
      "workspace",
      "history",
      "slack",
      "channel-one",
      "2026-03-01_alice_1700000000.000001.jsonl",
    );
    const legacyFile = path.join(stateDir, "agents", "main", "sessions", "legacy-thread.jsonl");
    await fs.mkdir(path.dirname(historyFile), { recursive: true });
    await fs.mkdir(path.dirname(legacyFile), { recursive: true });
    await fs.writeFile(
      historyFile,
      `${JSON.stringify({
        type: "message",
        username: "alice",
        user: "U1",
        text: "alpha recursive history entry",
        ts: "1700000000.000001",
        thread_ts: "1700000000.000001",
      })}\n`,
      "utf-8",
    );
    await fs.writeFile(
      legacyFile,
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "alpha legacy transcript" }],
        },
      })}\n`,
      "utf-8",
    );

    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const normalizedHistoryViaDotSegments = path.join(
      path.dirname(historyFile),
      "..",
      path.basename(path.dirname(historyFile)),
      path.basename(historyFile),
    );
    await writeSessionStore(storePath, {
      "agent:main:slack:channel:c1": {
        sessionId: "s1",
        sessionFile: normalizedHistoryViaDotSegments,
      },
    });

    const cfg = buildSessionsConfig({
      sources: ["sessions"],
      sessionStorePath: storePath,
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await manager.sync({ force: true });

    const status = manager.status();
    const sessionsSource = status.sourceCounts?.find((entry) => entry.source === "sessions");
    expect(sessionsSource?.files).toBe(2);
    expect(status.sessions?.discovery?.candidateFiles).toBe(2);

    const results = await manager.search("alpha", { maxResults: 10, minScore: 0 });
    expect(results.some((entry) => entry.path.includes("sessions/history/slack/channel-one"))).toBe(
      true,
    );
    expect(results.every((entry) => !entry.path.includes(".."))).toBe(true);
  });

  it("parses both openclaw and raw slack jsonl records with labels and timestamps", async () => {
    const historyFile = path.join(
      stateDir,
      "workspace",
      "history",
      "slack",
      "dm-bob",
      "2026-03-05_1700000100.000001.jsonl",
    );
    await fs.mkdir(path.dirname(historyFile), { recursive: true });
    const fixture = await fs.readFile(
      new URL("./fixtures/session-mixed-format.jsonl", import.meta.url),
      "utf-8",
    );
    await fs.writeFile(historyFile, fixture, "utf-8");

    const cfg = buildSessionsConfig({ sources: ["sessions"] });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await manager.sync({ force: true });

    const results = await manager.search("alpha", { maxResults: 10, minScore: 0 });
    const snippets = results.map((entry) => entry.snippet).join("\n");
    expect(snippets).toContain("User: alpha openclaw user note");
    expect(snippets).toContain("Slack bob: alpha slack note");
    expect(snippets).toContain("Slack bob: alpha slack edited note");

    const sessions = manager.status().sessions;
    expect((sessions?.datedChunks ?? 0) >= 3).toBe(true);
    expect((sessions?.latestMessageTs ?? 0) > (sessions?.earliestMessageTs ?? 0)).toBe(true);
  });

  it("applies time filters to candidate retrieval and excludes out-of-range session chunks", async () => {
    const historyFile = path.join(
      stateDir,
      "workspace",
      "history",
      "slack",
      "channel-two",
      "2026-03-06_1700000200.000001.jsonl",
    );
    await fs.mkdir(path.dirname(historyFile), { recursive: true });
    const fixture = await fs.readFile(
      new URL("./fixtures/slack-history-timefilter.jsonl", import.meta.url),
      "utf-8",
    );
    await fs.writeFile(historyFile, fixture, "utf-8");

    const cfg = buildSessionsConfig({ sources: ["sessions"] });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await manager.sync({ force: true });

    const baseline = await manager.search("alpha", { maxResults: 10, minScore: 0 });
    expect(baseline.some((entry) => entry.snippet.includes("older"))).toBe(true);
    expect(baseline.some((entry) => entry.snippet.includes("newer"))).toBe(true);

    const inRange = await manager.search("alpha", {
      maxResults: 10,
      minScore: 0,
      from: 1_750_000_000,
      to: 1_850_000_000,
      timezone: "America/New_York",
    });
    expect(inRange.length).toBeGreaterThan(0);
    expect(inRange.every((entry) => entry.snippet.includes("newer"))).toBe(true);

    const outOfRange = await manager.search("alpha", {
      maxResults: 10,
      minScore: 0,
      to: 1_750_000_000,
      timezone: "America/New_York",
    });
    expect(outOfRange.length).toBeGreaterThan(0);
    expect(outOfRange.every((entry) => entry.snippet.includes("older"))).toBe(true);
  });

  it("keeps static memory results when time filters are provided", async () => {
    const cfg = buildSessionsConfig({ sources: ["memory"] });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await manager.sync({ force: true });
    const filtered = await manager.search("beta", {
      maxResults: 10,
      minScore: 0,
      from: 1_750_000_000,
      to: 1_850_000_000,
    });
    expect(filtered.some((entry) => entry.path.includes("MEMORY.md"))).toBe(true);
  });

  it("applies date-only boundaries in the provided timezone", async () => {
    const historyFile = path.join(
      stateDir,
      "workspace",
      "history",
      "slack",
      "timezone-room",
      "2026-03-03_1772506800.000000.jsonl",
    );
    await fs.mkdir(path.dirname(historyFile), { recursive: true });
    await fs.writeFile(
      historyFile,
      `${JSON.stringify({
        type: "message",
        username: "alice",
        text: "alpha timezone boundary note",
        ts: "1772506800.000000",
      })}\n`,
      "utf-8",
    );

    const cfg = buildSessionsConfig({ sources: ["sessions"] });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await manager.sync({ force: true });

    const utcRange = await manager.search("alpha", {
      maxResults: 10,
      minScore: 0,
      from: "2026-03-02",
      to: "2026-03-02",
    });
    expect(utcRange.length).toBe(0);

    const tzRange = await manager.search("alpha", {
      maxResults: 10,
      minScore: 0,
      from: "2026-03-02",
      to: "2026-03-02",
      timezone: "America/New_York",
    });
    expect(tzRange.length).toBeGreaterThan(0);
    expect(tzRange.every((entry) => entry.snippet.includes("timezone boundary"))).toBe(true);
  });

  it("preserves millisecond session timestamps before year 2001", async () => {
    const historyFile = path.join(
      stateDir,
      "workspace",
      "history",
      "slack",
      "legacy-ms",
      "1998-07-09_900000000000.jsonl",
    );
    await fs.mkdir(path.dirname(historyFile), { recursive: true });
    await fs.writeFile(
      historyFile,
      `${JSON.stringify({
        type: "message",
        username: "alice",
        text: "alpha pre-2001 ms timestamp",
        ts: "900000000000",
      })}\n`,
      "utf-8",
    );

    const cfg = buildSessionsConfig({ sources: ["sessions"] });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await manager.sync({ force: true });

    const sessions = manager.status().sessions;
    expect(sessions?.latestMessageTs).toBe(900_000_000_000);
    const range = await manager.search("alpha", {
      maxResults: 10,
      minScore: 0,
      from: 899_999_999_000,
      to: 900_000_001_000,
    });
    expect(range.length).toBeGreaterThan(0);
  });

  it("reindexes sessions when only timestamps change", async () => {
    const historyFile = path.join(
      stateDir,
      "workspace",
      "history",
      "slack",
      "reindex-ts-only",
      "2026-03-07_1700000000.000000.jsonl",
    );
    await fs.mkdir(path.dirname(historyFile), { recursive: true });
    await fs.writeFile(
      historyFile,
      `${JSON.stringify({
        type: "message",
        username: "alice",
        text: "alpha timestamp-only-change",
        ts: "1700000000.000000",
      })}\n`,
      "utf-8",
    );

    const cfg = buildSessionsConfig({ sources: ["sessions"] });
    const first = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(first.manager).not.toBeNull();
    if (!first.manager) {
      throw new Error("manager missing");
    }
    manager = first.manager;
    await manager.sync({ force: true });
    const oldRange = await manager.search("alpha", {
      maxResults: 10,
      minScore: 0,
      from: 1_750_000_000,
      to: 1_850_000_000,
    });
    expect(oldRange.length).toBe(0);
    await manager.close();
    manager = null;

    await fs.writeFile(
      historyFile,
      `${JSON.stringify({
        type: "message",
        username: "alice",
        text: "alpha timestamp-only-change",
        ts: "1800000000.000000",
      })}\n`,
      "utf-8",
    );

    const second = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(second.manager).not.toBeNull();
    if (!second.manager) {
      throw new Error("manager missing");
    }
    manager = second.manager;
    await manager.sync({ reason: "search" });
    const newRange = await manager.search("alpha", {
      maxResults: 10,
      minScore: 0,
      from: 1_750_000_000,
      to: 1_850_000_000,
    });
    expect(newRange.length).toBeGreaterThan(0);
  });

  it("keeps noticeboard markdown search results working without time filters", async () => {
    const noticeboardDir = path.join(workspaceDir, "noticeboard");
    await fs.mkdir(noticeboardDir, { recursive: true });
    await fs.writeFile(
      path.join(noticeboardDir, "weekly.md"),
      "Alpha alpha alpha alpha alpha noticeboard updates.",
      "utf-8",
    );
    const cfg = buildSessionsConfig({
      sources: ["memory", "sessions"],
      extraPaths: [noticeboardDir],
    });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    await manager.sync({ force: true });
    const results = await manager.search("alpha", { maxResults: 10, minScore: 0 });
    expect(results.some((entry) => entry.path.includes("noticeboard/weekly.md"))).toBe(true);
  });
});
