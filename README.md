# dsh-redo

DeepSeek Harness 插件：**改掉已经发出去的那句话，再重发一次**。

不需要开新会话，也不需要手动"回退 → 复制原文 → 改 → 再发"。在任意一条提问旁点「订正」，就地改完确认，撤回与新发送一次完成。

> [!IMPORTANT]
> **依赖 [dsh-rewind-plugin](https://www.npmjs.com/package/dsh-rewind-plugin)，且不可省略。**
> dsh-redo 只补「改完自动重发」这一步；撤回对话、遮蔽上下文、还原工作区文件全部由 rewind 提供。未装 rewind 时「订正」按钮不会出现。详见[依赖](#依赖)一节。

## 它解决什么

两个真实场景：

1. **提交后发现笔误**——句子有歧义，模型已经开始答了，想撤回来改一个字。
2. **答完发现方向偏了**——模型顺着错误的理解做完了一轮，连带改了一堆文件，想把这一切退回去重新提问。

两者在插件看来是同一件事：目标消息及之后的全部内容一起撤掉，改好的提问重新发送。

## 交互

每条用户消息旁多一个「订正」按钮（与 dsh-rewind 的回退按钮并排）。

点击后：

- **这一段没有文件改动** → 直接弹出居中编辑框，预填原提问；
- **这一段改过文件** → 先列出会被还原的文件清单（`↺ 还原` / `✕ 删除`），确认后再进编辑框。

**在编辑框里点「撤回并发送」之前，什么都不发生。**取消 = 零副作用，对话和文件都保持原样。

编辑框的按键与主输入框一致：`Enter` 发送、`Shift+Enter` 换行、带 `Alt`/`Ctrl`/`Cmd` 的组合键不拦截。

确认后依次执行：

1. `/rewind-plugin @<seq> chat|both` —— 撤回对话，必要时还原文件；
2. `session.prompt(content, 'queue')` —— 把改好的文本（连同原图）作为新的真实用户消息发出。

## 依赖

**必须安装 [dsh-rewind-plugin](https://www.npmjs.com/package/dsh-rewind-plugin)。**

> [!IMPORTANT]
> **这不是可选项。** dsh-redo 本身**不实现撤回**——撤回对话、遮蔽模型上下文、还原工作区文件、隐藏被撤回的消息行，全部由 dsh-rewind-plugin 完成。
>
> 未安装 dsh-rewind-plugin 时，「订正」按钮**不会出现**，插件不提供任何替代路径，也不会有半残状态。

依赖分工：

| 能力 | 由谁提供 |
|---|---|
| 撤回对话（遮蔽，日志只追加不删改） | dsh-rewind |
| 工作区文件还原 | dsh-rewind 的检查点引擎 |
| 被撤回消息的行隐藏 | dsh-rewind 的视图包装 |
| 文件改动预检 | dsh-rewind 的 `preview` RPC |
| **改完自动重发** | **本插件** |

安装顺序：先装 rewind，再装本插件。

```sh
dsh plugin --profile <name> add dsh-rewind-plugin@<版本>
dsh plugin --profile <name> add dsh-redo-plugin@<版本>
```

卸载 rewind 会让本插件同时失效——这是设计上的依赖，不是缺陷。

## 已知边界

继承自 rewind 的检查点机制：

- **只跟踪 `write` / `edit` 两个工具**——模型用 shell 重定向、`pwsh`、`str_replace_editor` 写的文件不会被备份，撤不回来；
- **单文件 8 MiB 上限**——超过不备份；
- **每个会话只保留最新 100 组**备份——太早的回合没有还原点。

另外两点是本插件自身的：

- **`file` 类附件无法重发**——harness 没有客户端文件字节加载器，只有文本和图片能随订正消息重发；
- **撤回不可逆**——遮蔽是 append-only 的标记，没有 undo 事件。因此若撤回成功但发送失败，插件会把改好的文本放回输入框，避免你白写。

## 与 dsh-rewind-plugin 的关系

**依赖，但不冲突。**

两者共用同一个视图包装与同一套消息行锚点。本插件只读取 rewind 已经算好的结果（命令结果与 `preview` RPC），**不注册自己的视图包装**，因此不会与 rewind 争夺同一个 builder。

区别只在撤回后的最后一步：

| | dsh-rewind | dsh-redo |
|---|---|---|
| 撤回后 | 把原文填回输入框 | 弹出编辑框 |
| 发送 | 你自己点发送 | 确认后自动发送 |

换句话说：rewind 负责「回到上一步」，dsh-redo 负责「回到上一步，顺便把话改成对的那句再说一遍」。

## 安装

```sh
dsh plugin --profile <name> add dsh-redo-plugin@<版本>
```

## 开发

本仓库是 `dsh-redo-plugin` 的源码树。安装时以本地目录链接进 profile，无需构建步骤——`lib/client.js` 就是最终产物。

```sh
git clone https://github.com/basiak1438/dsh-redo-plugin.git
```

## 构建说明

本项目在 DeepSeek Harness 环境中完成：由开发者定义交互规范与验收标准，DSH 智能体负责从机制调研、接口核实到实现与真机验证的全过程。

## 许可

MIT
