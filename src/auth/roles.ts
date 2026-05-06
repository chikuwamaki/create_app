export type Role = "staff" | "manager";

type Profile = Record<string, unknown> | undefined | null;

export const roleLabels: Record<Role, string> = {
  staff: "バイト",
  manager: "店長"
};

export function getRoleFromProfile(profile: Profile): Role | null {
  if (!profile) {
    return null;
  }
  const rawRole = profile["custom:role"] ?? profile.role;
  if (rawRole === "staff" || rawRole === "manager") {
    return rawRole;
  }
  return null;
}
