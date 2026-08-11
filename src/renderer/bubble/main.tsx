/**
 * 气泡窗口入口 —— 构建产物占位。
 *
 * 气泡属 M3（提醒层，docs/08），主进程目前不创建 BubbleWindow：
 * 骨架阶段没有可提醒的内容，提前挂一个常驻置顶的空窗口只会白占 C7 的开销预算。
 *
 * 这里保留入口是因为 electron.vite.config.ts 声明了三个渲染入口，
 * 缺文件会让构建失败 —— 也提醒后续实现者：气泡的窗口配置见 docs/06 §2.3，
 * 关键约束是 setIgnoreMouseEvents 常开（气泡完全不可点击）。
 */

import { createRoot } from 'react-dom/client'

const container = document.getElementById('root')
if (!container) throw new Error('#root 缺失')

createRoot(container).render(null)
