import type { GrowthEventDeliveryHandler } from "./growth-event-delivery";
import { readMemoryEventReference } from "./growth-domain-gateway";
import { readSocialExperienceReference } from "./social-experience-gateway";
import { dispatchSocialExperienceAssessment } from "./social-experiences";

/**
 * 第一位真实只读消费者：验证忆泡来源引用仍属于事件中的 Character。
 * 不复制正文、不调用模型、不修改记忆或社交领域数据。
 */
export const GROWTH_EVENT_HANDLERS: Readonly<Record<string, GrowthEventDeliveryHandler>> = {
  "growth.memory-source-integrity": async (tx, event) => {
    if (
      event.sourceDomain !== "memory"
      || event.eventType !== "memory.event.created"
      || event.aggregateType !== "MemoryEvent"
    ) {
      return { skipReason: "事件类型与记忆来源校验消费者不匹配。" };
    }

    const source = await readMemoryEventReference(tx, event.characterId, event.aggregateId);
    if (!source) return { skipReason: "来源忆泡不存在或不属于事件所属角色。" };
    // ARCHIVED 仍然是可追溯来源；归档不等于删除，因此允许确认投递。
    return;
  },
  "social.relationship-assessment-dispatch": async (tx, event) => {
    if (
      event.sourceDomain !== "social"
      || event.eventType !== "social.experience.created"
      || event.aggregateType !== "SocialExperience"
      || event.schemaVersion !== 1
    ) return { skipReason: "事件协议与社交经历派发消费者不匹配。" };
    const source = await readSocialExperienceReference(tx, event.characterId, event.aggregateId);
    if (!source) return { skipReason: "社交经历不存在或经历/忆泡不属于事件所属角色。" };
    const result = await dispatchSocialExperienceAssessment(tx, {
      characterId: event.characterId, experienceId: source.id,
    });
    if ("skipReason" in result) return result;
  },
};
