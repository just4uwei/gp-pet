import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root 缺失')

// 刻意不套 StrictMode：StrictMode 会把 effect 跑两遍，
// 而桌宠的 effect 里带着 setIgnoreMouseEvents 这类跨进程副作用，双跑会让 C2 的行为难以判读。
createRoot(container).render(<App />)
