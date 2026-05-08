/**
 * Prebuilt voices for `gemini-3.1-flash-tts-preview`.
 *
 * Source:
 * https://ai.google.dev/gemini-api/docs/speech-generation#voices
 *
 * The names are case-sensitive — the API expects them exactly as listed.
 * The descriptors are taken verbatim from the docs and surfaced by
 * `/voice voice` (no-arg form) so users can pick a vibe before they
 * pick a name.
 */

export interface PrebuiltVoice {
  name: string;
  descriptor: string;
}

export const PREBUILT_VOICES: readonly PrebuiltVoice[] = [
  { name: "Zephyr", descriptor: "Bright" },
  { name: "Puck", descriptor: "Upbeat" },
  { name: "Charon", descriptor: "Informative" },
  { name: "Kore", descriptor: "Firm" },
  { name: "Fenrir", descriptor: "Excitable" },
  { name: "Leda", descriptor: "Youthful" },
  { name: "Orus", descriptor: "Firm" },
  { name: "Aoede", descriptor: "Breezy" },
  { name: "Callirrhoe", descriptor: "Easy-going" },
  { name: "Autonoe", descriptor: "Bright" },
  { name: "Enceladus", descriptor: "Breathy" },
  { name: "Iapetus", descriptor: "Clear" },
  { name: "Umbriel", descriptor: "Easy-going" },
  { name: "Algieba", descriptor: "Smooth" },
  { name: "Despina", descriptor: "Smooth" },
  { name: "Erinome", descriptor: "Clear" },
  { name: "Algenib", descriptor: "Gravelly" },
  { name: "Rasalgethi", descriptor: "Informative" },
  { name: "Laomedeia", descriptor: "Upbeat" },
  { name: "Achernar", descriptor: "Soft" },
  { name: "Alnilam", descriptor: "Firm" },
  { name: "Schedar", descriptor: "Even" },
  { name: "Gacrux", descriptor: "Mature" },
  { name: "Pulcherrima", descriptor: "Forward" },
  { name: "Achird", descriptor: "Friendly" },
  { name: "Zubenelgenubi", descriptor: "Casual" },
  { name: "Vindemiatrix", descriptor: "Gentle" },
  { name: "Sadachbia", descriptor: "Lively" },
  { name: "Sadaltager", descriptor: "Knowledgeable" },
  { name: "Sulafat", descriptor: "Warm" },
] as const;

const VOICE_NAMES: ReadonlySet<string> = new Set(PREBUILT_VOICES.map((v) => v.name));

/** Case-sensitive membership test against the 30-name list. */
export function isValidVoice(name: string): boolean {
  return VOICE_NAMES.has(name);
}

/** Sorted list of just the names — useful for autocomplete. */
export function voiceNames(): string[] {
  return PREBUILT_VOICES.map((v) => v.name);
}

/**
 * Format the full table for `/voice voice` (no-arg form).
 *
 * Two-column layout, padded to the widest name in the list. Returns a
 * plain string — caller wraps it in `ctx.ui.notify`.
 */
export function formatVoiceTable(): string {
  const width = Math.max(...PREBUILT_VOICES.map((v) => v.name.length));
  const lines: string[] = [];
  // Pair voices into rows of two for a denser display.
  for (let i = 0; i < PREBUILT_VOICES.length; i += 2) {
    const a = PREBUILT_VOICES[i];
    const b = PREBUILT_VOICES[i + 1];
    const left = `${a.name.padEnd(width)}  (${a.descriptor})`;
    const right = b ? `${b.name.padEnd(width)}  (${b.descriptor})` : "";
    lines.push(right ? `${left.padEnd(width + 24)}${right}` : left);
  }
  return lines.join("\n");
}
