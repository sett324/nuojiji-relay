import { Hono } from 'hono';
import { requireSecret } from './util/auth.js';
import { createOutboxStore } from './store/outboxStore.js';
import { createSubStore } from './store/subStore.js';
import { dispatchPush } from './push/pushSender.js';

export function createApp() {
    const app = new Hono();

    // 基础存活检查
    app.get('/health', (c) => c.json({ 
        ok: true, 
        store: 'kv', 
        version: '1.0.5-debug-path' 
    }));

    // 🛠️ 诊断接口：支持所有方法 (ALL)，并兼容多种路径
    const diagHandler = async (c) => {
        const env = c.env;
        return c.json({
            ok: true,
            message: 'Backend reached!',
            config: {
                hasRelaySecret: !!env.RELAY_SECRET,
                hasWxPusherToken: !!env.WXPUSHER_APP_TOKEN,
                hasWxPusherUid: !!env.WXPUSHER_UID
            }
        });
    };

    app.all('/push/diag', requireSecret, diagHandler);
    app.all('/api/push/diag', requireSecret, diagHandler);
    app.all('/*/push/diag', requireSecret, diagHandler);

    // 🔍 路径追踪器：如果还是 404，直接告诉用户它访问了什么
    app.notFound((c) => {
        const path = c.req.path;
        const method = c.req.method;
        console.warn(`[404] App tried to access: ${method} ${path}`);
        return c.text(`阿昼提示：后端没找到这个路径 -> [${method}] ${path}`, 404);
    });

    // 核心逻辑：生成消息并触发推送
    app.post('/generate', requireSecret, async (c) => {
        const outbox = await createOutboxStore(c.env);
        const sub = await createSubStore(c.env);
        const body = await c.req.json();

        const requestId = body.requestId || `req_${Date.now()}`;
        const item = {
            id: `relay_${requestId}`,
            requestId,
            charId: body.charId,
            userId: body.userId,
            content: body.content,
            createdAt: Date.now(),
        };

        // 1. 存入 KV
        await outbox.put(body.inboxId, item);

        // 2. 强制触发 WxPusher 推送
        try {
            const subs = await sub.list(body.inboxId);
            // 即使没有订阅记录，我们也尝试用环境变量里的 UID 发送（用于测试）
            const testSub = subs.length > 0 ? subs[0] : { channel: 'wxpusher' };
            
            await dispatchPush(c.env, testSub, {
                title: body.charName || '新消息',
                body: body.content,
                kind: 'relay-outbox'
            });
        } catch (e) {
            console.error('Push failed:', e.message);
        }

        return c.json({ ok: true, id: item.id });
    });

    // 消息查询接口
    app.get('/outbox/:inboxId', requireSecret, async (c) => {
        const outbox = await createOutboxStore(c.env);
        const items = await outbox.get(c.req.param('inboxId'));
        return c.json({ items });
    });

    return app;
}
