import { describe, expect, it } from "vitest";
import { resolveLocale, translate } from "../i18n";

describe("UI localization", () => {
  it("uses English when no supported language has been saved", () => {
    expect(resolveLocale(null)).toBe("en");
    expect(resolveLocale("fr")).toBe("en");
  });

  it("restores Italian and translates interpolated UI text", () => {
    expect(resolveLocale("it")).toBe("it");
    expect(translate("it", "Job {id} queued.", { id: "abc123" })).toBe("Job abc123 accodato.");
    expect(translate("it", "Dependency line 2 must contain an id and version range"))
      .toBe("La riga 2 della dipendenza deve contenere un ID e un intervallo di versioni");
  });
});
