export async function sendWeCom(env, payload) {
    const { WECOM_CORPID, WECOM_AGENTID, WECOM_SECRET, WECOM_TOUSER = '@all' } = env;

    if (!WECOM_CORPID || !WECOM_AGENTID || !WECOM_SECRET) {
        console.error('[WeCom] Missing config in env');
        return { ok: false, reason: 'missing-wecom-config' };
    }

    try {
        // 1. 获取 access_token
        const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${WECOM_CORPID}&corpsecret=${WECOM_SECRET}`;
        const tokenRes = await fetch(tokenUrl);
        const tokenData = await tokenRes.json();
        
        if (tokenData.errcode !== 0) {
            console.error('[WeCom] Get Token Error:', tokenData.errmsg);
            return { ok: false, reason: `token-error:${tokenData.errmsg}` };
        }

        const accessToken = tokenData.access_token;

        // 2. 发送消息
        const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`;
        const content = payload.title ? `${payload.title}\n${payload.body}` : payload.body;
        
        const sendRes = await fetch(sendUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                touser: WECOM_TOUSER,
                msgtype: 'text',
                agentid: parseInt(WECOM_AGENTID, 10),
                text: {
                    content: content
                },
                safe: 0
            })
        });

        const sendData = await sendRes.json();
        if (sendData.errcode !== 0) {
            console.error('[WeCom] Send Message Error:', sendData.errmsg);
        } else {
            console.log('[WeCom] Push success!');
        }
        return { ok: sendData.errcode === 0, data: sendData };
    } catch (e) {
        console.error('[WeCom] Network/Runtime Error:', e.message);
        return { ok: false, reason: e.message };
    }
}
