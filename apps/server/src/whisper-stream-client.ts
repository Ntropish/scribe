import { env } from "./env";

export async function enroll(
  spaceId: string,
  speakerName: string,
  embeddings: number[][],
): Promise<{ embedding_count: number } | { error: string }> {
  if (embeddings.length === 0) return { embedding_count: 0 };
  try {
    const res = await fetch(`${env.whisperStreamHttp}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        space_id: spaceId,
        speaker_name: speakerName,
        embeddings,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { error: `service returned ${res.status}: ${text}` };
    }
    const data = (await res.json()) as { embedding_count: number };
    return { embedding_count: data.embedding_count };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}
