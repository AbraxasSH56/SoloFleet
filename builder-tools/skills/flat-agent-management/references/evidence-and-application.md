# 管理学依据与代理应用

以下记录已用于提炼的原文与设计参考。阅读为所列相关段落，完整著作未通读；代理应用是方法转化，其效果需实际验证。

## 管理学来源

| 来源与阅读范围 | 可复用方法 |
| --- | --- |
| Andrew S. Grove, High Output Management，第 3 章 Managerial Leverage 与第 12 章 Task-Relevant Maturity 的相关段落 | 管理产出按成果评价；委派保持结果责任；早期检查低成本中间结果，监督随具体任务表现调整 |
| Stanley McChrystal 等, Team of Teams，第 7、8、10、11 章相关段落 | 共同目标和共享态势支持授权执行，领导者改善信息与协作条件 |
| Atul Gawande, The Checklist Manifesto；《清單革命》译本第 6 章相关段落 | 在易遗漏的关键节点设置精简核对，按流程选择执行后确认或逐项执行，依据真实使用修订 |
| Henry Mintzberg, A Typology of Organizational Structure，收于 Organizations: A Quantum View（1984），书内页 68–73 | 按任务选择协调机制，分别考虑组织结构、信息流与决策分工 |
| Herbert A. Simon, Administrative Behavior, 4th Edition，出版社第 1 章与评论中的目标、决策分工和沟通段落 | 子目标服务整体目的，区分目标取舍与事实依据，将信息与判断职责合理分配 |
| Donella H. Meadows, Thinking in Systems 的 The Basics 草稿节选全 9 页；Leverage Points（1999）的存量流量、延迟、负反馈和信息结构相关页 | 分析积压、流量与延迟；检测连接纠正，改善责任者的信息访问 |
| OpenStax, Principles of Management，第 2.3、10.1、17.8 节 | 区分重复可判定和新颖模糊决策，按任务选择结构，控制关注目标成果 |

原文入口：[Grove](https://penguinrandomhousehighereducation.com/book/?isbn=9780679762881)、[Team of Teams](https://penguinrandomhousehighereducation.com/book/?isbn=9780698178519)、[Gawande](https://atulgawande.com/book/the-checklist-manifesto/)、[Mintzberg 章节](https://mintzberg.org/sites/default/files/article/download/hm_a_typology_of_organizational_structure.pdf)、[Simon 出版社节选](https://www.simonandschuster.com/books/Administrative-Behavior-4th-Edition/Herbert-A-Simon/9781439136065)、[Meadows 草稿节选](https://donellameadows.org/wp-content/userfiles/bathtubs101.pdf)、[Leverage Points](https://donellameadows.org/wp-content/userfiles/Leverage_Points.pdf)、[OpenStax](https://openstax.org/details/books/principles-management)。

## 开源设计参考

以下是局部设计参考，不代表框架整体的适用性或可靠性。

| 来源 | 可借鉴的设计 |
| --- | --- |
| [ClawFu High Output Management](https://github.com/guia-matthieu/clawfu-skills/blob/4108f5c010ccaa8b5707fa05ca1d888ae167e548/skills/leadership/high-output-management/SKILL.md)及 reversible-decisions、context-engineering、skill-orchestrator | 以产出评价管理，按决策影响与可恢复性安排检查，提供最小相关上下文 |
| [Agent Flow 角色定义](https://github.com/svishniakov/agent-flow/blob/9987d284c96f62d3578f1a4e583bf9fd71a5c674/skills/agent-flow/docs/en/agents.md) | 角色配置复用于多个任务实例，职责、交接和检查分别安排 |
| [Hive 设计](https://github.com/hanuele/hive/blob/cd6be4b9eb6e4f514b26f75b81af6860c553fffc/README.md) | 按不确定性、影响及依赖选择临时协作，保留独立观点 |
| [PM Skills pre-mortem](https://github.com/phuryn/pm-skills/blob/c68487d721e419ec87af1ae6412a842978eab785/pm-execution/skills/pre-mortem/SKILL.md) | 实施前核对失败原因、已有防护与证据，把重要风险落实为动作 |
| [Agent Orchestration 协调源码](https://github.com/madebyaris/agent-orchestration/blob/b6a46731b2fa22fc803ec8a2e7482342a88f8995/src/tools/coordination.ts)及 task.ts | 共享队列、资源占用和依赖检查；约束落实范围与成果验收需分别核验 |

## 转化与实现

人类组织的训练、动机和人数阈值，需转成代理任务的可观测表现。skill 指导职责及判断；固定调用条件、并发控制和写入核验需要工具或运行配置落实。语义复核按任务影响及表现安排，规则存在与实际执行分别验收。

本指引采用原创归纳，来源材料用于追溯方法；方法选择见[方法选择](method-selection.md)。
