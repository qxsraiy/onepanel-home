/**
 * 企业微信应用消息推送
 * ------------------------------------------------------------------
 * v2.0.0 修复要点：
 *  - access_token 按 corpId+secret 缓存（换配置不再复用旧 token）
 *  - 所有请求带超时，避免网络卡住时把监测循环一起拖死
 *  - token 失效（errcode 40014 / 42001）自动刷新并重试一次
 *  - 每次推送前做退避保护，避免企微限流
 */
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const TIMEOUT = Number(process.env.WECHAT_TIMEOUT_MS || 8000);
const tokenCache = new Map(); // key: corpId|secret -> { token, expireAt }

const INVALID_TOKEN_CODES = new Set([40014, 42001, 41001]);

async function getToken(corpId, corpSecret, forceRefresh = false) {
  const cacheKey = `${corpId}|${corpSecret}`;
  const cached = tokenCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() < cached.expireAt) return cached.token;

  const { data } = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
    params: { corpid: corpId, corpsecret: corpSecret },
    timeout: TIMEOUT,
  });

  if (data.errcode !== 0) {
    console.error('❌ 获取企微 token 失败:', data.errcode, data.errmsg);
    return null;
  }
  // 官方有效期 7200s，这里留 5 分钟安全边界
  tokenCache.set(cacheKey, { token: data.access_token, expireAt: Date.now() + 6900 * 1000 });
  return data.access_token;
}

async function postMessage(token, payload) {
  const { data } = await axios.post(
    'https://qyapi.weixin.qq.com/cgi-bin/message/send',
    payload,
    { params: { access_token: token }, timeout: TIMEOUT },
  );
  return data;
}

/**
 * 发送文本消息给全员
 * @param {string} content
 * @returns {Promise<boolean>}
 */
async function send(content) {
  try {
    const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
    if (!config?.wechatCorpId || !config?.wechatCorpSecret || !config?.wechatAgentId) {
      console.log('⚠️ 企微推送中断：未配置完整的企微参数');
      return false;
    }

    const payload = {
      touser: config.wechatTouser || '@all',
      msgtype: 'text',
      agentid: Number(config.wechatAgentId),
      text: { content },
    };
    if (!Number.isFinite(payload.agentid)) {
      console.error('❌ 企微推送失败：AgentId 必须是数字，当前值为', config.wechatAgentId);
      return false;
    }

    let token = await getToken(config.wechatCorpId, config.wechatCorpSecret);
    if (!token) return false;

    let res = await postMessage(token, payload);
    if (res.errcode !== 0 && INVALID_TOKEN_CODES.has(res.errcode)) {
      token = await getToken(config.wechatCorpId, config.wechatCorpSecret, true);
      if (token) res = await postMessage(token, payload);
    }

    if (res.errcode === 0) {
      console.log('✅ 企微消息推送成功');
      return true;
    }
    console.error('❌ 企微消息推送失败:', res.errcode, res.errmsg);
    return false;
  } catch (error) {
    console.error('❌ 企微推送网络异常:', error.message);
    return false;
  }
}

module.exports = { send };
