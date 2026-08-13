# resources/icons/

应用与托盘图标。

```
app/
  icon.ico          安装包与窗口图标（16/32/48/64/128/256 多尺寸）
  icon.png          256×256，electron-builder 的 buildResources 用
  tray.png          16×16 托盘图标
  tray@2x.png       32×32，Electron 按命名约定自动选取，不需要代码判断缩放比
  tray-muted.png    免打扰状态的去饱和版
  tray-muted@2x.png
```

## 两条注意

1. **这些是静态资源，不再是生成件。** 2026-08-13 移除皮肤系统时，连同
   `tools/asset-build/`（那套画猫的程序化生成器）与 `pnpm assets:build` /
   `pnpm verify:assets` 一起删掉了。要换图标就直接替换这里的文件，
   尺寸与命名保持不变即可。

2. **目录名 `app` 不是皮肤 id。** 旧版本这里叫 `default`，那时托盘图标随皮肤走
   （`resources/icons/<skin>/`）。现在路径是常量，写死在
   [`src/main/tray/TrayController.ts`](../../src/main/tray/TrayController.ts) 里；
   `electron-builder.yml` 有四处引用同一个目录，改名要一起改。

图标缺失时托盘不会建不出来 —— 会退到 `src/main/tray/fallback-icon.ts` 里那个
内置的 base64 兜底图标并打一条 warn。退出与「显示悬浮条」只有托盘这一条路（C9），
所以这条降级路径必须保持可用。
