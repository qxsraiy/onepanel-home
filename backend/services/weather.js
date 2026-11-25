/**
 * 天气小组件数据源（v2.7.0 换成 Open-Meteo）
 * ------------------------------------------------------------------
 * 旧版走 wttr.in：中文城市名经常被解析成奇怪的地名（上海 → Pootung），
 * 返回的温度是整度数、还带一层它自己的缓存，看起来像"假数据、不变"。
 *
 * 现在两段调用，都是免 key、真实观测：
 *  1) geocoding-api.open-meteo.com  城市名 → 经纬度（中文/英文都认）
 *  2) api.open-meteo.com/forecast   当前实测 + 今日最高/最低（10 分钟粒度观测）
 * 前端会显示"更新于 HH:mm"，数据来源与时间都摆明面上。
 */
const axios = require('axios');

const FORECAST_TTL = 5 * 60 * 1000;   // 当前天气 5 分钟够新
const GEO_TTL = 24 * 60 * 60 * 1000;  // 城市坐标一天不怎么会变
const FAIL_TTL = 60 * 1000;
const TIMEOUT = Number(process.env.WEATHER_TIMEOUT_MS || 8000);

const forecastCache = new Map(); // key: lat,lon
const geoCache = new Map();      // key: city

// WMO 天气码 → 中文 + emoji（Open-Meteo 用的就是这套码）
const WMO = {
  0: ['晴', '☀️'],
  1: ['大部晴朗', '🌤️'],
  2: ['多云', '⛅'],
  3: ['阴', '☁️'],
  45: ['雾', '🌫️'],
  48: ['霜雾', '🌫️'],
  51: ['小毛毛雨', '🌦️'],
  53: ['毛毛雨', '🌦️'],
  55: ['大毛毛雨', '🌧️'],
  56: ['冻毛毛雨', '🌧️'],
  57: ['强冻毛毛雨', '🌧️'],
  61: ['小雨', '🌦️'],
  63: ['中雨', '🌧️'],
  65: ['大雨', '🌧️'],
  66: ['冻雨', '🌧️'],
  67: ['强冻雨', '🌧️'],
  71: ['小雪', '🌨️'],
  73: ['中雪', '🌨️'],
  75: ['大雪', '❄️'],
  77: ['雪粒', '🌨️'],
  80: ['阵雨', '🌦️'],
  81: ['强阵雨', '🌧️'],
  82: ['暴雨', '⛈️'],
  85: ['阵雪', '🌨️'],
  86: ['强阵雪', '❄️'],
  95: ['雷阵雨', '⛈️'],
  96: ['雷阵雨伴冰雹', '⛈️'],
  99: ['强雷暴伴冰雹', '⛈️'],
};

const sanitizeCity = (raw) => {
  const city = String(raw || '').trim().replace(/[\r\n\t]/g, ' ').slice(0, 40);
  if (!city) return '';
  if (!/^[\p{L}\p{N}\s.,'\-]+$/u.test(city)) return '';
  return city;
};

const describe = (code) => {
  const hit = WMO[Number(code)];
  return { desc: hit ? hit[0] : '未知', emoji: hit ? hit[1] : '🌡️' };
};

async function geocode(city) {
  const hit = geoCache.get(city);
  if (hit && Date.now() - hit.at < GEO_TTL) return hit.data;
  const request = () => axios.get('https://geocoding-api.open-meteo.com/v1/search', {
    // count=5 再按人口挑：chengde 这种拼音会同时命中"承德市(92万)"和"承德/吉林(0)"
    params: { name: city, count: 5, language: 'zh', format: 'json' },
    timeout: TIMEOUT,
    headers: { 'User-Agent': 'onepanel-weather/2.0' },
  });
  let res;
  try {
    res = await request();
  } catch (e) {
    // 上游偶尔抽风（429/网络抖动），重试一次再报错
    res = await request();
  }
  const results = Array.isArray(res.data?.results) ? res.data.results.slice() : [];
  const first = results.sort((a, b) => (b.population || 0) - (a.population || 0))[0];
  // 有人口数据的优先，实在没有就退回第一条
  const picked = first || res.data?.results?.[0];
  if (!picked) throw new Error(`找不到城市「${city}」`);
  const data = {
    name: picked.name,
    admin1: picked.admin1 || '',
    country: picked.country || '',
    latitude: picked.latitude,
    longitude: picked.longitude,
    timezone: picked.timezone || 'auto',
  };
  geoCache.set(city, { at: Date.now(), data });
  return data;
}

async function forecast(lat, lon, timezone, force = false) {
  const key = `${lat},${lon}`;
  const hit = forecastCache.get(key);
  // force=true 是用户在卡片上点了刷新：直接穿透缓存，证明数据真的在动
  if (!force && hit && Date.now() - hit.at < FORECAST_TTL && hit.data) {
    return { data: hit.data, cached: true };
  }
  if (hit && hit.error && Date.now() - hit.at < FAIL_TTL) return { error: hit.error };

  try {
    const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: lat,
        longitude: lon,
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min',
        timezone: timezone || 'auto',
        forecast_days: 2,
      },
      timeout: TIMEOUT,
      headers: { 'User-Agent': 'onepanel-weather/2.0' },
    });
    const cur = res.data?.current;
    if (!cur) throw new Error('Open-Meteo 没返回 current');
    const daily = res.data?.daily || {};
    const today = describe(daily.weather_code?.[0] ?? cur.weather_code);
    const data = {
      temp: Number(cur.temperature_2m),
      feelsLike: Number(cur.apparent_temperature),
      humidity: Number(cur.relative_humidity_2m),
      wind: Number(cur.wind_speed_10m),
      code: Number(cur.weather_code),
      desc: describe(cur.weather_code).desc,
      emoji: describe(cur.weather_code).emoji,
      max: Number(daily.temperature_2m_max?.[0]),
      min: Number(daily.temperature_2m_min?.[0]),
      todayDesc: today.desc,
      // 观测时间由接口给（"2026-11-17T13:45"），前端直接展示，说明数据几点几分测的
      observedAt: cur.time || null,
      timezone: res.data?.timezone || timezone || '',
    };
    forecastCache.set(key, { at: Date.now(), data });
    return { data };
  } catch (e) {
    const message = e.response?.status
      ? `天气服务返回 ${e.response.status}`
      : (e.code === 'ECONNABORTED' ? '请求天气超时' : e.message);
    forecastCache.set(key, { at: Date.now(), error: message });
    return { error: message };
  }
}

/**
 * @param {string} rawCity 城市名（中文/英文都行）
 * @returns {Promise<{data?:object, error?:string, cached?:boolean}>}
 */
async function getWeather(rawCity, options = {}) {
  const query = sanitizeCity(rawCity) || 'Shanghai';
  try {
    const geo = await geocode(query);
    const result = await forecast(geo.latitude, geo.longitude, geo.timezone, !!options.force);
    if (result.error) return { error: result.error };
    return {
      data: {
        query,
        city: geo.name,
        region: geo.admin1 || geo.country,
        ...result.data,
        updatedAt: Date.now(),
        source: 'open-meteo',
      },
      cached: !!result.cached,
    };
  } catch (e) {
    return { error: e.message || '获取天气失败' };
  }
}

module.exports = { getWeather, sanitizeCity };
