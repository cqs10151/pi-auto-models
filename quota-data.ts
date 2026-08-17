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
 * 安全的原子文件写入
 */
function safeWriteJsonSync(filePath: string, data: unknown): void {
  try {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tempPath = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tempPath, filePath);
  } catch (err) {
    console.error(`[pi-auto-models] Failed to write ${filePath}:`, err);
  }
}

/**
 * 读取 M1~M4 槽位配置
 */
export function readConfig(): ModelSlot[] {
  try {
    if (!existsSync(CONFIG_FILE)) return [...DEFAULT_MODELS];
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as AutoModelConfig;
    if (Array.isArray(cfg.models) && cfg.models.length > 0) {
      const validModels: ModelSlot[] = cfg.models
        .filter((m): m is ModelSlot => Boolean(m && typeof m.provider === "string" && typeof m.model === "string"))
        .map((m) => ({
          provider: m.provider.trim(),
          model: m.model.trim(),
          thinking: VALID_THINKING_LEVELS.includes(m.thinking) ? m.thinking : "off",
        }));

      while (validModels.length < 4) {
        validModels.push(DEFAULT_MODELS[validModels.length]);
      }
      return validModels.slice(0, 4);
    }
    return [...DEFAULT_MODELS];
  } catch {
    return [...DEFAULT_MODELS];
  }
}

/**
 * 持久化 M1~M4 槽位配置
 */
export function writeConfig(models: ModelSlot[]): void {
  safeWriteJsonSync(CONFIG_FILE, { models });
}