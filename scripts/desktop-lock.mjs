#!/usr/bin/env node
// Small command line for the desktop operator: release, wait, status, skip, note (and tick/settings/queue for the scheduler).
// 桌面角色用的桌面锁小命令：release（放锁）、wait（记为“等确认”）、status（看锁）、skip（划掉）、note（补资料）。
// 施工和定时任务用：tick（固定推进任务每 2 分钟跑一次）、settings（改设置文件）、next（手动选人，不发送）、queue（只读看名单）、selftest（S1 自检）。
// 逻辑和“动屏幕前核对锁”的检查共用 plugins/personal-inbox/desktop-lock.mjs。
import { dirname, join } from 'node:path';
import {
  describeLock, describeQueue, describeQueueLine, holdForConfirmation, lockPathsFromConfig, noteQueued, releaseLock,
  runSelftest, runTick, selectNextCommand, skipQueued, updateSettings,
} from '../plugins/personal-inbox/desktop-lock.mjs';

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : undefined;
};
const flags = (name) => rest.flatMap((value, index) => (rest[index - 1] === `--${name}` ? [value] : []));

// 锁的位置和插件用同一个来源：配置里 personal-inbox 的 syncRoot。--lock、--settings 只给测试用。
const fromConfig = lockPathsFromConfig();
const lockPath = flag('lock') ?? fromConfig?.lockPath;
const settingsPath = flag('settings');
const logPath = flag('lock') ? join(dirname(flag('lock')), 'screen-lock.log') : fromConfig?.logPath ?? null;
const KNOWN = ['release', 'wait', 'status', 'skip', 'note', 'settings', 'next', 'queue', 'tick', 'selftest'];
if (!lockPath && KNOWN.includes(command)) {
  console.log('读不到配置里的项目根目录，不知道锁放在哪里，没动锁。请点名主人说明。');
  process.exit(1);
}

function finish(result) {
  console.log(result.queueNote ? `${result.message}${result.queueNote}` : result.message);
  process.exit(result.ok ? 0 : 1);
}

switch (command) {
  case 'release':
    finish(releaseLock({ lockPath, logPath, settingsPath, threadId: flag('thread') }));
    break;
  case 'wait':
    finish(holdForConfirmation({ lockPath, threadId: flag('thread'), what: flag('what') }));
    break;
  case 'status':
    console.log(describeLock({ lockPath }));
    console.log(describeQueueLine({ lockPath, settingsPath }));
    break;
  case 'skip':
    finish(skipQueued({ lockPath, logPath, settingsPath, threadId: flag('thread'), why: flag('why') }));
    break;
  case 'note':
    finish(noteQueued({ lockPath, logPath, settingsPath, threadId: flag('thread'), message: flag('message'), requester: flag('requester') }));
    break;
  case 'settings':
    finish(updateSettings({ lockPath, settingsPath, sets: flags('set') }));
    break;
  case 'next':
    finish(selectNextCommand({ lockPath, logPath, settingsPath }));
    break;
  case 'queue': {
    const view = describeQueue({ lockPath, settingsPath });
    console.log(view.text);
    process.exit(view.ok ? 0 : 1);
    break;
  }
  case 'tick':
    // 只有程序自己崩了（读写文件异常、代码错误）才非零退出；发送失败、读不全、名单读不懂、设置无效都记进名单或日志，照样输出 NO_REPLY。
    try {
      await runTick({ lockPath, logPath, settingsPath });
      console.log('NO_REPLY');
      process.exit(0);
    } catch (error) {
      console.error(`tick 出错：${error.stack ?? error.message}`);
      process.exit(1);
    }
    break;
  case 'selftest': {
    const resultPath = join(dirname(lockPath), 'selftest-result.json');
    const result = await runSelftest({ threadId: flag('thread'), resultPath });
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
    break;
  }
  default:
    console.error('用法：desktop-lock.mjs release --thread <线程编号> | wait --thread <线程编号> [--what <六类操作里要等确认的那件事>] | status | skip --thread <线程编号> --why <不用了|完成|被接手> | note --thread <线程编号> [--message <消息编号>] [--requester <请求方编号>] | settings --set <键>=<值> [--set …] | next | queue | tick | selftest --thread <测试线程编号>');
    process.exit(2);
}
