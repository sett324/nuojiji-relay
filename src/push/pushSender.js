import { sendWebPush } from './webPush.js';
import { sendApns } from './apns.js';
import { sendFcm } from './fcm.js';

/**
 * @param subscription { channel: 'web'|'apns'|'fcm', ...channel-specific }
 */
export async function dispatchPush(env, subscription, payload) {
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
