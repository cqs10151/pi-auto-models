/**
 * Auto Model Switch Extension (Multi-tier 4-Model Fallback Chain with Auto-Retry)
 *
 * Automatically falls back across 4 models on 429/529 rate limits:
 * Model 1 ➔ Model 2 ➔ Model 3 ➔ Model 4
 * Seamlessly auto-retries the failed turn with the fallback model.
 * Recovers back to higher priority models once cooldown expires.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, SelectList, type SelectItem, matchesKey, Key } from "@earendil-works/pi-tui";
import {
  getPassiveRateLimitCooldownMs,
  isClaudeUsageAvailable,
  isProviderRateLimitError,
  parseCooldownMs,
  type RateLimitInfo,
} from "./quota-utils.ts";
import {
  type ThinkingLevel,
  type ModelSlot,
  DEFAULT_MODELS,
  readConfig,
  writeConfig,
  setProviderRateLimit,
  clearProviderRateLimit,
  getProviderRateLimitLeft,
  readAuth,
  readRateLimits,
  writeRateLimits,
  fetchClaudeUsage,
  parseAnthropicHeaders,
  parseOpenAIHeaders,
} from "./quota-data.ts";

async function setModelTo(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  slot: ModelSlot,
): Promise<boolean> {
  const model = ctx.modelRegistry.find(slot.provider, slot.model);
  if (!model) {
    return false;
  }
  const ok = await pi.setModel(model);
  if (!ok) {
    return false;
  }
  pi.setThinkingLevel(slot.thinking);
  return true;
}

export default function (pi: ExtensionAPI) {
  let modelChain: ModelSlot[] = readConfig();
  let currentActiveIndex = 0;
  let lastRequestProvider: string | undefined;
  let isSwitchingFallback = false;
  const rateLimits = new Map<string, RateLimitInfo>(Object.entries(readRateLimits()));

  // 检查某个 Provider 是否处于限流冷却期
  function getCooldownLeft(provider: string): number {
    return Math.max(
      getProviderRateLimitLeft(provider),
      getPassiveRateLimitCooldownMs(rateLimits.get(provider)),
    );
  }

  // 沿降级链寻找下一个可用模型
  async function selectBestAvailableModel(
    ctx: ExtensionContext,
    startFromIndex = 0,
  ): Promise<{ index: number; slot: ModelSlot } | null> {
    for (let i = startFromIndex; i < modelChain.length; i++) {
      const slot = modelChain[i];
      const cooldown = getCooldownLeft(slot.provider);

      if (cooldown <= 0) {
        const ok = await setModelTo(pi, ctx, slot);
        if (ok) {
          return { index: i, slot };
        }
      }
    }

    // 若从 startFromIndex 往后全部限流，且不是从 0 开始搜索的，则回绕从 0 检查
    if (startFromIndex > 0) {
      return selectBestAvailableModel(ctx, 0);
    }
    return null;
  }

  pi.on("before_provider_request", (event, ctx) => {
    lastRequestProvider = event.model?.provider ?? ctx.model?.provider ?? lastRequestProvider;
  });

  // 会话启动时，优先尝试按优先级从最高位（Model 1）开始选择
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWorkingVisible(true);
    modelChain = readConfig();

    // 如果首选模型是 Claude，尝试刷新一次实时配额
    const primary = modelChain[0];
    if (primary && primary.provider === "anthropic") {
      const entry = readAuth()[primary.provider];
      if (entry && Date.now() <= entry.expires) {
        try {
          if (isClaudeUsageAvailable(await fetchClaudeUsage(entry))) {
            clearProviderRateLimit(primary.provider);
            rateLimits.delete(primary.provider);
            writeRateLimits(rateLimits);
          }
        } catch {}
      }
    }

    const selected = await selectBestAvailableModel(ctx, 0);
    if (selected) {
      currentActiveIndex = selected.index;
      const isPrimary = selected.index === 0;
      ctx.ui.setStatus(
        "auto-model",
        ctx.ui.theme.fg(isPrimary ? "success" : "warning", `⚡ [M${selected.index + 1}] ${selected.slot.model}`),
      );
      if (!isPrimary) {
        ctx.ui.notify(`M1 限流中，已启用备用模型 [M${selected.index + 1}] ${selected.slot.model}`, "info");
      }
    }
  });

  // 捕获请求异常流中的 429 错误
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!isProviderRateLimitError(event.message.errorMessage)) return;

    const provider = event.message.provider ?? lastRequestProvider ?? ctx.model?.provider;
    if (!provider) return;

    const cooldownMs = parseCooldownMs(undefined);
    setProviderRateLimit(provider, Date.now() + cooldownMs);

    await triggerFallbackAndRetry(ctx, provider, cooldownMs);
  });

  // 捕获响应 Headers 中的 429 / 529 状态
  pi.on("after_provider_response", async (event, ctx) => {
    const headers = event.headers;
    const provider = lastRequestProvider ?? ctx.model?.provider;

    if (headers && provider) {
      const info = parseAnthropicHeaders(headers) ?? parseOpenAIHeaders(headers);
      if (info) {
        rateLimits.set(provider, info);
        writeRateLimits(rateLimits);
        const passiveLeft = getPassiveRateLimitCooldownMs(info);
        if (passiveLeft > 0) setProviderRateLimit(provider, Date.now() + passiveLeft);
      }
    }

    if (event.status === 429 || event.status === 529) {
      const cooldownMs = parseCooldownMs(headers);
      if (provider) {
        setProviderRateLimit(provider, Date.now() + cooldownMs);
      }
      await triggerFallbackAndRetry(ctx, provider, cooldownMs);
    }
  });

  // 核心：执行降级并自动无感重发请求
  async function triggerFallbackAndRetry(ctx: ExtensionContext, provider: string | undefined, cooldownMs: number) {
    if (isSwitchingFallback) return; // 防抖，防止同一报错触发多次切换
    isSwitchingFallback = true;

    try {
      const nextTargetIndex = (currentActiveIndex + 1) % modelChain.length;
      const selected = await selectBestAvailableModel(ctx, nextTargetIndex);

      if (selected) {
        currentActiveIndex = selected.index;
        const minutes = Math.ceil(cooldownMs / 60000);
        ctx.ui.setStatus(
          "auto-model",
          ctx.ui.theme.fg("warning", `⚡ [M${selected.index + 1}] ${selected.slot.model}`),
        );
        ctx.ui.notify(
          `模型 ${provider ?? ""} 触发 429 限流，已秒切至 [M${selected.index + 1}] ${selected.slot.model}，正在自动接管执行...`,
          "warning",
        );

        // 延迟触发重试，确保状态和模型上下文完全切换就绪
        setTimeout(() => {
          try {
            const anyPi = pi as any;
            if (typeof anyPi.retry === "function") {
              anyPi.retry();
            } else if (typeof anyPi.sendMessage === "function") {
              anyPi.sendMessage();
            } else if (typeof anyPi.sendUserMessage === "function") {
              anyPi.sendUserMessage();
            } else if (typeof anyPi.send === "function") {
              anyPi.send();
            } else {
              ctx.ui.notify(`模型已切换至 [M${selected.index + 1}]，请按回车继续`, "info");
            }
          } catch {
            ctx.ui.notify(`模型已切换至 [M${selected.index + 1}]，请按回车继续`, "info");
          }
        }, 300);
      }
    } finally {
      setTimeout(() => {
        isSwitchingFallback = false;
      }, 1000);
    }
  }

  // ── /auto-model 交互式配置 4 个模型 ──

  pi.registerCommand("auto-model", {
    description: "配置 4 级模型自动降级链条",
    handler: async (_args, ctx) => {
      const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
      const availableModels = ctx.modelRegistry.getAvailable();
      const modelItems: SelectItem[] = availableModels.map((m: { provider: string; id: string }) => ({
        value: `${m.provider}/${m.id}`,
        label: `${m.provider}/${m.id}`,
      }));

      // 1. 选择槽位
      const slotIndexStr = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Configure Fallback Chain (4 Slots)")), 1, 0));

        const items: SelectItem[] = [0, 1, 2, 3].map((i) => {
          const m = modelChain[i] || DEFAULT_MODELS[i];
          return {
            value: String(i),
            label: `Model ${i + 1} (${i === 0 ? "Primary" : `Fallback ${i}`})`,
            description: `${m.provider}/${m.model} [${m.thinking}]`,
          };
        });

        const list = new SelectList(items, 4, {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        });
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);
        container.addChild(list);
        container.addChild(new Text(theme.fg("dim", "↑↓ select slot • enter confirm • esc cancel"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
        };
      });

      if (slotIndexStr === null) return;
      const targetIndex = parseInt(slotIndexStr, 10);

      // 2. 选择模型
      const chosenModel = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        let filter = "";
        const fzfMatch = (text: string, pattern: string): number => {
          if (!pattern) return 1;
          const lower = text.toLowerCase();
          const p = pattern.toLowerCase();
          let j = 0;
          for (let i = 0; i < lower.length && j < p.length; i++) {
            if (lower[i] === p[j]) j++;
          }
          return j === p.length ? 1 : 0;
        };

        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        const titleText = new Text("", 1, 0);
        const updateTitle = () => {
          const searchHint = filter ? theme.fg("accent", ` ❯ ${filter}`) : theme.fg("dim", " (type to search)");
          titleText.setText(theme.fg("accent", theme.bold(`Select Model for Slot ${targetIndex + 1}`)) + searchHint);
        };
        updateTitle();
        container.addChild(titleText);

        const selectTheme = {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        };
        let list = new SelectList(modelItems, Math.min(modelItems.length, 12), selectTheme);
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);
        container.addChild(list);
        const helpText = new Text(theme.fg("dim", "↑↓ select • type to search • enter confirm • esc cancel"), 1, 0);
        container.addChild(helpText);
        const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
        container.addChild(bottomBorder);

        const rebuildList = () => {
          const filtered = filter
            ? modelItems.filter((item) => fzfMatch(item.label, filter))
            : modelItems;
          container.removeChild(list);
          container.removeChild(helpText);
          container.removeChild(bottomBorder);
          list = new SelectList(filtered, Math.min(filtered.length, 12), selectTheme);
          list.onSelect = (item) => done(item.value);
          list.onCancel = () => done(null);
          container.addChild(list);
          container.addChild(helpText);
          container.addChild(bottomBorder);
          container.invalidate();
        };

        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            if (matchesKey(data, Key.backspace)) {
              if (filter.length > 0) {
                filter = filter.slice(0, -1);
                updateTitle();
                rebuildList();
              }
            } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
              filter += data;
              updateTitle();
              rebuildList();
            } else {
              list.handleInput(data);
            }
            tui.requestRender();
          },
        };
      });

      if (!chosenModel) return;

      // 3. 选择 Thinking Level
      const thinkingItems: SelectItem[] = THINKING_LEVELS.map((l) => ({ value: l, label: l }));
      const thinking = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Select Thinking Level")), 1, 0));
        const list = new SelectList(thinkingItems, 6, {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        });
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);
        container.addChild(list);
        container.addChild(new Text(theme.fg("dim", "↑↓ select • enter confirm • esc cancel"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
        };
      });

      if (!thinking) return;

      const [provider, ...rest] = chosenModel.split("/");
      const modelId = rest.join("/");

      while (modelChain.length < 4) {
        modelChain.push(DEFAULT_MODELS[modelChain.length]);
      }
      modelChain[targetIndex] = {
        provider,
        model: modelId,
        thinking: thinking as ThinkingLevel,
      };

      writeConfig(modelChain);
      ctx.ui.notify(`Slot ${targetIndex + 1} 已成功更新为 ${chosenModel} (${thinking})`, "info");
    },
  });
}