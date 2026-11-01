/**
 * 兼容层。裸文本模型调用已经抽到 `server/utils/raw-llm.ts`：
 * 主动机制要学会同一套「不套 JSON 契约 + 思考模型预算翻倍重试」，复制一份只会分裂。
 *
 * 这里只保留 B站 侧的旧名字 —— 调用点和 `test:bili-llm` 都不用改。
 */

export {
  callRawModel as callBiliModel,
  RAW_MODEL_MIN_TOKENS as BILI_MODEL_MIN_TOKENS,
  type RawModelCall as BiliModelCall,
} from "../../raw-llm";
