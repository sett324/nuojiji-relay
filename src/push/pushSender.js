// 推送分发：根据订阅通道选发送器。Phase 1 实做 web，apns/fcm 为 stub。
//
// 订阅由手机通过 /api/push/subscribe 注册，按 inboxId 存（复用 outbox 同一存储后端的
// 一个独立命名空间）。这里只负责「给某 inbox 发叫醒推送」。

import { sendWebPush } from './webPush.js';
import { sendApns } from './apns.js';
import { sendFcm } from './fcm.js';
import { sendWeCom } from './wecom.js';

/**
 * @param subscription { channel: 'web'|'apns'|'fcm', ...channel-specific }
 */
export async function dispatchPush(env, subscription, payload) {
    // 只要配置了企微，就顺便发一份给企微
    if (env.WECOM_SECRET) {
        await sendWeCom(env, payload).catch(e => console.error('[WeCom] push failed:', e.message));
    }

    if (!subscription || !subscription.channel) return { ok: false, reason: 'no-subscription' };
    switch (subscription.channel) {
        case 'web':
            return sendWebPush(env, subscription.sub || subscription, payload);
        case 'apns':
            return sendApns(env, subscription, payload);
        case 'fcm':
            return sendFcm(env, subscription, payload);
        default:
            return { ok: false, reason: `unknown-channel:${subscription.channel}` };
    }
}
