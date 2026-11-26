// 长文本 TTS 链路测试：MIME 类型映射、endpoint 令牌并发缓存、失败降级与错误传播
// 运行: node --test test/
// 不依赖真实微软服务，全部通过可替换的 fetch 桩构造场景。

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const ENDPOINT_URL = 'https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0';

// 构造一个 JWT 字符串（仅用于测试，payload 携带 exp）
function makeJwt(exp) {
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
    return `${b64({ alg: 'none' })}.${b64({ exp })}.sig`;
}

function makeEndpointResponse(exp, region = 'eastus') {
    return new Response(JSON.stringify({ t: makeJwt(exp), r: region }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}

function makeAudioResponse(label = 'audio') {
    return new Response(new Blob([label]), { status: 200 });
}

// 每个用例使用独立的模块实例（查询串绕过 ESM 缓存），避免令牌缓存串扰
let caseCounter = 0;
async function loadService() {
    return import(`../src/services/tts.js?case=${caseCounter++}`);
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// ---------- MIME 类型映射 ----------

test('getAudioContentType 按输出格式返回正确 MIME', async () => {
    const { getAudioContentType } = await loadService();

    assert.equal(getAudioContentType('audio-24khz-48kbitrate-mono-mp3'), 'audio/mpeg');
    assert.equal(getAudioContentType('mp3'), 'audio/mpeg');
    assert.equal(getAudioContentType('riff-24khz-16bit-mono-pcm'), 'audio/wav');
    assert.equal(getAudioContentType('wav'), 'audio/wav');
    assert.equal(getAudioContentType('ogg-24khz-16bit-mono-opus'), 'audio/ogg');
    assert.equal(getAudioContentType('ogg'), 'audio/ogg');
    assert.equal(getAudioContentType('webm-24khz-16bit-mono-opus'), 'audio/webm');
    // 未知格式回退 audio/mpeg
    assert.equal(getAudioContentType('something-else'), 'audio/mpeg');
    assert.equal(getAudioContentType(undefined), 'audio/mpeg');
});

// ---------- getVoice 响应头 ----------

test('短文本路径：Content-Type 跟随 response_format（wav）', async () => {
    const { getVoice } = await loadService();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    globalThis.fetch = async (url) => {
        if (String(url).startsWith(ENDPOINT_URL)) return makeEndpointResponse(exp);
        return makeAudioResponse();
    };

    const res = await getVoice('你好', 'zh-CN-XiaoxiaoNeural', '+0%', '+0Hz', '+0%', 'general', 'riff-24khz-16bit-mono-pcm');
    assert.equal(res.headers.get('Content-Type'), 'audio/wav');
});

test('长文本路径：Content-Type 跟随 response_format（ogg），短/长路径一致', async () => {
    const { getVoice } = await loadService();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    let ttsCalls = 0;
    globalThis.fetch = async (url) => {
        if (String(url).startsWith(ENDPOINT_URL)) return makeEndpointResponse(exp);
        ttsCalls++;
        return makeAudioResponse();
    };

    // 构造超过 1500 字符的长文本（句号分句，保证被切成多块）
    const longText = '这是一段用于测试的长文本。'.repeat(200);
    const res = await getVoice(longText, 'zh-CN-XiaoxiaoNeural', '+0%', '+0Hz', '+0%', 'general', 'ogg-24khz-16bit-mono-opus');

    assert.equal(res.headers.get('Content-Type'), 'audio/ogg');
    assert.ok(ttsCalls >= 2, `长文本应分块请求，实际 ${ttsCalls} 次`);
    // 拼接后的响应体类型与响应头一致
    const blob = await res.blob();
    assert.equal(blob.type, 'audio/ogg');
});

test('长文本路径：mp3 仍为 audio/mpeg', async () => {
    const { getVoice } = await loadService();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    globalThis.fetch = async (url) => {
        if (String(url).startsWith(ENDPOINT_URL)) return makeEndpointResponse(exp);
        return makeAudioResponse();
    };

    const longText = '这是一段用于测试的长文本。'.repeat(200);
    const res = await getVoice(longText, 'zh-CN-XiaoxiaoNeural', '+0%', '+0Hz', '+0%', 'general', 'audio-24khz-48kbitrate-mono-mp3');
    assert.equal(res.headers.get('Content-Type'), 'audio/mpeg');
});

// ---------- 并发令牌刷新 ----------

test('并发 getEndpoint 只触发一次刷新，所有调用复用同一结果', async () => {
    const { getEndpoint } = await loadService();
    const exp = Math.floor(Date.now() / 1000) + 3600;

    let endpointCalls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    globalThis.fetch = async (url) => {
        assert.ok(String(url).startsWith(ENDPOINT_URL));
        endpointCalls++;
        await gate; // 挂起刷新，确保并发调用堆积
        return makeEndpointResponse(exp);
    };

    const pending = Promise.all([
        getEndpoint(), getEndpoint(), getEndpoint(), getEndpoint(), getEndpoint()
    ]);
    // 给所有调用进入刷新流程的机会
    await new Promise((r) => setTimeout(r, 50));
    release();

    const results = await pending;
    assert.equal(endpointCalls, 1, `并发下应只刷新一次，实际 ${endpointCalls} 次`);
    for (const ep of results) {
        assert.equal(ep, results[0], '所有并发调用应复用同一 endpoint 结果');
    }
});

// ---------- 刷新失败降级 ----------

test('刷新失败且存在过期缓存：降级使用过期端点，后续请求再次尝试刷新', async () => {
    const { getEndpoint } = await loadService();
    const now = Math.floor(Date.now() / 1000);

    // 第一次刷新成功，但令牌本身已过期（exp 在过去）
    let endpointCalls = 0;
    let failRefresh = false;
    globalThis.fetch = async () => {
        endpointCalls++;
        if (failRefresh) return new Response('boom', { status: 500 });
        return makeEndpointResponse(now - 100);
    };

    const first = await getEndpoint();
    assert.equal(endpointCalls, 1);
    assert.ok(first.t);

    // 缓存已过期 → 触发刷新；刷新失败 → 降级返回过期端点
    failRefresh = true;
    const degraded = await getEndpoint();
    assert.equal(endpointCalls, 2, '过期缓存应触发新的刷新尝试');
    assert.equal(degraded, first, '刷新失败时应降级复用过期端点');

    // 过期令牌不得被当作有效令牌长期缓存：下次调用必须再次尝试刷新
    const third = await getEndpoint();
    assert.equal(endpointCalls, 3, '后续请求应再次尝试刷新，而不是长期使用过期令牌');
    assert.equal(third, first);

    // 刷新恢复后能拿到新令牌
    failRefresh = false;
    const recovered = await getEndpoint();
    assert.equal(endpointCalls, 4);
    assert.ok(recovered.t);
});

// ---------- 无缓存时错误沿重试链路上传 ----------

test('刷新失败且无缓存：getAudioChunk 重试后由 getVoice 返回 edge_tts_error JSON', { timeout: 30000 }, async () => {
    const { getVoice } = await loadService();

    let endpointCalls = 0;
    let ttsCalls = 0;
    globalThis.fetch = async (url) => {
        if (String(url).startsWith(ENDPOINT_URL)) {
            endpointCalls++;
            return new Response('endpoint down', { status: 503 });
        }
        ttsCalls++;
        return makeAudioResponse();
    };

    const res = await getVoice('你好', 'zh-CN-XiaoxiaoNeural', '+0%', '+0Hz', '+0%', 'general', 'audio-24khz-48kbitrate-mono-mp3');

    assert.equal(res.status, 500);
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    const body = await res.json();
    assert.equal(body.error.code, 'edge_tts_error');
    assert.equal(body.error.type, 'api_error');
    assert.ok(body.error.message.includes('获取endpoint失败'));

    // MAX_RETRIES = 3 → 共 4 次尝试，每次都应重新请求 endpoint
    assert.equal(endpointCalls, 4, `应重试后失败，实际 endpoint 请求 ${endpointCalls} 次`);
    assert.equal(ttsCalls, 0, 'endpoint 不可用时不应请求 TTS 接口');
});

test('endpoint 刷新中途恢复：重试成功，正常返回音频', { timeout: 30000 }, async () => {
    const { getVoice } = await loadService();
    const exp = Math.floor(Date.now() / 1000) + 3600;

    let endpointCalls = 0;
    globalThis.fetch = async (url) => {
        if (String(url).startsWith(ENDPOINT_URL)) {
            endpointCalls++;
            if (endpointCalls < 3) return new Response('flaky', { status: 500 });
            return makeEndpointResponse(exp);
        }
        return makeAudioResponse();
    };

    const res = await getVoice('你好', 'zh-CN-XiaoxiaoNeural', '+0%', '+0Hz', '+0%', 'general', 'audio-24khz-48kbitrate-mono-mp3');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'audio/mpeg');
    assert.equal(endpointCalls, 3);
});
