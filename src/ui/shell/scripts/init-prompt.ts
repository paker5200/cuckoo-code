/**
 * 初始化项目输入弹窗（壳页面）
 */
import { api } from './shared.js';

export function bindInitPrompt() {
  // 使用事件委托绑定到 document，防止 React 重渲染或移动 DOM 导致绑定失效
  document.addEventListener('click', async (e: Event) => {
    const target = e.target as HTMLElement;
    if (!target) return;

    // 处理选择目录
    if (target.closest('#init-prompt-select-dir')) {
      e.preventDefault();
      const selectDirBtn = target.closest('#init-prompt-select-dir') as HTMLButtonElement;
      const dirInput = document.getElementById('init-prompt-dir') as HTMLInputElement;
      const textarea = document.getElementById('init-prompt-textarea') as HTMLTextAreaElement;
      if (!api.selectProjectDir) return;
      selectDirBtn.disabled = true;
      selectDirBtn.textContent = '选择中...';
      try {
        const res = await api.selectProjectDir();
        if (res && res.success && res.dir) {
          if (dirInput) dirInput.value = res.dir;
          if (textarea) textarea.focus();
        } else if (res && !res.success) {
          alert(res.message || '未选择目录');
        }
      } finally {
        selectDirBtn.disabled = false;
        selectDirBtn.textContent = '选择目录';
      }
      return;
    }

    // 处理发送
    if (target.closest('#init-prompt-send')) {
      console.log('[Cuckoo Init] 点击了发送按钮！');
      e.preventDefault();
      const modal = document.getElementById('init-prompt-modal');
      const sendBtn = target.closest('#init-prompt-send') as HTMLButtonElement;
      const dirInput = document.getElementById('init-prompt-dir') as HTMLInputElement;
      const textarea = document.getElementById('init-prompt-textarea') as HTMLTextAreaElement;

      let text = textarea ? textarea.value.trim() : '';
      if (!dirInput || !dirInput.value) {
        alert('请先选择项目目录');
        return;
      }
      if (!text) text = '请开始分析该项目。';

      // 立刻关闭弹窗，给用户明确反馈
      alert('已获取到内容，准备发送！');
      if (modal) modal.classList.add('cuckoo-hidden');
      if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.textContent = '发送中...';
      }

      // 唤醒视图
      if (api.setAiViewVisible) {
        try { api.setAiViewVisible(true).catch(() => {}); } catch (_) {}
      }

      // 延迟发送确保 DOM 就绪
      setTimeout(async () => {
        try {
          if (!api.sendInitMessage) {
            throw new Error('缺少必要的 API');
          }
          const res = await api.sendInitMessage(text, dirInput.value);
          if (!res || !res.success) {
            alert('发送失败: ' + (res?.error || '未知错误'));
            if (modal) modal.classList.remove('cuckoo-hidden');
          }
        } catch (err: any) {
          alert('发送异常: ' + err.message);
          if (modal) modal.classList.remove('cuckoo-hidden');
        } finally {
          if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.textContent = '发送';
          }
        }
      }, 500);
      return;
    }

    // 处理取消
    if (target.closest('#init-prompt-cancel')) {
      e.preventDefault();
      const modal = document.getElementById('init-prompt-modal');
      if (modal) modal.classList.add('cuckoo-hidden');
      if (api.setAiViewVisible) {
        try { api.setAiViewVisible(true).catch(() => {}); } catch (_) {}
      }
      if (api.cancelInitPrompt) {
        api.cancelInitPrompt();
      }
      return;
    }
  });

  // 保留弹窗显示的监听
  const modal = document.getElementById('init-prompt-modal');
  if (modal && modal.parentElement !== document.body) {
    document.body.appendChild(modal);
  }

  const triggerShow = (data?: any) => {
    const m = document.getElementById('init-prompt-modal');
    if (!m) return;
    const dirInput = document.getElementById('init-prompt-dir') as HTMLInputElement;
    const textarea = document.getElementById('init-prompt-textarea') as HTMLTextAreaElement;

    const isVisible = !m.classList.contains('cuckoo-hidden');
    if (isVisible && (!data || !data.projectDir)) return;
    
    if (!isVisible) {
      m.classList.remove('cuckoo-hidden');
      if (api.setAiViewVisible) {
        try { api.setAiViewVisible(false).catch(() => {}); } catch (_) {}
      }
    }
    
    if (data && data.projectDir) {
      if (dirInput) dirInput.value = data.projectDir;
      if (textarea) textarea.focus();
    } else if (!isVisible) {
      if (dirInput) dirInput.value = '';
      if (textarea) textarea.value = '';
    }
  };

  (window as any).__ckShowInitModal = triggerShow;

  if (api.onShowInitPrompt) {
    api.onShowInitPrompt(triggerShow);
  }
}
