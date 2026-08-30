import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendApiError, SseParser, TrainingApiClient, canCancelTrainingJob, canonicalDatasetParameters } from "../training/api";
import { trainingLogWindowUrl } from "../training/windows";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("training job actions", () => {
  it("submits only parameters from the current dataset schema", () => {
    const dataset = {
      reference: { kind: "builtin", id: "builtin.autoencoder-mnist", version: "1.0.0", ref: "builtin_autoencoder_mnist" },
      manifest: { schemaVersion: 1, id: "builtin.autoencoder-mnist", version: "1.0.0", entrypoints: { definition: "dataset.json", python: "dataset.py" } },
      definition: { schemaVersion: 1, id: "builtin.autoencoder-mnist", version: "1.0.0", name: "AutoencoderMNIST", parameters: [
        { name: "batch_size", type: "int", default: 32, required: false },
        { name: "num_workers", type: "int", default: 0, required: false },
        { name: "train_size", type: "float", default: 0.8, required: false },
      ], batch: { inputs: { image: { shape: ["B", 1, 28, 28], dtype: "float32" } }, targets: { reconstruction: { shape: ["B", 1, 28, 28], dtype: "float32" } } } },
    };

    expect(canonicalDatasetParameters(dataset, {
      batch_size: "128", num_workers: "0", train_size: "0.8", root: "/tmp/old-editor",
    })).toEqual({ batch_size: "128", num_workers: "0", train_size: "0.8" });
  });

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
  it("uploads a package bundle through the authenticated package endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ bundle_ref: "bundle-1", digest: "a".repeat(64), size: 12 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");
    const bundle = { schema_version: 1, format: "package-bundle/v1", runtime: { name: "stereotype_runtime.pytorch", version: 1 }, graph: { nodes: [], edges: [] }, packages: [], digest: "a".repeat(64) } as const;

    await expect(api.uploadPackageBundle(bundle)).resolves.toMatchObject({ bundle_ref: "bundle-1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend.lan:8000/package-bundles");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer very-secret-token");
    expect(JSON.parse(String(init.body))).toMatchObject({ format: "package-bundle/v1", digest: bundle.digest });
  });

  it("accepts only a package job request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");

    await api.submitTrainingJob({
      schema_version: 1,
      network: { format: "package", value: { bundle_ref: "bundle-1", graph: { nodes: [], edges: [] } } },
      training: {}, resources: {}, priority: 0,
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).toMatchObject({
      network: { format: "package", value: { bundle_ref: "bundle-1", graph: { nodes: [], edges: [] } } },
    });
    expect(body.training).not.toHaveProperty("overrides");
  });

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

  it("submits the requested package name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new TrainingApiClient("http://backend.lan:8000", "very-secret-token");

    await api.submitTrainingJob({
      schema_version: 1,
      network: { format: "package", value: { bundle_ref: "bundle-1", graph: { nodes: [], edges: [] } } },
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
