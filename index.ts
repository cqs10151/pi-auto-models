/**
 * Auto Model Switch Extension (Multi-tier 4-Model Fallback Chain with Intent-Aware Manual Override)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, SelectList, type SelectItem, matchesKey, Key } from "@earendil-works/pi-tui";
import { parseRetryCooldownMs, getModelKey } from "./quota-utils.ts";
import {
  type ThinkingLevel,
  type ModelSlot,
  DEFAULT_MODELS,
  VALID_THINKING_LEVELS,
  readConfig,
  writeConfig,
} from "./quota-data.ts";

export default function (pi: ExtensionAPI) {
  let modelChain: ModelSlot[] = readConfig();

  // 状态机核心变量
  let manualBaseIndex: number | null = 0;  // 用户手工锚定的基准槽位 (null = 外部独立模型, 0..3 = M1..M4)
  let isPluginSwitching = false;           // 标志是否是插件发起的降级切换（用于识别手工切换）
  let isFallbackInProgress = false;        // 降级互斥锁（覆盖切模与重试全周期）
  let lastFallbackTime = 0;                // 最近一次降级触发时间戳（防抖）

  // 纯内存临时冷却表 (Key: "provider/model", Value: 到期时间戳)
  const modelCooldowns = new Map<string, number>();

  function findSlotIndex(provider?: string, modelId?: string): number {
    if (!provider || !modelId) return -1;
    return modelChain.findIndex((s) => s.provider === provider && s.model === modelId);
  }

  function isModelCoolingDown(provider: string, modelId: string): boolean {
    const key = getModelKey(provider, modelId);
    const expiresAt = modelCooldowns.get(key);
    if (!expiresAt) return false;
    if (Date.now() >= expiresAt) {
      modelCooldowns.delete(key);
      return false;
    }
    return true;
  }

  function setModelCooldown(provider: string, modelId: string, durationMs: number): void {
    const key = getModelKey(provider, modelId);
    modelCooldowns.set(key, Date.now() + durationMs);
  }

  async function setModelTo(pi: ExtensionAPI, ctx: ExtensionContext, slot: ModelSlot): Promise<boolean> {
    const model = ctx.modelRegistry.find(slot.provider, slot.model);
    if (!model) return false;
    const ok = await pi.setModel(model);
    if (!ok) return false;
    try {
      pi.setThinkingLevel(slot.thinking);
    } catch {}
    return true;
  }

  /**
   * 切换模型槽位并更新状态栏显示
   */
  async function switchModelSlot(
    ctx: ExtensionContext,
    index: number,
    slot: ModelSlot,
    notifyMsg?: { text: string; level: "info" | "warning" | "error" },
  ): Promise<boolean> {
    isPluginSwitching = true;
    try {
      const ok = await setModelTo(pi, ctx, slot);
      if (!ok) return false;

      const isPrimary = index === 0;
      ctx.ui.setStatus(
        "auto-model",
        ctx.ui.theme.fg(isPrimary ? "success" : "warning", `⚡ [M${index + 1}] ${slot.model}`),
      );
      if (notifyMsg) {
        ctx.ui.notify(notifyMsg.text, notifyMsg.level);
      }
      return true;
    } finally {
      isPluginSwitching = false;
    }
  }

  /**
   * 自动驱动模型接续工作，无需人工介入
   */
  function resumeWorkAutomatically(ctx: ExtensionContext, slotIndex: number, modelName: string) {
    const anyPi = pi as any;
    const anyCtx = ctx as any;

    try {
      if (typeof anyPi.sendUserMessage === "function") {
        anyPi.sendUserMessage("请继续");
      } else if (typeof anyPi.retry === "function") {
        anyPi.retry();
      } else if (typeof anyPi.retryTurn === "function") {
        anyPi.retryTurn();
      } else if (typeof anyPi.sendMessage === "function") {
        anyPi.sendMessage({ role: "user", content: "请继续" });
      } else if (typeof anyCtx.sendUserMessage === "function") {
        anyCtx.sendUserMessage("请继续");
      } else if (typeof anyCtx.session?.prompt === "function") {
        anyCtx.session.prompt("请继续");
      } else {
        ctx.ui.notify(`[M${slotIndex + 1}] ${modelName} 已就绪，请发送消息继续`, "info");
      }
    } catch (e) {
      console.error("[pi-auto-models] Auto resume error:", e);
      ctx.ui.notify(`[M${slotIndex + 1}] ${modelName} 已就绪，请发送消息继续`, "info");
    }
  }

  // 1. 监听模型变化（区分用户手工选择 vs 插件被动降级）
  pi.on("model_change", (event, ctx) => {
    const newProvider = event.model?.provider ?? ctx.model?.provider;
    const newModelId = event.model?.id ?? ctx.model?.id;
    const slotIdx = findSlotIndex(newProvider, newModelId);

    if (!isPluginSwitching) {
      if (slotIdx !== -1) {
        manualBaseIndex = slotIdx;
        ctx.ui.setStatus(
          "auto-model",
          ctx.ui.theme.fg(slotIdx === 0 ? "success" : "warning", `⚡ [M${slotIdx + 1}] ${modelChain[slotIdx].model}`),
        );
      } else if (newModelId) {
        manualBaseIndex = null;
        ctx.ui.setStatus("auto-model", ctx.ui.theme.fg("muted", `⚡ [Manual] ${newModelId}`));
      }
    }
  });

  // 2. 轮次开始（turn_start）：受控的受限自动恢复机制
  pi.on("turn_start", async (_event, ctx) => {
    if (manualBaseIndex === null) return;

    const currentProvider = ctx.model?.provider;
    const currentModelId = ctx.model?.id;
    const currentSlotIdx = findSlotIndex(currentProvider, currentModelId);

    if (currentSlotIdx === -1 || currentSlotIdx <= manualBaseIndex) return;

    for (let i = manualBaseIndex; i < currentSlotIdx; i++) {
      const candidate = modelChain[i];
      const modelExists = !!ctx.modelRegistry.find(candidate.provider, candidate.model);
      if (modelExists && !isModelCoolingDown(candidate.provider, candidate.model)) {
        await switchModelSlot(ctx, i, candidate, {
          text: `高优先级模型已解除冷却，已自动恢复至 [M${i + 1}] ${candidate.model}`,
          level: "info",
        });
        break;
      }
    }
  });

  // 3. 会话开始初始化
  pi.on("session_start", async (_event, ctx) => {
    modelChain = readConfig();
    const currentSlotIdx = findSlotIndex(ctx.model?.provider, ctx.model?.id);

    if (currentSlotIdx !== -1) {
      manualBaseIndex = currentSlotIdx;
      const cur = modelChain[currentSlotIdx];
      if (isModelCoolingDown(cur.provider, cur.model)) {
        await triggerFallbackAndRetry(ctx, cur.provider, cur.model, 0, "启动检测冷却", false);
      } else {
        ctx.ui.setStatus(
          "auto-model",
          ctx.ui.theme.fg(currentSlotIdx === 0 ? "success" : "warning", `⚡ [M${currentSlotIdx + 1}] ${cur.model}`),
        );
      }
    } else if (ctx.model?.id) {
      manualBaseIndex = null;
      ctx.ui.setStatus("auto-model", ctx.ui.theme.fg("muted", `⚡ [Manual] ${ctx.model.id}`));
    }
  });

  // 4. HTTP 级不可用拦截 (400, 401, 403, 404, 429, 500, 502, 503, 529 等)
  pi.on("after_provider_response", async (event, ctx) => {
    if (event.status >= 400) {
      const provider = ctx.model?.provider;
      const modelId = ctx.model?.id;
      if (!provider || !modelId) return;

      const cooldownMs = parseRetryCooldownMs(event.headers, 60 * 1000);
      await triggerFallbackAndRetry(ctx, provider, modelId, cooldownMs, `HTTP ${event.status}`);
    }
  });

  // 5. 消息级不可用拦截 (流中断、超时、格式报错等)
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!event.message.errorMessage) return;

    const provider = event.message.provider ?? ctx.model?.provider;
    const modelId = ctx.model?.id;
    if (!provider || !modelId) return;

    await triggerFallbackAndRetry(ctx, provider, modelId, 60 * 1000, event.message.errorMessage);
  });

  /**
   * 核心降级与全自动无缝接管
   */
  async function triggerFallbackAndRetry(
    ctx: ExtensionContext,
    failedProvider: string,
    failedModelId: string,
    cooldownMs: number,
    reason: string,
    shouldRetry = true,
  ) {
    const now = Date.now();
    if (isFallbackInProgress) return;
    if (now - lastFallbackTime < 1000) return;

    isFallbackInProgress = true;
    lastFallbackTime = now;

    let willUnlockAsync = false;

    try {
      if (cooldownMs > 0) {
        setModelCooldown(failedProvider, failedModelId, cooldownMs);
      }

      const currentSlotIdx = findSlotIndex(failedProvider, failedModelId);
      const startIdx = currentSlotIdx !== -1
        ? (currentSlotIdx + 1) % modelChain.length
        : (manualBaseIndex !== null ? manualBaseIndex : 0);

      let selected: { index: number; slot: ModelSlot } | null = null;
      for (let step = 0; step < modelChain.length; step++) {
        const candidateIdx = (startIdx + step) % modelChain.length;
        const candidateSlot = modelChain[candidateIdx];
        const exists = !!ctx.modelRegistry.find(candidateSlot.provider, candidateSlot.model);
        if (exists && !isModelCoolingDown(candidateSlot.provider, candidateSlot.model)) {
          selected = { index: candidateIdx, slot: candidateSlot };
          break;
        }
      }

      if (selected) {
        const ok = await switchModelSlot(ctx, selected.index, selected.slot, {
          text: `模型不可用 (${reason})，已自动切换至 [M${selected.index + 1}] ${selected.slot.model} 接管工作`,
          level: "warning",
        });

        if (ok && shouldRetry) {
          willUnlockAsync = true;
          // 留出 350ms 缓冲，确保前序报错轮次完全结算释放
          setTimeout(() => {
            try {
              resumeWorkAutomatically(ctx, selected!.index, selected!.slot.model);
            } finally {
              isFallbackInProgress = false;
            }
          }, 350);
          return;
        }
      } else {
        ctx.ui.notify("降级链条中所有备用模型均不可用或处于冷却中", "error");
      }
    } catch (e) {
      console.error("[pi-auto-models] Fallback error:", e);
    } finally {
      if (!willUnlockAsync) {
        isFallbackInProgress = false;
      }
    }
  }

  // ── /auto-model 交互式配置命令 ──

  pi.registerCommand("auto-model", {
    description: "配置 4 级模型自动降级链条",
    handler: async (_args, ctx) => {
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

      // 2. 搜索并选择模型
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

        let list = new SelectList(modelItems, Math.max(1, Math.min(modelItems.length, 12)), selectTheme);
        list.onSelect = (item) => { if (item.value) done(item.value); };
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

          const displayItems = filtered.length > 0
            ? filtered
            : [{ value: "", label: "无匹配模型", description: "按 Backspace 修改检索词" }];

          list = new SelectList(displayItems, Math.max(1, Math.min(displayItems.length, 12)), selectTheme);
          list.onSelect = (item) => { if (item.value) done(item.value); };
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
            } else if (
              !data.startsWith("\x1b") &&
              !matchesKey(data, Key.enter) &&
              !matchesKey(data, Key.tab) &&
              data.charCodeAt(0) >= 32
            ) {
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
      const thinkingItems: SelectItem[] = VALID_THINKING_LEVELS.map((l) => ({ value: l, label: l }));
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

      if (targetIndex === manualBaseIndex) {
        await switchModelSlot(ctx, targetIndex, modelChain[targetIndex]);
      }
    },
  });
}