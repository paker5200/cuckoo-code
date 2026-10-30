/**
 * 捐赠与支持区块（共用组件）
 *
 * 在 About 页和 Token 页各展示一份。
 * 样式复用 components.css 里的 ck-about-* 系列。
 */
import { createElement } from 'react';

export function DonationBlock() {
  return createElement('div', { className: 'ck-about-group' },
    createElement('div', { className: 'ck-about-group-title' }, '捐赠与支持'),
    createElement('p', { className: 'ck-about-tip' },
      '🚫 本项目不接受任何形式的个人捐赠——作者不会收取任何款项。',
    ),
  );
}
