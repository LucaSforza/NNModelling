import { describe, expect, it, vi } from "vitest";
import { TrainingController, TrainingConfigurationError } from "../training/controller";
import type { DatasetInfo } from "../training/api";
import type { GeneratedDatasetResources } from "../project-workspace/dataset-authoring";

const dataset: DatasetInfo = {
  reference: { kind: "project", id: "example.vae-mnist", version: "0.1.0", ref: "project_example_vae_mnist_0_1_0", digest: "a".repeat(64) },
  manifest: { schemaVersion: 1, id: "example.vae-mnist", version: "0.1.0", entrypoints: { definition: "dataset.json", python: "dataset.py" } },
  definition: { schemaVersion: 1, id: "example.vae-mnist", version: "0.1.0", name: "VAE MNIST", parameters: [
    { name: "batch_size", type: "integer", default: 32, required: false },
    { name: "shuffle", type: "boolean", default: true, required: false },
  ], batch: { inputs: { image: { shape: ["B", 1], dtype: "float32" } }, targets: { label: { shape: ["B"], dtype: "int64" } } } },
};

function projectDataset(ref: string, id = ref): DatasetInfo {
  return {
    reference: { kind: "project", id, version: "1.0.0", ref },
    manifest: { schemaVersion: 1, id, version: "1.0.0", entrypoints: { definition: "dataset.json", python: "dataset.py" } },
    definition: { schemaVersion: 1, id, version: "1.0.0", name: id, parameters: [
      { name: "batch_size", type: "integer", default: 16, required: false },
      { name: "shuffle", type: "boolean", default: false, required: false },
    ], batch: { inputs: { image: { shape: ["B", 1], dtype: "float32" } }, targets: { label: { shape: ["B"], dtype: "int64" } } } },
  };
}

const resources = new Map<string, GeneratedDatasetResources>();

describe("TrainingController", () => {
  it("keeps a typed configuration and rejects invalid patches atomically", () => {
    const controller = new TrainingController();
    controller.setProjectDatasets([dataset], resources);
    controller.updateConfig({ selectedDataset: dataset.reference.ref, datasetParams: { batch_size: 64 } });
    expect(controller.getConfig()).toMatchObject({ selectedDataset: dataset.reference.ref, datasetParams: { batch_size: 64, shuffle: true } });

    expect(() => controller.updateConfig({ datasetParams: { batch_size: "64" } })).toThrow(TrainingConfigurationError);
    expect(controller.getConfig().datasetParams.batch_size).toBe(64);
    expect(() => controller.updateConfig({ accelerator: "tpu" as never })).toThrow(TrainingConfigurationError);
  });

  it("publishes pairing status without exposing the token", async () => {
    const api = {
      health: vi.fn().mockResolvedValue({ status: "ok" }),
      createPairing: vi.fn().mockResolvedValue({ request_id: "req", connection_id: "conn", token: "secret", verification_code: "123", expires_at: "later" }),
    } as any;
    const snapshots: ReturnType<TrainingController["snapshot"]>[] = [];
    const controller = new TrainingController({ apiFactory: () => api, storage: new MemoryStorage() });
    controller.subscribe((snapshot) => snapshots.push(snapshot));
    await controller.connect("http://backend.test:8000", "test device");
    expect(controller.getConnection()).toMatchObject({ status: "pending", requestId: "req", verificationCode: "123" });
    expect(JSON.stringify(snapshots.at(-1))).not.toContain("secret");
    await controller.disconnect();
  });

  it("reconciles selection and parameters when the project dataset catalog changes", () => {
    const first = projectDataset("project-a");
    const second = projectDataset("project-b");
    const controller = new TrainingController();

    controller.setProjectDatasets([first], resources);
    controller.updateConfig({ datasetParams: { batch_size: 99 } });
    expect(controller.getConfig()).toMatchObject({ selectedDataset: first.reference.ref, datasetParams: { batch_size: 99, shuffle: false } });

    controller.setProjectDatasets([second], resources);
    expect(controller.getConfig()).toMatchObject({ selectedDataset: second.reference.ref, datasetParams: { batch_size: 16 } });
  });

  it("clears project archive references when installing a new project catalog", () => {
    const controller = new TrainingController();
    const oldDataset = projectDataset("project-a");
    const newDataset = projectDataset("project-b");
    controller.setProjectDatasets([oldDataset], resources);
    (controller as unknown as { projectDatasetReferences: Map<string, unknown> }).projectDatasetReferences.set(oldDataset.reference.ref, { ...oldDataset.reference, digest: "old" });

    controller.setProjectDatasets([newDataset], resources);

    expect((controller as unknown as { projectDatasetReferences: Map<string, unknown> }).projectDatasetReferences.size).toBe(0);
  });

  it("clears one-time pairing details after approval", async () => {
    const api = {
      health: vi.fn().mockResolvedValue({ status: "ok" }),
      createPairing: vi.fn().mockResolvedValue({ request_id: "req", connection_id: "grant", token: "secret", verification_code: "123", expires_at: "later" }),
      getPairingStatus: vi.fn().mockResolvedValue({ status: "approved", request_id: "req", connection_id: "grant", verification_code: "123", expires_at: "later", session_expires_at: "later" }),
      getSession: vi.fn().mockResolvedValue({ id: "session", status: "active", device_name: "test", created_at: "now", approved_at: "now", expires_at: "later", last_seen_at: null, revoked_at: null }),
    } as any;
    const controller = new TrainingController({ apiFactory: () => api, storage: new MemoryStorage() });
    await controller.connect("http://backend.test:8000");
    await vi.waitFor(() => expect(controller.getConnection().status).toBe("active"), { timeout: 3000 });
    expect(controller.getConnection()).toMatchObject({ connectionId: "session", requestId: null, verificationCode: null });
    await controller.disconnect();
  });
});

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
