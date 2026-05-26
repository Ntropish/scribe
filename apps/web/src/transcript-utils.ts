export interface TranscriptLineLike {
  id: string;
  line_index: number;
  raw_speaker_label: string;
  resolved_speaker: string;
}

export interface LineGroup<T extends TranscriptLineLike> {
  rawLabel: string;
  resolved: string;
  lines: T[];
}

export function formatMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const s = (totalSec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// Consecutive lines with the same raw_speaker_label fold into one group;
// the resolved speaker on the last line wins as the group's display label.
export function groupConsecutive<T extends TranscriptLineLike>(lines: T[]): LineGroup<T>[] {
  const groups: LineGroup<T>[] = [];
  for (const line of lines) {
    const tail = groups[groups.length - 1];
    if (tail && tail.rawLabel === line.raw_speaker_label) {
      tail.lines.push(line);
      tail.resolved = line.resolved_speaker;
    } else {
      groups.push({
        rawLabel: line.raw_speaker_label,
        resolved: line.resolved_speaker,
        lines: [line],
      });
    }
  }
  return groups;
}
