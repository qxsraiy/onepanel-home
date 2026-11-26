# OnePanel 浏览器扩展

右键保存任意页面 → 同步到你的所有节点。

## 功能

- **右键保存**：任意页面 → 右键 → 「保存到 OnePanel」
- **选中文字存备忘录**：选中一段文字 → 右键 → 保存成卡片 + 写入备忘录
- **弹窗保存**：点扩展图标，可改名称 / 选分组再保存
- **自动跟随主题**：读取面板设置的主题色，外观与网页端一致

## 安装（开发者模式，30 秒）

1. 在面板 → 设置 → **浏览器扩展** → 点「下载扩展包」
2. 解压 zip 到一个**固定目录**（别删，删了扩展失效）
3. 浏览器打开 `chrome://extensions`（Edge 是 `edge://extensions`）
4. 打开右上角 **开发者模式**
5. 点 **加载已解压的扩展程序**，选中解压出的文件夹
6. 点扩展图标 → **设置节点与账号** → 填节点地址 + Token

**Token 在哪拿**：面板 → 设置 → **API 接口** → 生成 Token（形如 `op_xxxxx`）

## 为什么不能"点一下就装"

浏览器的安全模型**禁止网页安装扩展**（任何网站都做不到）。想做到一键，只能：

- **上架 Edge 加载项商店**（免费）或 Chrome Web Store（$5）→ 用户点「获取」即可
- 或者走企业策略 `ExtensionInstallForcelist`（需管理员权限）

## 文件说明

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 清单 |
| `background.js` | Service Worker：右键菜单 + 保存逻辑 |
| `popup.html/js` | 点击图标弹出的小窗 |
| `options.html/js` | 设置页（节点地址 / Token / 默认分组） |
| `common.js` | 共享工具：配置读写、API 请求、主题跟随 |
| `icon*.png` | 图标 |

## 权限说明

- `activeTab`：读当前标签页标题和地址
- `storage`：存节点地址和 Token（只存本地 `chrome.storage.local`）
- `contextMenus`：右键菜单
- `scripting`：注入脚本读页面信息

**不申请** `<all_urls>`，不读你不点右键的页面。
