/**
 * 关于页：版本号、检查更新、开源地址。
 * （v0.8.18 起 about 页已 React 化，实际渲染由 about-react.tsx 接管；
 *   本文件保留仅为兼容旧骨架，不再加载群二维码。）
 */
import { api, ckAlert } from '../shared.js';

export async function loadAbout(): Promise<void> {
  if (api.getAppInfo) {
    try {
      const r = await api.getAppInfo();
      const verEl = document.getElementById('about-version');
      if (r && r.success && verEl) verEl.textContent = r.version || '—';
    } catch (_) { /* ignore */ }
  }
}

const aboutCheckBtn = document.getElementById('about-check-update') as any;
if (aboutCheckBtn) aboutCheckBtn.addEventListener('click', async () => {
  if (!api.checkUpdate) return;
  aboutCheckBtn.disabled = true;
  try {
    const r = await api.checkUpdate();
    if (r && !r.success) await ckAlert((r && r.error) || '检查更新失败');
  } catch (e: any) { await ckAlert('检查更新失败: ' + (e.message || e)); }
  aboutCheckBtn.disabled = false;
});
document.getElementById('about-github')?.addEventListener('click', () => {
  if (api.openExternal) api.openExternal('https://github.com/paker5200/cuckoo-code');
});
