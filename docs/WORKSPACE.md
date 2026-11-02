# 手机工作区识别 / Mobile workspace identity

Beta.4 的聊天顶栏常驻项目和当前 Git 分支。普通名称下保留会话标题与驱动方式；名称过长时优先用两行显示项目、分支。点击顶栏查看完整工作目录、所属仓库、独立工作树、会话名称和 ID。更多菜单提供 Git 变更、会话分叉、重命名和驱动模式。

项目名称来自所属仓库，工作目录是 Hub 继续该会话时使用的具体目录；独立工作树不会因为文件夹名不同就被当成另一个项目。Git 分支和会话分叉分别显示：复制聊天上下文不会创建 Git 分支或独立目录。

进入会话、回到前台、网络恢复和发送前都会读取当前工作区。最近 50 个会话的已核对身份保存在该 PWA 的本地存储中，关闭后重开仍能发现工作区变化；清理站点数据或换手机后会重新建立基线。变化时草稿、附件和待发原文保留，确认工作区后仍需手动发送或重试。读取失败显示“分支未确认”，不会用历史分支或 `main` 代替。Git 仓库的分支识别需要可用的 Git；普通目录可在没有 Git 的电脑上继续使用。

离线消息保留发送时的工作区身份。分支变化、目标目录变化或旧消息缺少身份记录时停止自动补发，打开会话核对目标，再手动重试。网络错误仍保留原身份重试，已完成请求的幂等重放不会再执行一次。

工作区核对发生在消息受理前，不是 Git 分支锁。已接受的排队消息、模型运行时主动切换分支，以及另一个终端在核对后切分支仍需协调；同时处理不同分支时建议使用各自独立的 Git worktree。

## English

Beta.4 keeps the project and current Git branch visible in the chat header. With long names, the two lines prioritize project and branch; tap the header for the full working directory, parent repository, linked worktree, chat title and ID. Git changes, chat branches, rename and drive modes are in the more menu.

The project name comes from the parent repository. The working directory identifies the actual directory Hub uses to continue the chat. A linked worktree is marked separately. Forking a chat copies its context and does not create a Git branch or a separate working directory.

Hub refreshes workspace identity when opening a chat, returning to the foreground, reconnecting and before sending. The PWA remembers up to 50 reviewed chat identities locally, so reopening it can still detect a change. Clearing site data or using a different device establishes a new baseline. A changed workspace preserves the draft and attachments; review it, then send or retry manually. Unverified branches are labeled explicitly. Git repositories need an available Git executable for branch verification; plain directories still work without Git.

Offline messages retain their original workspace identity. A changed destination or a legacy message without identity pauses automatic resending until you review and retry. Network retries retain the same identity and idempotency key.

The check runs before message acceptance and does not lock Git. Already accepted queued work, a model's own checkout, or another terminal switching branches after the check still require coordination. Use separate Git worktrees for concurrent work on different branches.
