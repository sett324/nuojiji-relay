import { sendWebPush } from './webPush.js';
import { sendApns } from './apns.js';
import { sendFcm } from './fcm.js';

export async function dispatchPush(env, subscription, payload) {
  // 1. WxPusher 原生推送 (OPPO 厂商通道)
  if (env.WXPUSHER_APP_TOKEN && env.WXPUSHER_UID) {
    try {
      await fetch('https://wxpusher.zjiecode.com/api/send/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appToken: env.WXPUSHER_APP_TOKEN,
          content: payload.body,
          summary: payload.title,
          contentType: 1,
          uids: [env.WXPUSHER_UID],
          verifyPay: false
        })
      });
    } catch (e) {
      console.warn('[WxPusher] failed:', e.message);
    }
  }

  // 2. 原作者的通道分发逻辑
  if (!subscription || !subscription.channel) return { ok: true };
  
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
        return { ok: true };
    }
  } catch (e) {
    console.error(`[dispatchPush] Error in channel ${subscription.channel}:`, e.message);
    return { ok: false, reason: e.message };
  }
}
