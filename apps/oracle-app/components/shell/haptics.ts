export async function haptic(pattern: number | number[] = 8): Promise<void> {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(pattern);
  } catch {}
}
