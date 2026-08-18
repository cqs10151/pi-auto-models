/**
 * Auto Model Switch Extension
 * 纯粹、确定性的多槽位模型循环降级与手工优先接管插件
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, SelectList, type SelectItem, matchesKey, Key } from "@earendil-works/pi-tui";
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
  let lastSlotIndex: number = 0;         // 记忆最后一次有效的槽位索引 (0..3 对应 M1..M4，默认 M1)
  let isPluginSwitching: boolean = false; // 标识是否为插件内部发起的切换
  let isFallbackInProgress: boolean = false; // 降级与重试执行互斥锁

  function findSlotIndex(provider?: string, modelId?: string): number {
    if (!provider || !modelId) return -1;
    return modelChain.findIndex((s) => s.provider === provider && s.model === modelId);
  }

  async function setModelTo(ctx: ExtensionContext, slot: ModelSlot): Promise<boolean> {
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
   * 切换槽位模型并更新状态栏显示
   */
  async function switchModelSlot(
    ctx: ExtensionContext,
    index: number,
    slot: ModelSlot,
    notifyMsg?: { text: string; level: "info" | "warning" | "error" },
  ): Promise<boolean> {
    isPluginSwitching = true;
    try {
      const ok = await setModelTo(ctx, slot);
      if (!ok) return false;

      ctx.ui.setStatus(
        "auto-model",
        ctx.ui.theme.fg(index === 0 ? "success" : "warning", `⚡ [M${index + 1}] ${slot.model}`),
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
   * 原生重试接续
   */
  function triggerAutoRetry(ctx: ExtensionContext, slotIndex: number, modelName: string) {
    const anyPi = pi as any;
    const anyCtx = ctx as any;

    try {
      if (typeof anyPi.retry === "function") {
        anyPi.retry();
      } else if (typeof anyPi.retryTurn === "function") {
        anyPi.retryTurn();
      } else if (typeof anyCtx.retry === "function") {
        anyCtx.retry();
      } else {
        ctx.ui.notify(`[M${slotIndex + 1}] ${modelName} 已就绪，请按 Enter 继续`, "info");
      }
    } catch (e) {
      console.error("[pi-auto-models] Auto retry failed:", e);
      ctx.ui.notify(`[M${slotIndex + 1}] ${modelName} 已就绪，请按 Enter 继续`, "info");
    }
  }

  /**
   * 核心故障接管逻辑
   */
  async function triggerFallback(ctx: ExtensionContext, reason: string) {
    if (isFallbackInProgress) return;
    isFallbackInProgress = true;

    try {
      const currentProvider = ctx.model?.provider;
      const currentModelId = ctx.model?.id;
      const currentSlotIdx = findSlotIndex(currentProvider, currentModelId);

      let targetIndex: number;
      if (currentSlotIdx === -1) {
        // 当前为外部手工模型：从手工切换前记录的槽位状态开始（如 M2 切换外部挂掉，继续尝试 M2）
        targetIndex = lastSlotIndex;
      } else {
        // 当前为槽位模型：顺推到下一个槽位并循环 (M1->M2->M3->M4->M1...)
        targetIndex = (currentSlotIdx + 1) % modelChain.length;
      }

      const targetSlot = modelChain[targetIndex];
      const prevModelLabel = currentModelId || "当前模型";

      const ok = await switchModelSlot(ctx, targetIndex, targetSlot, {
        text: `[${prevModelLabel}] 异常 (${reason}) -> 已自动接管至 [M${targetIndex + 1}] ${targetSlot.model}`,
        level: "warning",
      });

      if (ok) {
        lastSlotIndex = targetIndex;
        // 1.5 秒防雪崩节流延迟后，发起自动重试
        setTimeout(() => {
          try {
            triggerAutoRetry(ctx, targetIndex, targetSlot.model);
          } finally {
            isFallbackInProgress = false;
          }
        }, 1500);
        return;
      }
    } catch (err) {
      console.error("[pi-auto-models] Fallback error:", err);
    }
    isFallbackInProgress = false;
  }

  // 1. 监听会话启动
  pi.on("session_start", async (_event, ctx) => {
    modelChain = readConfig();
    const currentSlotIdx = findSlotIndex(ctx.model?.provider, ctx.model?.id);

    if (currentSlotIdx !== -1) {
      lastSlotIndex = currentSlotIdx;
      ctx.ui.setStatus(
        "auto-model",
        ctx.ui.theme.fg(currentSlotIdx === 0 ? "success" : "warning", `⚡ [M${currentSlotIdx + 1}] ${modelChain[currentSlotIdx].model}`),
      );
    } else if (ctx.model?.id) {
      ctx.ui.setStatus("auto-model", ctx.ui.theme.fg("muted", `⚡ [Manual] ${ctx.model.id}`));
    }
  });

  // 2. 监听用户手工切换模型
  pi.on("model_change", (event, ctx) => {
    if (isPluginSwitching) return;

    const newProvider = event.model?.provider ?? ctx.model?.provider;
    const newModelId = event.model?.id ?? ctx.model?.id;
    const slotIdx = findSlotIndex(newProvider, newModelId);

    if (slotIdx !== -1) {
      // 用户手工切到 M1~M4 其中一个槽位
      lastSlotIndex = slotIdx;
      ctx.ui.setStatus(
        "auto-model",
        ctx.ui.theme.fg(slotIdx === 0 ? "success" : "warning", `⚡ [M${slotIdx + 1}] ${modelChain[slotIdx].model}`),
      );
    } else if (newModelId) {
      // 用户手工切到外部独立模型：保留 lastSlotIndex 不变，更新显示
      ctx.ui.setStatus("auto-model", ctx.ui.theme.fg("muted", `⚡ [Manual] ${newModelId}`));
    }
  });

  // 3. HTTP 级响应拦截
  pi.on("after_provider_response", async (event, ctx) => {
    // 明确排除 401, 403 (API Key 错误 / 未授权)，不接管
    if (event.status === 401 || event.status === 403) {
      return;
    }

    // 400, 429, 529, 500, 502, 503 等错误触发自动接管
    if (event.status >= 400) {
      const reason = event.status === 429 ? "429 Rate Limit" : `HTTP ${event.status}`;
      await triggerFallback(ctx, reason);
    }
  });

  // 4. 消息/流级异常拦截
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!event.message.errorMessage) return;

    const err = event.message.errorMessage;
    // 忽略包含明确 401/403 鉴权特征的流报错
    if (err.includes("401") || err.includes("403") || /unauthorized|invalid api key/i.test(err)) {
      return;
    }

    // 忽略用户主动取消 / 中断场景
    if (/abort|cancel|interrupted|context canceled/i.test(err)) {
      return;
    }

    await triggerFallback(ctx, err);
  });

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
      ctx.ui.notify(`Slot ${targetIndex + 1} 已更新为 ${chosenModel} (${thinking})`, "info");

      // 如果修改的是当前槽位，立即刷新
      const curSlotIdx = findSlotIndex(ctx.model?.provider, ctx.model?.id);
      if (curSlotIdx === targetIndex) {
        await switchModelSlot(ctx, targetIndex, modelChain[targetIndex]);
      }
    },
  });
}