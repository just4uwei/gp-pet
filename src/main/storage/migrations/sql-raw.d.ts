/**
 * `?raw` 导入的类型声明。
 *
 * 迁移写成 .sql 文件而不是 TS 模板串，是为了让 SQL 保持可高亮、可 diff、可被 sqlite 工具直接执行；
 * `?raw` 由 Vite 在构建期内联成字符串，打包后不需要额外把文件塞进 extraResources。
 */
declare module '*.sql?raw' {
  const sql: string
  export default sql
}
