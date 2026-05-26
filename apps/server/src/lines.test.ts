import { describe, expect, test } from "bun:test";
import { resolveSpeakerName } from "./lines";

describe("resolveSpeakerName", () => {
  const rawLabel = "Speaker 1";

  test("override wins over every other tier", () => {
    expect(
      resolveSpeakerName({
        override: "Alice",
        sessionMapping: "Bob",
        spaceMapping: "Carol",
        rawLabel,
      }),
    ).toBe("Alice");
  });

  test("session mapping wins over space mapping and raw label", () => {
    expect(
      resolveSpeakerName({
        override: null,
        sessionMapping: "Bob",
        spaceMapping: "Carol",
        rawLabel,
      }),
    ).toBe("Bob");
  });

  test("space mapping is used when override and session mapping are absent", () => {
    expect(
      resolveSpeakerName({
        override: null,
        sessionMapping: null,
        spaceMapping: "Carol",
        rawLabel,
      }),
    ).toBe("Carol");
  });

  test("falls back to raw label when no tier resolves", () => {
    expect(
      resolveSpeakerName({
        override: null,
        sessionMapping: null,
        spaceMapping: null,
        rawLabel,
      }),
    ).toBe("Speaker 1");
  });
});
