type Profile = Record<string, unknown> | undefined | null;

const defaultAdminGroup =
  (import.meta.env.VITE_ADMIN_GROUP_NAME as string | undefined) ?? "admins";

function getGroups(profile: Profile): string[] {
  if (!profile) {
    return [];
  }
  const raw = profile["cognito:groups"];
  if (Array.isArray(raw)) {
    return raw.filter((value) => typeof value === "string") as string[];
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
}

export function isAdminUser(profile: Profile): boolean {
  return getGroups(profile).includes(defaultAdminGroup);
}
