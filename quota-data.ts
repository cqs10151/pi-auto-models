/**
 * Data layer: types & config persistence
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelSlot {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}

export interface AutoModelConfig {
  models?: ModelSlot[];
}

export const MAX_SLOTS = 4;
const CONFIG_FILE = join(getAgentDir(), "auto-model.json");

export const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const DEFAULT_MODELS: ModelSlot[] = [
  { provider: "opencode", model: "deepseek-v4-flash-free", thinking: "high" },
  { provider: "cloudflare-workers-ai", model: "@cf/zai-org/glm-4.7-flash", thinking: "off" },
  { provider: "nvidia", model: "stepfun-ai/step-3.7-flash", thinking: "off" },
  { provider: "openrouter", model: "openrouter/free", thinking: "off" },
];

/**
 * 安全的原子文件写入 (加固：异常明确感知与日志记录)
 */
function safeWriteJsonSync(filePath: string, data: unknown): void {
  try {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tempPath = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tempPath, filePath);
  } catch (err) {
    console.error("[pi-auto-models] Failed to atomically write config:", err);
  }
}

/**
 * 读取 M1~M4 槽位配置 (加固：严格固定 4 槽位，解析错误安全回退并输出警告)
 */
export function readConfig(): ModelSlot[] {
  try {
    if (!existsSync(CONFIG_FILE)) return [...DEFAULT_MODELS];
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const cfg = JSON.parse(raw) as AutoModelConfig;
    if (Array.isArray(cfg.models) && cfg.models.length > 0) {
      const validModels: ModelSlot[] = cfg.models
        .filter((m): m is ModelSlot => Boolean(m && typeof m.provider === "string" && typeof m.model === "string"))
        .map((m) => ({
          provider: m.provider.trim(),
          model: m.model.trim(),
          thinking: VALID_THINKING_LEVELS.includes(m.thinking) ? m.thinking : "off",
        }));

      while (validModels.length < MAX_SLOTS) {
        validModels.push(DEFAULT_MODELS[validModels.length]);
      }
      return validModels.slice(0, MAX_SLOTS);
    }
    return [...DEFAULT_MODELS];
  } catch (err) {
    console.warn("[pi-auto-models] Failed to read auto-model.json, falling back to defaults:", err);
    return [...DEFAULT_MODELS];
  }
}

/**
 * 持久化 M1~M4 槽位配置
 */
export function writeConfig(models: ModelSlot[]): void {
  const sanitized = models.slice(0, MAX_SLOTS);
  safeWriteJsonSync(CONFIG_FILE, { models: sanitized });
}