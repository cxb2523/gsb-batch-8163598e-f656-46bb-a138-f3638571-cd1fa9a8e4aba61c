# 发布到 GitHub 与扩展商店

这个目录本身就是一个可以独立发布的仓库，不需要构建工具；扩展代码也没有运行时依赖。`tools/pack.mjs` 只是把运行时文件打成 zip。

## 1. 建议的仓库信息

- **仓库名**：`bilibili-volume-balancer`
- **描述**：`B站网页视频响度均衡扩展：按 EBU R128 测量并拉齐不同视频的音量，支持 Chrome / Edge / Firefox。`
- **Topics**：`bilibili`、`chrome-extension`、`edge-extension`、`firefox-extension`、`loudness`、`ebu-r128`、`web-audio`
- **License**：MIT（已放在 `LICENSE`）

## 2. 创建仓库并推送

在 GitHub 上新建一个空仓库，**不要**勾选自动生成 README、.gitignore 或 LICENSE，避免和已有文件冲突。

然后在本目录执行：

```bash
git init
git add .
git commit -m "feat: initial release"
git branch -M main
git remote add origin https://github.com/<你的用户名>/bilibili-volume-balancer.git
git push -u origin main
```

如果本机安装了 `gh` 并已登录：

```bash
gh repo create bilibili-volume-balancer --public --source=. --remote=origin --push
```

## 3. 打发布包

```bash
node tools/pack.mjs
```

产物：

```
dist/chrome/bilibili-volume-balancer-chrome.zip     # Chrome / Edge，去掉了 Firefox 专用键
dist/firefox/bilibili-volume-balancer-firefox.zip   # Firefox，含 gecko id 与数据收集声明
dist/chrome/…、dist/firefox/…                       # 解压后的目录，本地"加载已解压的扩展"用
```

`dist/` 和 `*.zip` 都在 `.gitignore` 里，不要提交，放到 GitHub Releases 即可。

## 4. 发布到 GitHub Releases

1. 打 tag：

```bash
git tag v0.2.0
git push origin v0.2.0
```

2. 在仓库页面进入 **Releases → Draft a new release**；
3. 选择 `v0.2.0`，把两个 zip 都上传；
4. 说明里分开写安装方式：
   - Chrome / Edge：解压 → 扩展页 → 开发者模式 → 加载已解压的扩展；
   - Firefox：`about:debugging#/runtime/this-firefox` → 临时载入附加组件 → 选 `manifest.json`。

## 5. Firefox：签名与 AMO 上架

Firefox 正式版只安装已签名的扩展，所以要么上架 AMO，要么用 `web-ext sign` 做自托管签名。

**方式一：AMO 上架（推荐）**

1. 用 Firefox 账号登录 [addons.mozilla.org 开发者中心](https://addons.mozilla.org/developer/)；
2. **Submit a New Add-on** → 选择 **On this site**（公开列表）或 **On your own**（自托管）；
3. 上传 `dist/firefox/bilibili-volume-balancer-firefox.zip`；
4. 提交时确认数据收集声明为 **none**（清单里已经写了 `data_collection_permissions.required = ["none"]`，与之一致）；
5. 审核通过后拿到的 `*.xpi` 就是可永久安装的版本。

**方式二：命令行签名（自托管）**

```bash
npx web-ext sign \
  --source-dir dist/firefox \
  --channel unlisted \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET"
```

`--channel unlisted` 不会出现在 AMO 搜索里，签名后的 xpi 在 `web-ext-artifacts/` 下，用户可以用它安装。

## 6. Chrome Web Store / Edge Add-ons

两边都接受 `dist/chrome/bilibili-volume-balancer-chrome.zip`：

- Chrome Web Store：开发者后台 → 新增项目 → 上传 zip；
- Edge Add-ons：Partner Center → 新建扩展 → 上传 zip。

清单里没有 `content_security_policy` 放宽、没有远程代码、权限只有 `storage` 和 B 站域名，审核通常比较直接。

## 7. 发布前检查清单

- [ ] `npm test` 通过（Node 22+，只跑算法测试，不需要装依赖）；
- [ ] `npm run check` 通过；
- [ ] `npm run pack` 产出两个 zip，且 Firefox 包里有 `browser_specific_settings`；
- [ ] `npx web-ext lint --source-dir dist/firefox` 没有 error（`innerHTML` 那两条 warning 是面板静态模板，可忽略）；
- [ ] `npm run test:e2e`（Chromium）与 `npm run test:e2e:firefox`（Firefox，先 `npm install`）都通过；
- [ ] 在真实的 Chrome / Edge / Firefox 里各加载一次，确认面板出现、状态变成"已均衡"；
- [ ] README 里的截图路径 `docs/panel.png` 正常显示；
- [ ] 保留非官方声明：与哔哩哔哩无隶属关系；
- [ ] 不要把 B 站视频、音频或登录态上传到仓库。

## 8. 关于截图和素材

`docs/panel.png` 是在 B 站页面上截的控制面板，背景里可能带有少量页面元素。它只用于说明扩展功能，不构成对 B 站内容的再分发。若你希望仓库完全干净，可以：

- 用一张纯色背景 + 面板的截图替换它；或
- 从 README 中删除截图，只保留文字说明。

测试视频 `test/e2e/level-test.webm` 是用 ffmpeg 生成的正弦波和纯色画面，不包含第三方内容，可以安全提交。
