import { createError } from "h3";

/** Explicit owner setting only; never derive education authority from relationship or model output. */
export function readFriendEducationPatch(body: Record<string, unknown>): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, "educationEnabled")) return undefined;
  if (typeof body.educationEnabled !== "boolean") throw createError({ statusCode: 400, statusMessage: "教育权限必须是布尔值。" });
  return body.educationEnabled;
}
export function assertFriendEducationOwner(actorId: string, ownerId: string): void {
  if (actorId !== ownerId) throw createError({ statusCode: 403, statusMessage: "只有角色主人可以设置教育权限。" });
}
