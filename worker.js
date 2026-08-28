// Cloudflare Workers 入口。
// 部署：wrangler deploy（需在 wrangler.toml 绑定 KV namespace "OUTBOX"，
//      并 `wrangler secret put RELAY_SECRET` / VAPID_* 等）。

import { createApp } from './src/app.js';
import { runProactiveTick } from './src/proactive/tick.js';

const app = createApp();

export default {
    fetch: app.fetch,
    // Phase 2：定时主动生成。wrangler.toml [triggers] crons 配置触发频率。
    async scheduled(_event, env, ctx) {
        // 🎲 掷骰子环节：生成 0~1 的随机数，只有小于 0.1（10%概率）才继续
        // 这样可以把 1 分钟的闹钟拦截掉 90%，极大地节省 KV 读取和 API 调用成本，
        // 同时让 AI 找你的时间变得随机自然（比如 10:07 而不是 10:10）
        if (Math.random() > 0.1) {
            console.log('[scheduled] 🎲 掷骰子未中奖，阿昼继续睡觉💤');
            return;
        }

        ctx.waitUntil(
            runProactiveTick(env).catch((e) => console.error('[scheduled] proactive tick failed:', e?.message))
        );
    },
};
