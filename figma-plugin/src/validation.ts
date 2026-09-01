export const MAX_NODES = 100;
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

export function numberIn(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function optionalNumber(value: unknown, minimum: number, maximum: number, name: string): number | undefined {
  return value == null ? undefined : numberIn(value, minimum, maximum, name);
}

export function stringIn(value: unknown, minimum: number, maximum: number, name: string): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`${name} must contain ${minimum}..${maximum} characters`);
  }
  return value;
}

export function optionalString(value: unknown, maximum: number, name: string): string | undefined {
  return value == null ? undefined : stringIn(value, 0, maximum, name);
}

export function nodeIds(value: unknown, name = "nodeIds"): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_NODES) {
    throw new Error(`${name} must contain 1..${MAX_NODES} node IDs`);
  }
  return value.map((item, index) => stringIn(item, 1, 128, `${name}[${index}]`));
}

export function color(value: unknown): RGB | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object") throw new Error("fill must be an RGB object");
  const candidate = value as Record<string, unknown>;
  return {
    r: numberIn(candidate.r, 0, 1, "fill.r"),
    g: numberIn(candidate.g, 0, 1, "fill.g"),
    b: numberIn(candidate.b, 0, 1, "fill.b")
  };
}
