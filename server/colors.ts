// Excalidraw's default palette, so a model can say "blue" instead of knowing hex codes.
const STROKE: Record<string, string> = {
  black: "#1e1e1e",
  red: "#e03131",
  green: "#2f9e44",
  blue: "#1971c2",
  orange: "#f08c00",
  purple: "#9c36b5",
  gray: "#868e96",
  grey: "#868e96",
  white: "#ffffff",
};
const BACKGROUND: Record<string, string> = {
  red: "#ffc9c9",
  green: "#b2f2bb",
  blue: "#a5d8ff",
  yellow: "#ffec99",
  orange: "#ffd8a8",
  purple: "#eebefa",
  gray: "#dee2e6",
  grey: "#dee2e6",
  white: "#ffffff",
  transparent: "transparent",
};

export class ColorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ColorError";
  }
}

function resolve(table: Record<string, string>, value: string, kind: string): string {
  const key = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(key) || /^#[0-9a-f]{3}$/.test(key)) return key;
  const named = table[key];
  if (named) return named;
  throw new ColorError(`Unknown ${kind} color "${value}". Use a hex like #1971c2 or one of: ${Object.keys(table).join(", ")}`);
}

export const strokeColor = (value: string) => resolve(STROKE, value, "stroke");
export const backgroundColor = (value: string) => resolve(BACKGROUND, value, "background");
