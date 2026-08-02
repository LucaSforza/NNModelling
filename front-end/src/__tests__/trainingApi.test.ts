import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackendApiError,
  SseParser,
  TrainingApiClient,
  buildTrainingRequest,
  canCancelTrainingJob,
  type TrainingRequestBuildInput,
} from "../training/api";
import { trainingLogWindowUrl } from "../training/windows";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("training job actions", () => {
  it("allows cancellation before and during execution", () => {
    expect(canCancelTrainingJob("queued")).toBe(true);
    expect(canCancelTrainingJob("running")).toBe(true);
  });

  it("does not offer cancellation for terminal jobs", () => {
    expect(canCancelTrainingJob("succeeded")).toBe(false);
    expect(canCancelTrainingJob("failed")).toBe(false);
    expect(canCancelTrainingJob("cancelled")).toBe(false);
  });
});

describe("authenticated training API", () => {
  it("sends the bearer token in headers and never in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");

    await api.listTrainingJobs();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend.lan:8000/jobs");
    expect(url).not.toContain("very-secret-token");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer very-secret-token");
  });

  it("submits the requested nnm-prefixed package name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");

    await api.submitTrainingJob({
      schema_version: 1,
      network: { format: "nntree", value: {} },
      training: {},
      resources: {},
      priority: 0,
      package_name: "nnm_mnist_classifier",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ package_name: "nnm_mnist_classifier" });
  });

  it("exposes machine-readable authentication errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: "session_expired", message: "expired" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ));
    const api = new TrainingApiClient("http://backend.lan:8000", "expired-token");

    await expect(api.getSession()).rejects.toMatchObject<Partial<BackendApiError>>({
      status: 401,
      code: "session_expired",
    });
  });

  it("requests incremental job logs with authenticated byte cursors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ stdout: {}, stderr: {} }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");

    await api.tailTrainingJobLogs("job-1", 42, 7);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend.lan:8000/jobs/job-1/logs/tail?stdout_after=42&stderr_after=7");
    expect(url).not.toContain("very-secret-token");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer very-secret-token");
  });

  it("downloads and verifies an exported model wheel with the bearer token", async () => {
    const expected = await sha256Hex("wheel");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("wheel", {
        status: 200,
        headers: { "content-type": "application/octet-stream", "x-nnm-sha256": expected },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");

    const wheel = await api.downloadModelPackage("job-1", expected);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend.lan:8000/jobs/job-1/package");
    expect(url).not.toContain("very-secret-token");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer very-secret-token");
    expect(await wheel.text()).toBe("wheel");
  });

  it("rejects a package whose body digest does not match the manifest", async () => {
    const expected = await sha256Hex("pristine-wheel");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("corrupted-bytes", {
        status: 200,
        headers: { "content-type": "application/octet-stream", "x-nnm-sha256": expected },
      }),
    ));
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");

    await expect(api.downloadModelPackage("job-1", expected)).rejects.toMatchObject<Partial<BackendApiError>>({
      status: 502,
      code: "package_corrupted",
    });
  });

  it("rejects when the server header digest contradicts the manifest digest", async () => {
    const expected = await sha256Hex("wheel");
    const other = await sha256Hex("different-wheel");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("wheel", {
        status: 200,
        headers: { "content-type": "application/octet-stream", "x-nnm-sha256": other },
      }),
    ));
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");

    await expect(api.downloadModelPackage("job-1", expected)).rejects.toMatchObject<Partial<BackendApiError>>({
      status: 502,
      code: "package_digest_mismatch",
    });
  });

  it("rejects when the server omits the integrity header", async () => {
    const expected = await sha256Hex("wheel");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("wheel", { status: 200, headers: { "content-type": "application/octet-stream" } }),
    ));
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");

    await expect(api.downloadModelPackage("job-1", expected)).rejects.toMatchObject<Partial<BackendApiError>>({
      status: 502,
      code: "package_digest_missing",
    });
  });

  it("rejects when the server integrity header is malformed", async () => {
    const expected = await sha256Hex("wheel");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("wheel", {
        status: 200,
        headers: { "content-type": "application/octet-stream", "x-nnm-sha256": "not-a-sha256" },
      }),
    ));
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");

    await expect(api.downloadModelPackage("job-1", expected)).rejects.toMatchObject<Partial<BackendApiError>>({
      status: 502,
      code: "package_digest_invalid",
    });
  });

  it("rejects a malformed manifest digest before contacting the backend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");

    await expect(api.downloadModelPackage("job-1", "cazz")).rejects.toMatchObject<Partial<BackendApiError>>({
      status: 400,
      code: "invalid_expected_digest",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to download a package without a backend token", async () => {
    const expected = await sha256Hex("wheel");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = new TrainingApiClient("http://backend.lan:8000");

    await expect(api.downloadModelPackage("job-1", expected)).rejects.toMatchObject<Partial<BackendApiError>>({
      status: 401,
      code: "missing_token",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses the verified download before fetching when Web Crypto is unavailable", async () => {
    const expected = await sha256Hex("wheel");
    const fetchMock = vi.fn();
    vi.stubGlobal("crypto", {});
    vi.stubGlobal("fetch", fetchMock);
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");

    const error = await api.downloadModelPackage("job-1", expected).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackendApiError);
    const apiError = error as BackendApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe("package_verification_unavailable");
    expect(apiError.message).toMatch(/HTTPS|localhost/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a rejecting Web Crypto digest to the same platform error after the download", async () => {
    const expected = await sha256Hex("wheel");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("wheel", {
        status: 200,
        headers: { "content-type": "application/octet-stream", "x-nnm-sha256": expected },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const digestMock = vi.fn().mockRejectedValue(new Error("crypto disabled by browser policy"));
    vi.stubGlobal("crypto", { subtle: { digest: digestMock } });
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");

    const error = await api.downloadModelPackage("job-1", expected).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackendApiError);
    const apiError = error as BackendApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe("package_verification_unavailable");
    expect(apiError.message).toMatch(/HTTPS|localhost/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(digestMock).toHaveBeenCalledWith("SHA-256", expect.any(Uint8Array));
  });
});

describe("training companion windows", () => {
  it("opens the log viewer without putting credentials in its URL", () => {
    expect(trainingLogWindowUrl("http://editor.lan:5174/?diagram=mnist", "job-1")).toBe(
      "http://editor.lan:5174/?diagram=mnist&training-log=job-1",
    );
  });
});

function buildInput(overrides: Partial<TrainingRequestBuildInput> = {}): TrainingRequestBuildInput {
  return {
    nntree: { nodes: [], edges: [] },
    datasetTarget: "dataset.mnist.MNISTDataset",
    datasetParams: {},
    numClasses: 10,
    batchSize: 32,
    numWorkers: 4,
    trainSize: 0.8,
    optimizerTarget: "torch.optim.Adam",
    learningRate: 0.001,
    maxEpochs: 20,
    accelerator: "auto",
    seed: 42,
    wandb: { project: "NeuralNetworks", mode: "online" },
    earlyStopping: { patience: 3, min_delta: 0.0 },
    overrides: [],
    resources: { cpu: 4, memory_gb: 8, gpu: 0 },
    priority: 0,
    packageName: null,
    projectId: null,
    ...overrides,
  };
}

describe("project-aware training requests", () => {
  it("includes project_id in the payload only for an active local project", () => {
    const request = buildTrainingRequest(buildInput({ projectId: "proj-123" }));
    expect(request.project_id).toBe("proj-123");
  });

  it("omits project_id when no project context exists", () => {
    const request = buildTrainingRequest(buildInput({ projectId: null }));
    expect(request.project_id).toBeUndefined();
  });

  it("submits project_id through the authenticated client without leaking it in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "job-1" }), { status: 202, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");

    await api.submitTrainingJob(buildTrainingRequest(buildInput({ projectId: "proj-123" })));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend.lan:8000/jobs");
    expect(url).not.toContain("proj-123");
    expect(JSON.parse(String(init.body))).toMatchObject({ project_id: "proj-123" });
  });

  it("sends W&B entity/tags/name only when configured", () => {
    const full = buildTrainingRequest(
      buildInput({ wandb: { project: "NeuralNetworks", mode: "online", entity: "team", tags: ["prod"], name: "run-{epoch}" } }),
    );
    expect(full.training.wandb).toMatchObject({
      entity: "team",
      tags: ["prod"],
      name: "run-{epoch}",
      project: "NeuralNetworks",
      mode: "online",
    });

    const bare = buildTrainingRequest(buildInput({ wandb: { project: "NeuralNetworks", mode: "offline" } }));
    expect(bare.training.wandb).toEqual({ project: "NeuralNetworks", mode: "offline" });
  });
});

describe("SSE parser", () => {
  it("parses split chunks, comments, multiline data, and event IDs", () => {
    const parser = new SseParser();

    expect(parser.push(": keep-alive\n\nid: 12-0\ndata: {\"type\":\"run")).toEqual([]);
    expect(parser.push("ning\",\ndata: \"step\":1}\n\n")).toEqual([
      { id: "12-0", data: "{\"type\":\"running\",\n\"step\":1}" },
    ]);
  });
});

/** Real Web Crypto digest, so integrity expectations are deterministic. */
async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
