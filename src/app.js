import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireSecret } from './util/auth.js';
import { createOutboxStore } from './store/outboxStore.js';
import { createSubStore } from './store/subStore.js';
import { createProactiveStore } from './store/proactiveStore.js';
import { createKvStore } from './store/kvStore.js';
import { runGeneration } from './ai/aiCaller.js';
import { dispatchPush } from './push/pushSender.js';
import { getVapidPublicKey } from './push/webPush.js';
import { makeMessageId, nowMs, extractPushBodies } from './util/ids.js';

const VERSION = '1.0.4-path-wildcard';

export function createApp() {
    const app = new Hono();

    app.use('*', cors({
        origin: (o) => o || '*',
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
    }));

    const stores = { outbox: null, sub: null, proactive: null, kv: null };
    async function getStores(env) {
        if (env && env.OUTBOX) {
            return {
                outbox: await createOutboxStore(env),
                sub: await createSubStore(env),
                proactive: await createProactiveStore(env),
                kv: await createKvStore(env),
            };
        }
        if (!stores.outbox) stores.outbox = await createOutboxStore(env);
        if (!stores.sub) stores.sub = await createSubStore(env);
        if (!stores.proactive) stores.proactive = await createProactiveStore(env);
        if (!stores.kv) stores.kv = await createKvStore(env);
        return stores;
    }

    // 公开健康检查
    app.get('/health', async (c) => {
        const { outbox } = await getStores(c.env);
        return c.json({ ok: true, store: outbox.kind || 'unknown', version: VERSION });
    });

    // 诊断处理器
    const diagHandler = async (c) => {
        return c.json({
            ok: true,
            env: {
                has_wxpusher_token: !!c.env.WXPUSHER_APP_TOKEN,
                has_wxpusher_uid: !!c.env.WXPUSHER_UID,
                has_relay_secret: !!c.env.RELAY_SECRET,
                has_kv: !!c.env.OUTBOX
            },
            version: VERSION
        });
    };

    // 🛡️ 暴力路径匹配：无论路径里有没有 api，只要是 push/diag 结尾就接住
    app.get('/api/push/diag', requireSecret, diagHandler);
    app.get('/push/diag', requireSecret, diagHandler);
    // 针对某些 App 可能出现的奇怪补全路径进行兜底
    app.get('/*/push/diag', requireSecret, diagHandler);

    app.post('/generate', requireSecret, async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { requestId, inboxId, messages, settings, maxTokens, meta } = body || {};
        if (!requestId || !inboxId || !Array.isArray(messages) || !settings) {
            return c.json({ error: 'requestId / inboxId / messages / settings required' }, 400);
        }

        const { outbox, sub } = await getStores(c.env);
        if (await outbox.seenRequest(requestId)) {
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

        const pushWork = (async () => {
            try {
                if (item.error) return;
                const subs = await sub.list(inboxId);
                const title = meta?.charName || '糯叽机';
                const bodies = extractPushBodies(item.content);
                for (const body of bodies) {
                    const payload = {
                        title, body, charId: item.charId, userId: item.userId, kind: 'relay-outbox',
                    };
                    await dispatchPush(c.env, null, payload);
                    for (const s of subs) {
                        await dispatchPush(c.env, s, payload);
                    }
                }
            } catch (e) {
                console.warn('[generate] push failed:', e?.message);
            }
        })();
        if (typeof c.executionCtx?.waitUntil === 'function') c.executionCtx.waitUntil(pushWork);

        return c.json({ accepted: true, requestId, generated: !item.error }, 202);
    });

    // 同样为其他接口增加兜底路径
    app.get('/outbox', requireSecret, async (c) => {
        const inboxId = c.req.query('inboxId');
        const since = Number(c.req.query('since') || 0);
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { outbox } = await getStores(c.env);
        const items = await outbox.list(inboxId, since);
        return c.json({ items, now: nowMs() });
    });
    app.get('/api/outbox', requireSecret, async (c) => {
        const inboxId = c.req.query('inboxId');
        const since = Number(c.req.query('since') || 0);
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { outbox } = await getStores(c.env);
        const items = await outbox.list(inboxId, since);
        return c.json({ items, now: nowMs() });
    });

    app.post('/ack', requireSecret, async (c) => {
        const { inboxId, ids } = await c.req.json();
        const { outbox } = await getStores(c.env);
        const acked = await outbox.ack(inboxId, ids);
        return c.json({ acked });
    });

    return app;
}
