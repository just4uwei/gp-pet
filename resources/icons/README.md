# resources/icons/

应用与托盘图标。形象是「蹲点」的角色像素画（银白长发 + 右侧黑蝴蝶结 + 红金军装 +
黑裙白荷叶边 + 白过膝袜黑鞋）。

```
app/
  icon.png          256×256，**手绘源文件** —— 下面所有 ico 档位都从它缩出来
  icon.ico          安装包与窗口图标（16/32/48/64/128/256 六档，每档一个 PNG 条目）
  tray.png          16×16 托盘图标（常态）
  tray@2x.png       32×32，Electron 按命名约定自动选取，不需要代码判断缩放比
  tray-muted.png    免打扰状态
  tray-muted@2x.png
```

## 四条注意

1. **`icon.png` 与四张 `tray*.png` 是手绘美术资产，不是生成件。**
   要换形象就直接替换这几个文件（尺寸与文件名保持不变），
   然后跑一次下面那条命令把 `icon.ico` 重出。

2. **`icon.ico` 是唯一的生成件**，由 [`tools/logo/make-ico.mjs`](../../tools/logo/make-ico.mjs)
   从 `icon.png` 缩出六档：

   ```bash
   node tools/logo/make-ico.mjs                  # 覆盖 icon.ico
   LOGO_PREVIEW=1 node tools/logo/make-ico.mjs   # 顺带往临时目录写各档放大图给人眼看
   ```

   它**刻意不进 `package.json` 的 scripts**，也没有 `verify:` 配套 ——
   2026-08-13 删掉 `tools/asset-build/`（那套画猫的生成器 + `pnpm assets:build` /
   `verify:assets`）时定下的口径是「图标是静态资源」，这条不推翻。
   脚本**只读**那五张 png，只写 `icon.ico`。

   为什么要预先出六档而不是只丢一张 256：Windows 在任务栏 / Alt-Tab / 资源管理器各档视图 /
   安装程序里各取一档，只有 256 的话小尺寸全由系统临时缩，糊且不可控。

3. **16px 那一档是全身像缩下来的，必然发糊** —— 一个站姿角色缩到 16×16 就只剩色块。
   要让它可辨，唯一的办法是**单独给一张 16×16 的头像**（`tray@2x.png` 就是这么做的：
   它是头肩像而不是全身像，所以 32px 下五官还在）。
   哪天要做，就在 `make-ico.mjs` 里把 16/32 两档改成读 `tray.png` / `tray@2x.png`，
   而不是继续调缩放算法 —— 那不是算法问题。

4. **目录名 `app` 不是皮肤 id。** 旧版本这里叫 `default`，那时托盘图标随皮肤走
   （`resources/icons/<skin>/`）。现在路径是常量，写死在
   [`src/main/tray/TrayController.ts`](../../src/main/tray/TrayController.ts) 里；
   `electron-builder.yml` 有四处引用同一个目录，改名要一起改。
   面板头部的品牌标记也直接取 `tray.png`（走 `res://`，见
   [`src/renderer/panel/BrandMark.tsx`](../../src/renderer/panel/BrandMark.tsx)）。

图标缺失时托盘不会建不出来 —— 会退到
[`src/main/tray/fallback-icon.ts`](../../src/main/tray/fallback-icon.ts) 里那个内置兜底位图
（就是 `tray.png` 的像素，去掉元数据后内联成 base64）并打一条 warn。
退出与「显示悬浮条」只有托盘这一条路（C9），所以这条降级路径必须保持可用。
**换了 `tray.png` 记得把那一串 base64 一起换**，`make-ico.mjs` 每次都会打印它。
