//! Current upstream playback transport, matching the public site's playback service.
//! Signed URLs and ephemeral encryption keys stay in memory only.
//!
//! 预取（prewarm）缓存必须与真实取址严格对应同一会话：
//! - 条目键 = 线路 origin + 作品 id + 集数 + 发起时的登录令牌，任何一项不同都不命中；
//! - 每次取址带一个单调递增的「代次」（epoch），切线路 / 登录状态变化 / 清理媒体缓存都会抬升代次，
//!   旧代次的在途响应到达后既不写缓存也不触发 HLS 预热；
//! - 同一会话下同一条目的并发取址只放行一次真实请求，其余请求复用同一个结果；
//! - 预取条目保持单次消费语义：`video` 命中即移除，再次进入会重新获取签名地址。
use crate::edge_crypto::{self, EdgeScope};
use base64::{engine::general_purpose::STANDARD, Engine};
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;

const PREFETCH_TTL: Duration = Duration::from_secs(90);
const PREFETCH_MAX: usize = 16;

/// 一次取址的完整身份：线路 + 作品 + 集数 + 发起时的登录令牌。
/// 同时作为预取条目与在途请求的键，结构上杜绝跨令牌 / 跨线路的命中或复用。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Scope {
    origin: String,
    id: i64,
    ep: u32,
    token: Option<String>,
}

#[derive(Clone)]
struct Ready {
    expires: Instant,
    data: Value,
}

struct Inflight {
    /// 放行真实取址时的代次；响应落库时必须仍等于当前代次。
    epoch: u64,
    /// 首个发起者是否是后台预取（决定完成后是否写回预取缓存）。
    prewarm: bool,
    /// 真实取址完成后向所有并发复用者广播同一份结果。
    tx: watch::Sender<Option<Result<Value, String>>>,
}

#[derive(Default)]
struct PrefetchState {
    /// 代次：任何会让旧签名 / 旧会话失效的事件都会抬升它。
    epoch: u64,
    ready: HashMap<Scope, Ready>,
    inflight: HashMap<Scope, Inflight>,
}

static PREFETCH: Lazy<Mutex<PrefetchState>> = Lazy::new(|| Mutex::new(PrefetchState::default()));

fn prune_expired(map: &mut HashMap<Scope, Ready>, now: Instant) {
    map.retain(|_, v| v.expires > now);
}

fn current_epoch() -> u64 {
    PREFETCH.lock().map(|state| state.epoch).unwrap_or(0)
}

/// 抬升预取代次：丢弃所有已缓存条目，旧代次的在途响应也不得再落库 / 预热。
pub(crate) fn invalidate() {
    if let Ok(mut state) = PREFETCH.lock() {
        state.epoch = state.epoch.wrapping_add(1);
        state.ready.clear();
        // 在途槽位移除并关闭通道：等待者收到关闭信号后自行重新取址，响应到达时按代次丢弃。
        state.inflight.clear();
    }
}

/// 命中并移除预取条目（单次消费）；令牌不同、线路不同或已过期都不命中。
fn take_prefetched(scope: &Scope) -> Option<Value> {
    let mut state = PREFETCH.lock().ok()?;
    prune_expired(&mut state.ready, Instant::now());
    state.ready.remove(scope).map(|entry| entry.data)
}

/// 只判断是否存在可命中的预取条目，不移除（后台预取去重用）。
fn has_prefetched(scope: &Scope) -> bool {
    let Ok(mut state) = PREFETCH.lock() else {
        return false;
    };
    prune_expired(&mut state.ready, Instant::now());
    state.ready.contains_key(scope)
}

/// 真实取址函数：生产环境走 edge_crypto，测试可注入离线桩。
type FetchFn = Arc<
    dyn Fn(Scope) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Send + Sync,
>;

fn default_fetch() -> FetchFn {
    Arc::new(|scope: Scope| {
        Box::pin(async move {
            fetch_video(&scope.origin, scope.id, scope.ep, scope.token.as_deref()).await
        })
    })
}

/// 测试注入点：默认走真实上游，离线测试用它替换成可控桩。
static FETCH_OVERRIDE: Lazy<Mutex<Option<FetchFn>>> = Lazy::new(|| Mutex::new(None));

fn active_fetch() -> FetchFn {
    FETCH_OVERRIDE
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .unwrap_or_else(default_fetch)
}

/// HLS 预热测试注入点：离线测试用它统计预热次数，避免真实联网。
type WarmFn = Arc<dyn Fn(String) + Send + Sync>;
static WARM_OVERRIDE: Lazy<Mutex<Option<WarmFn>>> = Lazy::new(|| Mutex::new(None));

async fn warm_hls(url: String) {
    let seam = WARM_OVERRIDE.lock().ok().and_then(|slot| slot.clone());
    if let Some(warm) = seam {
        warm(url);
        return;
    }
    crate::media::prewarm_hls(&url, crate::media::LOCAL_ORIGIN).await;
}

/// 测试专用串行锁：预取状态是进程级全局，离线用例都要触碰它，
/// 必须在默认多线程测试调度器下互斥，避免跨用例 / 跨模块的代次与注入互相覆盖。
#[cfg(test)]
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 其它模块（session / media）中会抬升预取代次的用例，用它与播放用例串行化。
#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Ticket {
    scope: Scope,
    epoch: u64,
    prewarm: bool,
    /// None 表示本调用是放行真实取址的发起者；Some 表示复用在途请求。
    rx: Option<watch::Receiver<Option<Result<Value, String>>>>,
}

/// 同一会话（线路 + 作品 + 集数 + 令牌）的并发取址只创建一个在途槽位。
fn acquire(scope: Scope, prewarm: bool) -> Ticket {
    let mut state = PREFETCH.lock().unwrap_or_else(|e| e.into_inner());
    prune_expired(&mut state.ready, Instant::now());
    if let Some(inflight) = state.inflight.get(&scope) {
        // 复用者：订阅发起者的结果，不会再触发真实取址。
        return Ticket {
            epoch: inflight.epoch,
            prewarm: inflight.prewarm,
            rx: Some(inflight.tx.subscribe()),
            scope,
        };
    }
    let (tx, _rx) = watch::channel(None);
    let epoch = state.epoch;
    state.inflight.insert(
        scope.clone(),
        Inflight {
            epoch,
            prewarm,
            tx,
        },
    );
    // 发起者：没有接收端，由它执行唯一的真实取址并在 settle 中广播。
    Ticket {
        scope,
        epoch,
        prewarm,
        rx: None,
    }
}

/// 放行真实取址的发起者在响应到达后结算：校验代次后再落库 / 广播。
fn settle(ticket: &Ticket, result: Result<Value, String>) -> Result<Value, String> {
    let mut state = PREFETCH.lock().unwrap_or_else(|e| e.into_inner());
    // 槽位可能已被 invalidate 清掉；无论如何都要把结果广播给仍订阅的复用者。
    if let Some(inflight) = state.inflight.remove(&ticket.scope) {
        let _ = inflight.tx.send(Some(result.clone()));
    }
    // 旧代次响应：用户已切线路 / 换账号 / 清缓存，禁止写回预取缓存。
    if ticket.epoch != state.epoch {
        return result;
    }
    if ticket.prewarm {
        if let Ok(data) = &result {
            prune_expired(&mut state.ready, Instant::now());
            if state.ready.len() >= PREFETCH_MAX {
                state.ready.clear();
            }
            state.ready.insert(
                ticket.scope.clone(),
                Ready {
                    expires: Instant::now() + PREFETCH_TTL,
                    data: data.clone(),
                },
            );
        }
    }
    result
}

/// 统一取址入口：预取命中即单次消费，否则同会话并发只放行一次真实请求。
async fn resolve(scope: Scope, prewarm: bool, fetch: &FetchFn) -> Result<Value, String> {
    if prewarm {
        if has_prefetched(&scope) {
            return Ok(json!({}));
        }
    } else if let Some(hit) = take_prefetched(&scope) {
        return Ok(hit);
    }
    let mut ticket = acquire(scope.clone(), prewarm);
    if let Some(rx) = ticket.rx.take() {
        let result = join_inflight(rx).await?;
        // 复用者不负责落库 / 预热：预取复用直接返回内部空标记，由发起者统一处理。
        if prewarm {
            return Ok(json!({}));
        }
        return Ok(result);
    }
    // 发起者：执行本次会话唯一的真实取址。
    let result = fetch(scope).await;
    settle(&mut ticket, result)
}

async fn join_inflight(
    mut rx: watch::Receiver<Option<Result<Value, String>>>,
) -> Result<Value, String> {
    loop {
        if let Some(result) = rx.borrow_and_update().clone() {
            return result;
        }
        if rx.changed().await.is_err() {
            // 通道在结算前被关闭（代次失效）：调用方需要重新取址。
            return Err("取址请求已失效，请重试".to_string());
        }
    }
}

async fn fetch_video(
    origin: &str,
    id: i64,
    ep: u32,
    token: Option<&str>,
) -> Result<Value, String> {
    let path = format!("/api/videos/{id}/episodes/{ep}/playback");
    let encoded = STANDARD.encode(b"{}");
    let env = edge_crypto::request(
        origin,
        EdgeScope::Playback,
        "POST",
        &path,
        &encoded,
        "application/json",
        token,
    )
    .await
    .map_err(|e| e.into_message())?;

    if !(200..300).contains(&env.status) {
        return Err(format!("播放接口返回 HTTP {}", env.status));
    }
    let value: Value =
        serde_json::from_slice(&env.body).map_err(|_| "播放数据格式无效".to_string())?;
    if value["status"] != 1 {
        return Err(value["msg"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("获取播放地址失败")
            .into());
    }
    normalize(value["data"].clone(), id, ep)
}

fn validate_target(origin: &str, token: Option<&str>) -> Result<String, String> {
    let origin = crate::net::normalize_base(origin).ok_or("播放请求必须使用安全 HTTPS 线路")?;
    if crate::network_policy::strict_security()
        && token.is_some()
        && !crate::net::trusted_auth_origin(&origin)
    {
        return Err("镜像线路仅供游客浏览；登录请切换到固定线路".into());
    }
    Ok(origin)
}

pub(crate) async fn video(
    origin: &str,
    id: i64,
    ep: u32,
    token: Option<&str>,
) -> Result<Value, String> {
    if id <= 0 || ep == 0 || ep > i32::MAX as u32 {
        return Err("无效的视频或分集编号".into());
    }
    let origin = validate_target(origin, token)?;
    let scope = Scope {
        origin,
        id,
        ep,
        token: token.map(str::to_string),
    };
    resolve(scope, false, &active_fetch()).await
}

/// 后台预取下一集 / 下一部的播放地址并预热 HLS 首帧分片（单次消费，不影响返回重取新签名）。
///
/// 旧代次的响应会在 [`settle`] 中被拒绝落库；这里再按代次决定是否预热 HLS，
/// 保证切集 / 换线路后旧响应既不写缓存也不触发预热。
pub(crate) async fn prewarm(origin: &str, id: i64, ep: u32, token: Option<&str>) {
    if id <= 0 || ep == 0 || ep > i32::MAX as u32 {
        return;
    }
    let Ok(origin) = validate_target(origin, token) else {
        return;
    };
    let scope = Scope {
        origin,
        id,
        ep,
        token: token.map(str::to_string),
    };
    let fetch = active_fetch();
    let epoch_at_start = current_epoch();
    let Ok(data) = resolve(scope, true, &fetch).await else {
        return;
    };
    // 复用了已缓存条目时 resolve 提前返回空对象，无需再预热。
    if data.is_object() && data.as_object().is_some_and(|m| m.is_empty()) {
        return;
    }
    // 等待期间代次已抬升（切线路 / 换账号 / 清缓存）：旧响应不得触发 HLS 预热。
    if current_epoch() != epoch_at_start {
        return;
    }
    let url = data["video_url"].as_str().unwrap_or("").to_string();
    if url.to_ascii_lowercase().contains(".m3u8") {
        warm_hls(url).await;
    }
}

fn normalize(data: Value, id: i64, ep: u32) -> Result<Value, String> {
    if data["manifest_method"] != "GET" {
        return Err("不支持的播放清单请求方式".into());
    }
    let main = data["streams"]
        .get("main")
        .and_then(Value::as_str)
        .ok_or_else(|| "播放响应缺少 main".to_string())?;
    if main.trim().is_empty() {
        return Err("上游暂未提供本集播放地址，请稍后重试".into());
    }
    crate::network_policy::parse_target(main)?;
    Ok(json!({
        "id": id,
        "ep_num": ep,
        "duration": 0,
        "title": "",
        "video_url": main,
        "video_url_hevc": data["streams"]["hevc"].as_str().unwrap_or(""),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// 离线取址桩：记录真实放行次数，并用闩锁控制响应时机（可先等待、后放行，支持重复放行）。
    #[derive(Clone)]
    struct FakeFetcher {
        calls: Arc<AtomicUsize>,
        gates: Arc<Mutex<HashMap<Scope, Arc<Gate>>>>,
    }

    struct Gate {
        opened: std::sync::atomic::AtomicBool,
        notify: tokio::sync::Notify,
    }

    impl FakeFetcher {
        fn new() -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
                gates: Arc::new(Mutex::new(HashMap::new())),
            }
        }
        fn gate(&self, scope: &Scope) -> Arc<Gate> {
            let mut gates = self.gates.lock().unwrap();
            gates
                .entry(scope.clone())
                .or_insert_with(|| {
                    Arc::new(Gate {
                        opened: std::sync::atomic::AtomicBool::new(false),
                        notify: tokio::sync::Notify::new(),
                    })
                })
                .clone()
        }
        fn open(&self, scope: &Scope) {
            let gate = self.gate(scope);
            gate.opened
                .store(true, std::sync::atomic::Ordering::SeqCst);
            // notify_waiters 只唤醒已在等待的取址；下一次取址会直接读到 opened=true。
            gate.notify.notify_waiters();
        }
        fn fetch(&self) -> FetchFn {
            let fetcher = self.clone();
            Arc::new(move |scope: Scope| {
                let fetcher = fetcher.clone();
                Box::pin(async move {
                    let gate = fetcher.gate(&scope);
                    while !gate.opened.load(std::sync::atomic::Ordering::SeqCst) {
                        gate.notify.notified().await;
                    }
                    fetcher.calls.fetch_add(1, Ordering::SeqCst);
                    Ok(normalize(
                        json!({
                            "manifest_method": "GET",
                            "streams": {"main": format!("https://cdn.example/{}/{}.m3u8", scope.id, scope.ep), "hevc": ""}
                        }),
                        scope.id,
                        scope.ep,
                    )
                    .unwrap())
                })
            })
        }
    }

    /// 安装离线桩并保证测试结束后还原全局状态（取址桩 / 预热桩 / 缓存代次）。
    /// 持有进程级测试锁，使所有触碰预取全局状态的用例在并行调度下互斥。
    struct OverrideGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
    }
    impl OverrideGuard {
        fn install(fetch: FetchFn) -> Self {
            let guard = test_lock();
            *FETCH_OVERRIDE.lock().unwrap() = Some(fetch);
            *WARM_OVERRIDE.lock().unwrap() = None;
            invalidate();
            OverrideGuard { _lock: guard }
        }
    }
    impl Drop for OverrideGuard {
        fn drop(&mut self) {
            *FETCH_OVERRIDE.lock().unwrap() = None;
            *WARM_OVERRIDE.lock().unwrap() = None;
            invalidate();
        }
    }

    fn scope(origin: &str, id: i64, ep: u32, token: Option<&str>) -> Scope {
        Scope {
            origin: origin.to_string(),
            id,
            ep,
            token: token.map(str::to_string),
        }
    }

    fn ready_entry(ttl: Duration) -> Ready {
        Ready {
            expires: Instant::now() + ttl,
            data: json!({"video_url": "https://cdn.example/77/2.m3u8"}),
        }
    }

    #[test]
    fn playback_shape_and_target_validation() {
        let data = json!({"manifest_method":"GET", "streams":{"main":"https://cdn.example/test.m3u8?auth_key=test", "hevc":""}});
        let result = normalize(data.clone(), 117, 3).unwrap();
        assert_eq!(result["ep_num"], 3);
        assert_eq!(result["video_url"], data["streams"]["main"]);
        for target in [
            "",
            "javascript:alert(1)",
            "http://127.0.0.1/test",
            "file:///C:/secret",
        ] {
            let mut invalid = data.clone();
            invalid["streams"]["main"] = json!(target);
            assert!(normalize(invalid, 117, 3).is_err());
        }
        assert!(normalize(json!({"manifest_method":"POST"}), 117, 3).is_err());
    }

    #[test]
    fn prefetch_is_single_use_and_isolated_by_line_and_token() {
        let _guard = OverrideGuard::install(default_fetch());
        let origin = "https://huangguoai.com";
        let payload = json!({"id": 77, "ep_num": 2, "video_url": "https://cdn.example/77-2.m3u8"});
        {
            let mut state = PREFETCH.lock().unwrap();
            state.ready.insert(
                scope(origin, 77, 2, Some("tok-a")),
                Ready {
                    expires: Instant::now() + PREFETCH_TTL,
                    data: payload.clone(),
                },
            );
        }
        // 线路不同不命中
        assert!(take_prefetched(&scope(
            "https://huangguodrama.io",
            77,
            2,
            Some("tok-a")
        ))
        .is_none());
        // 令牌不同不命中
        assert!(take_prefetched(&scope(origin, 77, 2, Some("tok-b"))).is_none());
        assert!(take_prefetched(&scope(origin, 77, 2, None)).is_none());
        // 完全同会话才命中
        assert_eq!(
            take_prefetched(&scope(origin, 77, 2, Some("tok-a"))).unwrap(),
            payload
        );
        // 单次消费后再次进入会重新获取签名地址
        assert!(take_prefetched(&scope(origin, 77, 2, Some("tok-a"))).is_none());
    }

    #[test]
    fn expired_entries_never_hit() {
        let _guard = OverrideGuard::install(default_fetch());
        let s = scope("https://huangguoai.com", 9, 1, None);
        {
            let mut state = PREFETCH.lock().unwrap();
            state.ready.insert(
                s.clone(),
                Ready {
                    expires: Instant::now() - Duration::from_millis(1),
                    data: json!({"video_url": "stale"}),
                },
            );
        }
        assert!(!has_prefetched(&s));
        assert!(take_prefetched(&s).is_none());
        assert!(
            PREFETCH.lock().unwrap().ready.is_empty(),
            "过期条目应被清理"
        );
    }

    #[test]
    fn invalidate_clears_ready_and_orphans_inflight_slots() {
        let _guard = OverrideGuard::install(default_fetch());
        let s = scope("https://huangguoai.com", 11, 4, Some("tok"));
        {
            let mut state = PREFETCH.lock().unwrap();
            state
                .ready
                .insert(s.clone(), ready_entry(PREFETCH_TTL));
            let (tx, _rx) = watch::channel(None);
            let epoch = state.epoch;
            state.inflight.insert(
                s.clone(),
                Inflight {
                    epoch,
                    prewarm: true,
                    tx,
                },
            );
        }
        invalidate();
        let state = PREFETCH.lock().unwrap();
        assert!(state.ready.is_empty());
        assert!(state.inflight.is_empty());
        assert!(state.epoch > 0);
    }

    #[tokio::test]
    async fn concurrent_same_scope_fetches_once_and_shares_the_result() {
        let fetcher = FakeFetcher::new();
        let _guard = OverrideGuard::install(fetcher.fetch());
        let s = scope("https://huangguoai.com", 21, 1, Some("tok-a"));
        let mut handles = Vec::new();
        for _ in 0..5 {
            let s = s.clone();
            handles.push(tokio::spawn(async move {
                resolve(s, false, &active_fetch()).await
            }));
        }
        // 给所有任务时间进入在途等待，再放行唯一的真实取址。
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 0);
        fetcher.open(&s);
        for handle in handles {
            let value = handle.await.unwrap().unwrap();
            assert_eq!(value["video_url"], "https://cdn.example/21/1.m3u8");
        }
        assert_eq!(
            fetcher.calls.load(Ordering::SeqCst),
            1,
            "同会话并发只允许一次真实取址"
        );
        // 播放路径不写预取缓存，再次取址仍会真实请求。
        fetcher.open(&s);
        let again = resolve(s, false, &active_fetch()).await.unwrap();
        assert_eq!(again["video_url"], "https://cdn.example/21/1.m3u8");
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn different_tokens_or_lines_bypass_inflight_dedup() {
        let fetcher = FakeFetcher::new();
        let _guard = OverrideGuard::install(fetcher.fetch());
        let scopes = [
            scope("https://huangguoai.com", 31, 2, Some("tok-a")),
            scope("https://huangguoai.com", 31, 2, Some("tok-b")),
            scope("https://huangguodrama.io", 31, 2, Some("tok-a")),
        ];
        let mut handles = Vec::new();
        for s in scopes.clone() {
            handles.push(tokio::spawn(async move {
                resolve(s.clone(), false, &active_fetch()).await
            }));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        for s in &scopes {
            fetcher.open(s);
        }
        let mut seen = Vec::new();
        for handle in handles {
            seen.push(handle.await.unwrap().unwrap());
        }
        assert_eq!(
            fetcher.calls.load(Ordering::SeqCst),
            3,
            "令牌 / 线路不同不得复用在途请求"
        );
        for value in seen {
            assert!(value["video_url"].as_str().unwrap().contains("/31/2.m3u8"));
        }
    }

    #[tokio::test]
    async fn prewarm_writes_single_use_entry_that_play_consumes() {
        let fetcher = FakeFetcher::new();
        let _guard = OverrideGuard::install(fetcher.fetch());
        let s = scope("https://huangguoai.com", 41, 3, None);
        fetcher.open(&s);
        prewarm(&s.origin, s.id, s.ep, s.token.as_deref()).await;
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 1);
        // 第二次预取命中缓存，不再真实取址。
        prewarm(&s.origin, s.id, s.ep, s.token.as_deref()).await;
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 1);
        // 播放单次消费后缓存被移除，且不再触发真实取址（直接用预取结果）。
        let played = video(&s.origin, s.id, s.ep, s.token.as_deref())
            .await
            .unwrap();
        assert_eq!(played["video_url"], "https://cdn.example/41/3.m3u8");
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 1);
        assert!(take_prefetched(&s).is_none());
    }

    #[tokio::test]
    async fn stale_epoch_responses_are_dropped_without_cache_or_warmup() {
        let fetcher = FakeFetcher::new();
        let warms = Arc::new(AtomicUsize::new(0));
        let _guard = OverrideGuard::install(fetcher.fetch());
        // 守卫安装后再挂预热桩（install 会重置注入点），Drop 时仍会统一还原。
        {
            let warms = warms.clone();
            *WARM_OVERRIDE.lock().unwrap() = Some(Arc::new(move |_url: String| {
                warms.fetch_add(1, Ordering::SeqCst);
            }));
        }
        let s = scope("https://huangguoai.com", 51, 1, Some("tok-a"));
        let handle = tokio::spawn({
            let s = s.clone();
            async move { prewarm(&s.origin, s.id, s.ep, s.token.as_deref()).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        // 用户切集 / 换账号 / 清缓存：代次抬升，旧响应到达后必须被丢弃。
        invalidate();
        fetcher.open(&s);
        handle.await.unwrap();
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 1);
        assert!(PREFETCH.lock().unwrap().ready.is_empty());
        assert_eq!(warms.load(Ordering::SeqCst), 0, "旧代次响应不得触发 HLS 预热");
        // 新代次重新预取会发起新的真实取址并正常预热。
        fetcher.open(&s);
        prewarm(&s.origin, s.id, s.ep, s.token.as_deref()).await;
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 2);
        assert!(has_prefetched(&s));
        assert_eq!(warms.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn invalidation_makes_waiting_play_requests_refetch() {
        let fetcher = FakeFetcher::new();
        let _guard = OverrideGuard::install(fetcher.fetch());
        let s = scope("https://huangguoai.com", 61, 2, None);
        // 两个并发请求：一个成为发起者（真实取址），另一个复用在途通道。
        let leader = tokio::spawn({
            let s = s.clone();
            async move { video(&s.origin, s.id, s.ep, s.token.as_deref()).await }
        });
        let joiner = tokio::spawn({
            let s = s.clone();
            async move { video(&s.origin, s.id, s.ep, s.token.as_deref()).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 0, "复用者不触发第二次真实取址");
        // 代次失效（切线路 / 换账号 / 清缓存）：在途通道关闭，旧结果禁止落库。
        invalidate();
        fetcher.open(&s);
        let leader_value = leader.await.unwrap().unwrap();
        assert_eq!(leader_value["video_url"], "https://cdn.example/61/2.m3u8");
        let join_err = joiner.await.unwrap().unwrap_err();
        assert!(
            join_err.contains("已失效"),
            "复用者在通道关闭后应收到可重试错误: {join_err}"
        );
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 1);
        assert!(
            PREFETCH.lock().unwrap().ready.is_empty(),
            "旧代次结果即使到达也不得写入缓存"
        );
        // 重试走新代次的真实取址并成功。
        let value = video(&s.origin, s.id, s.ep, s.token.as_deref())
            .await
            .unwrap();
        assert_eq!(value["video_url"], "https://cdn.example/61/2.m3u8");
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn invalid_requests_rejected_without_network() {
        let _guard = OverrideGuard::install(default_fetch());
        assert!(video("https://huangguoai.com", -1, 1, None).await.is_err());
        assert!(video("https://huangguoai.com", 1, 0, None).await.is_err());
        assert!(video("https://mirror.invalid", 1, 1, Some("secret"))
            .await
            .unwrap_err()
            .contains("镜像线路"));
    }

    #[tokio::test]
    #[ignore = "Live playback smoke: API, manifest rewrite, AES key and one segment"]
    async fn live_playback() {
        let id = std::env::var("HGHUB_TEST_VIDEO_ID")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(117);
        let ep = std::env::var("HGHUB_TEST_EP")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3);
        let info = video(crate::net::DEFAULT_BASE, id, ep, None)
            .await
            .expect("playback API");
        let playlist = crate::media::load_playlist(
            info["video_url"].as_str().unwrap(),
            crate::media::LOCAL_ORIGIN,
        )
        .await
        .expect("playlist");
        assert!(playlist.starts_with("#EXTM3U"));
        let key_line = playlist
            .lines()
            .find(|line| line.starts_with("#EXT-X-KEY"))
            .expect("key line");
        let key_url = key_line
            .split("URI=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        let key = crate::media::handle(
            "/seg",
            key_url.split_once('?').unwrap().1,
            crate::media::LOCAL_ORIGIN,
        )
        .await;
        assert_eq!(key.status(), 200);
        assert_eq!(key.body().len(), 16);
        let segment = playlist
            .lines()
            .find(|line| !line.starts_with('#') && line.contains("/seg?u="))
            .expect("segment");
        let segment = crate::media::handle(
            "/seg",
            segment.split_once('?').unwrap().1,
            crate::media::LOCAL_ORIGIN,
        )
        .await;
        assert_eq!(segment.status(), 200);
        assert!(segment.body().len() > 1000);
        println!("API + HLS rewrite + 16-byte AES key + media segment OK (video {id}, ep {ep})");
    }
}
