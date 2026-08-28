import { sendWebPush } from './webPush.js';
import { sendApns } from './apns.js';
import { sendFcm } from './fcm.js';

/**
 * @param subscription { channel: 'web'|'apns'|'fcm', ...channel-specific }
 */
export async function dispatchPush(env, subscription, payload) {
    if (!subscription || !subscription.channel) return { ok: false, reason: 'no-subscription' };
    
    // 兼容旧版订阅格式：如果 subscription.sub 存在，则使用它作为实际订阅信息
    const subData = subscription.sub || subscription;
    
    try {
        switch (subscription.channel) {
            case 'web':
                return await sendWebPush(env, subData, payload);
            case 'apns':
                return await sendApns(env, subData, payload);
            case 'fcm':
                return await sendFcm(env, subData, payload);
            default:
                return { ok: false, reason: `unknown-channel:${subscription.channel}` };
        }
    } catch (e) {
        console.error(`[dispatchPush] Error in channel ${subscription.channel}:`, e.message);
        return { ok: false, reason: e.message };
    }
}
