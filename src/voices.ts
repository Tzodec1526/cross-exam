/** Built-in xAI voices available on Voice Agent + TTS. */
export const XAI_VOICES: { id: string; label: string; tone: string }[] = [
  { id: "eve", label: "Eve", tone: "Clear, professional" },
  { id: "ara", label: "Ara", tone: "Warm, approachable" },
  { id: "leo", label: "Leo", tone: "Steady, authoritative" },
  { id: "rex", label: "Rex", tone: "Direct, firm" },
  { id: "sal", label: "Sal", tone: "Calm, measured" },
  { id: "luna", label: "Luna", tone: "Soft, measured" },
  { id: "helix", label: "Helix", tone: "Neutral, precise" },
  { id: "orion", label: "Orion", tone: "Deep, deliberate" },
  { id: "carina", label: "Carina", tone: "Bright, articulate" },
  { id: "zagan", label: "Zagan", tone: "Gravelly, forceful" },
];

export function voiceLabel(id: string | undefined, fallback = "App default"): string {
  if (!id) return fallback;
  return XAI_VOICES.find((v) => v.id === id)?.label ?? id;
}
