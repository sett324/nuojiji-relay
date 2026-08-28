// Hono app —— 一份代码，Workers 和 Node 共用。
//
// 路由：
//   GET  /health                 健康检查（设置页测连接用）
//   POST /generate               提交生成（fire-and-forget，202）
//   GET  /outbox?inboxId=&since=  拉取已生成结果
//   POST /ack                    确认并删除
//   GET  /api/push/vapid-key     取 VAPID 公钥（复用 APP 现有订阅流程）
//   POST /api/push/subscribe     注册推送订阅
//   DELETE /api/push/unsubscribe 退订

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireSecret } from './util/auth.js';
import { createOutboxStore } from './store/outboxStore.js';
import { createSubStore, subKey } from './store/subStore.js';
import { createProactiveStore, PROACTIVE_WINDOW_CAP } from './store/proactiveStore.js';
import { createKvStore } from './store/kvStore.js';
import { runGeneration } from './ai/aiCaller.js';
import { dispatchPush } from './push/pushSender.js';
import { getVapidPublicKey } from './push/webPush.js';
import { makeMessageId, nowMs, extractPushBodies } from './util/ids.js';
import { sendWeCom } from './push/wecom.js';

const VERSION = '1.0.1';

export function createApp() {
    const app = new Hono();

    // 中继是用户自己的后端，APP 从套壳 (https://localhost / capacitor://localhost) 或
    // 网页 (https://*.pages.dev) 跨域请求 → 放开 CORS（鉴权靠 Bearer secret，不靠 origin）。
    app.use('*', cors({
        origin: (o) => o || '*',
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
    }));

    // 企微校验文件路由
    app.get('/WW_verify_OsAExzVsZdi27EXs.txt', (c) => c.text('OsAExzVsZdi27EXs'));

    // 每个请求懒初始化 store（Workers 每次 fetch 都新 env；Node 进程级缓存见下）
    const stores = { outbox: null, sub: null, proactive: null, kv: null };
    async function getStores(env) {
        if (env && env.OUTBOX) {
            // Workers：KV 绑定每次都现取，store 实例无状态可重建
            return {
                outbox: await createOutboxStore(env),
                sub: await createSubStore(env),
                proactive: await createProactiveStore(env),
                kv: await createKvStore(env),
            };
        }
        // Node：进程级单例
        if (!stores.outbox) stores.outbox = await createOutboxStore(env);
        if (!stores.sub) stores.sub = await createSubStore(env);
        if (!stores.proactive) stores.proactive = await createProactiveStore(env);
        if (!stores.kv) stores.kv = await createKvStore(env);
        return stores;
    }

    app.get('/health', async (c) => {
        const { outbox } = await getStores(c.env);
        return c.json({ ok: true, store: outbox.kind || 'unknown', version: VERSION });
    });

    // 🖼️ 角色头像公开读取（无鉴权）
    app.get('/avatar/:key', async (c) => {
        const key = c.req.param('key');
        if (!key || !/^[\w.-]{1,128}$/.test(key)) return c.json({ error: 'bad key' }, 400);
        const { kv } = await getStores(c.env);
        if (!kv) return c.json({ error: 'no store' }, 503);
        const rec = await kv.get(`av:${key}`, { type: 'json' }).catch(() => null);
        if (!rec || !rec.b64) return c.json({ error: 'not found' }, 404);
        try {
            const bin = Uint8Array.from(atob(rec.b64), (ch) => ch.charCodeAt(0));
            return new Response(bin, {
                status: 200,
                headers: {
                    'content-type': rec.mime || 'image/png',
                    'cache-control': 'public, max-age=86400',
                    'access-control-allow-origin': '*',
                },
            });
        } catch {
            return c.json({ error: 'decode failed' }, 500);
        }
    });

    // 以下全部要鉴权
    app.use('/avatar', requireSecret);
    app.use('/generate', requireSecret);
    app.use('/outbox', requireSecret);
    app.use('/ack', requireSecret);
    app.use('/api/push/subscribe', requireSecret);
    app.use('/api/push/unsubscribe', requireSecret);
    app.use('/api/push/diag', requireSecret);
    app.use('/proactive/*', requireSecret);

    app.post('/generate', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { requestId, inboxId, messages, settings, maxTokens, meta } = body || {};
        if (!requestId || !inboxId || !Array.isArray(messages) || !settings) {
            return c.json({ error: 'requestId / inboxId / messages / settings required' }, 400);
        }

        const { outbox, sub } = await getStores(c.env);

        if (await outbox.seenRequest(requestId)) {
            try {
                const existing = (await outbox.list(inboxId, 0)).find(it => it && String(it.requestId) === String(requestId));
                if (existing && !existing.error && existing.content) {
                    return c.json({ accepted: true, requestId, generated: true, replayed: true }, 202);
                }
            } catch { }
            return c.json({ duplicate: true, requestId }, 409);
        }
        await outbox.markRequest(requestId);

        const id = makeMessageId(requestId);
        let item;
        try {
            const content = await runGeneration(settings, messages, maxTokens);
            item = {
                id, requestId,
                charId: meta?.charId ?? null, roundId: meta?.roundId ?? null, userId: meta?.userId ?? null,
                content, error: null, createdAt: nowMs(),
            };
        } catch (e) {
            item = {
                id, requestId,
                charId: meta?.charId ?? null, roundId: meta?.roundId ?? null, userId: meta?.userId ?? null,
                content: null, error: String(e?.message || e), createdAt: nowMs(),
            };
        }
        await outbox.put(inboxId, item);

        // 发推送
        const pushWork = (async () => {
            try {
                if (item.error) return;
                const title = meta?.charName || '糯叽机';
                const rawBodies = extractPushBodies(item.content);
                const fullMsg = rawBodies.join('\n\n');

                // 1. 企业微信自建应用推送
                if (c.env.WECOM_SECRET) {
                    await sendWeCom(c.env, { title, body: fullMsg }).catch(e => console.error('[WeCom] push failed:', e.message));
                }

                // 2. WxPusher 推送 (原生安卓推送方案)
                const wxSpt = c.env.WXPUSHER_SPT;
                const wxAppToken = c.env.WXPUSHER_APP_TOKEN;
                const wxUid = c.env.WXPUSHER_UID;

                if (wxAppToken && wxUid) {
                    // 标准推送
                    await fetch('https://wxpusher.zjiecode.com/api/send/message', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            appToken: wxAppToken,
                            content: fullMsg,
                            summary: title,
                            contentType: 1,
                            uids: [wxUid]
                        })
                    }).catch(e => console.error('[WxPusher] Standard push failed:', e.message));
                } else if (wxSpt) {
                    // 极简推送
                    const finalUrl = `https://wxpusher.zjiecode.com/api/send/message/${wxSpt}/${encodeURIComponent(`【${title}】\n${fullMsg}`)}`;
                    await fetch(finalUrl).catch(e => console.error('[WxPusher] Simple push failed:', e.message));
                }

                // 3. 自定义 Webhook 推送
                const webhookUrl = c.env.WECHAT_WEBHOOK_URL;
                if (webhookUrl && !webhookUrl.includes('wxpusher')) {
                    const wechatPayload = { msgtype: 'text', text: { content: `【${title}】\n${fullMsg}` } };
                    await fetch(webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(wechatPayload)
                    }).catch(e => console.warn('[Webhook] push failed:', e.message));
                }

                // 4. 原生推送 (iOS/PWA)
                const bodies = meta?.notifPrivacy ? rawBodies.map(() => '你有一条新消息') : rawBodies;
                const subs = await sub.list(inboxId);
                if (subs.length > 0) {
                    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                    let i = 0;
                    for (const body of bodies) {
                        if (i > 0) {
                            const delay = Math.min(4000, 600 + (body?.length || 0) * 120);
                            await sleep(delay);
                        }
                        const payload = {
                            title, body, charId: item.charId, userId: item.userId, kind: 'relay-outbox',
                            avatarUrl: meta?.avatarUrl || null,
                            senderName: title,
                            conversationId: `${item.userId}_${item.charId}`,
                            mutableContent: true,
                        };
                        for (const s of subs) {
                            const res = await dispatchPush(c.env, s, payload);
                            if (res?.gone) await sub.remove(inboxId, s);
                        }
                        i++;
                    }
                }
            } catch (e) {
                console.warn('[pushWork] failed:', e?.message);
            }
        })();

        try { c.executionCtx.waitUntil(pushWork); } catch { }
        return c.json({ accepted: true, requestId, generated: !item.error }, 202);
    });

    app.get('/outbox', async (c) => {
        const inboxId = c.req.query('inboxId');
        const since = Number(c.req.query('since') || 0);
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { outbox } = await getStores(c.env);
        const items = await outbox.list(inboxId, since);
        return c.json({ items, now: nowMs() });
    });

    app.post('/ack', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, ids } = body || {};
        if (!inboxId || !Array.isArray(ids)) return c.json({ error: 'inboxId / ids required' }, 400);
        const { outbox } = await getStores(c.env);
        const acked = await outbox.ack(inboxId, ids);
        return c.json({ acked });
    });

    app.get('/api/push/vapid-key', async (c) => {
        const publicKey = await getVapidPublicKey(c.env);
        if (!publicKey) return c.json({ error: 'VAPID not configured' }, 503);
        return c.json({ publicKey });
    });

    app.post('/api/push/subscribe', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, subscription, channel } = body || {};
        if (!inboxId || !subscription) return c.json({ error: 'inboxId / subscription required' }, 400);
        const entry = subscription.channel ? subscription : { channel: channel || 'web', sub: subscription };
        try {
            const { sub } = await getStores(c.env);
            await sub.add(inboxId, entry);
            const ch = entry.channel || 'web';
            if ((ch === 'apns' || ch === 'fcm') && typeof sub.pruneChannel === 'function') {
                await sub.pruneChannel(inboxId, ch, subKey(entry));
            }
        } catch (e) {
            return c.json({ error: 'subscribe failed', detail: String(e?.message || e), hasKV: !!(c.env && c.env.OUTBOX) }, 500);
        }
        return c.json({ ok: true });
    });

    app.post('/api/push/diag', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { body = {}; }
        const { inboxId, test } = body || {};
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { sub } = await getStores(c.env);
        const subs = await sub.list(inboxId);
        const mask = (s) => {
            const t = s?.token || s?.sub?.token || s?.sub?.endpoint || '';
            const tail = String(t).slice(-6);
            return { channel: s?.channel || 'web', idTail: tail ? `…${tail}` : null };
        };
        const result = { inboxId, count: subs.length, channels: subs.map(mask) };
        return c.json(result);
    });

    app.post('/avatar', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { key, dataUrl } = body || {};
        if (!key || !/^[\w.-]{1,128}$/.test(key)) return c.json({ error: 'bad key' }, 400);
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return c.json({ error: 'dataUrl required' }, 400);
        const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!m) return c.json({ error: 'bad dataUrl' }, 400);
        const mime = m[1], b64 = m[2];
        if (b64.length > 512 * 1024) return c.json({ error: 'avatar too large' }, 413);
        const { kv } = await getStores(c.env);
        if (!kv) return c.json({ error: 'no store' }, 503);
        try {
            await kv.put(`av:${key}`, JSON.stringify({ mime, b64 }), { expirationTtl: 60 * 60 * 24 * 60 });
        } catch (e) {
            return c.json({ error: 'put failed', detail: String(e?.message || e) }, 500);
        }
        return c.json({ ok: true, url: `/avatar/${key}` });
    });

    app.delete('/api/push/unsubscribe', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, subscription, endpoint } = body || {};
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { sub } = await getStores(c.env);
        await sub.remove(inboxId, subscription || { endpoint });
        return c.json({ ok: true });
    });

    // Proactive routes...
    app.post('/proactive/register', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        let { inboxId, userId, charId, promptTemplate, aiSettings, mode, interval, intervalUnit, probability } = body || {};
        if (!inboxId || userId == null || charId == null || !promptTemplate || !aiSettings) {
            return c.json({ error: 'required fields missing' }, 400);
        }
        const { proactive } = await getStores(c.env);
        await proactive.upsert({
            inboxId, userId: String(userId), charId: String(charId),
            mode: mode === 'interval' ? 'interval' : 'impulse',
            interval: interval ?? 60, intervalUnit: intervalUnit || 'minutes', probability: probability || 'medium',
            promptTemplate, aiSettings, enabled: true,
        });
        return c.json({ ok: true });
    });

    return app;
}
