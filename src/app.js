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

const VERSION = '1.0.3-auth-stable';

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

    // 公开接口
    app.get('/health', async (c) => {
        const { outbox } = await getStores(c.env);
        return c.json({ ok: true, store: outbox.kind || 'unknown', version: VERSION });
    });

    // 需要鉴权的接口统一处理
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

    // 显式绑定路径，确保鉴权中间件能正确拦截
    app.get('/api/push/diag', requireSecret, diagHandler);
    app.get('/push/diag', requireSecret, diagHandler);
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

    app.get('/outbox', requireSecret, async (c) => {
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
