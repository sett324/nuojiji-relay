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
    
    switch (subscription.channel) {
        case 'web':
            return sendWebPush(env, subData, payload);
        case 'apns':
            return sendApns(env, subData, payload);
        case 'fcm':
            return sendFcm(env, subData, payload);
        default:
            return { ok: false, reason: `unknown-channel:${subscription.channel}` };
    }
}
