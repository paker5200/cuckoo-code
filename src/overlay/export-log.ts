/**
 * 导出对话日志
 *
 * 在 DeepSeek 会话「⋯」菜单（重命名 / 置顶 / 分享 / 多选 / 删除）末尾追加一项
 * 「导出对话日志」；点击后从 IndexedDB 读取该会话全量消息，组装 JSON，
 * 交主进程弹保存对话框写入本地文件。
 *
 * 菜单 DOM 依赖网页结构，这里用「文本匹配 + MutationObserver」的方式定位，
 * 尽量不绑死具体类名，降低网页改版导致失效的概率。
 */
import { showToast } from './panel.js';

const ITEM_FLAG = 'data-cuckoo-export-item';
const MENU_KEYWORDS = ['重命名', '删除'];

let installed = false;
/** 最近一次点击的会话（点「⋯」时捕获，菜单出现后用它确定导出目标） */
let lastSessionId: string | null = null;
let lastSessionTitle: string | null = null;

/** 从 URL 提取会话 id */
function sessionIdFromUrl(url: string): string | null {
  const m = String(url || '').match(/\/chat\/s\/([a-f0-9-]+)/i);
  return m ? m[1] : null;
}

/**
 * 从元素向上找它所属的会话：
 * 优先自身/后代/祖先里的 a[href*="/chat/s/"]，取 href 中的会话 id。
 */
function resolveSessionFrom(el: Element | null): { id: string | null; title: string | null } {
  let cur: Element | null = el;
  let depth = 0;
  while (cur && depth++ < 8) {
    let link: Element | null = null;
    try {
      if (cur.matches('a[href*="/chat/s/"]')) link = cur;
      else link = cur.querySelector('a[href*="/chat/s/"]');
    } catch (_) { /* ignore */ }
    if (link) {
      const href = link.getAttribute('href') || '';
      const id = sessionIdFromUrl(href);
      if (id) {
        const title = (link.textContent || '').trim() || null;
        return { id, title };
      }
    }
    cur = cur.parentElement;
  }
  return { id: null, title: null };
}

/** 捕获阶段记录"用户点的是哪个会话"，供后续导出用 */
function onPointerDown(e: Event): void {
  const el = e.target as Element | null;
  if (!el || typeof el.closest !== 'function') return;
  const r = resolveSessionFrom(el);
  if (r.id) {
    lastSessionId = r.id;
    lastSessionTitle = r.title;
  }
}

/** 从 IndexedDB 读取某会话的完整消息数组 */
function readSessionMessages(sessionId: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open('deepseek-chat'); } catch (e) { reject(e as Error); return; }
    req.onerror = () => reject(new Error('打开本地数据库失败'));
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('history-message', 'readonly');
        const store = tx.objectStore('history-message');
        const g = store.get(sessionId);
        g.onsuccess = () => {
          db.close();
          const data = g.result && (g.result as any).data;
          const msgs = data && data.chat_messages;
          if (!Array.isArray(msgs)) {
            reject(new Error('本地没有该对话的缓存，请先打开该对话、刷新一次页面再导出'));
            return;
          }
          resolve(msgs);
        };
        g.onerror = () => { db.close(); reject(new Error('读取对话消息失败')); };
      } catch (e) {
        db.close();
        reject(e as Error);
      }
    };
  });
}

/** 执行导出：读 IDB → 组装 JSON → 交主进程保存 */
async function exportConversation(): Promise<void> {
  const id = lastSessionId || sessionIdFromUrl(location.href);
  const title = lastSessionTitle || '';
  if (!id) {
    showToast('无法确定要导出的对话', 3000);
    return;
  }
  showToast('正在导出对话日志...', 2000);
  try {
    const messages = await readSessionMessages(id);
    messages.sort((a: any, b: any) => (a.message_id || 0) - (b.message_id || 0));
    const payload = {
      sessionId: id,
      title: title || null,
      url: location.href,
      exportedAt: new Date().toISOString(),
      messageCount: messages.length,
      messages,
    };
    const api = (window as any).electronAPI;
    if (!api || typeof api.exportSessionLog !== 'function') {
      showToast('当前环境不支持导出', 3000);
      return;
    }
    const r = await api.exportSessionLog({
      sessionId: id,
      title,
      json: JSON.stringify(payload, null, 2),
    });
    if (r && r.success) showToast('已导出到：' + r.path, 5000);
    else if (r && r.canceled) showToast('已取消导出', 2000);
    else showToast('导出失败：' + ((r && r.error) || '未知错误'), 5000);
  } catch (err: any) {
    showToast('导出失败：' + (err && err.message ? err.message : err), 5000);
  }
}

/** 判断元素文本是否同时包含会话菜单的关键词 */
function looksLikeSessionMenu(el: HTMLElement): boolean {
  const t = el.textContent || '';
  for (const k of MENU_KEYWORDS) if (t.indexOf(k) < 0) return false;
  return true;
}

/**
 * 找到"重命名"所在的菜单项整行元素。
 * 菜单项结构通常是 <div><svg/><span>重命名</span></div>：
 * 先取文本匹配的最深元素，再向上收敛到"文本仍等于该词"的最高一层（即整行）。
 */
function findItemByText(container: Element, text: string): HTMLElement | null {
  let best: HTMLElement | null = null;
  const all = container.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as HTMLElement;
    const t = (el.textContent || '').trim();
    if (!t || t.indexOf(text) !== 0) continue;
    if (!best || t.length < (best.textContent || '').trim().length) best = el;
  }
  if (!best) return null;
  // 向上收敛：只要父元素文本仍等价于当前元素文本，就上移（跳过 span → div 这类纯包装层）
  let cur: HTMLElement = best;
  const norm = (s: string) => s.replace(/\s+/g, '');
  while (cur.parentElement && cur.parentElement !== container) {
    if (norm(cur.parentElement.textContent || '') !== norm(cur.textContent || '')) break;
    cur = cur.parentElement;
  }
  return cur;
}

/** 把元素内文本节点里的 oldText 替换为 newText */
function replaceText(root: Element, oldText: string, newText: string): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const v = node.nodeValue || '';
    if (v.indexOf(oldText) >= 0) {
      node.nodeValue = v.replace(oldText, newText);
      return;
    }
  }
  // 没有独立文本节点（如被拆成多段）→ 退化为整体重写
  root.textContent = newText;
}

/** 向菜单容器插入「导出对话日志」项 */
function injectIntoMenu(container: HTMLElement): void {
  if (container.querySelector('[' + ITEM_FLAG + ']')) return;
  const renameItem = findItemByText(container, '重命名');
  if (!renameItem || !renameItem.parentElement) {
    // 找不到「重命名」项，挂到菜单容器末尾兜底
    const fallback = document.createElement('div');
    fallback.setAttribute(ITEM_FLAG, '1');
    fallback.textContent = '导出对话日志';
    fallback.style.cssText = 'padding:8px 12px;cursor:pointer;';
    fallback.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      exportConversation();
    }, true);
    container.appendChild(fallback);
    return;
  }
  const item = renameItem.cloneNode(true) as HTMLElement;
  item.setAttribute(ITEM_FLAG, '1');
  item.removeAttribute('id');
  item.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  // 去掉克隆节点上可能残留的 aria/焦点态
  item.removeAttribute('aria-checked');
  item.removeAttribute('aria-selected');
  replaceText(item, '重命名', '导出对话日志');
  // 捕获阶段拦截，避免被网页自身的事件处理抢走
  item.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    exportConversation();
  }, true);
  renameItem.parentElement.insertBefore(item, renameItem.nextSibling);
}

/** 递归扫描新增节点，命中"会话菜单"就注入 */
function scan(node: Node): void {
  if (!(node instanceof HTMLElement)) return;
  if (looksLikeSessionMenu(node)) {
    let childHit = false;
    for (let i = 0; i < node.children.length; i++) {
      const c = node.children[i];
      if (c instanceof HTMLElement && looksLikeSessionMenu(c)) { childHit = true; break; }
    }
    if (!childHit) {
      injectIntoMenu(node);
      return;
    }
  }
  for (let i = 0; i < node.children.length; i++) scan(node.children[i]);
}

/** 安装：监听点击（定位会话）+ 监听菜单出现（注入菜单项） */
function install(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('pointerdown', onPointerDown, true);
  
  // 监听 URL 变化，清理旧会话状态，防止导出到之前的对话
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastSessionId = null;
      lastSessionTitle = null;
    }
  }, 1000);
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (let i = 0; i < r.addedNodes.length; i++) scan(r.addedNodes[i]);
    }
  });
  const start = () => {
    if (!document.body) return;
    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[Cuckoo Code] 导出对话日志：菜单监听已安装');
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
}

export { install as installExportLog };
