const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5000/api";

// Uploaded documents are served by the API server from its root (/uploads/...),
// not from the Next app and not under the /api prefix, so the base URL has to
// have that suffix stripped before the stored path is appended.
export function attachmentUrl(path: string): string {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const origin = API_BASE.replace(/\/api\/?$/, "");
  return `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function isImagePath(path: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(path);
}

// A snapshot field may hold a legacy boolean, one path, or several.
export function attachmentPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (typeof value === "string" && value.startsWith("/uploads/")) return [value];
  return [];
}
