import { api } from './shared.js';

// 维护一个引用计数：只要有任何一个组件（设置面板、原生弹窗、DSH插件页）要求隐藏，AI视图就必须隐藏。
let hideCount = 0;

export function hideAiView(): void {
  hideCount++;
  if (hideCount === 1) {
    const anyApi = api as any;
    if (anyApi.setAiViewVisible) anyApi.setAiViewVisible(false).catch(() => {});
  }
}

export function showAiView(): void {
  hideCount = Math.max(0, hideCount - 1);
  if (hideCount === 0) {
    const anyApi = api as any;
    if (anyApi.setAiViewVisible) anyApi.setAiViewVisible(true).catch(() => {});
  }
}

export function forceShowAiView(): void {
  hideCount = 0;
  const anyApi = api as any;
  if (anyApi.setAiViewVisible) anyApi.setAiViewVisible(true).catch(() => {});
}
