/**
 * 气泡窗口入口（docs/06 §2.3）。
 *
 * 窗口由主进程的 `BubbleWindow` 懒加载创建 —— 第一条 L2 提醒到来时才有这个进程。
 * 关键约束在主进程那一侧：`setIgnoreMouseEvents(true)` 常开、`focusable: false`。
 * 这里只负责画内容与淡入淡出。
 */

import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root 缺失')

// 与悬浮条同样不套 StrictMode：effect 里注册的是跨进程推送订阅，双跑会收到两遍同一条提醒
createRoot(container).render(<App />)
