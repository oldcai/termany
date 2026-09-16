import { apiPath } from "./api";

/** Read the local account name used to seed a new user profile. */
export async function fetchSystemUsername(): Promise<string> {
  try {
    const response = await fetch(apiPath("/api/system-profile"));
    if (!response.ok) return "";
    const data = await response.json() as { username?: unknown };
    return typeof data.username === "string" ? data.username.trim() : "";
  } catch {
    return "";
  }
}
