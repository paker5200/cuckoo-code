/**
 * 「框架正在驱动 UI」时间窗
 *
 * 背景：挂载助手发送消息时会通过主进程 sendInputEvent 注入鼠标/键盘事件，
 * 这些事件在页面里是 **isTrusted=true 的真实 DOM 事件**，与用户手动点击无法靠
 * isTrusted 区分。上层若要判断"用户是否真的回来了"（例如空闲自动唤醒的重置逻辑），
 * 就必须靠这个时间窗把"框架自己造成的事件"排除掉。
 *
 * 设计要点：
 * - 独立叶子模块（src/infra 谁都能引），避免 chat-input → providers/registry →
 *   providers/chatgpt → chat-input 的循环依赖；
 * - mark 只**延长**不缩短（多轮点击重试时逐轮续期不会把小窗口写小）；
 * - 状态挂在 globalThis 上：同一渲染进程里即便存在多份模块实例（测试、多份模块图），
 *   读到的也是同一个窗口，避免"各持一份状态"导致的误判。
 *
 * 用法：
 * - 发送入口（chat-input.triggerSend 首行）：markFrameworkDriving()  // 默认 5 秒
 *   （入口只覆盖同步的 fallbackSend 兜底点击/Enter；长重试由 provider 逐轮续期）
 * - 平台多轮重试（providers/chatgpt.triggerSend 每轮）：markFrameworkDriving(2000)
 * - 判断用户操作（overlay/events.handleUserActivityForAutoWake 首行）：isFrameworkDriving()
 */

/** 全局唯一的"框架驱动截止时间戳"（挂 globalThis，避免测试/多份模块图各持一份状态） */
const G = globalThis as any;
const DRIVING_KEY = '__ckFrameworkDrivingUntil';
if (typeof G[DRIVING_KEY] !== 'number') G[DRIVING_KEY] = 0;

/**
 * 标记从现在起 ms 毫秒内属于"框架驱动 UI"。
 * 只延长不缩短：已有窗口更长时保持原值，避免短续期把长窗口改小。
 *
 * 时长取值说明：
 * - 入口 `chat-input.triggerSend()` 用**默认 5 秒**：只覆盖同步的 fallbackSend 点击/Enter
 *   注入（以及紧随其后的事件派发），不宜过长 —— 窗口内真实用户的点击不算"用户回来了"，
 *   过长会让"用户回到页面"迟迟无法解除自动唤醒的停用状态。
 * - 平台的多轮点击重试（ChatGPT 10 轮、每轮约 600ms、最坏 ~6s）由 provider 侧逐轮
 *   `markFrameworkDriving(2000)` 滚动续期覆盖，不依赖入口的大窗口。
 * @param ms 窗口长度（毫秒），默认 5000
 */
function markFrameworkDriving(ms: number = 5000): void {
  const span = Number.isFinite(ms) && ms > 0 ? ms : 5000;
  const until = Date.now() + span;
  if (until > G[DRIVING_KEY]) G[DRIVING_KEY] = until; // 只延长、不缩短
}

/**
 * 当前是否处于"框架驱动 UI"窗口内。
 * @returns true = 页面上的点击/按键可能来自框架自身，不应视为用户操作
 */
function isFrameworkDriving(): boolean {
  return Date.now() < G[DRIVING_KEY];
}

/** 清空时间窗（仅供单测清场，生产代码不要调用） */
function resetFrameworkDriving(): void {
  G[DRIVING_KEY] = 0;
}

export { markFrameworkDriving, isFrameworkDriving, resetFrameworkDriving };
