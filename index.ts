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
  let lastFallbackTime = 0;                // 最近一次降级触发时间戳（防抖防竞争）

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

  // 1. 监听模型变化（区分用户手工选择 vs 插件被动降级）
  pi.on("model_change", (event, ctx) => {
    const newProvider = event.model?.provider ?? ctx.model?.provider;
    const newModelId = event.model?.id ?? ctx.model?.id;
    const slotIdx = findSlotIndex(newProvider, newModelId);

    // 如果不是插件发起的切换，则 100% 确认是用户手工切换
    if (!isPluginSwitching) {
      if (slotIdx !== -1) {
        // 场景 B：手工切换到了 M1~M4 中的某个槽位，更新基准锚点
        manualBaseIndex = slotIdx;
        ctx.ui.setStatus(
          "auto-model",
          ctx.ui.theme.fg(slotIdx === 0 ? "success" : "warning", `⚡ [M${slotIdx + 1}] ${modelChain[slotIdx].model}`),
        );
      } else if (newModelId) {
        // 场景 A：手工切换到了外部独立模型
        manualBaseIndex = null;
        ctx.ui.setStatus("auto-model", ctx.ui.theme.fg("muted", `⚡ [Manual] ${newModelId}`));
      }
    }
  });

  // 2. 轮次开始（turn_start）：受控的受限自动恢复机制
  pi.on("turn_start", async (_event, ctx) => {
    // 场景 A：用户处于外部独立模型，完全放行，不做任何自动干预
    if (manualBaseIndex === null) return;

    const currentProvider = ctx.model?.provider;
    const currentModelId = ctx.model?.id;
    const currentSlotIdx = findSlotIndex(currentProvider, currentModelId);

    if (currentSlotIdx === -1) return;

    // 场景 B：如果当前槽位已经处于或高于手工设定的基准点，绝不向前回拉
    if (currentSlotIdx <= manualBaseIndex) return;

    // 尝试在 [manualBaseIndex, currentSlotIdx - 1] 区间寻找已解除冷却的最高优先级模型
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
      // 检查当前模型是否在冷却中，若是则自动切到可用模型
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

  // 4. HTTP 级不可用拦截 (400, 401, 403, 404, 429, 500, 502, 503, 529 等任意 >= 400 错误)
  pi.on("after_provider_response", async (event, ctx) => {
    if (event.status >= 400) {
      const provider = ctx.model?.provider;
      const modelId = ctx.model?.id;
      if (!provider || !modelId) return;

      const cooldownMs = parseRetryCooldownMs(event.headers, 60 * 1000);
      await triggerFallbackAndRetry(ctx, provider, modelId, cooldownMs, `HTTP ${event.status}`);
    }
  });

  // 5. 消息级不可用拦截 (网络断开、超时、流异常、参数格式校验报错等)
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!event.message.errorMessage) return;

    const provider = event.message.provider ?? ctx.model?.provider;
    const modelId = ctx.model?.id;
    if (!provider || !modelId) return;

    await triggerFallbackAndRetry(ctx, provider, modelId, 60 * 1000, event.message.errorMessage);
  });

  /**
   * 核心降级与接管重试流程（完全杜绝死锁与事件双触发竞态）
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
    // 互斥与防抖：在降级过程中或1秒内同一轮次连续报错直接忽略
    if (isFallbackInProgress) return;
    if (now - lastFallbackTime < 1000) return;

    isFallbackInProgress = true;
    lastFallbackTime = now;

    let willUnlockAsync = false;

    try {
      // 记录失败模型的冷却
      if (cooldownMs > 0) {
        setModelCooldown(failedProvider, failedModelId, cooldownMs);
      }

      // 计算顺次降级的起始搜索槽位
      const currentSlotIdx = findSlotIndex(failedProvider, failedModelId);
      const startIdx = currentSlotIdx !== -1
        ? (currentSlotIdx + 1) % modelChain.length
        : (manualBaseIndex !== null ? manualBaseIndex : 0);

      // 顺次循环寻找第一个未在冷却中且注册表存在的模型
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
          text: `模型不可用 (${reason})，已切换至 [M${selected.index + 1}] ${selected.slot.model} 接管`,
          level: "warning",
        });

        if (ok && shouldRetry) {
          willUnlockAsync = true;
          setTimeout(() => {
            try {
              const anyPi = pi as any;
              if (typeof anyPi.retry === "function") {
                anyPi.retry();
              } else {
                ctx.ui.notify(`模型已就绪 [M${selected!.index + 1}] ${selected!.slot.model}，请继续`, "info");
              }
            } catch {
              ctx.ui.notify(`模型已就绪 [M${selected!.index + 1}] ${selected!.slot.model}，请继续`, "info");
            } finally {
              isFallbackInProgress = false; // 重试发起后释放锁
            }
          }, 200);
          return;
        }
      } else {
        ctx.ui.notify("降级链条中所有备用模型均不可用或处于冷却中", "error");
      }
    } catch (e) {
      console.error("[pi-auto-models] Fallback error:", e);
    } finally {
      // 只要没有进入异步重试流程，立即同步释放锁，彻底杜绝死锁
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