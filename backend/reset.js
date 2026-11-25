// backend/reset.js —— 忘记密码时的救援脚本：npm run reset
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function reset() {
  const newHash = await bcrypt.hash('123456', 10);
  const existing = await prisma.appConfig.findUnique({ where: { id: 1 } });

  if (existing) {
    await prisma.appConfig.update({
      where: { id: 1 },
      data: {
        username: 'admin',
        password: newHash,
        isFirstLogin: true,          // 强制重新改密
        twoFactorEnabled: false,     // 同步解绑 2FA，避免手机验证器丢了就进不去
        twoFactorSecret: null,
      },
    });
  } else {
    await prisma.appConfig.create({
      data: { id: 1, username: 'admin', password: newHash, isFirstLogin: true },
    });
  }

  console.log('✅ 系统已重置：账号 admin / 密码 123456（2FA 已解绑），请登录后立即修改。');
}

reset()
  .catch((e) => {
    console.error('❌ 重置失败：', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
