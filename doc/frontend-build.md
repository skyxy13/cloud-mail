# 前端构建与产物体积

## 现在的策略

- 路由全部懒加载（`src/perm/perm.js` 里每个页面都是 `() => import(...)`）。
- `vite.config.js` 只把 **echarts** 单独拆成一个 chunk（`manualChunks`），其余依赖交给 rollup 按引用关系自动切分。
- `chunkSizeWarningLimit` 设为 600kB：echarts 块体积大但只在分析页加载，不算首屏问题。

## 实测数据（`npm run build`，gzip）

| 项目 | 改动前 | 改动后 |
| --- | --- | --- |
| 首屏（index.html 引用的 JS） | 305 kB / gzip 114 kB | 305 kB / gzip 114 kB |
| 分析页 echarts chunk | 与页面代码合并 543 kB | 单独 531 kB + 页面 ~12 kB |

首屏没有变化（本来就只有 305 kB），但 echarts 单独成块后 hash 稳定：改业务代码时这个 531 kB
不会再失效，老用户回访分析页可以直接命中缓存。

## 踩过的坑（不要再踩）

一开始把 `element-plus` / `vue` / 剩余依赖分别塞进 `vendor` 之类的固定块，结果首屏从
**305 kB 涨到 811 kB**（gzip 114 → 275 kB）。原因：`manualChunks` 是按模块路径强制分组，
会把「只被懒加载页面用到」的模块（dexie、compressorjs、其它 element-plus 组件）也拉进首屏
引用的块里，破坏了按路由自动切分。

结论：除非有明确的缓存收益（比如体积大、几乎不变、只在某个页面用的库，如 echarts），
否则不要手写 `manualChunks`，交给 rollup。

## 检查方法

```bash
cd mail-vue && npm run build
# 首屏引用（script + modulepreload）就是 index.html 里的这些文件
type ..\mail-worker\dist\index.html | findstr ".js"
```
