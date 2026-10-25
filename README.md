# 1688 客户聊天检索与导出 · 1688 Chat Search & Exporter

> 按客服和客户旺旺号精确检索 1688 聊天记录，并导出为本地文件，适合每日询盘复盘和销售分析。
>
> Search 1688 conversations by salesperson and customer account, then export a local report for daily inquiry review and sales analysis.

**Chrome Extension · Search by Customer · Multi-salesperson · Excel/JSON Export**

## 项目定位

它适合“先精确找到需要复盘的客户，再交给分析系统处理”的场景。插件负责检索和导出，不会替代销售判断，也不会自动生成未经核对的客户结论。

推荐工作流：

`选择客服 → 输入客户旺旺号 → 检索近三个月 → 导出聊天记录 → 脱敏 → 导入 chat-analyzer → 输出客户需求、产品关注点和市场趋势`

本版本为检索版插件，支持按客户旺旺号精确检索并导出 1688 聊天记录。

- 勾选要检索的销售后输入客户旺旺号，点击“检索已勾选销售”，只扫描近三个月并显示每个销售匹配的消息数量。
- 检索结果会回填到员工列表，可取消勾选后点击“导出 JSON”。

## 1.5.9 日期修复

- 修复月末计算近三个月时可能跳过部分日期的问题，统一检索、日期预设与范围校验的本地日期计算。
- 运行 `node tests/dates.cjs` 检查跨月、跨年和闰年边界；尚未在当前 1688 页面验证实际检索及导出。
- 本版本基于检索版 V1.5.8。普通版 V1.3.2 后续的批量 ZIP 和接口直读优化尚未合并，不能认为两者功能完全相同。

## 1.3.0 安全桥接与独立标识

- 页面上下文与内容脚本通过一次性 `MessageChannel` 传递数据，带随机会话标识和来源校验，不再把聊天正文放入全局 `window.postMessage` 消息。
- 清理原始品牌/来源残留，当前版本名称为检索版插件。

## 1.2.1 员工列表连接修复

读取员工前自动补加载页面脚本并定位聊天查询内嵌框架，解决扩展升级后无消息接收端的问题。新增 scripting 权限用于向已授权的聊天页面补加载脚本。消息按实际 frameId 投递，连接检测可重试，导出指令不会因连接错误自动重复执行。

## 1.2.0 侧边栏

点击工具栏图标打开常驻侧边栏，点击网页不会关闭面板。支持纵向滚动与窄面板布局，要求 Chrome 116 或更新版本。
升级后在扩展管理页重新加载插件，再刷新 1688 页面。侧边栏左右位置由 Chrome 的外观设置控制；如显示在左侧，请切换为右侧。

## 1.1.0 速度优化

- 缓存客户列表滚动位置，读取下一个客户时直接定位；定位失效自动回退全列表查找。
- Excel 图片最多 4 路并发，同一文件中的相同图片 URL 只下载一次，保持消息和图片顺序。
- 单张图片下载超过 30 秒保留错误与链接，继续处理其他图片。
- Excel ZIP 校验采用 CRC32 查表计算，完成日志显示总耗时。
- 仍按员工、7 天周期查询；保留聊天详情等待，避免因盲目缩短等待导致串客或漏记录。

参考：https://github.com/sindresorhus/p-limit （有限并发思路，本插件自行实现，无新增运行时依赖）。
本次未在已登录 1688 页面进行速度对比，实际耗时受客户数量、聊天长度、图片及网络影响。

独立的 Chrome Manifest V3 扩展，只保留 1688 工作台聊天记录导出能力。

## 功能

- 读取聊天记录查询页中的员工账号，支持多选
- 按员工和每 7 天一个周期批量查询，避免单次查询范围过大
- 导出本地 Excel（含聊天图片）或兼容 JSON
- 任务进度、暂停、继续、取消和日志复制
- 可选同步到用户自行配置的飞书多维表格；默认关闭

## 使用方法

1. 在 Chrome 开发者模式中加载本目录并刷新已登录的 1688 页面。
2. 打开聊天查询页和扩展侧边栏，勾选要检查的客服。
3. 输入客户旺旺号，点击检索；结果会显示各客服匹配的消息数量。
4. 取消不需要的客服后导出 JSON 或 Excel，保存前先确认日期范围和消息数量。
5. 对导出文件做脱敏，再交给聊天分析器生成客户分级、需求摘要、异议分类和跟进建议。

## 每日询盘分析场景

- 按客户快速回看前一天的重点询盘，检查是否及时跟进。
- 识别客户集中询问的产品功能、尺寸、认证、包装和交期。
- 将多个客服的询盘汇总后，观察不同国家、行业和产品线的需求变化。
- 为销售培训、产品改进和市场内容提供可追溯的原始对话样本。

## Privacy notes

The extension is designed for local export. It does not include customer records in the repository. Exported conversations can contain names, account IDs, contact details, product requirements, and commercial terms. Remove or mask identifiers before sharing with an analyzer or a team, and never commit raw exports, screenshots, Feishu credentials, or API keys to GitHub. Feishu sync is optional and sends only the content selected by the user to the configured table.

## 隐私与权限

- 仅匹配 `work.1688.com` 和 `air.1688.com` 的聊天工作台页面。
- 不含生意参谋、数字营销或 `debugger` 权限；使用 `sidePanel` 权限显示常驻侧边栏。
- 图片域名权限仅用于将聊天内图片嵌入本地 Excel；飞书域名权限仅在用户主动开启飞书同步后使用。
- 飞书同步启用后会将用户选择的导出内容发送至用户配置的飞书多维表格，应用凭据保存在浏览器扩展本地存储。请仅在可信设备上配置，并妥善保管导出文件与应用密钥。
- 此版本尚未完成全面安全审计或实际 1688 页面上的端到端测试；页面结构或接口变动可能影响功能。

## 安装

1. 打开 `chrome://extensions/`，开启“开发者模式”。
2. 选择“加载已解压的扩展程序”。
3. 选择本目录。
4. 登录 1688 后点击扩展图标打开侧边栏，按提示进入聊天记录查询页并导出。
