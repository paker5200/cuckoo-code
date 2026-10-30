/**
 * React Hook：弹窗打开时隐藏 AI 视图（原生 WebContentsView 永远在网页之上）。
 * 用法：在模态组件的顶层调用 useHideAiView()；卸载时自动恢复。
 */
import { useEffect } from 'react';
import { api } from './shared.js';

/** 弹窗挂载时藏 AI 视图，卸载时恢复 */
export function useHideAiView(): void {
  useEffect(() => {
    const anyApi = api as any;
    if (anyApi.setAiViewVisible) anyApi.setAiViewVisible(false).catch(() => {});
    return () => { 
      // 如果当前是设置面板处于打开状态（强制隐藏），则不允许恢复 AI 视图
      if (!(window as any).__ckSettingsForcedHide && anyApi.setAiViewVisible) {
        anyApi.setAiViewVisible(true).catch(() => {}); 
      }
    };
  }, []);
}
