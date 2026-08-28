import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireSecret } from './util/auth.js';
import { createOutboxStore } from './store/outboxStore.js';
import { createSubStore } from './store/subStore.js';
import { createKvStore } from './store/kvStore.js';
import { runGeneration } from './ai/aiCaller.js';
import { dispatchPush } from './push/pushSender.js';
import { getVapidPublicKey } from './push/webPush.js';
import { makeMessageId, nowMs } from './util/ids.js';

const VERSION = '1.0.0-clean';

export function createApp() {
    const app = new Hono();

    app.use('*', cors({
        origin: (o) => o || '*',
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
    }));

    const stores = { outbox: null, sub: null, kv: null };
    async function getStores(env) {
        if (env && env.OUTBOX) {
            return {
                outbox: await createOutboxStore(env),
                sub: await createSubStore(env),
                kv: await createKvStore(env),
            };
        }
        if (!stores.outbox) stores.outbox = await createOutboxStore(env);
        if (!stores.sub) stores.sub = await createSubStore(env);
        if (!stores.kv) stores.kv = await createKvStore(env);
        return stores;
    }

    app.get('/health', async (c) => {
        const { outbox } = await getStores(c.env);
        return c.json({ ok: true, store: outbox.kind || 'unknown', version: VERSION });
    });

    app.use('/generate', requireSecret);
    app.use('/outbox', requireSecret);
    app.use('/ack', requireSecret);
    app.use('/api/push/subscribe', requireSecret);

    app.post('/generate', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { requestId, inboxId, messages, settings, maxTokens, meta } = body || {};
        if (!requestId || !inboxId || !Array.isArray(messages) || !settings) {
            return c.json({ error: 'bad request' }, 400);
        }

        const { outbox, sub } = await getStores(c.env);
        if (await outbox.seenRequest(requestId)) {
            return c.json({ duplicate: true }, 409);
        }
        await outbox.markRequest(requestId);

        const id = makeMessageId(requestId);
        let content;
        try {
            content = await runGeneration(settings, messages, maxTokens);
            const item = { id, requestId, content, error: null, createdAt: nowMs() };
            await outbox.put(inboxId, item);

            // 推送逻辑
            const pushWork = (async () => {
                try {
                    const subs = await sub.list(inboxId);
                    const payload = {
                        title: meta?.charName || '糯叽机',
                        body: content.slice(0, 100),
                        kind: 'relay-outbox'
                    };
                    for (const s of subs) {
                        await dispatchPush(c.env, s, payload);
                    }
                } catch (e) { console.warn('Push failed', e); }
            })();
            if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(pushWork);

            return c.json({ accepted: true, requestId, generated: true }, 202);
        } catch (e) {
            await outbox.put(inboxId, { id, requestId, content: null, error: String(e), createdAt: nowMs() });
            return c.json({ error: String(e) }, 500);
        }
    });

    app.get('/outbox', async (c) => {
        const inboxId = c.req.query('inboxId');
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { outbox } = await getStores(c.env);
        const items = await outbox.list(inboxId, 0);
        return c.json({ items, now: nowMs() });
    });

    app.post('/ack', async (c) => {
        const { inboxId, ids } = await c.req.json();
        const { outbox } = await getStores(c.env);
        await outbox.ack(inboxId, ids);
        return c.json({ ok: true });
    });

    return app;
}
