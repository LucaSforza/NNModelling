import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ServerContext } from "../src/server";
import { RemoteTrainingClient } from "../src/remote-training";
import * as remoteTools from "../src/tools/remote-training";

function contextWithClient(): { ctx: ServerContext; client: Record<string, ReturnType<typeof vi.fn>> } {
  const client = {
    listComputeUnits: vi.fn().mockResolvedValue([{ id: "local" }]),
    listJobs: vi.fn().mockResolvedValue([]),
    getJob: vi.fn().mockResolvedValue({ id: "job-1" }),
    getLogs: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    getEvents: vi.fn().mockResolvedValue([]),
    cancelJob: vi.fn().mockResolvedValue({ id: "job-1", status: "cancelled" }),
  };
  const ctx = { remoteTraining: client as unknown as RemoteTrainingClient } as ServerContext;
  return { ctx, client };
}

describe("remote training MCP tools", () => {
  it("delegates status, logs, events and cancellation tools", async () => {
    const { ctx, client } = contextWithClient();

    await remoteTools.list_training_compute_units.handler(ctx);
    await remoteTools.list_training_jobs.handler(ctx);
    await remoteTools.get_training_job.handler(ctx, { jobId: "job-1" });
    await remoteTools.get_training_job_logs.handler(ctx, { jobId: "job-1" });
    await remoteTools.get_training_job_events.handler(ctx, { jobId: "job-1", after: "2-0" });
    await remoteTools.cancel_training_job.handler(ctx, { jobId: "job-1" });

    expect(client.listComputeUnits).toHaveBeenCalledOnce();
    expect(client.listJobs).toHaveBeenCalledOnce();
    expect(client.getJob).toHaveBeenCalledWith("job-1");
    expect(client.getLogs).toHaveBeenCalledWith("job-1");
    expect(client.getEvents).toHaveBeenCalledWith("job-1", "2-0");
    expect(client.cancelJob).toHaveBeenCalledWith("job-1");
  });
});

describe("remote wheel download contract", () => {
  it("passes packageName to the backend and saves the selected wheel name", async () => {
    const bytes = Buffer.from("wheel-bytes");
    const digest = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJson({ model_package: { version: "0.1.0" } }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { "x-nnm-sha256": digest } }));
    vi.stubGlobal("fetch", fetchMock);
    const root = await mkdtemp(`${tmpdir()}/nnm-wheel-artifact-`);
    const previousRoot = process.env.NNM_ARTIFACT_ROOT;
    process.env.NNM_ARTIFACT_ROOT = root;
    try {
      const result = await new RemoteTrainingClient("http://backend.test", "token").downloadWheel("job-1", "nnm_vae");
      expect(fetchMock.mock.calls[1]?.[0]).toBe("http://backend.test/jobs/job-1/package?packageName=nnm_vae");
      expect(result.artifact.path).toMatch(/nnm_vae-0\.1\.0-py3-none-any\.whl$/);
    } finally {
      if (previousRoot === undefined) delete process.env.NNM_ARTIFACT_ROOT;
      else process.env.NNM_ARTIFACT_ROOT = previousRoot;
      await rm(root, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });
});

describe("selected-editor training MCP tools", () => {
  it("keeps progress monitoring on the paired browser route", async () => {
    const call = vi.fn().mockResolvedValue({ status: "ok", job: { id: "job-1" } });
    const ctx = { browser: { call } } as unknown as ServerContext;

    const result = await remoteTools.read_editor_training_progress.handler(ctx, { jobId: "job-1", waitMs: 100 });

    expect(result).toEqual({ status: "ok", job: { id: "job-1" } });
    expect(call).toHaveBeenCalledWith("read_training_progress", { jobId: "job-1", waitMs: 100 });
  });

  it("writes a browser-verified wheel without returning its bytes", async () => {
    const root = await mkdtemp(`${tmpdir()}/nnm-editor-artifact-`);
    const bytes = Buffer.from("wheel-bytes");
    const call = vi.fn().mockResolvedValue({
      status: "ok",
      artifact: {
        filename: "nnm_test-0.1.0-py3-none-any.whl",
        bytes: bytes.length,
        sha256: "9ceb18f15662bb87e54af2f5953c0484d2ef76f5444d87913360b9ef87d7296d",
        base64: bytes.toString("base64"),
      },
    });
    const ctx = { browser: { call } } as unknown as ServerContext;
    const previousRoot = process.env.NNM_ARTIFACT_ROOT;
    process.env.NNM_ARTIFACT_ROOT = root;

    try {
      // The digest is asserted by the implementation; use the real value so
      // this test exercises the complete file-delivery path.
      const crypto = await import("node:crypto");
      const response = await remoteTools.download_editor_training_wheel.handler(ctx, { jobId: "job-1", packageName: "nnm_test" });
      expect(response).toMatchObject({ status: "ok", artifact: { path: expect.stringContaining(root), bytes: bytes.length } });
      expect(call).toHaveBeenCalledWith("download_training_wheel", { jobId: "job-1", packageName: "nnm_test" });
      expect(response).not.toHaveProperty("artifact.base64");
      expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe("9ceb18f15662bb87e54af2f5953c0484d2ef76f5444d87913360b9ef87d7296d");
    } finally {
      if (previousRoot === undefined) delete process.env.NNM_ARTIFACT_ROOT;
      else process.env.NNM_ARTIFACT_ROOT = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── Authentication parity contract ──────────────────────────────────────
//
// The browser client (TrainingApiClient in front-end/src/training/api.ts)
// sends `authorization: Bearer <token>` on every authenticated request, with
// the token injected from the pairing flow. The FastAPI backend enforces
// bearer auth for /jobs, /compute-units, logs and events. These
// tests pin the equivalent contract for the MCP RemoteTrainingClient: when a
// token is configured (constructor arg or NNM_BACKEND_TOKEN), every request —
// including the SSE events stream — carries the same Bearer header the
// browser sends. When no token is configured the header is omitted (behavior
// unchanged) and the backend rejects with 401.

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("RemoteTrainingClient authentication parity with the browser client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NNM_BACKEND_TOKEN;
  });

  function stubFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okJson({ status: "ok" })));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function capturedHeaders(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0): Headers {
    const [url, init] = fetchMock.mock.calls[callIndex] as [string, RequestInit | undefined];
    expect(url).toBeTruthy();
    return new Headers(init?.headers);
  }

  it("attaches the bearer token to every authenticated read endpoint", async () => {
    const fetchMock = stubFetch();
    const client = new RemoteTrainingClient("http://127.0.0.1:8000", "test-token");

    await client.listComputeUnits();
    await client.listJobs();
    await client.getJob("job-1");
    await client.getLogs("job-1");
    await client.cancelJob("job-1");

    for (let i = 0; i < fetchMock.mock.calls.length; i++) {
      const headers = capturedHeaders(fetchMock, i);
      expect(headers.get("authorization")).toBe("Bearer test-token");
    }
  });

  it("attaches the bearer token to the SSE events stream request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("data: {\"type\":\"running\"}\n\n", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new RemoteTrainingClient("http://127.0.0.1:8000", "test-token");

    await client.getEvents("job-1", "2-0");

    const headers = capturedHeaders(fetchMock);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("accept")).toBe("text/event-stream");
  });

  it("reads the token from NNM_BACKEND_TOKEN when no explicit token is given", async () => {
    const fetchMock = stubFetch();
    process.env.NNM_BACKEND_TOKEN = "env-token";
    const client = new RemoteTrainingClient("http://127.0.0.1:8000");

    await client.listJobs();

    const headers = capturedHeaders(fetchMock);
    expect(headers.get("authorization")).toBe("Bearer env-token");
  });

  it("omits the authorization header when no token is configured (unchanged behavior)", async () => {
    const fetchMock = stubFetch();
    const client = new RemoteTrainingClient("http://127.0.0.1:8000");

    await client.listJobs();

    const headers = capturedHeaders(fetchMock);
    expect(headers.get("authorization")).toBeNull();
  });

});
