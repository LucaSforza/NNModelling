import { describe, expect, it, vi } from "vitest";
import { TrainingController, TrainingConfigurationError } from "../training/controller";
import type { DatasetInfo } from "../training/api";

const dataset: DatasetInfo = {
  target: "dataset.example.MNIST",
  name: "MNIST",
  doc: "",
  num_classes: 10,
  parameters: [
    { name: "batch_size", type: "int", default: 32, required: false },
    { name: "shuffle", type: "bool", default: true, required: false },
  ],
};

describe("TrainingController", () => {
  it("keeps a typed configuration and rejects invalid patches atomically", () => {
    const controller = new TrainingController();
    controller.setDatasets([dataset]);
    controller.updateConfig({ selectedDataset: dataset.target, datasetParams: { batch_size: 64 } });
    expect(controller.getConfig()).toMatchObject({ selectedDataset: dataset.target, datasetParams: { batch_size: 64, shuffle: true } });

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
});

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
