import { describe, expect, test } from "bun:test";
import { formatMs, groupConsecutive } from "./transcript-utils";

describe("formatMs", () => {
  test("formats seconds and minutes with leading zeros", () => {
    expect(formatMs(0)).toBe("00:00");
    expect(formatMs(5_000)).toBe("00:05");
    expect(formatMs(65_000)).toBe("01:05");
    expect(formatMs(125_500)).toBe("02:05");
  });

  test("clamps negative values to zero", () => {
    expect(formatMs(-1000)).toBe("00:00");
  });

  test("handles minutes past 60 by spilling, not wrapping", () => {
    expect(formatMs(60 * 60 * 1000)).toBe("60:00");
    expect(formatMs(125 * 60 * 1000)).toBe("125:00");
  });
});

interface Line {
  id: string;
  line_index: number;
  raw_speaker_label: string;
  resolved_speaker: string;
}

describe("groupConsecutive", () => {
  test("returns an empty array for empty input", () => {
    expect(groupConsecutive([] as Line[])).toEqual([]);
  });

  test("collapses consecutive same-label lines and splits on label change", () => {
    const input: Line[] = [
      { id: "1", line_index: 0, raw_speaker_label: "Speaker 1", resolved_speaker: "Alice" },
      { id: "2", line_index: 1, raw_speaker_label: "Speaker 1", resolved_speaker: "Alice" },
      { id: "3", line_index: 2, raw_speaker_label: "Speaker 2", resolved_speaker: "Bob" },
      { id: "4", line_index: 3, raw_speaker_label: "Speaker 1", resolved_speaker: "Alice" },
    ];
    const groups = groupConsecutive(input);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.rawLabel).toBe("Speaker 1");
    expect(groups[0]!.lines.map((l) => l.id)).toEqual(["1", "2"]);
    expect(groups[1]!.rawLabel).toBe("Speaker 2");
    expect(groups[2]!.lines.map((l) => l.id)).toEqual(["4"]);
  });

  test("the last line's resolved name wins as the group label", () => {
    const input: Line[] = [
      { id: "1", line_index: 0, raw_speaker_label: "Speaker 1", resolved_speaker: "Speaker 1" },
      { id: "2", line_index: 1, raw_speaker_label: "Speaker 1", resolved_speaker: "Alice" },
    ];
    const groups = groupConsecutive(input);
    expect(groups[0]!.resolved).toBe("Alice");
  });
});
