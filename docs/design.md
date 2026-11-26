# 设计说明：B站音量均衡器

## 1. 问题

同一个系统音量下，不同 B 站视频的听感响度差异很大。原因通常不是"音量条"不同，而是 UP 主在混音/导出时把整体电平做在了不同水平：

- 有的视频 integrated loudness 只有 `-26 LUFS`，听起来很小；
- 有的视频到了 `-9 LUFS`，听起来很吵；
- 还有的峰值已经削波，但整体 RMS 并不高。

用户想要的是"**换视频时不用再动音量**"，而不是"把每个声音都压到一样响"。这两件事必须区分：

- **整体增益（loudness normalization）**：保留视频内部的动态，只把整体电平搬过去。
- **动态压缩（compression）**：把大声压小、小声抬高，会改变爆炸、音乐、停顿的对比。

本项目的核心选择：**只做整体增益 + 安全限幅**。

---

## 2. 目标

- 在桌面版 Chrome / Edge / Firefox 上覆盖 B 站网页播放器。
- 对每个视频测一个稳定的 integrated loudness。
- 把不同视频拉向同一个目标（默认 `-16 LUFS`），允许用户选 `-20 / -18 / -16 / -14`。
- 不破坏 B 站原有控件：播放/暂停、进度条、音量条、全屏、弹幕都不受影响。
- 首次使用成本尽可能低：装扩展、点一下页面、开始看。

非目标：

- 不做系统级全局均衡（需要虚拟声卡/驱动）。
- 不修改 B 站服务器上的任何内容。
- 不做音质增强、EQ、降噪、空间音频。
- 不覆盖 DRM 番剧。

---

## 3. 为什么是浏览器扩展

| 方案 | 覆盖范围 | 安装成本 | 延迟/同步 | 结论 |
|---|---|---|---|---|
| 浏览器扩展 + Web Audio | B 站网页 | 低，加载文件夹即可 | 无额外延迟 | **选它** |
| 系统级 WASAPI loopback + 虚拟声卡 | 所有应用 | 高，要装驱动 | 20–50 ms，可能影响 A/V 同步 | 以后再说 |
| 修改 B 站播放器脚本 | B 站网页 | 中，易被页面更新破坏 | 无 | 不如扩展稳 |
| Android AudioPlaybackCapture | 部分 App | 中，受系统限制 | 有 | 不覆盖桌面 |

扩展可以直接拿到 `<video>` 元素，用 `createMediaElementSource` 把音频接进 Web Audio 图，既不需要驱动，也不需要改 B 站代码。

---

## 4. 音频图

```
                        ┌────────────────────────────────────────────┐
<video> ── MediaElementSource ── GainNode ── DynamicsCompressor ── destination
                        │
                        └── AudioWorklet ── K-weighting ── 400 ms 块 ── 门限 ── LUFS
                                  │
                                  └── GainNode(0) ── destination
```

- **主路径**：`source → gain → limiter → destination`，这是用户听到的声音。
- **测量支路**：`source → worklet → silentGain(0) → destination`。`silentGain` 的作用只是让 worklet 节点处于"被音频线程拉取"的图中；它的输出为 0，不会产生第二路声音。
- 测量在增益之前，所以测量值不受自己施加的增益影响。
- `AudioWorklet` 在音频线程计算，不占主线程；即使页面滚动、弹幕很多，测量也不会抖动。

### 为什么不用 AnalyserNode 做主方案

`AnalyserNode` 只能拿到当前 FFT 窗口的时域数据，没有标准的 400 ms 块、绝对/相对门限；在主线程轮询还会受定时器抖动影响。`AudioWorklet` 可以逐样本处理，块边界精确，适合做 BS.1770。

保留 `AnalyserNode` 作为兜底：如果 `audioWorklet.addModule()` 被浏览器/扩展资源策略拦截，就退化为 RMS 近似测量。

### 跨浏览器加载 Worklet

Worklet 模块的取源规则和普通脚本不同：它由音频线程按模块脚本抓取，CORS/principal 检查更严。三种浏览器的差异主要在扩展资源上：

| 路径 | Chromium | Firefox |
|---|---|---|
| `addModule(chrome-extension://…)` / `moz-extension://…` | 可用 | 可用（扩展资源在 `web_accessible_resources` 中） |
| `fetch(扩展 URL)` 后转 Blob | 可用 | 可用（内容脚本带扩展权限，fetch 不受页面 CORS 限制） |
| 兼容模式（`AnalyserNode`） | 兜底 | 兜底 |

实现按"直接加载 → Blob → 兼容模式"顺序退让，并把实际走通的路径记在 `state.workletMode`（`direct` / `blob`）里，方便排查。

另外两处 Firefox 差异也做了适配：

- **存储 API**：Firefox 的 `browser.*` 是 promise 风格，`chrome.*` 只有回调风格；Chromium 只有 `chrome.*`。`content.js` 启动时探测一次，之后统一走 `areaGet` / `areaSet`，取不到扩展 API（例如页面内注入的测试页）时退回 `localStorage`。
- **清单**：Firefox 需要 `browser_specific_settings.gecko.id` 才能签名，且从 2025-11 起上传 AMO 必须声明 `data_collection_permissions`（本项目为 `required: ["none"]`）。这些键 Chrome 会忽略，所以发布包按浏览器各生成一份。

---

## 5. 响度测量

按 ITU-R BS.1770-4 / EBU R128：

1. **K-weighting**：两级双二阶滤波器
   - high shelf：`fc = 1681.974450955533 Hz`，`G = 3.999843853973347 dB`，`Q = 0.7071752369554196`
   - high-pass：`fc = 38.13547087602444 Hz`，`Q = 0.5003270373238773`
   - 系数由模拟原型在任意采样率下双线性变换得到；48 kHz 时与标准表一致。

2. **400 ms 块，100 ms hop**
   每个块的能量是各声道 K-weighted 样本平方和除以块长。立体声两个声道能量相加，所以双声道同幅值比单声道高约 `3 LU`。

3. **块响度**
   `L_j = -0.691 + 10 log10(E_j)`

4. **绝对门限**
   丢弃 `L_j <= -70 LUFS` 的块（数字静音、极低底噪）。

5. **相对门限**
   先求绝对门限后块的平均能量，得到 `L_abs`；丢弃 `L_j <= L_abs - 10 LU` 的块。

6. **Integrated loudness**
   对剩余块的能量取平均，再转回 LUFS。

实现位于 `src/loudness-worklet.js`，单元测试在 `test/loudness.test.mjs`。

### 校准验证

对 1 kHz 立体声正弦，两个声道同幅值 `A`：

- 总能量 `E = A²`
- K-weighting 在 1 kHz 的响应约 `+0.698 dB`
- `-0.691` 偏置正好抵消，因此 `A = 0.1`（-20 dBFS）≈ `-20 LUFS`

测试结果：

| 输入 | 期望 | 实测 |
|---|---|---|
| 1 kHz 立体声，幅度 0.1 | ≈ -20.0 LUFS | -19.99 LUFS |
| 1 kHz 立体声，幅度 0.01 | ≈ -40.0 LUFS | -40.00 LUFS |
| 单声道 vs 双声道同幅值 | 低 3.01 LU | 3.01 LU |
| 3 s 声音 + 5 s 静音 | ≈ -20.0 LUFS | -20.00 LUFS |
| 全静音 | 无有效值 | null |
| reset 后重新测 -40 dBFS | ≈ -40.0 LUFS | -40.00 LUFS |

### 端到端验证

`test/e2e/` 里有一个真实的浏览器测试：前 10 秒是 `-41.7 LUFS` 的正弦，后 20 秒是 `-11.8 LUFS` 的正弦。无头 Edge 加载页面后，`content.js` 接管 `<video>`、加载 AudioWorklet、测量并施加增益。

实测（目标 `-16 LUFS`，采样率 `44.1 kHz`）：

| 时间点 | 视频响度 | 施加增益 |
|---|---|---|
| 安静段约 8 s | -41.7 LUFS | +15.0 dB（达到提升上限） |
| 大声段约 17 s | -11.9 LUFS | -4.1 dB |
| 大声段把 B 站音量调到 50% | 原始 -11.7 LUFS | -4.1 dB（不变） |

音量这一项很关键：`MediaElementAudioSourceNode` 的输出会随 `<video>.volume` 变化，测量值也会跟着变。如果直接拿新音量去补偿旧的 integrated 历史，会算出错误增益。实现上在 `volumechange` 后先暂停自适应，250 ms 稳定后清空测量历史，让新音量下的 integrated 重新建立；这样增益保持不变，用户调音量仍然是"调音量"，不会被扩展反着补回去。

这验证了几件关键的事：`createMediaElementSource` 能接管视频、扩展资源能加载进 AudioWorklet、44.1 kHz 下系数正确、增益方向正确。

Firefox 用另一套测试（`test/e2e/run-firefox.mjs`）：`web-ext` 把仓库文件临时安装成扩展（manifest 的 matches 换成 `http://127.0.0.1/`），无头 Firefox 160 打开测试页，内容脚本由浏览器真正注入，页面再把面板读数回传。实测目标 `-16 LUFS`、采样率 `48 kHz`：

| 时间点 | 视频响度 | 施加增益 |
|---|---|---|
| 安静段约 8 s | -41.7 LUFS | +15.0 dB（达到提升上限） |
| 大声段约 22 s | -11.8 LUFS | -4.0 dB |

面板状态、存储读写、`moz-extension://` 资源加载都正常，没有退到 `AnalyserNode` 兼容模式。两条浏览器路径都走通了，说明清单、内容脚本、Web Audio 图在 Gecko 上不需要单独的实现分支。

另外用加载了扩展的 Edge 157 打开了真实 B 站视频 `BV1GJ411x7h7`：面板在 12 秒内出现，读取到 `-13.3 LUFS`，施加 `-2.4 dB`，页面控制台没有报错。这说明线上 B 站播放器的 `#bilibili-player`、MSE `blob:` 视频源和扩展资源加载路径都能正常工作。B 站播放器 DOM 仍可能随改版变化，所以 `findMainVideo` 保留多个选择器和尺寸兜底。

---

## 6. 增益策略

### 6.1 目标

`target = -16 LUFS`（可调）。

`desiredGainDb = clamp(target - measuredLufs, -24, +15)`

- 提升上限 `+15 dB`：避免把底噪、房间声、录音瑕疵放大到刺耳。
- 衰减上限 `-24 dB`：已经非常响的视频也不会被压到听不见。
- 目标范围 `-20 … -14`：夜间到偏响。

### 6.2 何时开始校正

- 前 2.5 秒只测量，不动增益；避免用太短的样本误判。
- 2.5 秒后，用最近 3 秒的 gated 值做第一次校正。
- 6 秒后，用 integrated loudness 做更稳的校正。
- 有缓存时，进入视频立即套用历史值；6 秒后再用本次测量修正。

### 6.3 平滑与死区

- `GainNode.gain.setTargetAtTime(linear, now, 0.22)`：约 220 ms 时间常数，听感上是渐变而不是跳变。
- `|desired - applied| < 1.0 dB` 时不处理，避免 integrated 的微小抖动导致增益来回动。
- 两次修正之间至少间隔 400 ms。

### 6.4 限幅

`DynamicsCompressorNode`：

- threshold `-2.5 dB`
- knee `0`
- ratio `20:1`
- attack `2 ms`
- release `250 ms`

它不是 true-peak limiter，但足以防止大多数数字削波。后续可以换成带 look-ahead 的 AudioWorklet 限幅器。

### 6.5 与 B 站音量条的关系

`MediaElementAudioSourceNode` 的输出包含 `<video>.volume` 的影响。如果直接测量，用户把 B 站音量调到 50%，测量值会低 6 dB，扩展就会把增益加回去，等于"音量条失灵"。

所以测量值先做音量补偿：

`videoLufs = measuredLufs - 20 log10(video.volume)`

再用 `target - videoLufs` 算增益。这样：

- 用户调小 B 站音量 → 输出仍然按用户意愿变小；
- 扩展只负责把"视频本身的制作电平"拉齐。

---

## 7. 缓存

`chrome.storage.local` 保存一个 `loudnessCache` 对象：

```json
{
  "v:BV1xx411c7mD": { "lufs": -13.8, "ts": 1730000000000, "title": "...", "up": "..." },
  "u:123456":       { "lufs": -14.2, "ts": 1730000000000, "title": "...", "up": "..." }
}
```

- `v:` 按视频精确命中。
- `u:` 按 UP 主命中，用于第一次打开该 UP 主的新视频时先给一个近似值。
- 最多 800 条，超过按时间淘汰；180 天过期。
- 只在 integrated 稳定（≥ 6 秒）且峰值非静音时写入，避免把静音/加载中误存。
- `pagehide` 时再补写一次，防止用户看完就关页面。

缓存只存在本机，不上传。

---

## 8. 失败模式与兜底

| 情况 | 行为 |
|---|---|
| `AudioContext` 被自动播放策略挂起 | 等待用户点击；面板提示"点击页面空白处启用" |
| `AudioWorklet` 加载失败 | 退化到 `AnalyserNode` RMS 近似测量，面板提示"兼容测量模式" |
| `createMediaElementSource` 抛错 | 保持 B 站原生音频不动，面板提示"无法接管此视频的音频" |
| 视频被静音 | 不施加增益，面板提示"视频已静音" |
| 找不到主视频（播放器重排） | 不拆音频图，避免把正在播放的视频弄静音 |
| 番剧 / DRM | 不匹配 `/bangumi/play/`，避免接入后静音 |
| 视频切换 / SPA 导航 | 每 500 ms 检查 URL 与 `currentSrc`，重置测量并读取新缓存 |

---

## 9. 备选方案与取舍

### 9.1 系统级全局均衡

用 WASAPI loopback 捕获系统输出，分析后把增益后的音频送到虚拟声卡。优点是覆盖所有应用；缺点是要装虚拟声卡驱动，增加 20–50 ms 延迟，可能造成音画不同步，而且用户要在系统里切换默认播放设备。对"只在 B 站网页看视频"的场景，收益不值这个复杂度。

### 9.2 实时动态压缩

用 `DynamicsCompressor` 直接压，实现最简单，但会改变动态范围：爆炸变轻、对话变响、音乐失去起伏。它解决的是"响度战争"，不是"换视频音量不一致"。本项目刻意不用。

### 9.3 修改 B 站播放器

可以通过油猴脚本注入页面上下文，直接改播放器逻辑。但 B 站播放器更新频繁，维护成本高；扩展的 `content script` 只依赖 `<video>` 和 `#bilibili-player` 这类稳定接口，抗更新能力更好。

### 9.4 预先分析完整音轨

理想做法是把整个音轨解码，算完整 integrated loudness，再一次性施加固定增益。但 B 站音频是 DASH 分片，完整解码需要额外拉流、解复用（mp4box/WebCodecs），复杂度和请求量都高。实时测量 + 缓存已经能覆盖绝大多数场景。

---

## 10. 后续路线

1. **真峰值限幅 Worklet**：look-ahead 5 ms，ceiling `-1 dBTP`，替代 `DynamicsCompressor`。
2. **按 UP 主先验**：用历史中位数作为初始值，缩短首次校正时间。
3. **系统级版本**：Rust + WASAPI + 虚拟声卡，覆盖 B 站 App 和本地播放器。
4. **上架 AMO 与 Chrome Web Store**：签名后 Firefox 用户不再需要临时加载。
5. **可视化**：显示 3 秒响度曲线，让用户看到"这个视频确实比别的轻 8 dB"。
