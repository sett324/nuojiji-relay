export async function sendWeCom(env, payload) {
    const { WECOM_CORPID, WECOM_AGENTID, WECOM_SECRET, WECOM_TOUSER = '@all' } = env;

    if (!WECOM_CORPID || !WECOM_AGENTID || !WECOM_SECRET) {
        return { ok: false, reason: 'missing-wecom-config' };
    }

    try {
        // 1. 获取 access_token
        // 注意：在 Cloudflare Workers 环境下，fetch 会自动处理 HTTPS 握手，无需担心长连接或证书问题
        const tokenRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${WECOM_CORPID}&corpsecret=${WECOM_SECRET}`);
        const tokenData = await tokenRes.json();
        
        if (tokenData.errcode !== 0) {
            console.error('[WeCom] Get Token Error:', tokenData.errmsg);
            return { ok: false, reason: `token-error:${tokenData.errmsg}` };
        }

        const accessToken = tokenData.access_token;

        // 2. 发送消息
        const sendRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                touser: WECOM_TOUSER,
                msgtype: 'text',
                agentid: WECOM_AGENTID,
                text: {
                    content: payload.title ? `${payload.title}\n${payload.body}` : payload.body
                },
                safe: 0
            })
        });

        const sendData = await sendRes.json();
        if (sendData.errcode !== 0) {
            console.error('[WeCom] Send Message Error:', sendData.errmsg);
        }
        return { ok: sendData.errcode === 0, data: sendData };
    } catch (e) {
        console.error('[WeCom] Network/Runtime Error:', e.message);
        return { ok: false, reason: e.message };
    }
}
